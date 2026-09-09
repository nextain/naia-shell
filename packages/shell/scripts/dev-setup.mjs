#!/usr/bin/env node
/**
 * new-naia dev-setup — `tauri dev` 전에 실행.
 *
 * 옛 old-naia-os/scripts/dev-setup.mjs 의 새-구조 이식판. 핵심 차이:
 *  - 에이전트가 **분리 repo** (`../naia-agent`) → 옛 임베디드 `../agent` + `../../naia-agent` submodule 로직 제거(obsolete).
 *  - 코어(`new-naia-os` 루트, 헥사고날 src/main)와 BGM 사이드카를 tsc 빌드.
 *  - paired naia-agent 선택/빌드는 tauri-with-mode.mjs가 담당한다. 이 스크립트는
 *    sibling checkout을 임의로 빌드하지 않는다.
 *
 * 책임: ① 기존 프로세스를 보존한다는 사실을 알림 ② 코어/BGM tsc 빌드
 * ③ (--clean) Rust 증분캐시 삭제.
 * 플랫폼 env(GDK_BACKEND 등)는 spawn 시점이라 tauri-with-mode.mjs 가 주입.
 */
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cleanMode = process.argv.includes("--clean");

const HERE = import.meta.dirname; // packages/shell/scripts
const SHELL = resolve(HERE, ".."); // packages/shell
const OS_ROOT = resolve(SHELL, "..", ".."); // new-naia-os (코어)
const BGM = resolve(SHELL, "..", "bgm-sidecar"); // 환경 사이드카(YouTube BGM) — dist 없으면 lib.rs 가 옛 ../agent 로 폴백

// ─── 1. 프로세스 소유권 경계 ────────────────────────────────────────────────
// dev-setup은 Shell PID/시작 identity와 child record를 소유하지 않는다. 따라서
// 기존 프로세스나 포트 보유자를 "stale"로 추정하여 종료하지 않고, 다음 계층이
// 자기 소유 기록을 확인하게 둔다. 이 보수적 정책은 병렬 세션을 보존한다.
export function reportProcessOwnershipBoundary() {
	console.log(
		"[dev-setup] process cleanup skipped: ownership is not proven; existing processes and listeners are preserved.",
	);
}

// ─── 2. tsc 빌드(코어 + BGM) ─────────────────────────────────────────────────
export function tscBuild(dir, label, runTsc = execSync) {
	if (!existsSync(resolve(dir, "package.json"))) {
		console.log(`[dev-setup] ${label} 없음(${dir}) — skip`);
		return false;
	}
	console.log(`[dev-setup] ${label} tsc 빌드...`);
	try {
		const tsconfig = existsSync(resolve(dir, "tsconfig.build.json"))
			? "tsconfig.build.json"
			: "tsconfig.json";
		runTsc(`npx --no-install tsc -p ${tsconfig}`, { cwd: dir, stdio: "inherit" });
	} catch (error) {
		console.error(`[dev-setup] ${label} tsc 실패 — 후속 실행을 중단합니다.`);
		throw error;
	}
	return true;
}

export function requiredTscBuild(dir, label, runTsc = execSync) {
	if (!tscBuild(dir, label, runTsc)) {
		throw new Error(`[dev-setup] ${label} package.json 없음 — 빌드를 중단합니다.`);
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
export function main() {
	if (cleanMode) cleanRustCache();
	reportProcessOwnershipBoundary();
	requiredTscBuild(OS_ROOT, "core(new-naia-os)");
	// paired naia-agent는 여기서 sibling checkout을 빌드하지 않는다.
	// tauri-with-mode가 commit/proto/dirty 상태를 검증한 뒤 paired checkout을 빌드한다.
	requiredTscBuild(BGM, "bgm-sidecar"); // dist/bgm-server-bin.js → lib.rs 1순위 후보 적중(BGM health 복구)
	console.log("[dev-setup] 완료 — tauri-with-mode 로 paired env 주입 후 tauri dev 진입.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
