#!/usr/bin/env node
/**
 * check-compile-integrity — 컴파일 무결성 게이트.
 *
 * 목적(Luke 2026-06-12): "항상 깨끗한 상태 유지" 강제. 5d1078b 사고(gateway-sync.ts 삭제 커밋이
 * 호출처 import 제거를 누락 → HEAD 가 삭제된 파일을 import = tsc 에러인데 어떤 검출기도 tsc 를 안 돌려 미감지)
 * 를 막는다. pre-commit + cron(verify-watch) 공용.
 *
 * 검사: ① 코어(new-naia-os 루트) tsc  ② 셸(packages/shell) tsc — **비-테스트 src 에러만**(기존 jest-dom
 * toBeInTheDocument 등 테스트-타입 노이즈는 무결성과 무관 → 제외).  exit 1 = src 컴파일 깨짐(RED).
 * (--rust 시 src-tauri cargo check 추가 — 느려서 cron/opt-in.)
 */
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wantRust = process.argv.includes("--rust");
const errors = [];

function tsc(cwd, label) {
	try {
		execSync("npx tsc --noEmit -p tsconfig.json", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return [];
	} catch (e) {
		// tsc 출력(stdout)에서 error TS 라인 — 테스트 파일 제외(무결성=src).
		const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
		const srcErrs = out.split("\n").filter((l) => /error TS\d+/.test(l) && !/__tests__|\.test\.|\.spec\./.test(l));
		if (srcErrs.length) console.error(`[compile-integrity] ❌ ${label} src 컴파일 에러:\n${srcErrs.map((l) => "  " + l).join("\n")}`);
		return srcErrs;
	}
}

errors.push(...tsc(OS_ROOT, "core(new-naia-os)"));
errors.push(...tsc(resolve(OS_ROOT, "packages/shell"), "shell(packages/shell)"));

if (wantRust) {
	try {
		execSync("cargo check --message-format=short", { cwd: resolve(OS_ROOT, "packages/shell/src-tauri"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (e) {
		const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
		const rustErrs = out.split("\n").filter((l) => /^error/.test(l));
		console.error(`[compile-integrity] ❌ Rust(src-tauri) cargo check 에러:\n${rustErrs.map((l) => "  " + l).join("\n")}`);
		errors.push(...rustErrs);
	}
}

if (errors.length) {
	console.error(`[compile-integrity] ❌ RED — 컴파일 무결성 위반 ${errors.length}건. 깨진/불완전 상태(예: 삭제된 파일 import).`);
	process.exit(1);
}
console.log("[compile-integrity] ✅ PASS — core + shell src 컴파일 무결" + (wantRust ? " + Rust cargo check" : "") + ".");
process.exit(0);
