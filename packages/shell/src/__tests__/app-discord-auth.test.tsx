// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../lib/config";

const listeners: Record<
	string,
	((event: { payload: any }) => void) | undefined
> = {};
const secureState = vi.hoisted(() => ({
	naiaKey: null as string | null,
	legacyNaiaKey: null as string | null,
	nativeStorePath: null as string | null,
	nativeReads: [] as Array<{
		name: string;
		expectedStorePath: string;
	}>,
}));
const tauriState = vi.hoisted(() => ({ startupMessages: [] as string[] }));
const nativeState = vi.hoisted(() => ({
	adkPathBinds: [] as string[],
	pendingAdkPathBind: null as Promise<unknown> | null,
}));
const adkState = vi.hoisted(() => ({
	config: null as Record<string, unknown> | null,
	uiConfig: null as Record<string, unknown> | null,
}));
const backgroundState = vi.hoisted(() => ({
	assets: [] as string[],
	configReadDeferred: false,
	releaseConfigRead: null as (() => void) | null,
	listNaiaAssets: vi.fn(async () => [] as string[]),
	toLocalBlobUrl: vi.fn(async (path: string) => path),
}));
const avatarConfigState = vi.hoisted(() => ({
	loadConfigWithSecrets: null as (() => Promise<AppConfig | null>) | null,
	calls: 0,
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn((name: string, cb: (event: { payload: any }) => void) => {
		listeners[name] = cb;
		return Promise.resolve(() => {
			delete listeners[name];
		});
	}),
}));

vi.mock("@tauri-apps/api/core", () => ({
	convertFileSrc: vi.fn((path: string) => path),
	invoke: vi.fn(
		(
			command: string,
			args?: {
				adkPath?: string;
				message?: string;
				name?: string;
				expectedStorePath?: string;
			},
		) => {
			if (command === "secure_store_get") {
				const name = args?.name ?? "";
				const expectedStorePath = args?.expectedStorePath ?? "";
				secureState.nativeReads.push({ name, expectedStorePath });
				return Promise.resolve(
					name === "naiaKey" &&
						expectedStorePath === secureState.nativeStorePath
						? secureState.naiaKey
						: null,
				);
			}
			if (command === "store_startup_message" && args?.message)
				tauriState.startupMessages.push(args.message);
			if (command === "write_naia_path_cache" && args?.adkPath) {
				nativeState.adkPathBinds.push(args.adkPath);
				if (nativeState.pendingAdkPathBind)
					return nativeState.pendingAdkPathBind;
			}
			return Promise.resolve(command === "detect_gpu_vram" ? 8 : null);
		},
	),
}));

// App 마운트의 secure-store migration 경로가 @tauri-apps/plugin-store `load` 를 호출한다.
// 그 내부가 Tauri core invoke 를 부르는데 jsdom 엔 __TAURI_INTERNALS__ 가 없어 *unhandled rejection*
// (secure-store.ts:16 getStore→Store.load) 4건 → 케이스는 통과해도 vitest 'Errors' → exit 1.
// ⚠️ @tauri-apps/api/core 를 mock 해도 plugin-store 가 내부에서(다른 pnpm 물리경로) core 를 import 해 안 잡힌다.
// secure-store 가 직접 import 하는 migration 경계 = plugin-store 의 load → 여기에 stub Store 를 줘 차단.
vi.mock("@tauri-apps/plugin-store", () => ({
	load: vi.fn(() =>
		Promise.resolve({
			get: vi.fn((name: string) =>
				Promise.resolve(
					name === "naiaKey" ? secureState.legacyNaiaKey : null,
				),
			),
			set: vi.fn(() => Promise.resolve()),
			delete: vi.fn(() => Promise.resolve()),
			save: vi.fn(() => Promise.resolve()),
		}),
	),
}));

// The workspace tests run without the native composition package. Keep the App
// boundary focused on startup state rather than constructing its live session.
vi.mock("../lib/environment-skill", () => ({
	ENVIRONMENT_APP_ID: "environment",
	SKILL_ENVIRONMENT: {
		name: "skill_environment",
		description: "test environment skill",
		parameters: { type: "object", properties: {} },
		tier: 1,
	},
	noteEnvironmentToolAck: vi.fn(),
	refreshEnvironment: vi.fn().mockResolvedValue(null),
}));

