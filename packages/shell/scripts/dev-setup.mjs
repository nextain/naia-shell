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
import { existsSync, rmSync, writeFileSync } from "node:fs";
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

// ─── 3. 개발용 naia CLI 별칭 보장 ──────────────────────────────────────────
export function ensureDevCliAlias() {
	if (process.platform === "win32") {
		const targetDirs = [
			process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps"),
			process.env.USERPROFILE && resolve(process.env.USERPROFILE, ".cargo", "bin"),
			process.env.USERPROFILE && resolve(process.env.USERPROFILE, ".local", "bin"),
		].filter((d) => d && existsSync(d));

		const devExe = resolve(SHELL, "src-tauri", "target", "debug", "naia-shell.exe");
		const prodExe = process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, "Naia", "naia-shell.exe") : "";

		const cmdScript = `@echo off\r\nset "DEV_EXE=${devExe}"\r\nset "PROD_EXE=${prodExe}"\r\n\r\nif not "%~1"=="" if not "%~1"=="-*" (\r\n    if not exist "%~1" (\r\n        echo naia: '%~1': 파일을 찾을 수 없습니다. 1>&2\r\n    )\r\n)\r\n\r\ntasklist /FI "IMAGENAME eq naia-shell.exe" 2>NUL | find /I /N "naia-shell.exe">NUL\r\nif "%ERRORLEVEL%"=="0" (\r\n    if exist "%DEV_EXE%" (\r\n        "%DEV_EXE%" %*\r\n        exit /b %ERRORLEVEL%\r\n    )\r\n    if exist "%PROD_EXE%" (\r\n        "%PROD_EXE%" %*\r\n        exit /b %ERRORLEVEL%\r\n    )\r\n)\r\nif exist "%PROD_EXE%" (\r\n    "%PROD_EXE%" %*\r\n    exit /b %ERRORLEVEL%\r\n)\r\nif exist "%DEV_EXE%" (\r\n    netstat -ano 2>NUL | findstr /C:"127.0.0.1:1420" /C:"[::1]:1420" >NUL\r\n    if "%ERRORLEVEL%"=="0" (\r\n        "%DEV_EXE%" %*\r\n        exit /b %ERRORLEVEL%\r\n    )\r\n    echo naia: naia-shell 개발 서버(localhost:1420)가 실행 중이지 않습니다. 'pnpm run tauri:dev'를 먼저 실행해 주세요. 1>&2\r\n    exit /b 1\r\n)\r\necho naia: naia-shell 실행 파일을 찾을 수 없습니다. 1>&2\r\nexit /b 1\r\n`;

		const psScript = `[CmdletBinding()]\r\nparam(\r\n    [Parameter(ValueFromRemainingArguments = $true)]\r\n    [string[]]$Arguments\r\n)\r\nif ($Arguments.Length -gt 0 -and -not $Arguments[0].StartsWith("-")) {\r\n    if (-not (Test-Path $Arguments[0])) {\r\n        Write-Warning "naia: '$($Arguments[0])' 파일을 찾을 수 없습니다."\r\n    }\r\n}\r\n$devExe = "${devExe.replace(/\\/g, "\\\\")}"\r\n$prodExe = "${prodExe.replace(/\\/g, "\\\\")}"\r\n$running = (Get-Process naia-shell -ErrorAction SilentlyContinue | Select-Object -First 1).Path\r\nif ($running -and (Test-Path $running)) {\r\n    & $running @Arguments\r\n    exit $LASTEXITCODE\r\n}\r\nif ($prodExe -and (Test-Path $prodExe)) {\r\n    & $prodExe @Arguments\r\n    exit $LASTEXITCODE\r\n}\r\nif (Test-Path $devExe) {\r\n    $portOpen = $false\r\n    try {\r\n        $client = New-Object System.Net.Sockets.TcpClient\r\n        $iar = $client.BeginConnect("127.0.0.1", 1420, $null, $null)\r\n        if ($iar.AsyncWaitHandle.WaitOne(300, $false)) {\r\n            $client.EndConnect($iar)\r\n            $portOpen = $true\r\n        }\r\n        $client.Close()\r\n    } catch {}\r\n    if ($portOpen) {\r\n        & $devExe @Arguments\r\n        exit $LASTEXITCODE\r\n    } else {\r\n        Write-Error "naia: naia-shell 개발 서버(localhost:1420)가 실행 중이지 않습니다. 'pnpm run tauri:dev'를 먼저 실행해 주세요."\r\n        exit 1\r\n    }\r\n}\r\nWrite-Error "naia: naia-shell 실행 파일을 찾을 수 없습니다."\r\nexit 1\r\n`;

		const bashScript = `#!/usr/bin/env bash\r\nif [ -n "$1" ] && [[ "$1" != -* ]]; then\r\n    if [ ! -e "$1" ]; then\r\n        echo "naia: '$1': 파일을 찾을 수 없습니다." >&2\r\n    fi\r\nfi\r\nDEV_EXE="${devExe.replace(/\\/g, "/")}"\r\nPROD_EXE="${prodExe.replace(/\\/g, "/")}"\r\nif pgrep -x "naia-shell" >/dev/null 2>&1; then\r\n    if [ -f "$DEV_EXE" ]; then\r\n        "$DEV_EXE" "$@"\r\n        exit $?\r\n    elif [ -f "$PROD_EXE" ]; then\r\n        "$PROD_EXE" "$@"\r\n        exit $?\r\n    fi\r\nfi\r\nif [ -f "$PROD_EXE" ]; then\r\n    "$PROD_EXE" "$@"\r\n    exit $?\r\nfi\r\nif [ -f "$DEV_EXE" ]; then\r\n    if nc -z 127.0.0.1 1420 2>/dev/null || (echo > /dev/tcp/127.0.0.1/1420) 2>/dev/null; then\r\n        "$DEV_EXE" "$@"\r\n        exit $?\r\n    fi\r\n    echo "naia: naia-shell 개발 서버(localhost:1420)가 실행 중이지 않습니다. 'pnpm run tauri:dev'를 먼저 실행해 주세요." >&2\r\n    exit 1\r\nfi\r\necho "naia: naia-shell 실행 파일을 찾을 수 없습니다." >&2\r\nexit 1\r\n`;

		for (const dir of targetDirs) {
			try {
				writeFileSync(resolve(dir, "naia.cmd"), cmdScript, "utf8");
				writeFileSync(resolve(dir, "naia.ps1"), `\uFEFF${psScript}`, "utf8");
				writeFileSync(resolve(dir, "naia"), bashScript, "utf8");
			} catch {}
		}
	}
}

// ─── 실행 ────────────────────────────────────────────────────────────────────
export function main() {
	if (cleanMode) cleanRustCache();
	reportProcessOwnershipBoundary();
	ensureDevCliAlias();
	requiredTscBuild(OS_ROOT, "core(new-naia-os)");
	// paired naia-agent는 여기서 sibling checkout을 빌드하지 않는다.
	// tauri-with-mode가 commit/proto/dirty 상태를 검증한 뒤 paired checkout을 빌드한다.
	requiredTscBuild(BGM, "bgm-sidecar"); // dist/bgm-server-bin.js → lib.rs 1순위 후보 적중(BGM health 복구)
	console.log("[dev-setup] 완료 — tauri-with-mode 로 paired env 주입 후 tauri dev 진입.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
