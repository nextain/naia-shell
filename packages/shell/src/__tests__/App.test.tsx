// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSendAppSkills = vi.fn().mockResolvedValue(true);
const mockSendAppSkillsClear = vi.fn().mockResolvedValue(true);
const mockAddAllowedTool = vi.fn();
const mockFetchUnreadAnnouncements = vi.fn().mockResolvedValue([]);
const mockListNaiaAssets = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string[]>>());
const mockToLocalBlobUrl = vi.hoisted(() => vi.fn<(p: string) => Promise<string>>());
const mockReadNaiaConfig = vi.hoisted(() => vi.fn<() => Promise<Record<string, unknown>>>());
const mockReadNaiaUiConfig = vi.hoisted(() => vi.fn<() => Promise<Record<string, unknown>>>());
const mockWriteNaiaConfig = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>());
const mockWriteNaiaUiConfig = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<boolean>>());

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
	emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/webview", () => ({
	getCurrentWebview: vi.fn().mockReturnValue({
		onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
	}),
}));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: vi.fn().mockReturnValue({
		show: vi.fn().mockResolvedValue(undefined),
		setFocus: vi.fn().mockResolvedValue(undefined),
		innerSize: vi.fn().mockResolvedValue({ width: 1200, height: 800 }),
		setTheme: vi.fn().mockResolvedValue(undefined),
		onCloseRequested: vi.fn().mockResolvedValue(() => {}),
	}),
}));

vi.mock("../components/AppMainContent", () => ({
	AppMainContent: () => null,
}));
vi.mock("../components/SplashScreen", () => ({
	SplashScreen: () => null,
}));
vi.mock("../components/AppBar", () => ({
	AppBar: () => null,
}));
vi.mock("../components/ChatArea", () => ({
	ChatArea: () => null,
}));
vi.mock("../components/OnboardingFlow", () => ({
	OnboardingFlow: () => null,
}));
vi.mock("../components/AdkSetup", () => ({
	AdkSetup: () => null,
}));
vi.mock("../components/AppContainer", () => ({
	AppContainer: () => null,
}));
vi.mock("../components/AvatarView", () => ({
	AvatarView: () => null,
}));
vi.mock("../components/BgmPlayer", () => ({
	BgmPlayer: () => null,
}));
vi.mock("../hooks/useAgentAuthSync", () => ({
	useAgentAuthSync: vi.fn(),
}));

vi.mock("../lib/chat-service", () => ({
	sendAppSkills: (...args: unknown[]) => mockSendAppSkills(...args),
	sendAppSkillsClear: (...args: unknown[]) => mockSendAppSkillsClear(...args),
	sendNotifyConfig: vi.fn().mockResolvedValue(true),
	fetchAgentSkills: vi.fn().mockResolvedValue([]),
	isNewCore: vi.fn().mockReturnValue(false),
}));

vi.mock("../lib/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/config")>();
	return {
		...actual,
		addAllowedTool: (...args: unknown[]) => mockAddAllowedTool(...args),
		isOnboardingComplete: vi.fn().mockReturnValue(true),
		loadConfig: vi.fn(() => {
			const raw = localStorage.getItem("naia-config");
			if (raw) {
				try {
					return JSON.parse(raw);
				} catch {
					// fall through
				}
			}
			return { onboardingComplete: true };
		}),
		loadConfigWithSecrets: vi
			.fn()
			.mockResolvedValue({ onboardingComplete: true }),
		mergeBootConfig: vi.fn((local, file, ui) =>
			actual.mergeBootConfig(local, file, ui) ??
			local ?? { onboardingComplete: true },
		),
		migrateLabKeyToNaiaKey: vi.fn(),
		migrateLegacyDna3OllamaModel: vi.fn(),
		migrateLiveProviderToUnifiedModel: vi.fn(),
		migrateSpeechStyleValues: vi.fn(),
		reconcileExplicitLocalProfile: vi.fn((c) => c || {}),
		saveConfig: vi.fn((cfg) => {
			localStorage.setItem("naia-config", JSON.stringify(cfg));
		}),
		isToolAllowed: vi.fn().mockReturnValue(true),
	};
});

vi.mock("../lib/announcements", () => ({
	fetchUnreadAnnouncements: (...args: unknown[]) => mockFetchUnreadAnnouncements(...args),
}));

vi.mock("../lib/updater", () => ({
	checkForUpdate: vi.fn().mockResolvedValue(null),
	shouldShowStartupUpdatePrompt: vi.fn().mockReturnValue(false),
}));

