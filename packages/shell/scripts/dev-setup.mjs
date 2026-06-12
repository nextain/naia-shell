#!/usr/bin/env node
/**
 * new-naia dev-setup — `tauri dev` 전에 실행.
 *
 * 옛 old-naia-os/scripts/dev-setup.mjs 의 새-구조 이식판. 핵심 차이:
 *  - 에이전트가 **분리 repo** (`../new-naia-agent`) → 옛 임베디드 `../agent` + `../../naia-agent` submodule 로직 제거(obsolete).
 *  - 코어(`new-naia-os` 루트, 헥사고날 src/main)와 에이전트를 각각 tsc 빌드.
 *  - new-naia-os 는 항상 새 코어 → VITE_NAIA_NEW_CORE / NAIA_AGENT_SCRIPT 주입은 tauri-with-mode.mjs(env 레이어)가 담당.
 *
 * 책임: ① stale 프로세스 정리 ② 코어/에이전트 tsc 빌드 ③ (--clean) Rust 증분캐시 삭제.
 * 플랫폼 env(GDK_BACKEND 등)는 spawn 시점이라 tauri-with-mode.mjs 가 주입.
 */
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";

const cleanMode = process.argv.includes("--clean");
const isWin = platform() === "win32";

const HERE = import.meta.dirname; // packages/shell/scripts
const SHELL = resolve(HERE, ".."); // packages/shell
const OS_ROOT = resolve(SHELL, "..", ".."); // new-naia-os (코어)
const AGENT = resolve(OS_ROOT, "..", "new-naia-agent"); // 분리 repo

// ─── 1. stale 프로세스 정리 ──────────────────────────────────────────────────
// ⚠️ pkill -f 금지(컨테이너/무관 프로세스 오살). 정확 프로세스명(-x) + 포트 1420(vite)만.
function killStale() {
	try {
		if (isWin) execSync("taskkill /F /IM naia-shell.exe 2>nul", { stdio: "ignore" });
		else execSync("pkill -9 -x naia-shell 2>/dev/null || true", { stdio: "ignore", shell: "/bin/bash" });
	} catch {
		/* 미실행 — 정상 */
	}
	try {
		if (!isWin) {
			const pid = execSync("lsof -ti:1420 2>/dev/null || true", { encoding: "utf8" }).trim();
			if (pid) execSync(`kill -9 ${pid.split(/\s+/).join(" ")}`, { stdio: "ignore" });
		}
	} catch {
		/* 포트 free — 정상 */
	}
}

// ─── 2. tsc 빌드(코어 + 에이전트) ────────────────────────────────────────────
function tscBuild(dir, label) {
	if (!existsSync(resolve(dir, "package.json"))) {
		console.log(`[dev-setup] ${label} 없음(${dir}) — skip`);
		return;
	}
	console.log(`[dev-setup] ${label} tsc 빌드...`);
	try {
		execSync("npx tsc -p tsconfig.json", { cwd: dir, stdio: "inherit" });
	} catch {
		// tsc 비치명 타입오류 — old dev-setup 정책: dist 있으면 계속(dev 차단 방지).
		console.log(`[dev-setup] ${label} tsc 타입오류 — dist 있으면 계속`);
	}
}

// ─── 0. (--clean) Rust 증분캐시 삭제 ─────────────────────────────────────────
function cleanRustCache() {
	for (const d of ["target/debug/incremental", "target/debug/.fingerprint"]) {
		const p = resolve(SHELL, "src-tauri", d);
		if (existsSync(p)) {
			console.log(`[dev-setup] rm ${p}`);
			rmSync(p, { recursive: true, force: true });
		}
	}
	console.log("[dev-setup] Rust 증분캐시 삭제 완료.");
}

// ─── 실행 ────────────────────────────────────────────────────────────────────
if (cleanMode) cleanRustCache();
killStale();
tscBuild(OS_ROOT, "core(new-naia-os)");
tscBuild(AGENT, "new-naia-agent");
console.log("[dev-setup] 완료 — tauri-with-mode 로 env 주입 후 tauri dev 진입.");