vi.mock("../lib/chat-service", async () => {
	const actual = await vi.importActual<typeof import("../lib/chat-service")>(
		"../lib/chat-service",
	);
	return {
		...actual,
		sendAppSkills: vi.fn().mockResolvedValue(true),
		sendAppSkillsClear: vi.fn().mockResolvedValue(true),
	};
});

vi.mock("../lib/adk-store", async () => {
	const actual = await vi.importActual<typeof import("../lib/adk-store")>(
		"../lib/adk-store",
	);
	return {
		...actual,
		readNaiaConfig: vi.fn(async () => {
			if (backgroundState.configReadDeferred) {
				return await new Promise<Record<string, unknown> | null>((resolve) => {
					backgroundState.releaseConfigRead = () => resolve(adkState.config);
				});
			}
			if (adkState.config) return adkState.config;
			const raw = globalThis.localStorage?.getItem("naia-config");
			return raw ? JSON.parse(raw) : null;
		}),
		readNaiaUiConfig: vi.fn(async () => adkState.uiConfig),
		listNaiaAssets: backgroundState.listNaiaAssets,
		toLocalBlobUrl: backgroundState.toLocalBlobUrl,
		writeNaiaConfig: vi.fn().mockResolvedValue(undefined),
		writeNaiaUiConfig: vi.fn().mockResolvedValue(undefined),
	};
});

vi.mock("../lib/config", async () => {
	const actual = await vi.importActual<typeof import("../lib/config")>(
		"../lib/config",
	);
	return {
		...actual,
		loadConfigWithSecrets: () => {
			avatarConfigState.calls += 1;
			return avatarConfigState.loadConfigWithSecrets
				? avatarConfigState.loadConfigWithSecrets()
				: actual.loadConfigWithSecrets();
		},
	};
});

vi.mock("../components/OnboardingWizard", () => ({
	OnboardingWizard: ({ onComplete }: { onComplete: () => void }) => (
		<button type="button" onClick={onComplete}>
			onboarding
		</button>
	),
}));

vi.mock("../components/AvatarCanvas", () => ({
	AvatarCanvas: () => <div>avatar</div>,
}));

vi.mock("../components/VideoAvatarCanvas", () => ({
	VideoAvatarCanvas: () => <div>video-avatar</div>,
}));

vi.mock("../components/ChatArea", () => ({
	ChatArea: () => <div>chat</div>,
}));

vi.mock("../components/TitleBar", () => ({
	TitleBar: () => <div>title</div>,
}));

// Keep this App regression focused on App's avatar sync effect. The live
// control bar performs its own config refresh and deliberately has a separate
// lifecycle, which would otherwise consume the deferred promise below.
vi.mock("../components/AiControlBar", () => ({
	AiControlBar: () => <div data-testid="ai-control-bar" />,
}));

// Mock app system to prevent built-in apps from loading Tauri APIs
vi.mock("../lib/app-loader", () => ({
	loadInstalledApps: vi.fn().mockResolvedValue(undefined),
	areInstalledAppsSettled: vi.fn().mockReturnValue(false),
	invalidateInstalledApps: vi.fn(),
	resetInstalledAppsSettled: vi.fn(),
}));
vi.mock("../lib/app-registry", () => ({
	appRegistry: {
		list: vi.fn().mockReturnValue([]),
		get: vi.fn().mockReturnValue(null),
		register: vi.fn(),
		unregister: vi.fn(),
	},
	ActiveAppBridge: class {
		pushContext = vi.fn();
		onToolCall = vi.fn().mockReturnValue(() => {});
		callTool = vi.fn().mockResolvedValue("");
	},
}));
vi.mock("../lib/active-bridge", () => ({
	activeBridge: {
		pushContext: vi.fn(),
		onToolCall: vi.fn().mockReturnValue(() => {}),
		callTool: vi.fn().mockResolvedValue(""),
	},
	getBridgeForApp: vi.fn().mockReturnValue({
		pushContext: vi.fn(),
		onToolCall: vi.fn().mockReturnValue(() => {}),
		callTool: vi.fn().mockResolvedValue(""),
	}),
}));

