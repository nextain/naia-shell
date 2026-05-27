import type { ChildProcess } from "node:child_process";
import { execSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { execPath } from "node:process";

// Enable debug logging for Tauri app — Rust logs all agent events to stderr + naia.log
process.env.CAFE_DEBUG_E2E = "1";

// Load shell/.env.e2e first (e2e-only knobs like VITE_NAIA_DEV_GATEWAY_URL),
// then shell/.env (shared defaults). first-match-wins per key so .env.e2e
// values take precedence. Keeping the dev-gateway URL out of .env is what
// prevents `pnpm run tauri:dev` from breaking a prod OAuth login (#333).
function loadEnvFile(filePath: string): void {
	try {
		const content = readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			const match = line.match(/^([^#=]+)=(.*)$/);
			if (match) {
				const key = match[1].trim();
				const rawVal = match[2].trim();
				const val = rawVal.replace(/^['"]|['"]$/g, "");
				if (!process.env[key]) process.env[key] = val;
			}
		}
	} catch {
		/* file not found — keep going */
	}
}
loadEnvFile(resolve(import.meta.dirname, "../.env.e2e"));
loadEnvFile(resolve(import.meta.dirname, "../.env"));

// ── Platform constants ────────────────────────────────────────────────────────
// Linux uses WebKit2GTK + WebKitWebDriver; Windows uses WebView2 + msedgedriver.
// Keep Linux behavior identical to the original config and branch for win32.
const IS_WINDOWS = process.platform === "win32";
const EXE = IS_WINDOWS ? ".exe" : "";

const SHELL_DIR = resolve(import.meta.dirname, "..");
const TAURI_BINARY = resolve(
	SHELL_DIR,
	`src-tauri/target/debug/naia-shell${EXE}`,
);
const TAURI_DRIVER = resolve(homedir(), `.cargo/bin/tauri-driver${EXE}`);
const NATIVE_DRIVER = IS_WINDOWS
	? resolve(SHELL_DIR, "e2e-tauri/.drivers/msedgedriver.exe")
	: "/usr/bin/WebKitWebDriver";
// Run Vite via node directly — avoids `pnpm.cmd` (which Windows' CreateProcess
// refuses to spawn without a shell, producing `spawn EINVAL`) and also avoids
// the `shell:true + args[]` DEP0190 warning introduced in Node 22.
const VITE_ENTRY = resolve(SHELL_DIR, "node_modules/vite/bin/vite.js");

let tauriDriver: ChildProcess;
let viteServer: ChildProcess;

// ── Process cleanup helpers ───────────────────────────────────────────────────

/**
 * Kill processes by image name.
 * Linux: `pkill [-9] -f <name>` (matches against full command line).
 * Windows: `taskkill /F /IM <name>.exe` (matches against image name only).
 *
 * Always swallows errors — "no such process" is the common case.
 */
function killByName(name: string, force = false): void {
	try {
		if (IS_WINDOWS) {
			const exe = name.endsWith(".exe") ? name : `${name}.exe`;
			execSync(`taskkill /F /IM ${exe}`, { stdio: "ignore" });
		} else {
			const flag = force ? "-9 " : "";
			execSync(`pkill ${flag}-f ${name} 2>/dev/null || true`, {
				stdio: "ignore",
			});
		}
	} catch {
		/* ignore — no matching processes */
	}
}

/**
 * Kill processes listening on a TCP port.
 * Linux: `lsof -ti:<port> | xargs -r kill -9`.
 * Windows: parse `netstat -ano -p tcp` and `taskkill /F /PID`.
 */
function killByPort(port: number): void {
	try {
		if (IS_WINDOWS) {
			const out = execSync("netstat -ano -p tcp", {
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			const pids = new Set<string>();
			for (const rawLine of out.split(/\r?\n/)) {
				const line = rawLine.trim();
				// e.g. "TCP    0.0.0.0:4444   0.0.0.0:0   LISTENING   12345"
				const match = line.match(/^TCP\s+\S+:(\d+)\s+\S+\s+\S+\s+(\d+)$/);
				if (match && Number(match[1]) === port) pids.add(match[2]);
			}
			for (const pid of pids) {
				try {
					execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
				} catch {
					/* ignore */
				}
			}
		} else {
			execSync(`lsof -ti:${port} | xargs -r kill -9 2>/dev/null || true`, {
				stdio: "ignore",
			});
		}
	} catch {
		/* ignore */
	}
}

/** Wait until a port is accepting connections. */
function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
	return new Promise((ok, fail) => {
		const deadline = Date.now() + timeoutMs;
		const tryConnect = () => {
			const hosts = ["127.0.0.1", "::1", "localhost"] as const;
			let attempts = hosts.length;
			let connected = false;
			for (const host of hosts) {
				const sock = connect(port, host);
				sock.once("connect", () => {
					if (connected) return;
					connected = true;
					sock.destroy();
					ok();
				});
				sock.once("error", () => {
					sock.destroy();
					attempts -= 1;
					if (connected) return;
					if (attempts > 0) return;
					if (Date.now() > deadline) {
						fail(new Error(`Port ${port} not ready within ${timeoutMs}ms`));
					} else {
						setTimeout(tryConnect, 500);
					}
				});
			}
		};
		tryConnect();
	});
}

export const config = {
	runner: "local" as const,

	specs: ["./specs/**/*.spec.ts"],
	maxInstances: 1,
	capabilities: [
		{
			maxInstances: 1,
			"tauri:options": {
				application: TAURI_BINARY,
			},
		},
	],

	logLevel: "warn",
	bail: 0,
	waitforTimeout: 30_000,
	connectionRetryTimeout: 120_000,
	connectionRetryCount: 3,

	port: 4448,
	hostname: "127.0.0.1",

	framework: "mocha",
	mochaOpts: {
		ui: "bdd",
		timeout: 180_000,
	},

	reporters: ["spec"],

	async onPrepare() {
		// Kill orphaned processes from previous runs
		killByPort(1420);
		killByPort(4448);
		killByPort(4449);
		killByName("tauri-driver");
		if (IS_WINDOWS) {
			killByName("msedgedriver");
		} else {
			killByName("WebKitWebDriver");
		}
		killByName("naia-shell");
		// Brief pause to let ports release
		await new Promise((r) => setTimeout(r, 500));

		// Start Vite dev server (debug binary loads from devUrl localhost:1420).
		viteServer = spawn(execPath, [VITE_ENTRY], {
			cwd: SHELL_DIR,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, BROWSER: "none" },
		});
		viteServer.stdout?.on("data", (d: Buffer) => {
			const line = d.toString();
			if (line.includes("error") || line.includes("Error")) {
				process.stderr.write(`[vite] ${line}`);
			}
		});
		viteServer.stderr?.on("data", (d: Buffer) =>
			process.stderr.write(`[vite:err] ${d.toString()}`),
		);
		await waitForPort(1420, 30_000);
		console.log("[e2e] Vite dev server started on :1420");
	},

	async beforeSession() {
		// Kill leftover processes from previous spec's session.
		// Each spec runs in its own worker process; we must ensure
		// ports and app processes from the previous worker are fully dead.
		killByName("naia-shell", true);
		if (!IS_WINDOWS) {
			// Linux-only: naia-node is a legacy pkill pattern for the Agent child.
			// On Windows the Agent runs as `node.exe` and is cleaned up when
			// naia-shell.exe exits (Tauri child-process lifetime).
			killByName("naia-node", true);
		}
		killByName("tauri-driver", true);
		if (IS_WINDOWS) {
			killByName("msedgedriver", true);
		} else {
			killByName("WebKitWebDriver", true);
		}
		killByPort(4448);
		killByPort(4449);
		await new Promise((r) => setTimeout(r, 1_500));

		tauriDriver = spawn(
			TAURI_DRIVER,
			[
				"--port",
				"4448",
				"--native-driver",
				NATIVE_DRIVER,
				"--native-port",
				"4449",
			],
			{ stdio: [null, process.stdout, process.stderr] },
		);
		await waitForPort(4448, 30_000);
	},

	async before() {
		// Each spec runs in its own session (fresh app).
		// On Windows/WebView2 the session returns before the webview has
		// navigated from about:blank to devUrl — touching localStorage on an
		// opaque origin throws "Access is denied". Wait until the document is
		// on an http origin AND localStorage is actually writable before any
		// spec-level hook runs. Linux/WebKitGTK already blocks on navigation
		// so this wait is a no-op there.
		await browser.waitUntil(
			async () => {
				try {
					return await browser.execute(() => {
						if (!document.location.href.startsWith("http")) return false;
						try {
							const probe = "__naia_e2e_probe__";
							localStorage.setItem(probe, "1");
							localStorage.removeItem(probe);
							return true;
						} catch {
							return false;
						}
					});
				} catch {
					return false;
				}
			},
			{
				timeout: 30_000,
				timeoutMsg:
					"webview never reached an http origin with writable localStorage",
			},
		);

		// Ensure base config is set so the app bypasses onboarding.
		const { ensureAppReady } = await import("./helpers/settings.js");
		await ensureAppReady();

		// Auto-approve permission modals globally for all specs.
		// Prevents tool-call hangs when AI tries to use a tool not yet approved.
		const { autoApprovePermissions } = await import("./helpers/permissions.js");
		autoApprovePermissions();
	},

	afterSession() {
		tauriDriver?.kill();

		// Kill ALL processes spawned by Tauri app and E2E infrastructure.
		// Without this, ports 4444/4445 stay occupied and next spec's session fails.
		if (!IS_WINDOWS) {
			killByName("naia-node");
		}
		killByName("naia-shell");
		if (IS_WINDOWS) {
			killByName("msedgedriver");
		} else {
			killByName("WebKitWebDriver");
		}
		killByName("tauri-driver");
		killByPort(4448);
		killByPort(4449);
	},

	async onComplete() {
		viteServer?.kill();
	},
};
