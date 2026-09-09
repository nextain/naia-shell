import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { applyHarnessXdg } from "./e2e-xdg.mjs";
import { stopHarnessHerdrSession } from "./herdr-session.mjs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, resolve } from "node:path";
import { execPath } from "node:process";
// FR-VOICE.15 (#418): harness seeds come from the product config schema — a
// retired field seeded here silently disables local voice via the safety
// migration (the 2026-08-11 voice-6g incident). Type + runtime guarded.
import { buildSeedShellConfig } from "../src/lib/config-seed.js";

export const SHELL_DIR = resolve(import.meta.dirname, "..");
const pairing = JSON.parse(
	readFileSync(resolve(SHELL_DIR, "agent-pairing.json"), "utf8"),
) as { agentCommit: string };
// 실행 자리는 **OS 임시 디렉터리 아래**다 (#577).
//
// 예전에는 `~/.naia/run` 이었다. 오너 규칙은 데이터 홈에 `adk-path` 포인터 하나만
// 두는 것인데(FR-SHELL-ISO · docs/storage-locations.md), 이 전용 설정만 그 아래에
// 자기 자리를 만들었다. 그 대가는 실측으로 드러났다 — 2026-09-06 이 기계에
// `~/.naia/run/codex-live-e2e-<포트>` 일곱 자리가 사라진 뒤에도 그 자리를 물고 있던
// BGM 사이드카 여덟이 남아 있었다. 데이터 홈 게이트(check-data-home-boundary)는
// Rust 만 읽으므로 TS 하네스의 이 자리는 잡히지 않았다.
//
// 이름에 `codex-` 마디를 남기는 이유가 있다. 기본 설정은 자기 자리를
// `<tmpdir>/naia-shell-e2e-<포트>` 로 잡고 `onPrepare` 에서 그것을 통째로 지운다.
// 윈도우의 기본 설정 포트는 `4450 + (pid % 37)` 라 이 설정의 기본값 4450 과 겹칠 수
// 있다 — 이름이 같으면 기본 설정이 살아 있는 codex 실행의 자리를 지운다.
// 숫자로만 나누면 그 충돌을 막을 수 없으므로 마디로 나눈다.
export const E2E_RUN_PARENT = resolve(
	process.env.NAIA_E2E_RUN_PARENT ?? tmpdir(),
);
export const E2E_WEBDRIVER_PORT = Number(
	process.env.NAIA_E2E_WEBDRIVER_PORT ?? "4450",
);
const E2E_BGM_PORT = 18_000 + (E2E_WEBDRIVER_PORT % 1_000);
export const E2E_ROOT_NAME = `naia-shell-e2e-codex-${E2E_WEBDRIVER_PORT}`;
// A port-scoped root prevents a delayed Windows WebView2 teardown from
// contaminating the next independent native run.
export const E2E_ROOT = resolve(E2E_RUN_PARENT, E2E_ROOT_NAME);
export const E2E_WORKSPACE = resolve(E2E_ROOT, "workspace");
export const E2E_SETTINGS = resolve(E2E_WORKSPACE, "naia-settings");
export const E2E_WEBVIEW2_DATA = resolve(E2E_ROOT, "webview2");
// Tauri resolves the native config directory through APPDATA/LOCALAPPDATA.
// WebView2 alone is not enough: without this pair, a prior test can silently
// replace the seeded Codex provider with the developer's persisted E2E app
// settings.
export const E2E_APPDATA = resolve(E2E_ROOT, "appdata");
export const E2E_ARTIFACTS = resolve(E2E_ROOT, "artifacts");
export const E2E_RUNTIME = resolve(E2E_ROOT, "runtime");
export const E2E_CONFIG_PATH = resolve(E2E_SETTINGS, "config.json");
export const E2E_UI_CONFIG_PATH = resolve(E2E_SETTINGS, "ui-config.json");
export const E2E_SLOTS_MANIFEST_PATH = resolve(
	E2E_SETTINGS,
	"slots-manifest.json",
);
export const VITE_ENTRY = resolve(SHELL_DIR, "node_modules/vite/bin/vite.js");
// Keep Windows CMake/MSVC paths short without sharing the live Shell target.
// This must match scripts/build-e2e-tauri.mjs.
export const E2E_TARGET_DIR = resolve(
	process.env.NAIA_E2E_TARGET_DIR ??
		(process.platform === "win32"
			? `C:/tmp/naia-shell-e2e-${pairing.agentCommit.slice(0, 7)}`
			: resolve(SHELL_DIR, "src-tauri", "target-e2e")),
);
// Must match src-tauri/tauri.e2e.conf.json's devUrl. Keeping this explicit
// avoids a rebuilt test binary silently waiting on a different Vite server.
const E2E_VITE_PORT = 1422;
const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
const E2E_PREBAKED_NVA_ENABLED = process.env.NAIA_E2E_PREBAKED_NVA === "1";
const E2E_VOICE_6G_ENABLED = process.env.NAIA_E2E_VOICE_6G === "1";
const E2E_NVA_SOURCE =
	process.env.NAIA_E2E_NVA_SOURCE ??
	resolve(
		SHELL_DIR,
		"../../../..",
		"naia-settings",
		"nva-files",
		"naia-prebaked",
	);
