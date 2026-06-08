#!/usr/bin/env node
/**
 * ctx-bucket — 컨텍스트 예산 기반 작업 분할 계약의 *약한 결정적 checker* (v0.1 PoC).
 *
 * 설계 출처: claude 1차 서치 + codex·gemini 독립 서치+설계 수렴 (.agents/progress/ctx-bucket-methodology-2026-05-31.md).
 * 스키마: scripts/ctx-bucket-contract.schema.json. 이 도구는 스키마가 못 거는 *cross-field 규칙*과
 *   *반증가능 신호*만 본다(똑똑할 필요 없음). 의미·체감 품질은 계약 밖(인간 게이트).
 *
 * 두 모드:
 *   validate <contract.json> [--root R]  — 착수 전 정적 검증:
 *     · judge.actor_id != generator.actor_id  (닫힌 루프 차단 — codex 최우선)
 *     · risk_flags 비어있지 않으면 judge.kind != deterministic-checker (인지난이도는 사람/외부AI)
 *     · acceptance.covered_by 가 실재 falsifier id 참조 (dangling 금지)
 *     · 모든 falsifier 에 mutation_target (가짜 QA 차단 — gemini 최우선)
 *     · anchor.locator 파일 실존
 *     · 예산: E=min(user_cap, max_window*ratio); 정적팩 토큰추정 <= static_pack_max_ratio*E
 *     · fan-out: allowed_paths 매칭 파일의 distinct 모듈(상위2세그먼트) <= fanout_cap
 *   check <contract.json> --touched a,b,c [--root R] [--run]  — 완료 후 검증:
 *     · touched ⊆ allowed_paths, ∉ forbidden_paths (scope creep RED)
 *     · touched 수 <= artifact_cap
 *     · --run 이면 falsifier 실행(cwd,timeout) → expect_exit (반증가능 통과)
 *     · falsifier.mutation_target 마다 mutation-probe 권고 명령 출력(가짜 QA 합성검증)
 *
 * exit 0 = GREEN / 1 = RED / 2 = usage·parse. ESM, 의존성 0.
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const MUT_PROBE = path.join(SCRIPT_DIR, "mutation-probe.mjs");

const argv = process.argv.slice(2);
const mode = argv[0];
const contractPath = argv[1];
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true) : undefined; };
const ROOT = path.resolve(flag("--root") || ".");

if (!["validate", "check"].includes(mode) || !contractPath) {
	console.error("사용: ctx-bucket.mjs validate <contract.json> [--root R]");
	console.error("      ctx-bucket.mjs check <contract.json> --touched a,b,c [--root R] [--run]");
	process.exit(2);
}
let C;
try { C = JSON.parse(fs.readFileSync(contractPath, "utf8")); }
catch (e) { console.error(`계약 파싱 실패: ${e.message}`); process.exit(2); }

function globToRe(g) {
	let re = "^";
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === "*") {
			if (g[i + 1] === "*") { if (g[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i++; } }
			else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
		else re += c;
	}
	return new RegExp(re + "$");
}
const anyMatch = (rel, globs) => (globs || []).some((g) => globToRe(g).test(rel));
function walk(dir) {
	const out = [];
	if (!fs.existsSync(dir)) return out;
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (/^(node_modules|\.git)$/.test(e.name)) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p));
		else out.push(p);
	}
	return out;
}
const reds = [], greens = [], warns = [];
const RED = (m) => reds.push(m), OK = (m) => greens.push(m), WARN = (m) => warns.push(m);

if (mode === "validate") {
	// 1. judge != generator
	const gen = C.generator?.actor_id, jud = C.judge?.actor_id;
	if (!gen || !jud) RED(`generator/judge actor_id 누락 (gen=${gen} judge=${jud})`);
	else if (gen === jud) RED(`닫힌 루프: judge.actor_id == generator.actor_id (${gen})`);
	else OK(`judge≠generator (${gen} ≠ ${jud})`);

	// 2. risk_flags → judge.kind
	const rf = C.risk_flags || [];
	if (rf.length && C.judge?.kind === "deterministic-checker") RED(`risk_flags=[${rf}] 인데 judge.kind=deterministic-checker (인지난이도는 사람/외부AI 판정 필요)`);
	else if (rf.length) OK(`risk_flags=[${rf}] + judge.kind=${C.judge?.kind} (사람/외부AI OK)`);

	// 3. acceptance coverage
	const fids = new Set((C.falsifiers || []).map((f) => f.id));
	for (const a of C.acceptance || []) {
		const dangling = (a.covered_by || []).filter((id) => !fids.has(id));
		if (!a.covered_by?.length) RED(`acceptance 미커버: "${a.criterion}"`);
		else if (dangling.length) RED(`acceptance "${a.criterion}" 가 없는 falsifier 참조: ${dangling}`);
	}
	if (!reds.some((r) => r.includes("acceptance"))) OK(`acceptance 전부 falsifier 로 커버`);

	// 4. mutation_target 필수
	for (const f of C.falsifiers || []) if (!f.mutation_target) RED(`falsifier '${f.id}' mutation_target 누락(가짜 QA 차단 비강제)`);

	// 5. anchor 실존
	for (const a of C.anchors || []) {
		const file = (a.locator || "").split(/[#:]/)[0];
		if (!file || !fs.existsSync(path.join(ROOT, file))) RED(`anchor 실존 안 함: ${a.ref} → ${a.locator}`);
	}
	if ((C.anchors || []).length && !reds.some((r) => r.includes("anchor"))) OK(`anchor ${C.anchors.length}개 실존 확인`);

	// 6. 예산
	const b = C.budget || {};
	const E = Math.min(b.user_cap_tokens || Infinity, (b.max_window_tokens || 0) * (b.ratio ?? 0.25));
	const files = walk(ROOT).map((p) => path.relative(ROOT, p)).filter((rel) => anyMatch(rel, C.allowed_paths));
	let bytes = 0; for (const rel of files) { try { bytes += fs.statSync(path.join(ROOT, rel)).size; } catch {} }
	const est = Math.round(bytes / 4);
	const cap = (b.static_pack_max_ratio ?? 0.4) * E;
	if (est > cap) RED(`정적팩 토큰추정 ${est} > ${Math.round(cap)} (=${b.static_pack_max_ratio ?? 0.4}·E), E=${E}`);
	else OK(`예산 OK: 정적팩 추정 ${est}토큰 ≤ ${Math.round(cap)} (E=${E}, 매칭 ${files.length}파일)`);

	// 7. fan-out (distinct 상위2세그먼트)
	const mods = new Set(files.filter((rel) => !path.basename(rel).startsWith(".")).map((rel) => { const s = rel.split("/"); return s.length > 1 ? s.slice(0, 2).join("/") : s[0]; }));
	const fc = C.complexity_caps?.fanout_cap ?? Infinity;
	if (mods.size > fc) RED(`fan-out ${mods.size} > fanout_cap ${fc}: {${[...mods].join(", ")}}`);
	else OK(`fan-out ${mods.size} ≤ ${fc} {${[...mods].join(", ")}}`);
}

if (mode === "check") {
	const touched = String(flag("--touched") || "").split(",").map((s) => s.trim()).filter(Boolean);
	if (!touched.length) { console.error("check 모드는 --touched a,b,c 필요"); process.exit(2); }
	for (const t of touched) {
		if (anyMatch(t, C.forbidden_paths)) RED(`금지 경로 touch: ${t}`);
		else if (!anyMatch(t, C.allowed_paths)) RED(`허용 밖 touch(scope creep): ${t}`);
		else OK(`허용 내: ${t}`);
	}
	const ac = C.complexity_caps?.artifact_cap ?? Infinity;
	if (touched.length > ac) RED(`touched ${touched.length} > artifact_cap ${ac}`);

	// falsifier 검증 — mutation_target 있으면 mutation-probe 가 *필수 RED 게이트*(가짜 QA 차단).
	//   codex+gemini 도구리뷰 수렴 최우선 수정: WARN→강제. probe 가 변이를 '생존'시키면(=가짜 QA) RED.
	//   N/A(행위검증)는 --run 으로 exit 확인 + 사람 판정 명시.
	for (const f of C.falsifiers || []) {
		const real = f.mutation_target && !f.mutation_target.startsWith("N/A");
		if (real) {
			// 1) baseline: falsifier 가 애초에 통과하나? (실제 투입서 발견 — 베이스라인 실패와 반증력을 분리해야)
			let base;
			try { execSync(f.cmd, { cwd: path.resolve(ROOT, f.cwd || "."), timeout: (f.timeout_s || 120) * 1000, stdio: "ignore" }); base = 0; }
			catch (e) { base = e.status ?? 1; }
			if (base !== (f.expect_exit ?? 0)) { RED(`falsifier '${f.id}' baseline 실패(exit ${base} ≠ ${f.expect_exit ?? 0}) — 코드가 설계 테스트 미통과`); continue; }
			// 2) mutation-probe 반증력: 생존(exit1)=가짜 QA RED / 변이불가(exit2 등)=반증력 미확인 WARN(judge로 escalate) / robust(0)=OK.
			//    (exit2≠RED — mutation-probe hex-only 라 decimal-only 코드는 변이 불가. 좋은 코드를 false-RED 하면 안 됨.)
			let code;
			try { execSync(`node ${MUT_PROBE} ${f.mutation_target} -- ${f.cmd}`, { cwd: ROOT, timeout: 300000, stdio: "ignore" }); code = 0; }
			catch (e) { code = e.status ?? 1; }
			if (code === 0) OK(`falsifier '${f.id}' baseline PASS + mutation-probe PASS (반증력 확인)`);
			else if (code === 1) RED(`falsifier '${f.id}' mutation-probe 생존 = 가짜 QA — '${f.cmd}' 가 ${f.mutation_target} 미검증`);
			else WARN(`falsifier '${f.id}' baseline PASS, mutation-probe 불가(exit ${code}: 변이가능 토큰 없음 등) — 반증력 미확인, judge(${C.judge?.actor_id}) 가 확인 필요`);
		} else if (flag("--run")) {
			let code = 0;
			try { execSync(f.cmd, { cwd: path.resolve(ROOT, f.cwd || "."), timeout: (f.timeout_s || 120) * 1000, stdio: "ignore" }); }
			catch (e) { code = e.status ?? 1; }
			if (code === (f.expect_exit ?? 0)) OK(`falsifier '${f.id}'(N/A:행위) exit ${code} — 사람 판정 권고`);
			else RED(`falsifier '${f.id}' 실패 (exit ${code} ≠ ${f.expect_exit ?? 0})`);
		} else WARN(`falsifier '${f.id}'(N/A:행위) 미실행 — --run + 사람 판정 필요`);
	}
}

const label = mode.toUpperCase();
console.log(`[ctx-bucket ${label}] ${path.basename(contractPath)} — RED ${reds.length} / OK ${greens.length}${warns.length ? ` / WARN ${warns.length}` : ""}\n`);
for (const r of reds) console.log(`  ✗ RED  ${r}`);
for (const g of greens) console.log(`  ✓ ok   ${g}`);
for (const w of warns) console.log(`  • warn ${w}`);
console.log(`\n${reds.length ? "VERDICT=RED — 계약 위반(위 항목). 진위는 mutation-probe + 인간 게이트로 보강." : "VERDICT=GREEN — 구조 통과(경보 기준). 의미·체감 품질은 계약 밖(인간)."}`);
process.exit(reds.length ? 1 : 0);
