#!/usr/bin/env node
/**
 * quarantine — 방치 의심 자산(dormant/build-unconnected, 지우기도 애매한 회색 자산)을
 *   `quarantine/` 로 **보류 격리**하고 라이프사이클을 관리한다. (처분 6번째 방식)
 *
 * 라이프사이클:
 *   add      자산을 quarantine/<name>/ 로 이동(git 추적 해제 = 이력·디스크 보존) + manifest 기록.
 *   check    만료(review_by 경과) 검출 → **자동 압축(tar.gz, 비파괴)** → status=archived + pending_notice.
 *            ⚠️ 자동 삭제 절대 안 함. (cron/verify-watch 가 호출 — 비파괴 자동 처리만.)
 *   list     manifest + 계산된 status 출력.
 *   restore  격리 해제 — 원위치 복원 + git add 대상으로.
 *   extend   보관기간 연장(새 review_by) + pending_notice 해제.
 *   purge    삭제 — **사용자가 의도적으로 호출할 때만**. 백그라운드는 절대 호출 안 함.
 *
 * 원칙(불변): 백그라운드 = 검출·압축·보고만. 파괴(삭제)는 첫 세션 진입 때 권한 유저가 결정
 *   (SessionStart hook `quarantine-notice.js` 가 pending_notice 를 surface → 유저 질의 → purge).
 *
 * 컨텍스트 인지: quarantine/MANIFEST.json 은 force-추적(.gitignore 예외) → 세션이 "백업 자산이
 *   있었다"를 항상 안다. payload(격리된 실물)는 gitignore.
 *
 * env: QUARANTINE_PROJECT_ROOT (기본 cwd). ESM. (workflow 아님 — Date 사용 OK.)
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const ROOT = process.env.QUARANTINE_PROJECT_ROOT || process.cwd();
const QDIR = path.join(ROOT, "quarantine");
const MANIFEST_PATH = path.join(QDIR, "MANIFEST.json");
export const DEFAULT_RETENTION_MONTHS = 3;

// ─────────────────────────── 순수 함수 (테스트 대상, fs/git 무관) ───────────────────────────

export function todayStr(now = new Date()) {
	return now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

/** dateStr(YYYY-MM-DD) + months. 말일 오버플로 보정(예: 1/31 +1달 = 2/28). */
export function monthsAfter(dateStr, months) {
	const [y, m, d] = dateStr.split("-").map(Number);
	const totalMonth = m - 1 + months;
	const ty = y + Math.floor(totalMonth / 12);
	const tm = ((totalMonth % 12) + 12) % 12;
	const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate(); // 대상 달 말일
	const day = Math.min(d, lastDay);
	return new Date(Date.UTC(ty, tm, day)).toISOString().slice(0, 10);
}

export function emptyManifest() {
	return { version: 1, quarantined: [] };
}

/** archived 면 유지(이미 만료처리됨), 아니면 today>=review_by → 'expired' / else 'active'. */
export function computeStatus(entry, now = new Date()) {
	if (entry.status === "archived") return "archived";
	return todayStr(now) >= entry.review_by ? "expired" : "active";
}

export function makeEntry({ name, origin, reason, retention_months, compress_on_expiry, now = new Date() }) {
	const qd = todayStr(now);
	const rm = Number.isFinite(retention_months) ? retention_months : DEFAULT_RETENTION_MONTHS;
	return {
		name,
		origin: origin || name,
		quarantined_date: qd,
		reason: reason || "",
		retention_months: rm,
		review_by: monthsAfter(qd, rm),
		compress_on_expiry: compress_on_expiry !== false, // 기본 true
		status: "active",
		compressed: false,
		pending_notice: false,
		user_approved: true,
	};
}

/** 만료되어 아카이브(자동 압축) 대상인 active 항목. */
export function entriesToArchive(manifest, now = new Date()) {
	return manifest.quarantined.filter((e) => e.status === "active" && computeStatus(e, now) === "expired");
}