const E2E_VRM_SOURCE = process.env.NAIA_E2E_VRM_SOURCE;
const PAIRED_AGENT_ROOT = resolve(
	process.env.NAIA_AGENT_WORKTREES_DIR ??
		resolve(SHELL_DIR, "../../../..", "naia-agent-worktrees"),
);
const REQUIRED_AGENT_COMMIT = pairing.agentCommit;

let viteServer: ChildProcess | undefined;
let e2eApp: ChildProcess | undefined;

function assertOwnedRoot(path: string): void {
	const candidate = resolve(path);
	if (
		candidate !== E2E_ROOT ||
		dirname(candidate) !== E2E_RUN_PARENT ||
		basename(candidate) !== E2E_ROOT_NAME
	) {
		throw new Error(`Refusing to clean a non-E2E path: ${candidate}`);
	}
}

/** Keep the spawned agent identical to the commit verified by build-e2e-tauri. */
export function resolveRequiredPairedAgent(): string {
	const explicit = process.env.NAIA_E2E_AGENT_ROOT;
	const candidates = explicit
		? [resolve(explicit)]
		: existsSync(PAIRED_AGENT_ROOT)
			? readdirSync(PAIRED_AGENT_ROOT, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => resolve(PAIRED_AGENT_ROOT, entry.name))
			: [];
	for (const candidate of candidates) {
		if (!existsSync(resolve(candidate, "scripts/builds/agent-stdio-entry.mjs")))
			continue;
		if (
			!existsSync(resolve(candidate, "src/main/adapters/grpc/naia_agent.proto"))
		)
			continue;
		try {
			if (
				execFileSync("git", ["-C", candidate, "rev-parse", "HEAD"], {
					encoding: "utf8",
				}).trim() === REQUIRED_AGENT_COMMIT &&
				// Ignore request-contract crash-recovery leases under
				// .agents/session-contracts/.recovery/ (pure runtime artifact, never
				// source). Twin of build-e2e-tauri's paired-agent clean check.
				execFileSync("git", ["-C", candidate, "status", "--porcelain"], {
					encoding: "utf8",
				})
					.split("\n")
					.filter((line) => line.trim() !== "")
					.every((line) =>
						/\.agents[\\/]session-contracts[\\/]\.recovery[\\/]/.test(line),
					)
			) {
				return candidate;
			}
		} catch {
			// Keep searching; a malformed auxiliary checkout is not an E2E candidate.
		}
	}
	throw new Error(
		`No paired naia-agent checkout contains ${REQUIRED_AGENT_COMMIT} under ${explicit ?? PAIRED_AGENT_ROOT}`,
	);
}

/**
 * The test owns exactly this directory. Its three consumers are isolated:
 * Shell workspace/config, WebView2 profile, native app data, and WDIO
 * artifacts. The Tauri E2E binary uses com.naia.shell.e2e, but that identity
 * still shares its APPDATA location unless the harness owns it explicitly.
 */
