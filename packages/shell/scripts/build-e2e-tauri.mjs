import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { voxCpm2Profile } from "./stage-voxcpm2-runtime.mjs";
import {
	parseGitWorktreePaths,
	REQUIRED_AGENT_COMMIT,
	REQUIRED_PROTO_SHA256,
	resolvePairedAgent,
	e2eTargetDir,
} from "./agent-pairing.mjs";

const shellDir = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(shellDir, "..", "..");
const manifestPath = resolve(shellDir, "src-tauri", "Cargo.toml");
// MSVC's FileTracker and CMake scratch projects still fail at ordinary
// worktree depths. Keep the *test-only* target short on Windows; callers may
// override it, and production/development targets are never reused.
// 자리 계산은 agent-pairing 이 하나로 갖는다. 여기에 다시 적으면 러너의
// 전제 검사와 갈라지고, 실제로 그 탓에 Windows 가 회귀를 못 남겼다.
const targetDir = e2eTargetDir(shellDir);
/**
 * 지난 페어링 커밋의 e2e 타깃을 지운다 (#522).
 *
 * 타깃 경로에 페어링 커밋이 들어가므로 커밋이 바뀔 때마다 새 디렉터리가 생기는데,
 * 옛것을 지우는 곳이 없었다. 커밋당 11.5GB 가 무한히 쌓여 C: 드라이브를 0GB 까지
 * 고갈시킨 사고가 실제로 있었다(2026-08-31, 4개 커밋 46GB). C: 고갈은 앱 실사용
 * 장애로 직결된다 — 같은 날 WebView2 캐시 쓰기 실패와 임시파일 오류가 함께 났다.
 *
 * 지우는 것은 test-only cargo 타깃이라 재생성 비용뿐이다. 지금 쓰는 디렉터리와
 * 호출자가 NAIA_E2E_TARGET_DIR 로 지정한 경로는 건드리지 않는다. 조용히 쌓이게
 * 두지 않으려고 회수량을 한 줄 남긴다.
 */
function pruneStaleE2ETargets(currentTarget) {
	if (process.env.NAIA_E2E_TARGET_DIR) return; // 호출자가 소유한 경로는 손대지 않는다
	if (process.platform !== "win32") return;
	const parent = "C:/tmp";
	if (!existsSync(parent)) return;

	const keep = resolve(currentTarget);
	let removed = 0;
	let bytes = 0;
	for (const entry of readdirSync(parent, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("naia-shell-e2e-")) continue;
		const path = resolve(parent, entry.name);
		if (path === keep) continue;
		try {
			bytes += directorySize(path);
			rmSync(path, { recursive: true, force: true });
			removed += 1;
		} catch (error) {
			process.stdout.write(
				`[e2e] 지난 타깃 삭제 실패 ${entry.name}: ${error instanceof Error ? error.message : error}\n`,
			);
		}
	}
	if (removed > 0) {
		const gb = bytes / 1024 ** 3;
		const size = gb >= 1 ? `${gb.toFixed(1)}GB` : `${Math.round(bytes / 1024 ** 2)}MB`;
		process.stdout.write(`[e2e] 지난 타깃 ${removed}개 삭제, ${size} 회수\n`);
	}
}

/** 삭제 전 회수량을 알기 위한 크기 합산. 실패한 항목은 0 으로 넘긴다. */
function directorySize(path) {
	let total = 0;
	const stack = [path];
	while (stack.length > 0) {
		const current = stack.pop();
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const child = resolve(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(child);
				continue;
			}
			try {
				total += statSync(child).size;
			} catch {
				// 삭제 중이거나 접근 불가 — 회수량 추정에서 빠질 뿐이다
			}
		}
	}
	return total;
}

pruneStaleE2ETargets(targetDir);

const e2eTauriConfig = resolve(shellDir, "src-tauri", "tauri.e2e.conf.json");
const bgmSidecar = resolve(shellDir, "..", "bgm-sidecar");
const primaryAgentRoot = resolve(workspaceRoot, "..", "naia-agent");
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
const pairedAgentRoot = resolve(
	process.env.NAIA_AGENT_WORKTREES_DIR ??
		resolve(workspaceRoot, "..", "..", "naia-agent-worktrees"),
);

function gitOutput(directory, args) {
	const result = spawnSync("git", ["-C", directory, ...args], {
		encoding: "utf8",
		shell: false,
	});
	return result.status === 0 ? result.stdout.trim() : null;
}

if (!existsSync(manifestPath) || !existsSync(e2eTauriConfig))
	throw new Error("Missing Tauri E2E build input");