vi.mock("@tauri-apps/api/webview", () => ({
	getCurrentWebview: () => ({
		onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
		label: "main",
	}),
}));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		show: vi.fn().mockResolvedValue(undefined),
		onResized: vi.fn().mockResolvedValue(() => {}),
		onScaleChanged: vi.fn().mockResolvedValue(() => {}),
		setSize: vi.fn().mockResolvedValue(undefined),
		onCloseRequested: vi.fn().mockResolvedValue(() => {}),
	}),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({
	check: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
	relaunch: vi.fn().mockResolvedValue(undefined),
}));
import { App } from "../App";
import { readNaiaConfig, writeNaiaConfig } from "../lib/adk-store";
import { sendAppSkills } from "../lib/chat-service";
import { refreshEnvironment } from "../lib/environment-skill";
import { useAppStore } from "../stores/app";
import { useAvatarStore } from "../stores/avatar";

const E2E_ADK_PATH = "/adk/e2e-target";
const COLD_ADK_PATH = "/adk/complete";
const COLD_ADK_STORE_PATH = `${COLD_ADK_PATH}/data-private/secure-keys.dat`;
const PREVIOUS_ADK_PATH = "/adk/previous";
const PREVIOUS_ADK_CONFIG = {
	provider: "legacy-provider",
	model: "legacy-model",
	onboardingComplete: true,
	workspaceRoot: PREVIOUS_ADK_PATH,
	allowedTools: ["skill_app", "skill_youtube_bgm"],
};

function seedPreviousAdk(): void {
	localStorage.setItem("naia-adk-path", PREVIOUS_ADK_PATH);
	localStorage.setItem("naia-config", JSON.stringify(PREVIOUS_ADK_CONFIG));
}

function readLocalAdkConfig(): Record<string, unknown> {
	return JSON.parse(localStorage.getItem("naia-config") || "{}");
}