/** 사용자 처분 대기(만료·아카이브됨) 항목. */
export function pendingEntries(manifest) {
	return manifest.quarantined.filter((e) => e.pending_notice);
}

export function findEntry(manifest, name) {
	return manifest.quarantined.find((e) => e.name === name);
}

// ─────────────────────────── fs/git 래퍼 (얇은 imperative) ───────────────────────────

function loadManifest() {
	if (!fs.existsSync(MANIFEST_PATH)) return emptyManifest();
	try {
		const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
		if (!Array.isArray(m.quarantined)) m.quarantined = [];
		return m;
	} catch {
		return emptyManifest();
	}
}

function saveManifest(m) {
	fs.mkdirSync(QDIR, { recursive: true });
	fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, "\t") + "\n");
}

function gitUntrack(relPath) {
	try {
		execSync(`git -C "${ROOT}" rm -r --cached --quiet -- "${relPath}"`, { stdio: "ignore" });
	} catch {
		/* 추적 중이 아니면 무시 — 디스크 이동은 별도 */
	}
}

function compressEntry(entry) {
	const folder = path.join(QDIR, entry.name);
	const tgz = path.join(QDIR, `${entry.name}.tar.gz`);
	if (!fs.existsSync(folder)) return false;
	try {
		execSync(`tar -czf "${tgz}" -C "${QDIR}" "${entry.name}"`, { stdio: "ignore" });
		fs.rmSync(folder, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

// ─────────────────────────── 서브커맨드 ───────────────────────────

function doAdd(args) {
	const target = args._[0];
	if (!target) die("사용: quarantine.mjs add <경로> [--reason \"…\"] [--retention <개월>] [--compress-now]");
	const origin = path.relative(ROOT, path.resolve(ROOT, target)).replace(/\\/g, "/");
	const name = path.basename(origin);
	const src = path.join(ROOT, origin);
	if (!fs.existsSync(src)) die(`경로 없음: ${origin}`);
	const m = loadManifest();
	if (findEntry(m, name)) die(`이미 격리됨: ${name}`);

	const entry = makeEntry({
		name,
		origin,
		reason: args.reason,
		retention_months: args.retention != null ? Number(args.retention) : undefined,
		compress_on_expiry: args["compress-on-expiry"] !== "false",
	});

	fs.mkdirSync(QDIR, { recursive: true });
	gitUntrack(origin); // 추적 해제(이력 보존) — gitignore 라 재추적 안 됨
	fs.renameSync(src, path.join(QDIR, name)); // 디스크 이동(보존)
	if (args["compress-now"]) {
		entry.compressed = compressEntry(entry);
	}
	m.quarantined.push(entry);
	saveManifest(m);
	console.log(`[quarantine] 격리: ${origin} → quarantine/${name}/  (보관 ${entry.retention_months}개월, 재검토 ${entry.review_by})`);
	console.log(`  이력·디스크 보존(git rm --cached). 컨텍스트 인지 = quarantine/MANIFEST.json(추적).`);
}

function doCheck() {
	const m = loadManifest();
	const now = new Date();
	const toArchive = entriesToArchive(m, now);
	let changed = false;
	for (const e of toArchive) {
		if (e.compress_on_expiry) e.compressed = compressEntry(e);
		e.status = "archived";
		e.pending_notice = true;
		changed = true;
		console.log(`[quarantine] 만료·아카이브: ${e.name} (재검토 ${e.review_by} 경과)${e.compressed ? " — tar.gz 압축됨" : ""}`);
	}
	if (changed) saveManifest(m);

	const pend = pendingEntries(m);
	if (pend.length) {
		console.log(`[quarantine] 사용자 처분 대기 ${pend.length}건 (삭제/연장/복원 — 권한 유저 결정):`);
		for (const e of pend) console.log(`  - ${e.name} (격리 ${e.quarantined_date}, 사유: ${e.reason || "—"})`);
		process.exitCode = 1; // verify-watch delta 로 surface
	} else {
		console.log("[quarantine] 만료·대기 항목 없음.");
	}
}

function doList() {
	const m = loadManifest();
	if (!m.quarantined.length) return console.log("[quarantine] 격리 자산 없음.");
	const now = new Date();
	for (const e of m.quarantined) {
		const st = computeStatus(e, now);
		console.log(`${st === "archived" ? "📦" : st === "expired" ? "⏰" : "•"} ${e.name}  [${st}]  재검토 ${e.review_by}  ${e.compressed ? "(압축됨)" : ""}  ${e.pending_notice ? "← 처분 대기" : ""}`);
		if (e.reason) console.log(`    사유: ${e.reason}`);
	}
}

function doRestore(args) {
	const name = args._[0];
	if (!name) die("사용: quarantine.mjs restore <name>");
	const m = loadManifest();
	const e = findEntry(m, name);
	if (!e) die(`격리 항목 없음: ${name}`);
	const folder = path.join(QDIR, name);
	const tgz = path.join(QDIR, `${name}.tar.gz`);
	if (e.compressed && fs.existsSync(tgz)) {
		execSync(`tar -xzf "${tgz}" -C "${QDIR}"`, { stdio: "ignore" });
		fs.rmSync(tgz, { force: true });
	}
	if (!fs.existsSync(folder)) die(`격리 실물 없음: quarantine/${name}`);
	fs.renameSync(folder, path.join(ROOT, e.origin));
	m.quarantined = m.quarantined.filter((x) => x.name !== name);
	saveManifest(m);
	console.log(`[quarantine] 복원: quarantine/${name} → ${e.origin}  (git add 로 재추적하세요.)`);
}

function doExtend(args) {
	const name = args._[0];
	const months = Number(args._[1]);
	if (!name || !Number.isFinite(months)) die("사용: quarantine.mjs extend <name> <개월>");
	const m = loadManifest();
	const e = findEntry(m, name);
	if (!e) die(`격리 항목 없음: ${name}`);
	e.review_by = monthsAfter(todayStr(), months);
	e.retention_months = months;
	e.status = "active";
	e.pending_notice = false;
	saveManifest(m);
	console.log(`[quarantine] 연장: ${name} 재검토 ${e.review_by} (오늘+${months}개월), 처분 대기 해제.`);
}

function doPurge(args) {
	const m = loadManifest();
	let targets;
	if (args.expired) {
		targets = pendingEntries(m).map((e) => e.name);
		if (!targets.length) return console.log("[quarantine] 만료·대기 항목 없음 — 삭제할 것 없음.");
	} else if (args._[0]) {
		targets = [args._[0]];
	} else {
		die("사용: quarantine.mjs purge <name> | --expired   (⚠️ 사용자 의도적 호출만. 영구 삭제.)");
	}
	for (const name of targets) {
		const e = findEntry(m, name);
		if (!e) {
			console.log(`  건너뜀(없음): ${name}`);
			continue;
		}
		fs.rmSync(path.join(QDIR, name), { recursive: true, force: true });
		fs.rmSync(path.join(QDIR, `${name}.tar.gz`), { force: true });
		m.quarantined = m.quarantined.filter((x) => x.name !== name);
		console.log(`[quarantine] 영구 삭제: ${name} (사용자 승인 하 — 이력은 git history 에 잔존).`);
	}
	saveManifest(m);
}

function die(msg) {
	console.error(msg);
	process.exit(2);
}

// 아주 작은 arg 파서: --k v / --k=v / --flag / positional(_)
function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
			else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
			else out[a.slice(2)] = true;
		} else out._.push(a);
	}
	return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("quarantine.mjs");
if (isMain) {
	const [cmd, ...rest] = process.argv.slice(2);
	const args = parseArgs(rest);
	switch (cmd) {
		case "add": doAdd(args); break;
		case "check": doCheck(); break;
		case "list": doList(); break;
		case "restore": doRestore(args); break;
		case "extend": doExtend(args); break;
		case "purge": doPurge(args); break;
		default:
			console.log("사용: quarantine.mjs {add|check|list|restore|extend|purge}");
			process.exit(cmd ? 2 : 0);
	}
}
