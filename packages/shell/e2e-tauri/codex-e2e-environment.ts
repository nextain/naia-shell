import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { execPath } from "node:process";

export const SHELL_DIR = resolve(import.meta.dirname, "..");
export const E2E_RUN_PARENT = resolve(
	process.env.NAIA_E2E_RUN_PARENT ?? resolve(homedir(), ".naia", "run"),
);
const E2E_WEBDRIVER_PORT = Number(
	process.env.NAIA_E2E_WEBDRIVER_PORT ?? "4450",
);
const E2E_BGM_PORT = 18_000 + (E2E_WEBDRIVER_PORT % 1_000);
// A port-scoped root prevents a delayed Windows WebView2 teardown from
// contaminating the next independent native run.
export const E2E_ROOT = resolve(
	E2E_RUN_PARENT,
	`codex-live-e2e-${E2E_WEBDRIVER_PORT}`,
);
export const E2E_WORKSPACE = resolve(E2E_ROOT, "workspace");
export const E2E_SETTINGS = resolve(E2E_WORKSPACE, "naia-settings");
export const E2E_WEBVIEW2_DATA = resolve(E2E_ROOT, "webview2");
export const E2E_ARTIFACTS = resolve(E2E_ROOT, "artifacts");
export const E2E_RUNTIME = resolve(E2E_ROOT, "runtime");
export const E2E_CONFIG_PATH = resolve(E2E_SETTINGS, "config.json");
export const E2E_UI_CONFIG_PATH = resolve(E2E_SETTINGS, "ui-config.json");
export const VITE_ENTRY = resolve(SHELL_DIR, "node_modules/vite/bin/vite.js");
// Keep Windows CMake/MSVC paths short without sharing the live Shell target.
// This must match scripts/build-e2e-tauri.mjs.
export const E2E_TARGET_DIR = resolve(
	process.env.NAIA_E2E_TARGET_DIR ??
		(process.platform === "win32"
			? "C:/tmp/naia-shell-e2e"
			: resolve(SHELL_DIR, "src-tauri", "target-e2e")),
);
const E2E_VITE_PORT = 1421;
const E2E_AVATAR_ENABLED = process.env.NAIA_E2E_AVATAR === "1";
const E2E_NVA_SOURCE = process.env.NAIA_E2E_NVA_SOURCE;

let viteServer: ChildProcess | undefined;
let e2eApp: ChildProcess | undefined;

function assertOwnedRoot(path: string): void {
	const candidate = resolve(path);
	if (
		candidate !== E2E_ROOT ||
		dirname(candidate) !== E2E_RUN_PARENT ||
		basename(candidate) !== `codex-live-e2e-${E2E_WEBDRIVER_PORT}`
	) {
		throw new Error(`Refusing to clean a non-E2E path: ${candidate}`);
	}
}

/**
 * The test owns exactly this directory. Its three consumers are isolated:
 * Shell workspace/config, WebView2 profile, and WDIO artifacts. The Tauri
 * E2E binary uses com.naia.shell.e2e, isolating native Windows app data too.
 */
export function configureCodexE2eEnvironment(): void {
	process.env.CAFE_DEBUG_E2E = "1";
	process.env.NAIA_E2E_MOCK_CLONE = "1";
	process.env.NAIA_E2E_ADK_PATH = E2E_WORKSPACE;
	process.env.NAIA_E2E_RUNTIME_DIR = E2E_RUNTIME;
	process.env.NAIA_E2E_ARTIFACTS_DIR = E2E_ARTIFACTS;
	process.env.WEBVIEW2_USER_DATA_FOLDER = E2E_WEBVIEW2_DATA;
	process.env.NAIA_E2E_DISCORD_CAPTURE = "cancel";
	process.env.NAIA_BGM_PORT = String(E2E_BGM_PORT);
	process.env.VITE_NAIA_BGM_BASE = `http://127.0.0.1:${E2E_BGM_PORT}`;
	process.env.NAIA_AGENT_SCRIPT = resolve(
		"D:/alpha-adk/projects/naia-agent-worktrees/jeonju-course-codex-env",
		"scripts/builds/agent-stdio-entry.mjs",
	);
	process.env.NAIA_AGENT_PROTO_DIR = resolve(
		"D:/alpha-adk/projects/naia-agent-worktrees/jeonju-course-codex-env",
		"src/main/adapters/grpc",
	);
}