// 탐색 범위도 실행과 같아야 한다 — 여기서 좁히면 빌드와 실행이 다른 체크아웃을
// 고를 수 있고, 그것이 #539 의 어긋남이었다.
const { pairedAgent, agentScript, agentProtoDir } = resolvePairedAgent();
// A paired checkout is intentionally clean and may not have its ignored
// dependencies materialized yet. Make the native E2E entry point reproducible
// from that state instead of reporting unrelated TypeScript "module not found"
// errors. The frozen lockfile keeps this preparation deterministic.
if (!existsSync(resolve(pairedAgent, "node_modules"))) {
	const agentInstall = spawnSync(
		"pnpm",
		["--ignore-workspace", "install", "--frozen-lockfile"],
		{
			cwd: pairedAgent,
			stdio: "inherit",
			shell: process.platform === "win32",
		},
	);
	if (agentInstall.status !== 0)
		throw new Error("The paired naia-agent dependency install failed");
}
const agentBuild = spawnSync("pnpm", ["--ignore-workspace", "run", "build"], {
	cwd: pairedAgent,
	stdio: "inherit",
	shell: process.platform === "win32",
});
if (
	agentBuild.status !== 0 ||
	!existsSync(resolve(pairedAgent, "dist", "main", "composition", "index.js"))
) {
	throw new Error(
		"The paired naia-agent build failed or did not produce dist/main/composition/index.js",
	);
}
// The native E2E binary runs in development mode, so Rust resolves the
// shell-owned BGM process from packages/bgm-sidecar/dist rather than from a
// release resource directory. That directory is gitignored and therefore
// absent in a clean worktree unless the E2E entry point builds it explicitly.
// Do not fall back to the retired packages/agent source: it is neither owned
// by this package nor present in the rebuilt workspace.
if (!existsSync(resolve(bgmSidecar, "node_modules"))) {
	const bgmInstall = spawnSync(
		"pnpm",
		["install", "--frozen-lockfile", "--filter", "@naia/bgm-sidecar"],
		{
			cwd: workspaceRoot,
			stdio: "inherit",
			shell: process.platform === "win32",
		},
	);
	if (bgmInstall.status !== 0)
		throw new Error("The shell-owned BGM sidecar dependency install failed");
}
const bgmBuild = spawnSync("pnpm", ["run", "build"], {
	cwd: bgmSidecar,
	stdio: "inherit",
	shell: process.platform === "win32",
});
if (
	bgmBuild.status !== 0 ||
	!existsSync(resolve(bgmSidecar, "dist", "bgm-server-bin.js")) ||
	!existsSync(resolve(bgmSidecar, "dist", "youtube-server.js"))
) {
	throw new Error(
		"The shell-owned BGM sidecar build failed or did not produce its runtime entry files",
	);
}
const result = spawnSync(
	cargo,
	["build", "--manifest-path", manifestPath, "--features", "webdriver-e2e"],
	{
		cwd: shellDir,
		stdio: "inherit",
		env: {
			...process.env,
			CARGO_TARGET_DIR: targetDir,
			// tauri-build consumes TAURI_CONFIG as JSON content, while
			// generate_context! receives the file path in Rust.
			TAURI_CONFIG: readFileSync(e2eTauriConfig, "utf8"),
			NAIA_AGENT_SCRIPT: agentScript,
			NAIA_AGENT_PROTO_DIR: agentProtoDir,
		},
	},
);
if (result.status !== 0) process.exit(result.status ?? 1);

// #508: the E2E debug binary resolves its resource_dir to CARGO_TARGET_DIR/
// debug. Stage the three trusted installer resources there so
// voxcpm2_installation_status / install_voxcpm2_runtime see the same contract
// files as an installed bundle instead of a phantom "not packaged" state.
const e2eVoxCpm2Bundle = resolve(targetDir, "debug", "voxcpm2-runtime");
mkdirSync(e2eVoxCpm2Bundle, { recursive: true });
// The installer is an operating-system fact, the same one the Rust side reads
// from voice_runtime::layout. Spelling "windows" here staged a PowerShell
// script next to a Linux binary, so install_voxcpm2_runtime reported the
// installer missing on this machine (#537).
const e2eInstaller = voxCpm2Profile();
copyFileSync(
	resolve(shellDir, e2eInstaller.modelPrep),
	resolve(e2eVoxCpm2Bundle, e2eInstaller.modelPrepName),
);
copyFileSync(
	resolve(shellDir, "src-tauri", "voxcpm2-activation-contract.json"),
	resolve(e2eVoxCpm2Bundle, "voxcpm2-activation-contract.json"),
);
// A staged bundle is this build's real manifest; the checked-in one is the
// Windows fallback for a tree that has not staged yet.
const e2eVoxCpm2DownloadManifest = [
	resolve(shellDir, "src-tauri", "voxcpm2-runtime", "download-manifest.json"),
	resolve(shellDir, "scripts", "voxcpm2-download-manifest.json"),
].find((candidate) => existsSync(candidate));
if (e2eVoxCpm2DownloadManifest) {
	copyFileSync(
		e2eVoxCpm2DownloadManifest,
		resolve(e2eVoxCpm2Bundle, "download-manifest.json"),
	);
}
