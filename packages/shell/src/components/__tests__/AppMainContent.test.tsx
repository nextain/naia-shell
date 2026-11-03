// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWebAssetsModeForTests } from "../../lib/web-runtime/web-assets";
import { AppMainContent, mobileSheetDragHeight, type AppMainContentProps } from "../AppMainContent";
import { AppShellFrame } from "../AppShellFrame";
import { useChatStore } from "../../stores/chat";
import { useAppStore } from "../../stores/app";
import { t } from "../../lib/i18n";

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
		useChatStore.setState({ messages: [] });
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

	it("starts collapsed for an empty conversation and opens to half when messages arrive", () => {
		setWebAssetsModeForTests(true);
		const { container } = render(<AppMainContent {...baseProps({ naiaVisible: true })} />);
		const sheet = container.querySelector("[data-mobile-sheet]");
		expect(sheet?.getAttribute("data-mobile-sheet")).toBe("collapsed");
		act(() => useChatStore.setState({ messages: [{ id: "1", role: "user", content: "Hello", timestamp: 1 }] }));
		expect(sheet?.getAttribute("data-mobile-sheet")).toBe("half");
		act(() => useChatStore.setState({ messages: [] }));
		expect(sheet?.getAttribute("data-mobile-sheet")).toBe("collapsed");
	});

	it("clamps drag height to preserve the input and viewport bounds", () => {
		expect(mobileSheetDragHeight(350, 100, 800)).toBe(450);
		expect(mobileSheetDragHeight(350, -500, 800)).toBe(136);
		expect(mobileSheetDragHeight(350, 500, 800)).toBe(728);
	});

	it("shows only the speech action for the current state", () => {
		setWebAssetsModeForTests(true);
		useAppStore.setState({ ttsEnabled: false });
		render(<AppMainContent {...baseProps({ naiaVisible: true })} />);
		fireEvent.click(screen.getByRole("button", { name: "Menu" }));
		expect(screen.getByRole("button", { name: t("ai.ttsOff") })).toBeTruthy();
		expect(screen.queryByRole("button", { name: t("ai.ttsOn") })).toBeNull();
		act(() => useAppStore.setState({ ttsEnabled: true }));
		expect(screen.getByRole("button", { name: t("ai.ttsOn") })).toBeTruthy();
		expect(screen.queryByRole("button", { name: t("ai.ttsOff") })).toBeNull();
	});

	it("renders one background media layer and restores the fallback on video failure", () => {
		setWebAssetsModeForTests(true);
		const { container } = render(<AppShellFrame appReady bootComplete backgroundFallback={{ url: "/fallback.webp", type: "image" }} backgroundMediaType="video" backgroundVideoUrl="/scene.mp4" mainContent={baseProps()} onSplashDone={vi.fn()} setNaiaWidth={vi.fn()} />);
		expect(container.querySelectorAll(".app-bg-image, .app-bg-video, .app-bg-fallback")).toHaveLength(1);
		fireEvent.error(container.querySelector("video.app-bg-video")!);
		expect(container.querySelectorAll(".app-bg-image, .app-bg-video, .app-bg-fallback")).toHaveLength(1);
		expect(container.querySelector("img.app-bg-image")?.getAttribute("src")).toBe("/fallback.webp");
	});
});