vi.mock("../lib/adk-store", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/adk-store")>();
	return {
		beginNaiaConfigHydration: vi.fn(),
		buildNaiaConfigEnv: vi.fn(),
		completeNaiaConfigHydration: vi.fn(),
		getAdkPath: vi.fn().mockReturnValue("/test/adk"),
		isAdkInitialized: vi.fn().mockReturnValue(true),
		listNaiaAssets: (...args: unknown[]) =>
			mockListNaiaAssets.getMockImplementation()
				? mockListNaiaAssets(...args)
				: actual.listNaiaAssets(
						args[0] as "background" | "vrm-files" | "nva-files",
					),
		readNaiaConfig: () =>
			mockReadNaiaConfig.getMockImplementation()
				? mockReadNaiaConfig()
				: Promise.resolve({ onboardingComplete: true }),
		readNaiaUiConfig: () =>
			mockReadNaiaUiConfig.getMockImplementation()
				? mockReadNaiaUiConfig()
				: Promise.resolve({}),
		setAdkPath: vi.fn().mockResolvedValue(undefined),
		toLocalBlobUrl: (p: string) =>
			mockToLocalBlobUrl.getMockImplementation()
				? mockToLocalBlobUrl(p)
				: actual.toLocalBlobUrl(p),
		writeNaiaConfig: (...args: unknown[]) =>
			mockWriteNaiaConfig.getMockImplementation()
				? mockWriteNaiaConfig(...args)
				: Promise.resolve(undefined),
		writeNaiaUiConfig: (...args: unknown[]) =>
			mockWriteNaiaUiConfig.getMockImplementation()
				? mockWriteNaiaUiConfig(...args)
				: Promise.resolve(true),
	};
});

vi.mock("../lib/app-loader", () => ({
	areInstalledAppsSettled: vi.fn().mockReturnValue(true),
	invalidateInstalledApps: vi.fn(),
	loadInstalledApps: vi.fn().mockResolvedValue([]),
}));

vi.mock("../lib/app-registry", () => ({
	appRegistry: {
		list: vi.fn().mockReturnValue([]),
		get: vi.fn().mockReturnValue(undefined),
		getApi: vi.fn().mockReturnValue(undefined),
		register: vi.fn(),
		unregister: vi.fn(),
	},
}));