export function resetCodexE2eRoot(): void {
	assertOwnedRoot(E2E_ROOT);
	// WebView2 may release its user-data files a few seconds after the app exits.
	// This is an owned E2E directory, so bounded retry is safe and avoids leaving
	// a failed run's profile locked for the next isolated run.
	rmSync(E2E_ROOT, {
		recursive: true,
		force: true,
		maxRetries: 20,
		retryDelay: 250,
	});
	mkdirSync(E2E_SETTINGS, { recursive: true });
	mkdirSync(E2E_WEBVIEW2_DATA, { recursive: true });
	mkdirSync(E2E_ARTIFACTS, { recursive: true });
	mkdirSync(E2E_RUNTIME, { recursive: true });
	const config = {
		provider: "codex",
		model: "gpt-5.4",
		NAIA_MAIN_PROVIDER: "codex",
		NAIA_MAIN_MODEL: "gpt-5.4",
		llmRoles: {
			main: {
				provider: "codex",
				model: "gpt-5.4",
				credentialRef: "codex-login",
			},
		},
		...(E2E_AVATAR_ENABLED
			? {
					avatarProvider: "naia-video-avatar",
					nvaModel: "naia",
					localGpuTier: "laptop-4060-8g",
					ttsProvider: "naia-local-voice",
					vllmTtsHost: "http://127.0.0.1:8910",
				}
			: {}),
	};
	if (E2E_AVATAR_ENABLED) {
		if (!E2E_NVA_SOURCE || !existsSync(E2E_NVA_SOURCE)) {
			throw new Error(
				"NAIA_E2E_AVATAR=1 requires NAIA_E2E_NVA_SOURCE pointing to a real NVA bundle",
			);
		}
		cpSync(E2E_NVA_SOURCE, resolve(E2E_SETTINGS, "nva-files", "naia"), {
			recursive: true,
		});
	}
	writeFileSync(E2E_CONFIG_PATH, JSON.stringify(config, null, 2), {
		mode: 0o600,
	});
	if (E2E_AVATAR_ENABLED) {
		writeFileSync(
			E2E_UI_CONFIG_PATH,
			JSON.stringify(
				{
					avatarProvider: "naia-video-avatar",
					nvaModel: "naia",
					localGpuTier: "laptop-4060-8g",
					ttsProvider: "naia-local-voice",
					vllmTtsHost: "http://127.0.0.1:8910",
				},
				null,
				2,
			),
			{ mode: 0o600 },
		);
	}
}

export function assertCodexE2eIsolation(): void {
	for (const path of [
		E2E_WORKSPACE,
		E2E_SETTINGS,
		E2E_WEBVIEW2_DATA,
		E2E_RUNTIME,
	]) {
		if (!existsSync(path))
			throw new Error(`E2E isolation path missing: ${path}`);
	}
	if (!existsSync(E2E_CONFIG_PATH))
		throw new Error("E2E provider config was not seeded");
}

function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
	return new Promise((resolveReady, reject) => {
		const deadline = Date.now() + timeoutMs;
		const attempt = () => {
			const socket = connect(port, "127.0.0.1");
			socket.once("connect", () => {
				socket.destroy();
				resolveReady();
			});
			socket.once("error", () => {
				socket.destroy();
				if (Date.now() >= deadline)
					reject(
						new Error(`Vite did not listen on ${port} within ${timeoutMs}ms`),
					);
				else setTimeout(attempt, 250);
			});
		};
		attempt();
	});
}

