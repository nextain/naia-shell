import { existsSync } from "node:fs";
import { transformRequest } from "./node26-request.js";
import { resolve } from "node:path";
import {
	E2E_SETTINGS,
	E2E_TARGET_DIR,
	E2E_WEBDRIVER_PORT,
	E2E_WEBVIEW2_DATA,
	assertCodexE2eIsolation,
	cleanupCodexE2eRoot,
	configureCodexE2eEnvironment,
	resetCodexE2eRoot,
	startOwnedEmbeddedApp,
	startOwnedViteServer,
	stopOwnedEmbeddedApp,
	stopOwnedViteServer,
} from "./codex-e2e-environment.js";

// Same override as codex-e2e-environment.ts — the default stays Codex.
const MAIN_PROVIDER = process.env.NAIA_E2E_MAIN_PROVIDER ?? "codex";
const MAIN_MODEL = process.env.NAIA_E2E_MAIN_MODEL ?? "gpt-5.4";

const EXE = process.platform === "win32" ? ".exe" : "";
const TAURI_BINARY =
	process.env.TAURI_BINARY ??
	resolve(E2E_TARGET_DIR, "debug", `naia-shell${EXE}`);
const VOICE_MANIFEST = {
	version: 1,
	gate: { naiaAccount: true, mode: "naia" },
	slots: {
		main: { provider: MAIN_PROVIDER, model: MAIN_MODEL },
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
};
const E2E_NAIA_KEY = process.env.NAIA_API_KEY;
if (!E2E_NAIA_KEY?.startsWith("gw-"))
	throw new Error(
		"NAIA_API_KEY must contain a paid test member gateway key",
	);
if (process.env.NAIA_E2E_VOICE_6G !== "1") {
	throw new Error("Set NAIA_E2E_VOICE_6G=1 to run the 6GB voice acceptance");
}
configureCodexE2eEnvironment("voice-6g");

export const config = {
	transformRequest,
	runner: "local" as const,
	specs: ["./specs/94-voice-6g-shell.spec.ts"],
	maxInstances: 1,
	hostname: "127.0.0.1",
	port: E2E_WEBDRIVER_PORT,
	capabilities: [
		{
			maxInstances: 1,
			browserName: "tauri",
			"wdio:enforceWebDriverClassic": true,
			pageLoadStrategy: "eager",
			"tauri:options": { application: TAURI_BINARY },
		},
	],
	logLevel: "error",
	waitforTimeout: 30_000,
	connectionRetryTimeout: 900_000,
	connectionRetryCount: 2,
	framework: "mocha",
	mochaOpts: { ui: "bdd", timeout: 900_000 },
	reporters: ["spec"],
	async onPrepare() {
		if (!existsSync(TAURI_BINARY))
			throw new Error(`Missing embedded E2E binary: ${TAURI_BINARY}`);
		resetCodexE2eRoot();
		assertCodexE2eIsolation();
		await startOwnedViteServer();
		await startOwnedEmbeddedApp(TAURI_BINARY);
	},
	async before() {
		// The native install command verifies the complete 7 GB/43k-file artifact
		// before it may reuse the already-built model and engine. Keep WebDriver's
		// async script contract above that bounded integrity check.
		await browser.setTimeout({ script: 900_000 });
		await browser.waitUntil(
			async () => {
				try {
					return await browser.execute(() =>
						document.location.href.startsWith("http"),
					);
				} catch {
					return false;
				}
			},
			{ timeout: 45_000, timeoutMsg: "Tauri webview did not reach E2E Vite" },
		);
		if (!existsSync(E2E_WEBVIEW2_DATA))
			throw new Error("isolated WebView2 profile was not created");
		// Let the first App hydration finish before seeding the isolated UI cache.
		await browser.waitUntil(
			() => browser.execute(() => document.querySelector(".app-root") !== null),
			{
				timeout: 30_000,
				timeoutMsg: "Shell app root did not render before local profile seed",
			},
		);
		await browser.pause(1_500);
		// AvatarStore reads the local cache synchronously before file hydration.
		// Seed the same isolated file-backed identity into the fresh WebView and
		// reload once so this acceptance exercises a real VRM, not an empty model.
		await browser.execute(
			(settingsRoot: string, MAIN_PROVIDER: string, MAIN_MODEL: string) => {
				localStorage.setItem(
					"naia-adk-path",
					settingsRoot.replace(/[\\/]naia-settings$/, ""),
				);
				localStorage.setItem(
					"naia-config",
					JSON.stringify({
						provider: MAIN_PROVIDER,
						model: MAIN_MODEL,
						onboardingComplete: true,
						workspaceRoot: settingsRoot.replace(/[\\/]naia-settings$/, ""),
						localVoiceEnabled: true,
						ttsProvider: "naia-local-voice",
						ttsEnabled: true,
						vllmTtsHost: "http://127.0.0.1:8910",
						avatarProvider: "vrm",
						vrmModel: `${settingsRoot}\\vrm-files\\01-OL_Woman.vrm`,
					}),
				);
			},
			E2E_SETTINGS,
			MAIN_PROVIDER,
			MAIN_MODEL,
		);
		await browser.refresh();
		await browser.waitUntil(
			() => browser.execute(() => document.querySelector(".app-root") !== null),
			{ timeout: 30_000, timeoutMsg: "Shell app root did not restore" },
		);
		await browser.pause(1_500);
		// The explicit TRT profile selects the native runtime. The secure Naia
		// member credential authorizes install/start; Cascade remains uninvolved.
		await browser.execute(
			async (settingsRoot: string, manifestJson: string, naiaKey: string) => {
				const shell = window as unknown as {
					__TAURI_INTERNALS__?: {
						invoke: (command: string, value: unknown) => Promise<unknown>;
					};
				};
				const invoke = shell.__TAURI_INTERNALS__?.invoke;
				if (!invoke) throw new Error("Tauri invoke unavailable");
				await invoke("write_slots_manifest", {
					adkPath: settingsRoot.replace(/[\\/]naia-settings$/, ""),
					json: manifestJson,
				});
				await invoke("e2e_seed_secure_naia_key", { naiaKey });
				await invoke("install_voxcpm2_runtime", {});
				await invoke("start_voxcpm2", {
					expectedLoaderProfile: "windows_trt_6g",
				});
			},
			E2E_SETTINGS,
			JSON.stringify(VOICE_MANIFEST),
			E2E_NAIA_KEY,
		);
	},
	async onComplete() {
		try {
			await stopOwnedEmbeddedApp();
			stopOwnedViteServer();
		} finally {
			cleanupCodexE2eRoot();
		}
	},
};