export function configureCodexE2eEnvironment(): void {
	process.env.CAFE_DEBUG_E2E = "1";
	process.env.NAIA_E2E_MODE = "1";
	process.env.NAIA_E2E_MOCK_CLONE = "1";
	process.env.NAIA_E2E_ADK_PATH = E2E_WORKSPACE;
	process.env.NAIA_E2E_RUNTIME_DIR = E2E_RUNTIME;
	// 전용 설정은 기본 wdio.conf 의 onPrepare/onComplete 를 **상속하지 않는다** —
	// 앱 프로필 격리와 herdr 세션 정리를 여기서 명시로 부른다. 안 부르면 프로필이
	// `~/.config/com.naia.shell.e2e/` 에, herdr 세션이 `~/.config/herdr/sessions/` 에
	// 남는다(2026-09-06 실측).
	applyHarnessXdg();
	process.env.NAIA_VOXCPM2_RUNTIME_ROOT = resolve(
		process.env.NAIA_E2E_VOXCPM2_RUNTIME_ROOT ??
			resolve(E2E_RUNTIME, "voxcpm2-runtime"),
	);
	process.env.NAIA_E2E_VOXCPM2_BUNDLE_ROOT ??= resolve(
		SHELL_DIR,
		"src-tauri",
		"voxcpm2-runtime",
	);
	process.env.NAIA_E2E_ARTIFACTS_DIR = E2E_ARTIFACTS;
	process.env.NAIA_E2E_SECURE_STORE_FILE = resolve(
		E2E_RUNTIME,
		"secure-keys.dat",
	);
	process.env.WEBVIEW2_USER_DATA_FOLDER = E2E_WEBVIEW2_DATA;
	process.env.APPDATA = resolve(E2E_APPDATA, "roaming");
	process.env.LOCALAPPDATA = resolve(E2E_APPDATA, "local");
	process.env.NAIA_E2E_DISCORD_CAPTURE = "cancel";
	process.env.NAIA_BGM_PORT = String(E2E_BGM_PORT);
	process.env.NAIA_REPOS_ADK ??= resolve(SHELL_DIR, "../../../..");
	process.env.NAIA_CASCADE_LOADER_DIR ??= resolve(
		process.env.NAIA_REPOS_ADK,
		"projects/naia-omni-windows-manager",
	);
	process.env.VITE_NAIA_BGM_BASE = `http://127.0.0.1:${E2E_BGM_PORT}`;
	const pairedAgent = resolveRequiredPairedAgent();
	process.env.NAIA_AGENT_SCRIPT = resolve(
		pairedAgent,
		"scripts/builds/agent-stdio-entry.mjs",
	);
	process.env.NAIA_AGENT_PROTO_DIR = resolve(
		pairedAgent,
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
	mkdirSync(E2E_APPDATA, { recursive: true });
	mkdirSync(E2E_ARTIFACTS, { recursive: true });
	mkdirSync(E2E_RUNTIME, { recursive: true });
	// 실행 자리를 비운 뒤에 만든다 — 순서가 뒤집히면 방금 만든 자리를 rmSync 가 지운다.
	for (const dir of Object.values(applyHarnessXdg() ?? {})) {
		mkdirSync(dir, { recursive: true });
	}
	const voiceVrmPath = resolve(E2E_SETTINGS, "vrm-files", "01-OL_Woman.vrm");
	if (E2E_VOICE_6G_ENABLED) {
		if (!E2E_VRM_SOURCE || !existsSync(E2E_VRM_SOURCE)) {
			throw new Error(
				"NAIA_E2E_VOICE_6G=1 requires NAIA_E2E_VRM_SOURCE pointing to a real VRM",
			);
		}
		mkdirSync(dirname(voiceVrmPath), { recursive: true });
		cpSync(E2E_VRM_SOURCE, voiceVrmPath);
	}
	const mainProvider = process.env.NAIA_E2E_MAIN_PROVIDER ?? "codex";
	const mainModel = process.env.NAIA_E2E_MAIN_MODEL ?? DEFAULT_CODEX_MODEL;
	const config = buildSeedShellConfig({
		provider: mainProvider,
		model: mainModel,
		...(E2E_VOICE_6G_ENABLED
			? {
					localVoiceEnabled: true,
					ttsProvider: "naia-local-voice" as const,
					ttsEnabled: true,
					vllmTtsHost: "http://127.0.0.1:8910",
					avatarProvider: "vrm" as const,
					vrmModel: voiceVrmPath,
				}
			: {}),
		...(E2E_PREBAKED_NVA_ENABLED
			? {
					onboardingComplete: true,
					workspaceRoot: E2E_WORKSPACE,
					avatarProvider: "naia-video-avatar" as const,
					nvaModel: "naia-prebaked",
				}
			: {}),
	});
	if (E2E_PREBAKED_NVA_ENABLED) {
		if (!E2E_NVA_SOURCE || !existsSync(E2E_NVA_SOURCE)) {
			throw new Error(
				"NAIA_E2E_PREBAKED_NVA=1 requires NAIA_E2E_NVA_SOURCE pointing to a real pre-baked NVA bundle",
			);
		}
		cpSync(
			E2E_NVA_SOURCE,
			resolve(E2E_SETTINGS, "nva-files", "naia-prebaked"),
			{
				recursive: true,
			},
		);
	}
	writeFileSync(E2E_CONFIG_PATH, JSON.stringify(config, null, 2), {
		mode: 0o600,
	});
	if (E2E_VOICE_6G_ENABLED) {
		writeFileSync(
			E2E_SLOTS_MANIFEST_PATH,
			JSON.stringify(
				{
					version: 1,
					gate: { naiaAccount: true, mode: "naia" },
					slots: {
						main: { provider: mainProvider, model: mainModel },
						sub: { provider: "none" },
						embedding: { provider: "none" },
						stt: {},
						tts: { provider: "naia-local-voice" },
						avatar: { provider: "vrm" },
					},
					gpu: {
						detectedVramGb: 8,
						tier: "windows-voice-6g",
						loaderProfile: "windows_trt_6g",
					},
				},
				null,
				2,
			),
			{ mode: 0o600 },
		);
		writeFileSync(
			E2E_UI_CONFIG_PATH,
			JSON.stringify(
				buildSeedShellConfig({
					avatarProvider: "vrm",
					vrmModel: voiceVrmPath,
					localVoiceEnabled: true,
					ttsProvider: "naia-local-voice",
					ttsEnabled: true,
					vllmTtsHost: "http://127.0.0.1:8910",
				}),
				null,
				2,
			),
			{ mode: 0o600 },
		);
	}
	if (E2E_PREBAKED_NVA_ENABLED) {
		writeFileSync(
			E2E_UI_CONFIG_PATH,
			JSON.stringify(
				buildSeedShellConfig({
					avatarProvider: "naia-video-avatar",
					nvaModel: "naia-prebaked",
				}),
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
		E2E_APPDATA,
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
				VITE_NAIA_SECURE_STORE_FILE: process.env.NAIA_E2E_SECURE_STORE_FILE,
				VITE_NAIA_E2E_MODE: "1",
				VITE_NAIA_NEW_CORE: "1",
				BROWSER: "none",
				VITE_NAIA_E2E_ADK_PATH: E2E_WORKSPACE,
				// Same override the seeded shell config honours, so the webview and
				// the file-backed config never disagree about the main provider.
				VITE_NAIA_E2E_PROVIDER: process.env.NAIA_E2E_MAIN_PROVIDER ?? "codex",
				VITE_NAIA_E2E_MODEL:
					process.env.NAIA_E2E_MAIN_MODEL ?? DEFAULT_CODEX_MODEL,
				...(E2E_PREBAKED_NVA_ENABLED || E2E_VOICE_6G_ENABLED
					? {}
					: { VITE_NAIA_E2E_NO_AVATAR: "1" }),
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

function embeddedAppEnvironment(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		TAURI_WEBDRIVER_PORT: String(E2E_WEBDRIVER_PORT),
	};
	if (process.platform !== "linux") return environment;
	const buildDir = resolve(E2E_TARGET_DIR, "debug", "build");
	const voskDir = existsSync(buildDir)
		? readdirSync(buildDir)
				.filter((name) => name.startsWith("tauri-plugin-stt-"))
				.map((name) => resolve(buildDir, name, "out", "vosk-lib"))
				.find((path) => existsSync(resolve(path, "libvosk.so")))
		: undefined;
	if (voskDir) {
		environment.LD_LIBRARY_PATH = [voskDir, environment.LD_LIBRARY_PATH]
			.filter(Boolean)
			.join(delimiter);
	}
	return environment;
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
		env: embeddedAppEnvironment(),
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
	stopHarnessHerdrSession(process.env.NAIA_E2E_RUNTIME_DIR, spawnSync);
	// A red E2E run otherwise removes the only durable Agent record before the
	// failure can be classified. This opt-in is intentionally test-only and
	// preserves only the port-scoped root owned by this harness; normal runs
	// retain their clean-room cleanup guarantee.
	if (process.env.NAIA_E2E_KEEP_ARTIFACTS === "1") {
		process.stderr.write(
			`[codex-e2e] preserving owned diagnostics at ${E2E_ROOT}\n`,
		);
		return;
	}
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
