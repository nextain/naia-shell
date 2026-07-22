import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const shellDir = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(shellDir, "..", "..");
const manifestPath = resolve(shellDir, "src-tauri", "Cargo.toml");
// MSVC's FileTracker and CMake scratch projects still fail at ordinary
// worktree depths. Keep the *test-only* target short on Windows; callers may
// override it, and production/development targets are never reused.
const targetDir = resolve(
	process.env.NAIA_E2E_TARGET_DIR ??
		(process.platform === "win32"
			? "C:/tmp/naia-shell-e2e"
			: resolve(shellDir, "src-tauri", "target-e2e")),
);
const e2eTauriConfig = resolve(shellDir, "src-tauri", "tauri.e2e.conf.json");
const bgmSidecar = resolve(shellDir, "..", "bgm-sidecar");
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
const pairedAgent = "D:/alpha-adk/projects/naia-agent-worktrees/jeonju-course-codex-env";
const agentScript = resolve(pairedAgent, "scripts/builds/agent-stdio-entry.mjs");
const agentProtoDir = resolve(pairedAgent, "src/main/adapters/grpc");
const REQUIRED_AGENT_COMMIT = "ae5206aa6f5504407bd3901549e3364a09ca6968";
const REQUIRED_PROTO_SHA256 = "b77761930c0991ee825b6d2827adad264fc352a9f220404912a284fc166b691b";

function gitOutput(args) {
	const result = spawnSync("git", ["-C", pairedAgent, ...args], { encoding: "utf8", shell: false });
	return result.status === 0 ? result.stdout.trim() : null;
}

function assertPairedAgent() {
	if (!existsSync(agentScript) || !existsSync(resolve(agentProtoDir, "naia_agent.proto"))) {
		throw new Error("The paired naia-agent checkout required by the Shell build is unavailable");
	}
	if (gitOutput(["rev-parse", "HEAD"]) !== REQUIRED_AGENT_COMMIT) {
		throw new Error(`The Tauri E2E build requires paired naia-agent ${REQUIRED_AGENT_COMMIT}`);
	}
	if (gitOutput(["status", "--porcelain"]) !== "") {
		throw new Error("The paired naia-agent checkout must be clean before the Tauri E2E build");
	}
	const protoHash = createHash("sha256")
		.update(readFileSync(resolve(agentProtoDir, "naia_agent.proto"), "utf8").replace(/\r\n/g, "\n"))
		.digest("hex");
	if (protoHash !== REQUIRED_PROTO_SHA256) {
		throw new Error(`The paired naia-agent proto SHA256 must be ${REQUIRED_PROTO_SHA256}`);
	}
}

if (!existsSync(manifestPath) || !existsSync(e2eTauriConfig)) throw new Error("Missing Tauri E2E build input");
assertPairedAgent();
// A paired checkout is intentionally clean and may not have its ignored
// dependencies materialized yet. Make the native E2E entry point reproducible
// from that state instead of reporting unrelated TypeScript "module not found"
// errors. The frozen lockfile keeps this preparation deterministic.
if (!existsSync(resolve(pairedAgent, "node_modules"))) {
	const agentInstall = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
		cwd: pairedAgent,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (agentInstall.status !== 0) throw new Error("The paired naia-agent dependency install failed");
}
const agentBuild = spawnSync("pnpm", ["run", "build"], {
	cwd: pairedAgent,
	stdio: "inherit",
	shell: process.platform === "win32",
});
if (agentBuild.status !== 0 || !existsSync(resolve(pairedAgent, "dist", "main", "composition", "index.js"))) {
	throw new Error("The paired naia-agent build failed or did not produce dist/main/composition/index.js");
}
// The native E2E binary runs in development mode, so Rust resolves the
// shell-owned BGM process from packages/bgm-sidecar/dist rather than from a
// release resource directory. That directory is gitignored and therefore
// absent in a clean worktree unless the E2E entry point builds it explicitly.
// Do not fall back to the retired packages/agent source: it is neither owned
// by this package nor present in the rebuilt workspace.
if (!existsSync(resolve(bgmSidecar, "node_modules"))) {
	const bgmInstall = spawnSync("pnpm", ["install", "--frozen-lockfile", "--filter", "@naia/bgm-sidecar"], {
		cwd: workspaceRoot,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (bgmInstall.status !== 0) throw new Error("The shell-owned BGM sidecar dependency install failed");
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
	throw new Error("The shell-owned BGM sidecar build failed or did not produce its runtime entry files");
}
const result = spawnSync(cargo, ["build", "--manifest-path", manifestPath, "--features", "webdriver-e2e"], {
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
});
if (result.status !== 0) process.exit(result.status ?? 1);

// tauri-plugin-stt currently stages Vosk's Windows runtime beside the default
// `src-tauri/target/debug` binary even when CARGO_TARGET_DIR is overridden.
// Mirror only those generated DLLs into our owned target so the E2E executable
// can start; never write into a developer's normal target directory.
if (process.platform === "win32") {
	const defaultDebug = resolve(shellDir, "src-tauri", "target", "debug");
	const e2eDebug = resolve(targetDir, "debug");
	for (const name of readdirSync(defaultDebug).filter((entry) => entry.toLowerCase().endsWith(".dll"))) {
		copyFileSync(resolve(defaultDebug, name), resolve(e2eDebug, name));
	}
}