export async function startOwnedViteServer(): Promise<void> {
	// Never kill a process on the dedicated E2E port: it may be another test.
	try {
		await new Promise<void>((resolveOpen, rejectClosed) => {
			const socket = connect(E2E_VITE_PORT, "127.0.0.1");
			socket.once("connect", () => {
				socket.destroy();
				resolveOpen();
			});
			socket.once("error", () => {
				socket.destroy();
				rejectClosed(new Error("closed"));
			});
		});
		throw new Error(
			`Port ${E2E_VITE_PORT} is already in use; refusing to replace a non-E2E Vite server`,
		);
	} catch (error) {
		if (error instanceof Error && error.message !== "closed") throw error;
	}
	viteServer = spawn(
		execPath,
		[VITE_ENTRY, "--host", "127.0.0.1", "--port", String(E2E_VITE_PORT)],
		{
			cwd: SHELL_DIR,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				BROWSER: "none",
				VITE_NAIA_E2E_ADK_PATH: E2E_WORKSPACE,
				...(E2E_AVATAR_ENABLED ? {} : { VITE_NAIA_E2E_NO_AVATAR: "1" }),
				// The BGM acceptance fixture is same-origin and never contacts YouTube.
				VITE_NAIA_E2E_BGM_IFRAME_URL: "/e2e/bgm-playback-fixture.html",
			},
		},
	);
	viteServer.stderr?.on("data", (data: Buffer) =>
		process.stderr.write(`[codex-e2e:vite] ${data.toString()}`),
	);
	await waitForPort(E2E_VITE_PORT);
}

export async function startOwnedEmbeddedApp(appBinary: string): Promise<void> {
	try {
		await new Promise<void>((resolveOpen, rejectClosed) => {
			const socket = connect(E2E_WEBDRIVER_PORT, "127.0.0.1");
			socket.once("connect", () => {
				socket.destroy();
				resolveOpen();
			});
			socket.once("error", () => {
				socket.destroy();
				rejectClosed(new Error("closed"));
			});
		});
		throw new Error(
			`Port ${E2E_WEBDRIVER_PORT} is already in use; refusing to replace a non-E2E WebDriver server`,
		);
	} catch (error) {
		if (error instanceof Error && error.message !== "closed") throw error;
	}
	e2eApp = spawn(appBinary, [], {
		cwd: SHELL_DIR,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, TAURI_WEBDRIVER_PORT: String(E2E_WEBDRIVER_PORT) },
	});
	e2eApp.stderr?.on("data", (data: Buffer) =>
		process.stderr.write(`[codex-e2e:app] ${data.toString()}`),
	);
	const appExit = new Promise<never>((_, reject) => {
		e2eApp?.once("exit", (code, signal) =>
			reject(
				new Error(
					`Embedded E2E app exited before WebDriver became ready (code=${code}, signal=${signal})`,
				),
			),
		);
	});
	await Promise.race([waitForPort(E2E_WEBDRIVER_PORT, 90_000), appExit]);
}

export function stopOwnedViteServer(): void {
	if (viteServer && !viteServer.killed) viteServer.kill();
	viteServer = undefined;
}

export async function stopOwnedEmbeddedApp(): Promise<void> {
	const app = e2eApp;
	e2eApp = undefined;
	if (!app || app.killed || app.exitCode !== null) return;
	if (process.platform === "win32" && app.pid) {
		// A Tauri WebView2 process can outlive Node's child.kill(), keeping the
		// dedicated WebDriver socket and owned profile open.  This PID is created
		// by startOwnedEmbeddedApp in this run; terminate only its process tree.
		await new Promise<void>((resolveStopped) => {
			const killer = spawn(
				"taskkill.exe",
				["/pid", String(app.pid), "/t", "/f"],
				{
					stdio: "ignore",
				},
			);
			const timeout = setTimeout(resolveStopped, 5_000);
			killer.once("exit", () => {
				clearTimeout(timeout);
				resolveStopped();
			});
		});
		return;
	}
	await new Promise<void>((resolveStopped) => {
		const timeout = setTimeout(resolveStopped, 5_000);
		app.once("exit", () => {
			clearTimeout(timeout);
			resolveStopped();
		});
		app.kill();
	});
}

export function cleanupCodexE2eRoot(): void {
	assertOwnedRoot(E2E_ROOT);
	try {
		rmSync(E2E_ROOT, {
			recursive: true,
			force: true,
			maxRetries: 20,
			retryDelay: 250,
		});
	} catch (error) {
		// Do not turn a passed product UC into a false red solely because Windows
		// has not yet released this run's *owned* WebView2 files. The port-scoped
		// root makes the next run independent and the warning preserves evidence.
		process.stderr.write(
			`[codex-e2e] deferred cleanup for ${E2E_ROOT}: ${String(error)}\n`,
		);
	}
}
