// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGenericInstalledApp } from "../../apps/generic-installed/GenericInstalledApp";
import { appRegistry } from "../../lib/app-registry";
import { useAppStore } from "../../stores/app";
import { AppMainContent } from "../AppMainContent";

const mockSendAppSkillsClear = vi.hoisted(() =>
	vi.fn().mockResolvedValue(true),
);

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
	convertFileSrc: (path: string) =>
		`asset://localhost/${encodeURIComponent(path)}`,
}));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		minimize: vi.fn(),
		toggleMaximize: vi.fn(),
		close: vi.fn(),
		startDragging: vi.fn(),
	}),
}));

vi.mock("../../lib/chat-service", () => ({
	sendAppSkillsClear: (...args: unknown[]) => mockSendAppSkillsClear(...args),
}));

vi.mock("../../lib/slides-host-bridge", () => ({
	installSlidesHostBridge: vi.fn(() => vi.fn()),
}));

vi.mock("../../lib/slides-files-bridge", () => ({
	installSlidesFilesBridge: vi.fn(() => vi.fn()),
}));

vi.mock("../../lib/i18n", () => ({
	t: (k: string) => k,
	getLocale: () => "ko",
}));

vi.mock("../../lib/logger", () => ({
	Logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("../TitleBar", () => ({
	TitleBar: () => <div data-testid="title-bar" />,
}));

vi.mock("../AppBar", () => ({
	AppBar: () => <div data-testid="app-bar" />,
}));

vi.mock("../DeferredChatArea", () => ({
	DeferredChatArea: () => <div data-testid="chat-area" />,
}));

vi.mock("../AvatarCanvas", () => ({
	AvatarCanvas: () => <div data-testid="avatar-canvas" />,
}));

describe("Mini-app floating close button and full background termination (#872)", () => {
	const TAROT_ID = "land.naia.tarot-demo";
	const SETTINGS_ID = "settings";

	function renderShellMain(activeApp: string | null) {
		return render(
			<AppMainContent
				activeApp={activeApp}
				announcements={[]}
				appInstallRequest={null}
				appTitle="Naia"
				avatarProvider="vrm"
				chatModeOverride="app"
				chatDragRef={createRef()}
				chatHeight={320}
				chatVisible={true}
				configSaveError={null}
				handleNaiaWidthPointerDown={vi.fn()}
				handleNaiaWidthPointerMove={vi.fn()}
				handleNaiaWidthPointerUp={vi.fn()}
				naiaVisible={false}
				naiaWidth={320}
				nvaModel=""
				onAdkSetupComplete={vi.fn()}
				onOnboardingComplete={vi.fn()}
				railCollapsed={false}
				setAnnouncements={vi.fn()}
				setAppInstallRequest={vi.fn()}
				setChatHeight={vi.fn()}
				setChatMode={vi.fn()}
				setChatVisible={vi.fn()}
				setShowAppInstall={vi.fn()}
				setShowUpdatePrompt={vi.fn()}
				setUpdateInfo={vi.fn()}
				showAdkSetup={false}
				showAppInstall={false}
				showOnboarding={false}
				showSplash={false}
				showUpdatePrompt={false}
				toggleNaia={vi.fn()}
				toggleRailCollapsed={vi.fn()}
				uiMode="app"
				updateInfo={null}
			/>,
		);
	}

	beforeEach(() => {
		mockSendAppSkillsClear.mockClear();
		appRegistry.register({
			id: TAROT_ID,
			name: "Tarot Demo",
			source: "installed",
			keepAlive: true,
			deferMountUntilActive: true,
			center: createGenericInstalledApp(
				"/apps/land.naia.tarot-demo/index.html",
				[{ name: "skill_tarot_demo", description: "tarot" }],
				TAROT_ID,
			),
		});
		appRegistry.register({
			id: SETTINGS_ID,
			name: "Settings",
			builtIn: true,
			keepAlive: true,
			deferMountUntilActive: true,
			center: () => <div data-testid="settings-surface" />,
		});
		useAppStore.setState({
			activeApp: null,
			activatedApps: [],
			closedApps: [],
			appInstanceEpoch: {},
			activeAppContext: null,
			activeAppContextOwnerId: null,
			persistentAppContexts: {
				bgm: { type: "bgm", data: { track: "lofi" } },
			},
			appListVersion: useAppStore.getState().appListVersion + 1,
		});
	});

	afterEach(() => {
		cleanup();
		appRegistry.unregister(TAROT_ID);
		appRegistry.unregister(SETTINGS_ID);
	});

	it("shows floating close button on active mini-app, unmounts keepAlive iframe + clears skills/context on click, and mounts fresh on reopen", () => {
		const { rerender } = renderShellMain(null);

		// Not mounted before first activation
		expect(document.querySelector(".generic-installed-app__iframe")).toBeNull();
		expect(screen.queryByTestId("active-app-close-btn")).toBeNull();

		// Open mini-app
		act(() => {
			useAppStore.getState().setActiveApp(TAROT_ID);
			useAppStore.getState().setActiveAppContext(
				{ type: "tarot", data: { spread: "celtic" } },
				TAROT_ID,
			);
		});
		rerender(
			<AppMainContent
				activeApp={useAppStore.getState().activeApp}
				announcements={[]}
				appInstallRequest={null}
				appTitle="Naia"
				avatarProvider="vrm"
				chatModeOverride="app"
				chatDragRef={createRef()}
				chatHeight={320}
				chatVisible={true}
				configSaveError={null}
				handleNaiaWidthPointerDown={vi.fn()}
				handleNaiaWidthPointerMove={vi.fn()}
				handleNaiaWidthPointerUp={vi.fn()}
				naiaVisible={false}
				naiaWidth={320}
				nvaModel=""
				onAdkSetupComplete={vi.fn()}
				onOnboardingComplete={vi.fn()}
				railCollapsed={false}
				setAnnouncements={vi.fn()}
				setAppInstallRequest={vi.fn()}
				setChatHeight={vi.fn()}
				setChatMode={vi.fn()}
				setChatVisible={vi.fn()}
				setShowAppInstall={vi.fn()}
				setShowUpdatePrompt={vi.fn()}
				setUpdateInfo={vi.fn()}
				showAdkSetup={false}
				showAppInstall={false}
				showOnboarding={false}
				showSplash={false}
				showUpdatePrompt={false}
				toggleNaia={vi.fn()}
				toggleRailCollapsed={vi.fn()}
				uiMode="app"
				updateInfo={null}
			/>,
		);

		const firstIframe = document.querySelector(
			".generic-installed-app__iframe",
		) as HTMLIFrameElement;
		expect(firstIframe).not.toBeNull();
		firstIframe.setAttribute("data-instance-marker", "first");

		const closeBtn = screen.getByTestId("active-app-close-btn");
		expect(closeBtn).toHaveAttribute("aria-label", "appbar.closeApp");
		// R5: the close button lives in a shell title bar above the app slot,
		// not floating over the app's own header controls.
		const titlebar = screen.getByTestId("active-app-titlebar");
		expect(titlebar).toContainElement(closeBtn);
		expect(titlebar.parentElement).toHaveClass("content-app--with-titlebar");
		expect(titlebar.parentElement?.contains(firstIframe)).toBe(true);
		expect(titlebar.contains(firstIframe)).toBe(false);

		// Ordinary switch to built-in Settings keeps mini-app iframe mounted in background,
		// and built-in Settings does not show the mini-app close button
		act(() => {
			useAppStore.getState().setActiveApp(SETTINGS_ID);
		});
		rerender(
			<AppMainContent
				activeApp={useAppStore.getState().activeApp}
				announcements={[]}
				appInstallRequest={null}
				appTitle="Naia"
				avatarProvider="vrm"
				chatModeOverride="app"
				chatDragRef={createRef()}
				chatHeight={320}
				chatVisible={true}
				configSaveError={null}
				handleNaiaWidthPointerDown={vi.fn()}
				handleNaiaWidthPointerMove={vi.fn()}
				handleNaiaWidthPointerUp={vi.fn()}
				naiaVisible={false}
				naiaWidth={320}
				nvaModel=""
				onAdkSetupComplete={vi.fn()}
				onOnboardingComplete={vi.fn()}
				railCollapsed={false}
				setAnnouncements={vi.fn()}
				setAppInstallRequest={vi.fn()}
				setChatHeight={vi.fn()}
				setChatMode={vi.fn()}
				setChatVisible={vi.fn()}
				setShowAppInstall={vi.fn()}
				setShowUpdatePrompt={vi.fn()}
				setUpdateInfo={vi.fn()}
				showAdkSetup={false}
				showAppInstall={false}
				showOnboarding={false}
				showSplash={false}
				showUpdatePrompt={false}
				toggleNaia={vi.fn()}
				toggleRailCollapsed={vi.fn()}
				uiMode="app"
				updateInfo={null}
			/>,
		);
		expect(screen.queryByTestId("active-app-close-btn")).toBeNull();
		expect(
			document.querySelector(
				'.generic-installed-app__iframe[data-instance-marker="first"]',
			),
		).not.toBeNull();

		// Switch back to mini-app, push context, and click [✕] Close App
		act(() => {
			useAppStore.getState().setActiveApp(TAROT_ID);
			useAppStore.getState().setActiveAppContext(
				{ type: "tarot", data: { spread: "celtic" } },
				TAROT_ID,
			);
		});
		rerender(
			<AppMainContent
				activeApp={useAppStore.getState().activeApp}
				announcements={[]}
				appInstallRequest={null}
				appTitle="Naia"
				avatarProvider="vrm"
				chatModeOverride="app"
				chatDragRef={createRef()}
				chatHeight={320}
				chatVisible={true}
				configSaveError={null}
				handleNaiaWidthPointerDown={vi.fn()}
				handleNaiaWidthPointerMove={vi.fn()}
				handleNaiaWidthPointerUp={vi.fn()}
				naiaVisible={false}
				naiaWidth={320}
				nvaModel=""
				onAdkSetupComplete={vi.fn()}
				onOnboardingComplete={vi.fn()}
				railCollapsed={false}
				setAnnouncements={vi.fn()}
				setAppInstallRequest={vi.fn()}
				setChatHeight={vi.fn()}
				setChatMode={vi.fn()}
				setChatVisible={vi.fn()}
				setShowAppInstall={vi.fn()}
				setShowUpdatePrompt={vi.fn()}
				setUpdateInfo={vi.fn()}
				showAdkSetup={false}
				showAppInstall={false}
				showOnboarding={false}
				showSplash={false}
				showUpdatePrompt={false}
				toggleNaia={vi.fn()}
				toggleRailCollapsed={vi.fn()}
				uiMode="app"
				updateInfo={null}
			/>,
		);

		fireEvent.click(screen.getByTestId("active-app-close-btn"));
		rerender(
			<AppMainContent
				activeApp={useAppStore.getState().activeApp}
				announcements={[]}
				appInstallRequest={null}
				appTitle="Naia"
				avatarProvider="vrm"
				chatModeOverride="app"
				chatDragRef={createRef()}
				chatHeight={320}
				chatVisible={true}
				configSaveError={null}
				handleNaiaWidthPointerDown={vi.fn()}
				handleNaiaWidthPointerMove={vi.fn()}
				handleNaiaWidthPointerUp={vi.fn()}
				naiaVisible={false}
				naiaWidth={320}
				nvaModel=""
				onAdkSetupComplete={vi.fn()}
				onOnboardingComplete={vi.fn()}
				railCollapsed={false}
				setAnnouncements={vi.fn()}
				setAppInstallRequest={vi.fn()}
				setChatHeight={vi.fn()}
				setChatMode={vi.fn()}
				setChatVisible={vi.fn()}
				setShowAppInstall={vi.fn()}
				setShowUpdatePrompt={vi.fn()}
				setUpdateInfo={vi.fn()}
				showAdkSetup={false}
				showAppInstall={false}
				showOnboarding={false}
				showSplash={false}
				showUpdatePrompt={false}
				toggleNaia={vi.fn()}
				toggleRailCollapsed={vi.fn()}
				uiMode="app"
				updateInfo={null}
			/>,
		);

		// 1) Returned to desktop, 2) background iframe unmounted, 3) context & skills cleared (persistent bgm kept)
		expect(useAppStore.getState().activeApp).toBeNull();
		expect(useAppStore.getState().activeAppContext).toBeNull();
		expect(useAppStore.getState().activeAppContextOwnerId).toBeNull();
		expect(useAppStore.getState().persistentAppContexts.bgm).toEqual({
			type: "bgm",
			data: { track: "lofi" },
		});
		expect(mockSendAppSkillsClear).toHaveBeenCalledWith(TAROT_ID);
		expect(document.querySelector(".generic-installed-app__iframe")).toBeNull();
		expect(screen.queryByTestId("active-app-close-btn")).toBeNull();

		// Reopen: mounts a fresh iframe instance (marker gone, epoch incremented)
		act(() => {
			useAppStore.getState().setActiveApp(TAROT_ID);
		});
		rerender(
			<AppMainContent
				activeApp={useAppStore.getState().activeApp}
				announcements={[]}
				appInstallRequest={null}
				appTitle="Naia"
				avatarProvider="vrm"
				chatModeOverride="app"
				chatDragRef={createRef()}
				chatHeight={320}
				chatVisible={true}
				configSaveError={null}
				handleNaiaWidthPointerDown={vi.fn()}
				handleNaiaWidthPointerMove={vi.fn()}
				handleNaiaWidthPointerUp={vi.fn()}
				naiaVisible={false}
				naiaWidth={320}
				nvaModel=""
				onAdkSetupComplete={vi.fn()}
				onOnboardingComplete={vi.fn()}
				railCollapsed={false}
				setAnnouncements={vi.fn()}
				setAppInstallRequest={vi.fn()}
				setChatHeight={vi.fn()}
				setChatMode={vi.fn()}
				setChatVisible={vi.fn()}
				setShowAppInstall={vi.fn()}
				setShowUpdatePrompt={vi.fn()}
				setUpdateInfo={vi.fn()}
				showAdkSetup={false}
				showAppInstall={false}
				showOnboarding={false}
				showSplash={false}
				showUpdatePrompt={false}
				toggleNaia={vi.fn()}
				toggleRailCollapsed={vi.fn()}
				uiMode="app"
				updateInfo={null}
			/>,
		);

		const reopenedIframe = document.querySelector(
			".generic-installed-app__iframe",
		) as HTMLIFrameElement;
		expect(reopenedIframe).not.toBeNull();
		expect(reopenedIframe.getAttribute("data-instance-marker")).toBeNull();
		expect(useAppStore.getState().appInstanceEpoch[TAROT_ID]).toBe(1);
	});
});
