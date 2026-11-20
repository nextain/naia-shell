// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRegistry } from "../../lib/app-registry";
import {
	clearCameraActions,
	registerCameraActions,
} from "../../lib/avatar/camera-actions";
import { CHARCARD_APP_ID } from "../../lib/charcard-chat-start";
import { setWebAssetsModeForTests } from "../../lib/web-runtime/web-assets";
import { AppMainContent, mobileSheetDragHeight, type AppMainContentProps } from "../AppMainContent";
import { AppShellFrame } from "../AppShellFrame";
import { useChatStore } from "../../stores/chat";
import { useAppStore } from "../../stores/app";
import { t } from "../../lib/i18n";
import {
	LAYOUT_ORIENTATION_STORAGE_KEY,
	getStoredLayoutOrientation,
	resetUiPreferencesForTests,
	resolveEffectiveLayoutOrientation,
	toggleLayoutOrientation,
} from "../../lib/ui-preferences";

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
		resetUiPreferencesForTests();
		clearCameraActions();
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

	it.each([
		{ width: 1280, height: 720, portrait: false },
		{ width: 390, height: 844, portrait: true },
	])("R12: opens the chat without the card covering it at $width×$height", ({ width, height, portrait }) => {
		setWebAssetsModeForTests(true);
		vi.stubGlobal("innerWidth", width);
		vi.stubGlobal("innerHeight", height);
		appRegistry.register({
			id: CHARCARD_APP_ID,
			name: "Character Cards",
			htmlEntry: "/hosted-apps/naia-charcard/index.html",
			center: () => <div data-testid="hosted-card" />,
		});
		useAppStore.getState().setActiveApp(CHARCARD_APP_ID);
		try {
			render(<AppMainContent {...baseProps({ activeApp: CHARCARD_APP_ID, naiaVisible: true })} />);
			const card = screen.getByTestId("hosted-card");
			const sheet = screen.getByTestId("mock-chat-area").closest("[data-mobile-sheet]");
			expect(card).toBeVisible();
			expect(sheet).toHaveAttribute("data-mobile-sheet", "collapsed");

			const context = { type: "charcard", data: { character: "Tinker" } };
			act(() => useAppStore.getState().setActiveAppContext(context, CHARCARD_APP_ID));
			if (portrait) {
				expect(card).not.toBeVisible();
				expect(sheet).toHaveAttribute("data-mobile-sheet", "half");
				fireEvent.click(screen.getByRole("button", { name: "Menu" }));
				fireEvent.click(screen.getByTestId("web-character-card-mobile-btn"));
				expect(card).toBeVisible();
				expect(screen.getByTestId("hosted-card")).toBe(card);
			} else {
				expect(card).toBeVisible();
			}
			expect(useAppStore.getState().activeAppContext).toBe(context);
		} finally {
			cleanup();
			useAppStore.setState(useAppStore.getInitialState());
			appRegistry.unregister(CHARCARD_APP_ID);
			vi.unstubAllGlobals();
		}
	});

	it("clamps drag height to preserve the input and viewport bounds", () => {
		expect(mobileSheetDragHeight(350, 100, 800)).toBe(450);
		expect(mobileSheetDragHeight(350, -500, 800)).toBe(136);
		expect(mobileSheetDragHeight(350, 500, 800)).toBe(728);
	});

	it("lifts the default chat height cap once the chat toggle is dragged", () => {
		setWebAssetsModeForTests(true);
		const setChatHeight = vi.fn();
		const proto = HTMLElement.prototype as unknown as { setPointerCapture?: unknown };
		const original = proto.setPointerCapture;
		proto.setPointerCapture = vi.fn();
		try {
			const { container } = render(
				<AppMainContent {...baseProps({ naiaVisible: true, chatVisible: true, setChatHeight })} />,
			);
			const wrapper = container.querySelector(".naia-chat-wrapper");
			expect(wrapper?.getAttribute("data-chat-user-sized")).toBeNull();
			const toggle = container.querySelector(".naia-chat-toggle") as HTMLElement;
			fireEvent.pointerDown(toggle, { clientY: 500, pointerId: 1 });
			fireEvent.pointerMove(toggle, { clientY: 400, pointerId: 1 });
			expect(setChatHeight).toHaveBeenLastCalledWith(380);
			expect(wrapper?.getAttribute("data-chat-user-sized")).toBe("true");
		} finally {
			proto.setPointerCapture = original;
		}
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
		const { container } = render(<AppShellFrame appReady bootComplete backgroundFallback={{ url: "/fallback.webp", type: "image" }} backgroundMediaType="video" backgroundVideoUrl="/scene.mp4" bgmVideoUrl="" mainContent={baseProps()} onSplashDone={vi.fn()} setNaiaWidth={vi.fn()} />);
		expect(container.querySelectorAll(".app-bg-image, .app-bg-video, .app-bg-fallback")).toHaveLength(1);
		fireEvent.error(container.querySelector("video.app-bg-video")!);
		expect(container.querySelectorAll(".app-bg-image, .app-bg-video, .app-bg-fallback")).toHaveLength(1);
		expect(container.querySelector("img.app-bg-image")?.getAttribute("src")).toBe("/fallback.webp");
	});

	it("ignores old manual layout preference on web and follows viewport changes", () => {
		setWebAssetsModeForTests(true);
		const prevW = window.innerWidth;
		const prevH = window.innerHeight;
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 412 });
		Object.defineProperty(window, "innerHeight", { configurable: true, value: 915 });
		try {
			const { container } = render(
				<AppShellFrame
					appReady
					bootComplete
					backgroundFallback={null}
					backgroundMediaType=""
					backgroundVideoUrl=""
					bgmVideoUrl=""
					mainContent={baseProps({ naiaVisible: true })}
					onSplashDone={vi.fn()}
					setNaiaWidth={vi.fn()}
				/>,
			);
			const appRoot = container.querySelector(".app-root");
			expect(resolveEffectiveLayoutOrientation()).toBe("portrait");
			expect(appRoot?.getAttribute("data-layout-orientation")).toBe("portrait");
			expect(document.documentElement.getAttribute("data-layout-orientation")).toBe("portrait");

			act(() => {
				toggleLayoutOrientation("portrait");
			});

			expect(getStoredLayoutOrientation()).toBe("landscape");
			expect(localStorage.getItem(LAYOUT_ORIENTATION_STORAGE_KEY)).toBe("landscape");
			expect(resolveEffectiveLayoutOrientation()).toBe("portrait");
			Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
			Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
			act(() => window.dispatchEvent(new Event("resize")));
			expect(appRoot?.getAttribute("data-layout-orientation")).toBe("landscape");
			expect(document.documentElement.getAttribute("data-layout-orientation")).toBe("landscape");
		} finally {
			Object.defineProperty(window, "innerWidth", { configurable: true, value: prevW });
			Object.defineProperty(window, "innerHeight", { configurable: true, value: prevH });
		}
	});

	it("consolidates avatar corner buttons into a single Avatar icon that expands zoom, pan, and reset controls on click", () => {
		setWebAssetsModeForTests(true);
		const zoom = vi.fn();
		const pan = vi.fn();
		const reset = vi.fn();
		const save = vi.fn();
		registerCameraActions({ zoom, pan, reset, save });

		render(<AppMainContent {...baseProps({ naiaVisible: true })} />);

		const toggleBtn = screen.getByTestId("avatar-controls-toggle");
		expect(toggleBtn).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByTestId("avatar-controls-panel")).toBeNull();

		fireEvent.click(toggleBtn);
		expect(toggleBtn).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByTestId("avatar-controls-panel")).not.toBeNull();

		fireEvent.click(screen.getByTestId("avatar-corner-zoom-in"));
		expect(zoom).toHaveBeenCalledWith(0.1);
		expect(save).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByTestId("avatar-corner-zoom-out"));
		expect(zoom).toHaveBeenCalledWith(-0.1);
		expect(save).toHaveBeenCalledTimes(2);

		fireEvent.click(screen.getByTestId("avatar-corner-pan"));
		expect(pan).toHaveBeenCalled();

		fireEvent.click(screen.getByTestId("avatar-corner-reset"));
		expect(reset).toHaveBeenCalledTimes(1);
	});

	it("preserves user layout state (orientation, naiaWidth, chatHeight, chatMode, railCollapsed) when opening and closing File Explorer", () => {
		setWebAssetsModeForTests(true);
		localStorage.setItem(LAYOUT_ORIENTATION_STORAGE_KEY, "portrait");
		localStorage.setItem("naia:chatHeightRatio", "0.62");
		localStorage.setItem("naia:naiaWidth", "260");
		localStorage.setItem("naia:chatMode", "workspace");
		localStorage.setItem("naia:railCollapsed", "false");

		const { container, rerender } = render(
			<AppShellFrame
				appReady
				bootComplete
				backgroundFallback={null}
				backgroundMediaType=""
				backgroundVideoUrl=""
				bgmVideoUrl=""
				mainContent={baseProps({
					naiaVisible: true,
					naiaWidth: 260,
					activeApp: null,
				})}
				onSplashDone={vi.fn()}
				setNaiaWidth={vi.fn()}
			/>,
		);

		const appRoot = container.querySelector(".app-root") as HTMLElement;
		const appLayoutBefore = container.querySelector(".app-layout") as HTMLElement;
		expect(appRoot.getAttribute("data-layout-orientation")).toBe("landscape");
		expect(appRoot.style.getPropertyValue("--naia-width")).toBe("260px");
		expect(appLayoutBefore.style.left).toBe("260px");

		// Open File Explorer (workspace app)
		act(() => {
			useAppStore.getState().setActiveApp("workspace");
		});
		rerender(
			<AppShellFrame
				appReady
				bootComplete
				backgroundFallback={null}
				backgroundMediaType=""
				backgroundVideoUrl=""
				bgmVideoUrl=""
				mainContent={baseProps({
					naiaVisible: true,
					naiaWidth: 260,
					activeApp: "workspace",
				})}
				onSplashDone={vi.fn()}
				setNaiaWidth={vi.fn()}
			/>,
		);

		const appLayoutDuring = container.querySelector(".app-layout") as HTMLElement;
		expect(appRoot.getAttribute("data-layout-orientation")).toBe("landscape");
		expect(appRoot.style.getPropertyValue("--naia-width")).toBe("260px");
		expect(appLayoutDuring.style.left).toBe("260px");
		expect(localStorage.getItem(LAYOUT_ORIENTATION_STORAGE_KEY)).toBe("portrait");
		expect(localStorage.getItem("naia:chatHeightRatio")).toBe("0.62");
		expect(localStorage.getItem("naia:naiaWidth")).toBe("260");
		expect(localStorage.getItem("naia:chatMode")).toBe("workspace");
		expect(localStorage.getItem("naia:railCollapsed")).toBe("false");

		// Close File Explorer
		act(() => {
			useAppStore.getState().setActiveApp(null);
		});
		rerender(
			<AppShellFrame
				appReady
				bootComplete
				backgroundFallback={null}
				backgroundMediaType=""
				backgroundVideoUrl=""
				bgmVideoUrl=""
				mainContent={baseProps({
					naiaVisible: true,
					naiaWidth: 260,
					activeApp: null,
				})}
				onSplashDone={vi.fn()}
				setNaiaWidth={vi.fn()}
			/>,
		);

		expect(appRoot.getAttribute("data-layout-orientation")).toBe("landscape");
		expect(appRoot.style.getPropertyValue("--naia-width")).toBe("260px");
		expect(localStorage.getItem(LAYOUT_ORIENTATION_STORAGE_KEY)).toBe("portrait");
		expect(localStorage.getItem("naia:chatHeightRatio")).toBe("0.62");
		expect(localStorage.getItem("naia:naiaWidth")).toBe("260");
		expect(localStorage.getItem("naia:chatMode")).toBe("workspace");
		expect(localStorage.getItem("naia:railCollapsed")).toBe("false");
	});
});
