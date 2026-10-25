// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWebAssetsModeForTests } from "../../lib/web-runtime/web-assets";
import { AppMainContent, type AppMainContentProps } from "../AppMainContent";

const mockGetCurrentWindow = vi.hoisted(() =>
	vi.fn(() => ({
		isMaximized: vi.fn().mockResolvedValue(false),
		maximize: vi.fn(),
		unmaximize: vi.fn(),
		minimize: vi.fn(),
		close: vi.fn(),
		startDragging: vi.fn(),
	})),
);

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => mockGetCurrentWindow(),
}));

vi.mock("../AppBar", () => ({
	AppBar: () => <div data-testid="mock-app-bar" />,
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
	overrides: Partial<AppMainContentProps> = {},
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
		setShowAppInstall: vi.fn(),
		setShowUpdatePrompt: vi.fn(),
		setUpdateInfo: vi.fn(),
		showAdkSetup: false,
		showAppInstall: false,
		showOnboarding: false,
		showSplash: false,
		showUpdatePrompt: false,
		toggleNaia: vi.fn(),
		toggleRailCollapsed: vi.fn(),
		uiMode: "app",
		updateInfo: null,
		...overrides,
	};
}

describe("AppMainContent titlebar web/desktop mode", () => {
	beforeEach(() => {
		mockGetCurrentWindow.mockClear();
	});

	afterEach(() => {
		setWebAssetsModeForTests(null);
		cleanup();
	});

	it("does not render .titlebar or call getCurrentWindow in web mode (both main and setup views)", () => {
		setWebAssetsModeForTests(true);
		const { container, rerender } = render(<AppMainContent {...baseProps()} />);
		expect(container.querySelector(".titlebar")).toBeNull();
		expect(mockGetCurrentWindow).not.toHaveBeenCalled();
		expect(document.documentElement.getAttribute("data-naia-web")).toBe("true");

		rerender(<AppMainContent {...baseProps({ showAdkSetup: true })} />);
		expect(container.querySelector(".titlebar")).toBeNull();
		expect(mockGetCurrentWindow).not.toHaveBeenCalled();
	});

	it("renders .titlebar in desktop mode", () => {
		setWebAssetsModeForTests(false);
		const { container } = render(<AppMainContent {...baseProps()} />);
		expect(container.querySelector(".titlebar")).not.toBeNull();
		expect(mockGetCurrentWindow).toHaveBeenCalled();
		expect(document.documentElement.getAttribute("data-naia-web")).toBeNull();
	});
});