vi.mock("../lib/logger", () => ({
	Logger: {
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("../lib/i18n", () => ({
	t: (k: string) => k,
	getLocale: () => "ko",
	initializeI18n: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { App, restoreStartupBackground } from "../App";
import { BGM_APP_ID, SKILL_YOUTUBE_BGM } from "../lib/bgm-skill";
import { loadConfig } from "../lib/config";
import { Logger } from "../lib/logger";
import { setWebAssetsModeForTests } from "../lib/web-runtime/web-assets";
import { useAvatarStore } from "../stores/avatar";

describe("App startup BGM skill registration, allowed tools, and announcements", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSendAppSkills.mockResolvedValue(true);
		mockSendAppSkillsClear.mockResolvedValue(true);
		mockFetchUnreadAnnouncements.mockResolvedValue([]);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllEnvs();
	});

	it("does not register BGM skill, does not allow skill_youtube_bgm, and does not fetch announcements in web mode", async () => {
		vi.stubEnv("MODE", "web");
		render(<App />);

		await waitFor(() => {
			expect(mockAddAllowedTool).toHaveBeenCalledWith("skill_app");
		});

		// BGM tool must NOT be allowed in web mode
		expect(mockAddAllowedTool).not.toHaveBeenCalledWith("skill_youtube_bgm");

		// Startup BGM skill registration must NOT be called in web mode
		expect(mockSendAppSkills).not.toHaveBeenCalledWith(BGM_APP_ID, [
			SKILL_YOUTUBE_BGM,
		]);

		// Announcements must NOT be fetched from external server in web mode
		expect(mockFetchUnreadAnnouncements).not.toHaveBeenCalled();
	});

	it("registers BGM skill, allows skill_youtube_bgm, and fetches announcements in desktop mode", async () => {
		render(<App />);

		await waitFor(() => {
			expect(mockAddAllowedTool).toHaveBeenCalledWith("skill_app");
			expect(mockAddAllowedTool).toHaveBeenCalledWith("skill_youtube_bgm");
		});

		await waitFor(() => {
			expect(mockSendAppSkills).toHaveBeenCalledWith(BGM_APP_ID, [
				SKILL_YOUTUBE_BGM,
			]);
		});

		await waitFor(() => {
			expect(mockFetchUnreadAnnouncements).toHaveBeenCalled();
		});
	});
});

describe("App startup background video restoration (r8)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockListNaiaAssets.mockReset();
		mockToLocalBlobUrl.mockReset();
		mockReadNaiaConfig.mockReset();
		mockReadNaiaUiConfig.mockReset();
		mockWriteNaiaConfig.mockReset();
		mockWriteNaiaUiConfig.mockReset();
		localStorage.clear();
		useAvatarStore.getState().setBackgroundMediaType("");
		useAvatarStore.getState().setBackgroundVideoUrl("");
	});

	afterEach(() => {
		setWebAssetsModeForTests(null);
		cleanup();
		localStorage.clear();
		vi.unstubAllEnvs();
	});

	it("restores saved live MP4 background in web mode and renders <video class='app-bg-video'> in AppShellFrame", async () => {
		setWebAssetsModeForTests(true);
		localStorage.setItem("naia-remote-key", "test-web-key");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				onboardingComplete: true,
				backgroundVideo: "naia-starlight-lake-live.mp4",
			}),
		);

		const { container } = render(<App />);

		await waitFor(() => {
			expect(useAvatarStore.getState().backgroundMediaType).toBe("video");
			expect(useAvatarStore.getState().backgroundVideoUrl).toBe(
				"/backgrounds/naia-starlight-lake-live.mp4",
			);
		});

		await waitFor(() => {
			const video = container.querySelector(
				"video.app-bg-video",
			) as HTMLVideoElement | null;
			expect(video).toBeTruthy();
			expect(video?.getAttribute("src")).toBe(
				"/backgrounds/naia-starlight-lake-live.mp4",
			);
		});
	});

	it("restores desktop background asset in desktop mode without replacing saved filename with web catalog URL", async () => {
		setWebAssetsModeForTests(false);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				onboardingComplete: true,
				backgroundVideo: "custom-desktop-bg.mp4",
			}),
		);
		mockReadNaiaUiConfig.mockImplementation(() =>
			Promise.resolve({ backgroundVideo: "custom-desktop-bg.mp4" }),
		);
		mockListNaiaAssets.mockImplementation(() =>
			Promise.resolve([
				"/test/adk/naia-settings/background/custom-desktop-bg.mp4",
			]),
		);
		mockToLocalBlobUrl.mockImplementation((p: string) =>
			Promise.resolve(`blob:${p}`),
		);

		const { container } = render(<App />);

		await waitFor(() => {
			expect(useAvatarStore.getState().backgroundMediaType).toBe("video");
			expect(useAvatarStore.getState().backgroundVideoUrl).toBe(
				"blob:/test/adk/naia-settings/background/custom-desktop-bg.mp4",
			);
		});

		const video = container.querySelector(
			"video.app-bg-video",
		) as HTMLVideoElement | null;
		expect(video).toBeTruthy();
		expect(video?.getAttribute("src")).toBe(
			"blob:/test/adk/naia-settings/background/custom-desktop-bg.mp4",
		);
		expect(video?.getAttribute("src")).not.toContain("/backgrounds/");
		expect(loadConfig()?.backgroundVideo).toBe("custom-desktop-bg.mp4");
	});

	it("restores saved live MP4 background in web mode when workspace config hydration fails with TypeError without invoking config write commands", async () => {
		setWebAssetsModeForTests(true);
		localStorage.setItem("naia-remote-key", "test-web-key");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				onboardingComplete: true,
				backgroundVideo: "naia-starlight-lake-live.mp4",
			}),
		);
		const opfsError = new TypeError(
			"undefined is not an object (evaluating 'navigator.storage.getDirectory')",
		);
		mockReadNaiaConfig.mockImplementation(() => Promise.reject(opfsError));
		mockReadNaiaUiConfig.mockImplementation(() => Promise.reject(opfsError));
		mockWriteNaiaConfig.mockImplementation(async (cfg) => {
			await invoke("write_naia_config", {
				adkPath: "/test/adk",
				json: JSON.stringify(cfg),
			});
		});
		mockWriteNaiaUiConfig.mockImplementation(async (cfg) => {
			await invoke("write_naia_ui_config", {
				adkPath: "/test/adk",
				json: JSON.stringify(cfg),
			});
			return true;
		});

		const { container, unmount } = render(<App />);

		await waitFor(() => {
			expect(Logger.error).toHaveBeenCalledWith(
				"App",
				"workspace config hydration failed",
				expect.objectContaining({
					error: expect.stringContaining("navigator.storage.getDirectory"),
				}),
			);
		});

		await waitFor(() => {
			expect(useAvatarStore.getState().backgroundMediaType).toBe("video");
			expect(useAvatarStore.getState().backgroundVideoUrl).toBe(
				"/backgrounds/naia-starlight-lake-live.mp4",
			);
		});

		await waitFor(() => {
			const video = container.querySelector(
				"video.app-bg-video",
			) as HTMLVideoElement | null;
			expect(video).toBeTruthy();
			expect(video?.getAttribute("src")).toBe(
				"/backgrounds/naia-starlight-lake-live.mp4",
			);
		});

		window.dispatchEvent(new CustomEvent("naia-config-changed"));
		unmount();

		expect(mockWriteNaiaConfig).not.toHaveBeenCalled();
		expect(mockWriteNaiaUiConfig).not.toHaveBeenCalled();
		const invokedCommands = vi.mocked(invoke).mock.calls.map((c) => c[0]);
		expect(invokedCommands).not.toContain("write_naia_config");
		expect(invokedCommands).not.toContain("write_naia_ui_config");
		expect(invokedCommands).not.toContain("write_slots_manifest");
	});

	it("does not restore startup background in desktop mode when workspace config hydration fails (desktop invariant)", async () => {
		setWebAssetsModeForTests(false);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				onboardingComplete: true,
				backgroundVideo: "naia-starlight-lake-live.mp4",
			}),
		);
		const readError = new TypeError(
			"undefined is not an object (evaluating 'navigator.storage.getDirectory')",
		);
		mockReadNaiaConfig.mockImplementation(() => Promise.reject(readError));
		mockReadNaiaUiConfig.mockImplementation(() => Promise.reject(readError));
		mockListNaiaAssets.mockImplementation(() =>
			Promise.resolve([
				"/test/adk/naia-settings/background/naia-starlight-lake-live.mp4",
			]),
		);
		mockToLocalBlobUrl.mockImplementation((p: string) =>
			Promise.resolve(`blob:${p}`),
		);
		mockWriteNaiaConfig.mockImplementation(async (cfg) => {
			await invoke("write_naia_config", {
				adkPath: "/test/adk",
				json: JSON.stringify(cfg),
			});
		});

		const { container, unmount } = render(<App />);

		await waitFor(() => {
			expect(Logger.error).toHaveBeenCalledWith(
				"App",
				"workspace config hydration failed",
				expect.anything(),
			);
		});

		await Promise.resolve();
		await Promise.resolve();

		expect(mockListNaiaAssets).not.toHaveBeenCalled();
		expect(useAvatarStore.getState().backgroundMediaType).toBe("");
		expect(useAvatarStore.getState().backgroundVideoUrl).toBe("");
		expect(container.querySelector("video.app-bg-video")).toBeNull();

		unmount();
		expect(mockWriteNaiaConfig).not.toHaveBeenCalled();
		const invokedCommands = vi.mocked(invoke).mock.calls.map((c) => c[0]);
		expect(invokedCommands).not.toContain("write_naia_config");
		expect(invokedCommands).not.toContain("write_naia_ui_config");
	});

	it("keeps only the latest background when restoreStartupBackground calls overlap", async () => {
		setWebAssetsModeForTests(true);
		let firstBlobPending = false;
		let resolveFirstBlob: (url: string) => void = () => {};
		mockToLocalBlobUrl.mockImplementation((p: string) => {
			if (p.endsWith("naia-dawn-city-uhd.webp")) {
				firstBlobPending = true;
				return new Promise<string>((resolve) => {
					resolveFirstBlob = resolve;
				});
			}
			return Promise.resolve(p);
		});

		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				onboardingComplete: true,
				backgroundVideo: "naia-dawn-city-uhd.webp",
			}),
		);
		const firstCall = restoreStartupBackground({
			setBackgroundMediaType: useAvatarStore.getState().setBackgroundMediaType,
			setBackgroundVideoUrl: useAvatarStore.getState().setBackgroundVideoUrl,
		});
		await waitFor(() => {
			expect(firstBlobPending).toBe(true);
		});

		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				onboardingComplete: true,
				backgroundVideo: "naia-starlight-lake-live.mp4",
			}),
		);
		const secondCall = restoreStartupBackground({
			setBackgroundMediaType: useAvatarStore.getState().setBackgroundMediaType,
			setBackgroundVideoUrl: useAvatarStore.getState().setBackgroundVideoUrl,
		});

		await secondCall;
		resolveFirstBlob("/backgrounds/naia-dawn-city-uhd.webp");
		await firstCall;

		expect(useAvatarStore.getState().backgroundMediaType).toBe("video");
		expect(useAvatarStore.getState().backgroundVideoUrl).toBe(
			"/backgrounds/naia-starlight-lake-live.mp4",
		);
	});
});