describe("App discord deep-link persistence", () => {
	afterEach(() => {
		cleanup();
		localStorage.clear();
		Object.keys(listeners).forEach((key) => delete listeners[key]);
		secureState.naiaKey = null;
		secureState.legacyNaiaKey = null;
		secureState.nativeStorePath = null;
		secureState.nativeReads = [];
		tauriState.startupMessages = [];
		adkState.config = null;
		adkState.uiConfig = null;
		nativeState.adkPathBinds = [];
		nativeState.pendingAdkPathBind = null;
		backgroundState.assets = [];
		backgroundState.configReadDeferred = false;
		backgroundState.releaseConfigRead = null;
		backgroundState.listNaiaAssets.mockReset();
		backgroundState.listNaiaAssets.mockImplementation(async () => backgroundState.assets);
		backgroundState.toLocalBlobUrl.mockReset();
		backgroundState.toLocalBlobUrl.mockImplementation(async (path: string) => path);
		avatarConfigState.loadConfigWithSecrets = null;
		avatarConfigState.calls = 0;
		vi.mocked(refreshEnvironment).mockClear();
		vi.mocked(sendAppSkills).mockClear();
		vi.mocked(readNaiaConfig).mockClear();
		vi.mocked(writeNaiaConfig).mockClear();
		useAppStore.setState(useAppStore.getInitialState());
	});

	it("does not register environment before a disabled cold ADK finishes hydrating", async () => {
		localStorage.setItem("naia-adk-path", "/adk/environment-off");
		backgroundState.configReadDeferred = true;
		adkState.config = {
			provider: "ollama",
			model: "e2e",
			onboardingComplete: true,
			environmentAwareness: "off",
		};

		render(<App />);

		expect(backgroundState.releaseConfigRead).toEqual(expect.any(Function));
		expect(refreshEnvironment).not.toHaveBeenCalled();
		expect(sendAppSkills).not.toHaveBeenCalledWith(
			"environment",
			expect.anything(),
			expect.anything(),
		);

		backgroundState.releaseConfigRead?.();
		await waitFor(() => {
			expect(
				JSON.parse(localStorage.getItem("naia-config") || "{}").environmentAwareness,
			).toBe("off");
		});
		expect(refreshEnvironment).not.toHaveBeenCalled();
		expect(sendAppSkills).not.toHaveBeenCalledWith(
			"environment",
			expect.anything(),
			expect.anything(),
		);
	});

	it("registers environment after a cold ADK enables awareness", async () => {
		localStorage.setItem("naia-adk-path", "/adk/environment-on");
		backgroundState.configReadDeferred = true;
		adkState.config = {
			provider: "ollama",
			model: "e2e",
			onboardingComplete: true,
			environmentAwareness: "auto",
		};

		render(<App />);

		expect(backgroundState.releaseConfigRead).toEqual(expect.any(Function));
		expect(refreshEnvironment).not.toHaveBeenCalled();
		backgroundState.releaseConfigRead?.();

		await waitFor(() => {
			expect(refreshEnvironment).toHaveBeenCalledTimes(1);
			expect(sendAppSkills).toHaveBeenCalledWith(
				"environment",
				expect.any(Array),
				expect.objectContaining({ awaitAck: true }),
			);
		});
	});

	it("waits for the ADK background preference when assets resolve first", async () => {
		const adkPath = "/adk/custom-background";
		const customBackground = `${adkPath}/naia-settings/background/custom.webp`;
		const defaultBackground = `${adkPath}/naia-settings/background/naia-dawn-city-uhd.webp`;
		localStorage.setItem("naia-adk-path", adkPath);
		backgroundState.assets = [customBackground, defaultBackground];
		backgroundState.listNaiaAssets.mockImplementation(async () => backgroundState.assets);
		backgroundState.toLocalBlobUrl.mockImplementation(async (path: string) => path);
		backgroundState.configReadDeferred = true;
		adkState.config = {
			provider: "gemini",
			model: "gemini-3-flash-preview",
			onboardingComplete: true,
			backgroundVideo: "custom.webp",
		};

		render(<App />);

		expect(backgroundState.listNaiaAssets).not.toHaveBeenCalled();
		backgroundState.releaseConfigRead?.();

		await waitFor(() => {
			expect(backgroundState.listNaiaAssets).toHaveBeenCalledWith("background");
			expect(backgroundState.toLocalBlobUrl).toHaveBeenCalledWith(customBackground);
		});
		expect(backgroundState.toLocalBlobUrl).not.toHaveBeenCalledWith(defaultBackground);
	});

	it("persists discord defaults from global listener", () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-3-flash-preview",
				apiKey: "",
				onboardingComplete: true,
			}),
		);
		render(<App />);

		expect(typeof listeners.discord_auth_complete).toBe("function");
		listeners.discord_auth_complete?.({
			payload: {
				discordUserId: "865850174651498506",
			},
		});

		const saved = JSON.parse(localStorage.getItem("naia-config") || "{}");
		expect(saved.discordDefaultUserId).toBe("865850174651498506");
		expect(saved.discordDefaultTarget).toBe("user:865850174651498506");
	});

	it("registers naia_auth_complete listener for channel sync", () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-3-flash-preview",
				apiKey: "",
				onboardingComplete: true,
			}),
		);
		render(<App />);
		expect(typeof listeners.naia_auth_complete).toBe("function");
	});

	it("does not mount stale logged-out video avatar config", async () => {
		localStorage.setItem("naia-adk-path", "C:\\naia");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-3-flash-preview",
				apiKey: "",
				onboardingComplete: true,
				avatarProvider: "naia-video-avatar",
				nvaModel: "Naia",
				cascadeRuntimeUrl: "https://stale.example:9449",
			}),
		);

		render(<App />);

		expect(screen.queryByText("video-avatar")).toBeNull();
		expect(await screen.findByText("avatar")).toBeTruthy();
	});

	it("keeps a logged-out explicit local avatar profile dormant and renders VRM", async () => {
		localStorage.setItem("naia-adk-path", "C:\\naia");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-3-flash-preview",
				apiKey: "",
				onboardingComplete: true,
				avatarProvider: "naia-video-avatar",
				nvaModel: "Naia",
				localGpuTier: "laptop-4060-8g",
			}),
		);

		render(<App />);

		expect(screen.queryByText("video-avatar")).toBeNull();
		expect(await screen.findByText("avatar")).toBeTruthy();
	});

	it("mounts the selected 8GB NVA after restoring the Naia key from secure storage", async () => {
		secureState.legacyNaiaKey = "secure-member-key";
		localStorage.setItem("naia-adk-path", "C:\\naia");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-2.5-flash-live",
				onboardingComplete: true,
				avatarProvider: "naia-video-avatar",
				nvaModel: "Naia",
				localGpuTier: "laptop-4060-8g",
				local8gFocus: "both",
			}),
		);

		render(<App />);

		expect(await screen.findByText("video-avatar")).toBeTruthy();
		expect(screen.queryByText("avatar")).toBeNull();
	});

	it("does not leave onboarding open when a cold cache restores completed ADK config", async () => {
		localStorage.setItem("naia-adk-path", "/adk/complete");
		adkState.config = {
			provider: "gemini",
			model: "gemini-3-flash-preview",
			onboardingComplete: true,
		};

		render(<App />);

		await waitFor(() => {
			expect(
				JSON.parse(localStorage.getItem("naia-config") || "{}").onboardingComplete,
			).toBe(true);
			expect(
				document.querySelector(".app-root")?.getAttribute("data-app-ready"),
			).toBe("true");
			expect(screen.queryByRole("button", { name: "onboarding" })).toBeNull();
		});
	});

	it("keeps the previous ADK cache untouched while the E2E native bind is pending", async () => {
		seedPreviousAdk();
		adkState.config = {
			provider: "new-provider",
			model: "new-model",
			onboardingComplete: true,
		};
		let releaseBind!: () => void;
		nativeState.pendingAdkPathBind = new Promise<void>((resolve) => {
			releaseBind = resolve;
		});

		render(<App />);

		await waitFor(() => {
			expect(nativeState.adkPathBinds).toEqual([E2E_ADK_PATH]);
		});
		expect(readLocalAdkConfig()).toMatchObject(PREVIOUS_ADK_CONFIG);
		expect(localStorage.getItem("naia-adk-path")).toBe(PREVIOUS_ADK_PATH);
		expect(readNaiaConfig).not.toHaveBeenCalled();
		expect(writeNaiaConfig).not.toHaveBeenCalled();
		expect(document.querySelector(".app-root")?.getAttribute("data-ui-mode")).toBe(
			"setup",
		);

		releaseBind();
		await waitFor(() => {
			expect(localStorage.getItem("naia-adk-path")).toBe(E2E_ADK_PATH);
			expect(readNaiaConfig).toHaveBeenCalledWith(E2E_ADK_PATH);
			expect(readLocalAdkConfig()).toMatchObject({
				provider: "new-provider",
				model: "new-model",
				workspaceRoot: E2E_ADK_PATH,
			});
		});
	});

	it("retains the previous ADK after a rejected E2E bind without StrictMode retries", async () => {
		seedPreviousAdk();
		let rejectBind!: (reason?: unknown) => void;
		nativeState.pendingAdkPathBind = new Promise<void>((_, reject) => {
			rejectBind = reject;
		});

		const view = render(
			<StrictMode>
				<App />
			</StrictMode>,
		);

		await waitFor(() => {
			expect(nativeState.adkPathBinds).toEqual([E2E_ADK_PATH]);
		});
		rejectBind(new Error("native bind rejected"));

		await waitFor(() => {
			expect(localStorage.getItem("naia-adk-path")).toBe(PREVIOUS_ADK_PATH);
			expect(readLocalAdkConfig()).toMatchObject(PREVIOUS_ADK_CONFIG);
			expect(
				document.querySelector(".app-root")?.getAttribute("data-ui-mode"),
			).toBe("setup");
		});

		view.rerender(
			<StrictMode>
				<App />
			</StrictMode>,
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(nativeState.adkPathBinds).toEqual([E2E_ADK_PATH]);
		expect(readNaiaConfig).not.toHaveBeenCalled();
		expect(writeNaiaConfig).not.toHaveBeenCalled();
	});

	it("does not publish a deferred avatar rejection after unmount", async () => {
		localStorage.setItem("naia-adk-path", PREVIOUS_ADK_PATH);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				...PREVIOUS_ADK_CONFIG,
				vrmModel: `${PREVIOUS_ADK_PATH}/previous.vrm`,
			}),
		);
		useAvatarStore.getState().setModelPath(`${PREVIOUS_ADK_PATH}/previous.vrm`);

		let rejectAvatarLoad!: (reason?: unknown) => void;
		const deferredAvatarLoad = new Promise<AppConfig | null>((_, reject) => {
			rejectAvatarLoad = reject;
		});
		let firstLoad = true;
		avatarConfigState.loadConfigWithSecrets = () => {
			if (firstLoad) {
				firstLoad = false;
				return deferredAvatarLoad;
			}
			return Promise.resolve({
				provider: "gemini",
				model: "gemini-3-flash-preview",
				apiKey: "",
				vrmModel: `${PREVIOUS_ADK_PATH}/hydrated.vrm`,
				onboardingComplete: true,
			});
		};

		const view = render(<App />);
		await waitFor(() => {
			expect(avatarConfigState.calls).toBeGreaterThan(0);
		});
		await waitFor(() => {
			expect(useAvatarStore.getState().modelPath).toBe(
				`${PREVIOUS_ADK_PATH}/hydrated.vrm`,
			);
		});

		const publishedPath = useAvatarStore.getState().modelPath;
		view.unmount();
		rejectAvatarLoad(new Error("deferred avatar load rejected after unmount"));
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(useAvatarStore.getState().modelPath).toBe(publishedPath);
	});

	it("hydrates the persisted TTS enabled state into the app store", async () => {
		localStorage.setItem("naia-adk-path", "/adk/complete");
		adkState.config = {
			provider: "ollama",
			model: "e2e",
			onboardingComplete: true,
			ttsEnabled: true,
		};
		useAppStore.setState({ ttsEnabled: false });

		render(<App />);

		await waitFor(() => {
			expect(useAppStore.getState().ttsEnabled).toBe(true);
		});
	});

	it("clears a stale TTS enabled state when cold ADK config disables it", async () => {
		localStorage.setItem("naia-adk-path", "/adk/complete");
		adkState.config = {
			provider: "ollama",
			model: "e2e",
			onboardingComplete: true,
			ttsEnabled: false,
		};
		useAppStore.setState({ ttsEnabled: true });

		render(<App />);

		await waitFor(() => {
			expect(useAppStore.getState().ttsEnabled).toBe(false);
		});
	});

	it("defaults TTS off when cold ADK config omits the setting", async () => {
		localStorage.setItem("naia-adk-path", "/adk/complete");
		adkState.config = {
			provider: "ollama",
			model: "e2e",
			onboardingComplete: true,
		};
		useAppStore.setState({ ttsEnabled: true });

		render(<App />);

		await waitFor(() => {
			expect(useAppStore.getState().ttsEnabled).toBe(false);
		});
	});

	it("resets TTS when a selected ADK has no config files yet", async () => {
		localStorage.setItem("naia-adk-path", "/adk/empty");
		useAppStore.setState({ ttsEnabled: true });

		render(<App />);

		await waitFor(() => {
			expect(useAppStore.getState().ttsEnabled).toBe(false);
		});
	});

	it("replays secure startup auth after cold ADK hydration", async () => {
		secureState.naiaKey = "secure-cold-key";
		secureState.nativeStorePath = COLD_ADK_STORE_PATH;
		localStorage.setItem("naia-adk-path", COLD_ADK_PATH);
		adkState.config = {
			provider: "nextain",
			model: "gemini-2.5-flash",
			onboardingComplete: true,
		};

		render(<App />);

		await waitFor(() => {
			expect(
				tauriState.startupMessages.some((message) => {
					try {
						const parsed = JSON.parse(message) as {
							type?: string;
							naiaKey?: string;
						};
						return parsed.type === "auth_update" && parsed.naiaKey === "secure-cold-key";
					} catch {
						return false;
					}
				}),
			).toBe(true);
		});

		expect(secureState.nativeReads).toContainEqual({
			name: "naiaKey",
			expectedStorePath: COLD_ADK_STORE_PATH,
		});
	});
});
