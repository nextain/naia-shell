// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDistributionChannelForTests } from "../../lib/distribution";
import { resetUiPreferencesForTests } from "../../lib/ui-preferences";
import { setWebAssetsModeForTests } from "../../lib/web-runtime/web-assets";
import { useAppStore } from "../../stores/app";
import { useChatStore } from "../../stores/chat";
import { AppMainContent, type AppMainContentProps } from "../AppMainContent";

const { mockInvoke } = vi.hoisted(() => ({
	mockInvoke: vi.fn().mockResolvedValue([]),
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
	convertFileSrc: vi.fn((path: string) => `file://${path}`),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
	emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		isMaximized: vi.fn().mockResolvedValue(false),
		maximize: vi.fn(),
		unmaximize: vi.fn(),
		minimize: vi.fn(),
		close: vi.fn(),
		startDragging: vi.fn(),
	}),
}));

vi.mock("../AiControlBar", () => ({
	AiControlBar: () => <div data-testid="mock-ai-control-bar" />,
}));
vi.mock("../DeferredChatArea", () => ({
	DeferredChatArea: () => <div data-testid="mock-chat-area" />,
}));
vi.mock("../DeferredAdkSetupScreen", () => ({
	DeferredAdkSetupScreen: () => <div data-testid="mock-adk-setup" />,
}));
vi.mock("../DeferredOnboardingWizard", () => ({
	DeferredOnboardingWizard: () => <div data-testid="mock-onboarding" />,
}));
vi.mock("../AvatarCanvas", () => ({
	AvatarCanvas: () => <div data-testid="mock-avatar-canvas" />,
}));
vi.mock("../VideoAvatarCanvas", () => ({
	VideoAvatarCanvas: () => <div data-testid="mock-video-avatar-canvas" />,
}));

function baseProps(
	showAppInstall: boolean,
	setShowAppInstall: AppMainContentProps["setShowAppInstall"],
): AppMainContentProps {
	return {
		activeApp: null,
		announcements: [],
		appInstallRequest: null,
		appTitle: "Naia",
		avatarProvider: "vrm",
		chatModeOverride: "app",
		chatDragRef: { current: null },
		chatHeight: 280,
		chatVisible: true,
		configSaveError: null,
		handleNaiaWidthPointerDown: vi.fn(),
		handleNaiaWidthPointerMove: vi.fn(),
		handleNaiaWidthPointerUp: vi.fn(),
		naiaVisible: false,
		naiaWidth: 320,
		nvaModel: "naia",
		onAdkSetupComplete: vi.fn(),
		onOnboardingComplete: vi.fn(),
		railCollapsed: false,
		setAnnouncements: vi.fn(),
		setAppInstallRequest: vi.fn(),
		setChatHeight: vi.fn(),
		setChatMode: vi.fn(),
		setChatVisible: vi.fn(),
		setShowAppInstall,
		setShowUpdatePrompt: vi.fn(),
		setUpdateInfo: vi.fn(),
		showAdkSetup: false,
		showAppInstall,
		showOnboarding: false,
		showSplash: false,
		showUpdatePrompt: false,
		toggleNaia: vi.fn(),
		toggleRailCollapsed: vi.fn(),
		uiMode: "app",
		updateInfo: null,
	};
}

function Harness() {
	const [showAppInstall, setShowAppInstall] = useState(false);
	return <AppMainContent {...baseProps(showAppInstall, setShowAppInstall)} />;
}

describe("R7 kiosk demo AppBar -> AppInstallDialog wiring", () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		mockInvoke.mockReset();
		mockInvoke.mockResolvedValue([]);
		resetUiPreferencesForTests();
		resetDistributionChannelForTests();
		useChatStore.setState(useChatStore.getInitialState());
		useAppStore.setState(useAppStore.getInitialState());
	});

	afterEach(() => {
		cleanup();
		setWebAssetsModeForTests(null);
		vi.unstubAllEnvs();
		localStorage.clear();
		sessionStorage.clear();
	});

	it("opens and closes AppInstallDialog when clicking App Store button in kiosk demo", async () => {
		setWebAssetsModeForTests(true);
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");

		const { container } = render(<Harness />);

		const storeButton = await screen.findByRole("button", {
			name: /App Store|앱 스토어|appbar\.appStore/i,
		});
		fireEvent.click(storeButton);

		await waitFor(() => {
			expect(container.querySelector(".app-install-overlay")).not.toBeNull();
			expect(container.querySelector(".app-install-dialog")).not.toBeNull();
		});
		expect(container.querySelector("#git-url-input")).not.toBeNull();
		expect(mockInvoke).not.toHaveBeenCalledWith(
			"focus_or_create_app_store_window",
			expect.anything(),
		);

		fireEvent.click(container.querySelector(".app-install-close")!);
		await waitFor(() => {
			expect(container.querySelector(".app-install-overlay")).toBeNull();
		});
	});
});
