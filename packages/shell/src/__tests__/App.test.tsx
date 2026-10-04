// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSendAppSkills = vi.fn().mockResolvedValue(true);
const mockSendAppSkillsClear = vi.fn().mockResolvedValue(true);
const mockAddAllowedTool = vi.fn();
const mockFetchUnreadAnnouncements = vi.fn().mockResolvedValue([]);

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

vi.mock("../components/AppShellFrame", () => ({
	AppShellFrame: () => null,
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

vi.mock("../lib/config", () => ({
	addAllowedTool: (...args: unknown[]) => mockAddAllowedTool(...args),
	isOnboardingComplete: vi.fn().mockReturnValue(true),
	loadConfig: vi.fn().mockReturnValue({ onboardingComplete: true }),
	loadConfigWithSecrets: vi.fn().mockResolvedValue({ onboardingComplete: true }),
	mergeBootConfig: vi.fn((c) => c || { onboardingComplete: true }),
	migrateLabKeyToNaiaKey: vi.fn(),
	migrateLegacyDna3OllamaModel: vi.fn(),
	migrateLiveProviderToUnifiedModel: vi.fn(),
	migrateSpeechStyleValues: vi.fn(),
	reconcileExplicitLocalProfile: vi.fn((c) => c || {}),
	saveConfig: vi.fn(),
	isToolAllowed: vi.fn().mockReturnValue(true),
}));

vi.mock("../lib/announcements", () => ({
	fetchUnreadAnnouncements: (...args: unknown[]) => mockFetchUnreadAnnouncements(...args),
}));

vi.mock("../lib/updater", () => ({
	checkForUpdate: vi.fn().mockResolvedValue(null),
	shouldShowStartupUpdatePrompt: vi.fn().mockReturnValue(false),
}));

vi.mock("../lib/adk-store", () => ({
	beginNaiaConfigHydration: vi.fn(),
	buildNaiaConfigEnv: vi.fn(),
	completeNaiaConfigHydration: vi.fn(),
	getAdkPath: vi.fn().mockReturnValue("/test/adk"),
	isAdkInitialized: vi.fn().mockReturnValue(true),
	listNaiaAssets: vi.fn().mockResolvedValue([]),
	readNaiaConfig: vi.fn().mockResolvedValue({ onboardingComplete: true }),
	readNaiaUiConfig: vi.fn().mockResolvedValue({}),
	setAdkPath: vi.fn().mockResolvedValue(undefined),
	toLocalBlobUrl: vi.fn((p) => p),
	writeNaiaConfig: vi.fn().mockResolvedValue(undefined),
}));

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

import { App } from "../App";
import { BGM_APP_ID, SKILL_YOUTUBE_BGM } from "../lib/bgm-skill";

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
