#!/usr/bin/env node
/**
 * check-build-contract.mjs — 빌드/dev 툴링 드리프트 검출기.
 *
 * 목적(Luke 2026-06-12): 빌드 툴링이 "잘못 이식"되면 드리프트로 잡는다.
 * B0 verbatim 이식이 옛 `../scripts`·`../agent` 레이아웃을 들고 와 tauri:dev 가 dangling 으로 깨진 그 갭을 닫음.
 *
 * 검사:
 *   1) 모든 빌드 진입점(package.json 의 tauri / dev / build 스크립트 + tauri.conf 의 beforeDev/BuildCommand)이
 *      build-tooling-manifest.json 에 등록됐는가. 미등록 = RED (잘못 추가된 빌드 스크립트 검출).
 *   2) status=active 진입점이 참조하는 경로(node/cd/bash/python3 인자, --config 경로)가 전부 실제 존재하는가.
 *      dangling = RED.
 *   3) status=deferred = Tranche B 미이식 — dangling 허용하되 'DEFERRED'로 보고(거짓 GREEN 방지).
 *   4) manifest.required_files 가 전부 존재하는가. 누락 = RED.
 *
 * exit 0 = PASS(드리프트 없음), 1 = RED.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // new-naia-os
const MANIFEST = resolve(OS_ROOT, ".agents/context/build-tooling-manifest.json");

function fail(msg) {
	console.error(`[build-contract] ❌ ${msg}`);
}

if (!existsSync(MANIFEST)) {
	fail(`매니페스트 없음: ${MANIFEST} (fail-closed)`);
	process.exit(1);
}
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const baseDir = resolve(OS_ROOT, manifest.base_dir); // packages/shell
const reg = manifest.entrypoints ?? {};

/** 커맨드 문자열에서 경로-유사 토큰 추출(node/cd/bash/python3 인자 + --config X). */
function extractPaths(cmd) {
	const paths = new Set();
	const toks = cmd.split(/\s+/);
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i];
		// node/cd/bash/sh/python/python3 다음 인자(플래그 아니면)
		if (/^(node|cd|bash|sh|python3?|tsx)$/.test(t)) {
			// node 의 경우 --flag 를 건너뛰고 첫 비-플래그
			let j = i + 1;
			while (j < toks.length && toks[j].startsWith("-")) j++;
			if (j < toks.length) paths.add(toks[j]);
		}
		// --config X
		if (t === "--config" && i + 1 < toks.length) paths.add(toks[i + 1]);
		// 경로처럼 보이는 토큰(슬래시 포함 또는 빌드파일 확장자) — pnpm/vite/tsc/biome 등 커맨드는 제외
		if ((t.includes("/") || /\.(mjs|cjs|js|ts|py|sh|json)$/.test(t)) && !t.startsWith("-")) {
			paths.add(t);
		}
	}
	// pnpm 하위커맨드(run/exec/install/build/dev), 순수 커맨드명은 경로 아님 → 거른다
	return [...paths].filter((p) => p.includes("/") || /\.(mjs|cjs|js|ts|py|sh|json)$/.test(p));
}

/** baseDir 기준 상대경로 해소(존재 여부). `&&`로 cd 가 바뀌어도 보수적으로 baseDir 기준 + cd 추적. */
function resolveAll(cmd, base) {
	// 단순 cd 추적: `cd X && ...` 시퀀스에서 cd 가 base 를 바꾼다(서브셸 ( ) 은 무시 — 닫히면 복귀).
	const results = [];
	let cwd = base;
	const segments = cmd.split("&&").map((s) => s.trim());
	for (const seg of segments) {
		const m = seg.match(/^cd\s+(\S+)/);
		if (m && !m[1].startsWith("(")) {
			const target = resolve(cwd, m[1]);
			results.push({ path: m[1], abs: target, exists: existsSync(target) });
			cwd = target; // 후속 세그먼트는 이 cwd 기준
			continue;
		}
		for (const p of extractPaths(seg)) {
			if (p.startsWith("cd")) continue;
			results.push({ path: p, abs: resolve(cwd, p), exists: existsSync(resolve(cwd, p)) });
		}
	}
	return results;
}

// ── 진입점 수집 ──
const found = {}; // id → { cmd, kind }
const pkgPath = resolve(baseDir, "package.json");
if (existsSync(pkgPath)) {
	const scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {};
	for (const [name, cmd] of Object.entries(scripts)) {
		if (/^(tauri|dev$|build$)/.test(name) || name.startsWith("tauri:")) {
			found[`pkg:${name}`] = { cmd, base: baseDir };
		}
	}
}
const srcTauri = resolve(baseDir, "src-tauri");
if (existsSync(srcTauri)) {
	for (const f of readdirSync(srcTauri).filter((f) => /^tauri\.conf.*\.json$/.test(f))) {
		const conf = JSON.parse(readFileSync(resolve(srcTauri, f), "utf8"));
		for (const hook of ["beforeDevCommand", "beforeBuildCommand"]) {
			if (conf.build && hook in conf.build) {
				found[`conf:${f}:${hook}`] = { cmd: conf.build[hook] ?? "", base: baseDir };
			}
		}
	}
}

// ── 검사 ──
let red = 0;
const deferred = [];

// (4) required_files
for (const rf of manifest.required_files ?? []) {
	if (!existsSync(resolve(OS_ROOT, rf))) {
		fail(`required_file 누락: ${rf}`);
		red++;
	}
}

for (const [id, { cmd, base }] of Object.entries(found)) {
	const entry = reg[id];
	// (1) 미등록
	if (!entry) {
		fail(`미등록 빌드 진입점: ${id}  →  "${cmd}"  (build-tooling-manifest.json 에 추가하거나 제거)`);
		red++;
		continue;
	}
	const refs = resolveAll(cmd, base);
	const dangling = refs.filter((r) => !r.exists);
	if (entry.status === "active") {
		// (2) active 는 전부 해소돼야
		for (const d of dangling) {
			fail(`active 진입점 ${id} 의 dangling 경로: ${d.path}  (해소: ${d.abs})`);
			red++;
		}
	} else if (entry.status === "deferred") {
		// (3) deferred — 보고만
		deferred.push(`${id} (${entry.tranche ?? "?"}: ${entry.reason ?? entry.note ?? "deferred"})${dangling.length ? ` — dangling ${dangling.length}개` : ""}`);
	}
}

// 등록됐지만 실제 없는 진입점(매니페스트 stale)
for (const id of Object.keys(reg)) {
	if (!(id in found) && reg[id].note !== "empty") {
		// 정보성: 매니페스트엔 있으나 코드엔 없음(제거됐을 수 있음). active 면 경고.
		if (reg[id].status === "active") console.warn(`[build-contract] ⚠ 매니페스트 등록(active)이나 코드에 없음: ${id}`);
	}
}

if (deferred.length) {
	console.log(`[build-contract] DEFERRED(Tranche B 미이식 — 정상):`);
	for (const d of deferred) console.log(`  · ${d}`);
}

if (red > 0) {
	console.error(`[build-contract] ❌ RED — 빌드-계약 위반 ${red}건. 잘못된 이식/dangling 경로.`);
	process.exit(1);
}
console.log(`[build-contract] ✅ PASS — active 진입점 ${Object.values(found).filter((_, i) => reg[Object.keys(found)[i]]?.status === "active").length}개 경로 전부 해소, 미등록 0.`);
process.exit(0);
