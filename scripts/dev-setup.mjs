#!/usr/bin/env node
/**
 * Cross-platform dev setup — runs before `cargo tauri dev`.
 *
 * 1. Kill stale naia-shell processes
 * 2. Install gateway if missing
 * 3. Build agent
 *
 * Platform-specific logic is isolated in the `platform` object.
 * To add macOS: add a "darwin" key.
 */

import { execSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { resolve } from "node:path";

const cleanMode = process.argv.includes("--clean");

const isWin = platform() === "win32";
const isMac = platform() === "darwin";
const isLinux = platform() === "linux";

// ─── 1. Kill stale processes ─────────────────────────────────────────────────

function killStale() {
	try {
		if (isWin) {
			execSync('taskkill /F /IM naia-shell.exe 2>nul', { stdio: "ignore" });
		} else {
			execSync("pkill -9 -x naia-shell", { stdio: "ignore" });
		}
	} catch { /* not running — fine */ }

	try {
		if (isWin) {
			// Kill orphaned vite (node.exe) holding port 1420 after a crashed
			// tauri:dev — single-instance mutex only covers naia-shell.exe, not
			// vite child started by the beforeDevCommand.
			// Note: no `-p TCP` — that filter is IPv4-only on Windows, and vite
			// binds to [::1]:1420 (IPv6) which would be silently missed.
			const out = execSync("netstat -ano", { encoding: "utf8" });
			const pids = new Set();
			for (const line of out.split(/\r?\n/)) {
				const m = line.match(/(?:\[::1\]|127\.0\.0\.1):1420\s.*LISTENING\s+(\d+)/);
				if (m) pids.add(m[1]);
			}
			for (const pid of pids) {
				execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
			}
		} else {
			const pid = execSync("lsof -ti:1420", { encoding: "utf8" }).trim();
			if (pid) execSync(`kill -9 ${pid}`, { stdio: "ignore" });
		}
	} catch { /* port free — fine */ }
}

// ─── 2. Gateway install check ────────────────────────────────────────────────

function ensureGateway() {
	const gatewayPath = join(
		homedir(),
		".naia/openclaw/node_modules/openclaw/openclaw.mjs",
	);
	if (!existsSync(gatewayPath)) {
		console.log("[Naia] Gateway not installed — running install-gateway.sh...");
		execSync("bash ../scripts/install-gateway.sh", { stdio: "inherit" });
	}
}

// ─── 3. Agent build ──────────────────────────────────────────────────────────

function buildAgent() {
	const agentDir = resolve("../agent");
	execSync("pnpm install", {
		cwd: agentDir,
		stdio: "inherit",
		env: { ...process.env, CI: "true" },
	});
	try {
		execSync("pnpm build", { cwd: agentDir, stdio: "inherit" });
	} catch {
		// tsc may fail on non-critical type errors — check if dist exists
		if (existsSync(join(agentDir, "dist", "index.js"))) {
			console.log("[dev-setup] Agent build had type errors but dist exists — continuing");
		} else {
			throw new Error("Agent build failed and no dist found");
		}
	}
}

// ─── 3b. naia-agent submodule build ──────────────────────────────────────────
//
// spawn_agent_core (shell/src-tauri/src/lib.rs:912-928) PREFERS the
// standalone `projects/naia-agent` submodule over `naia-os/agent` (legacy
// embedded). When upstream pushes new exports (e.g. `isEnglishLocale` added
// 2026-05-28 with the RunPod Tier B work in commit 53917e5), the user's
// local `packages/*/dist/` becomes stale and `bin/naia-agent.ts` throws
// `SyntaxError: ... does not provide an export named 'isEnglishLocale'`,
// causing tauri:dev to enter an agent-restart loop.
//
// Fix: install + build the submodule too. No prune step — the submodule
// uses tsc-based workspace builds, so devDeps must stay for the next run.
function buildNaiaAgentSubmodule() {
	const submoduleDir = resolve("../../naia-agent");
	if (!existsSync(submoduleDir)) {
		console.log("[dev-setup] naia-agent submodule not present — skip");
		return;
	}
	console.log("[dev-setup] Installing + building naia-agent submodule...");
	execSync("pnpm install", {
		cwd: submoduleDir,
		stdio: "inherit",
		env: { ...process.env, CI: "true" },
	});
	try {
		execSync("pnpm build", { cwd: submoduleDir, stdio: "inherit" });
	} catch {
		const runtimeDist = join(
			submoduleDir,
			"packages",
			"runtime",
			"dist",
			"index.js",
		);
		if (existsSync(runtimeDist)) {
			console.log(
				"[dev-setup] naia-agent submodule build had type errors but runtime dist exists — continuing",
			);
		} else {
			throw new Error("naia-agent submodule build failed and no runtime dist found");
		}
	}
}

// ─── 4. Platform env ─────────────────────────────────────────────────────────

function setPlatformEnv() {
	if (isLinux) {
		// Tauri WebKitGTK needs X11 for XReparentWindow browser embedding
		process.env.GDK_BACKEND = "x11";
	}
}

// ─── 5. Deep link handler → dev build ───────────────────────────────────────

function setDevDeepLinkHandler() {
	if (!isLinux) return;
	const desktopFile = join(homedir(), ".local/share/applications/naia-shell-handler.desktop");
	const debugBin = resolve("../shell/src-tauri/target/debug/naia-shell");
	const content = `[Desktop Entry]\nType=Application\nName=Naia Deep Link Handler\nExec="${debugBin}" %u\nMimeType=x-scheme-handler/naia;\nNoDisplay=true\n`;
	try {
		writeFileSync(desktopFile, content);
		execSync("update-desktop-database ~/.local/share/applications/ 2>/dev/null", { stdio: "ignore" });
		console.log("[dev-setup] Deep link handler → dev build");
	} catch { /* non-critical */ }
}

// ─── 0. Clean Rust incremental cache ─────────────────────────────────────────

function cleanRustCache() {
	const tauriDir = resolve("src-tauri");
	const dirs = [
		join(tauriDir, "target", "debug", "incremental"),
		join(tauriDir, "target", "debug", ".fingerprint"),
	];
	for (const dir of dirs) {
		if (existsSync(dir)) {
			console.log(`[dev-setup] Removing ${dir}`);
			rmSync(dir, { recursive: true, force: true });
		}
	}
	console.log("[dev-setup] Rust incremental cache cleared.");
}

// ─── Run ─────────────────────────────────────────────────────────────────────

if (cleanMode) cleanRustCache();
killStale();
ensureGateway();
buildAgent();
buildNaiaAgentSubmodule();
setPlatformEnv();
await setDevDeepLinkHandler();
