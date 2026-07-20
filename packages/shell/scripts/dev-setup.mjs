#!/usr/bin/env node
/**
 * new-naia dev-setup — `tauri dev` 전에 실행.
 *
 * 옛 old-naia-os/scripts/dev-setup.mjs 의 새-구조 이식판. 핵심 차이:
 *  - 에이전트가 **분리 repo** (`../naia-agent`) → 옛 임베디드 `../agent` + `../../naia-agent` submodule 로직 제거(obsolete).
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
const AGENT = resolve(OS_ROOT, "..", "naia-agent"); // 분리 repo
const BGM = resolve(SHELL, "..", "bgm-sidecar"); // 환경 사이드카(YouTube BGM) — dist 없으면 lib.rs 가 옛 ../agent 로 폴백

// ─── 1. stale 프로세스 정리 ──────────────────────────────────────────────────
// ⚠️ pkill -f 금지(컨테이너/무관 프로세스 오살). 정확 프로세스명(-x) + 포트 1420(vite)만.
// ★8910(cascade facade uvicorn) 추가 — Windows 강제종료 시 loader 는 죽어도 uvicorn 손자가
//   살아남아(port 점유) 다음 start_cascade 가 EADDRINUSE 로 죽는다(R2.2b). dev 반복 기동 필수 정리.
function killStale() {
	try {
		if (isWin) execSync("taskkill /F /IM naia-shell.exe 2>nul", { stdio: "ignore" });
		else execSync("pkill -9 -x naia-shell 2>/dev/null || true", { stdio: "ignore", shell: "/bin/bash" });
	} catch {
		/* 미실행 — 정상 */
	}
	// cascade 고아(uvicorn output_cascade / loader / trt / voxcpm2) — PID 미추적 손자 정리.
	try {
		if (isWin) {
			execSync(
				'powershell -NoProfile -NonInteractive -Command "Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like \'*output_cascade.app:app*\' -or $_.CommandLine -like \'*loader*launch*\' -or $_.CommandLine -like \'*trt_native_stream_server*\' -or $_.CommandLine -like \'*voxcpm2_service*\' } | ForEach-Object { $_.Terminate() }"',
				{ stdio: "ignore" },
			);
		} else {
			for (const pat of ["output_cascade.app:app", "loader.*launch", "trt_native_stream_server", "voxcpm2_service"]) {
				execSync(`pkill -f '${pat}' 2>/dev/null || true`, { stdio: "ignore", shell: "/bin/bash" });
			}
		}
	} catch {
		/* 미실행 — 정상 */
	}
	try {
		if (!isWin) {
			const pid = execSync("lsof -ti:1420 2>/dev/null || true", { encoding: "utf8" }).trim();
			if (pid) execSync(`kill -9 ${pid.split(/\s+/).join(" ")}`, { stdio: "ignore" });
		} else {
			// Windows: vite(1420)=node 라 naia-shell.exe kill 로는 안 잡힘 → 좀비 vite 가 포트 점유 시
			// 다음 dev 가 "Port 1420 is already in use" 로 죽는다. netstat 로 LISTENING PID 만 정밀 정리.
			// netstat misses the IPv6 ::1 listener in some Windows shells. Ask
			// the networking cmdlet directly so an orphaned Vite never blocks
			// the next `tauri:dev` run with a false "Port 1420 in use" error.
			const out = execSync(
				'powershell -NoProfile -NonInteractive -Command "Get-NetTCPConnection -State Listen -LocalPort 1420 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"',
				{ encoding: "utf8" },
			);
			const pids = new Set(
				out
					.split(/\s+/)
					.map((pid) => pid.trim())
					.filter((pid) => /^\d+$/.test(pid) && pid !== "0"),
			);
			for (const pid of pids) execSync(`taskkill /F /PID ${pid} 2>nul`, { stdio: "ignore" });
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
		const tsconfig = existsSync(resolve(dir, "tsconfig.build.json"))
			? "tsconfig.build.json"
			: "tsconfig.json";
		execSync(`npx tsc -p ${tsconfig}`, { cwd: dir, stdio: "inherit" });
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
tscBuild(AGENT, "naia-agent");
tscBuild(BGM, "bgm-sidecar"); // dist/bgm-server-bin.js → lib.rs 1순위 후보 적중(BGM health 복구)
console.log("[dev-setup] 완료 — tauri-with-mode 로 env 주입 후 tauri dev 진입.");
