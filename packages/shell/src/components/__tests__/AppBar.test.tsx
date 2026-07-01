// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
	emit: vi.fn().mockResolvedValue(undefined),
}));

const mockLoadBrowserShortcuts = vi.fn().mockResolvedValue([]);
const mockRemoveBrowserShortcut = vi.fn();
const mockReorderBrowserShortcuts = vi.fn();
const mockUpdateBrowserShortcutIcon = vi.fn();

vi.mock("../../lib/browser-prefs", () => ({
	loadBrowserShortcuts: (...a: unknown[]) => mockLoadBrowserShortcuts(...a),
	addBrowserShortcut: vi.fn().mockResolvedValue([]),
	removeBrowserShortcut: (...a: unknown[]) => mockRemoveBrowserShortcut(...a),
	reorderBrowserShortcuts: (...a: unknown[]) =>
		mockReorderBrowserShortcuts(...a),
	updateBrowserShortcutIcon: (...a: unknown[]) =>
		mockUpdateBrowserShortcutIcon(...a),
	onBrowserPrefsChanged: vi.fn().mockReturnValue(() => {}),
}));

vi.mock("../../lib/config", () => ({
	loadConfig: vi.fn().mockReturnValue(null),
	saveConfig: vi.fn(),
}));

vi.mock("../../lib/panel-loader", () => ({
	removeInstalledPanel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/panel-registry", () => ({
	panelRegistry: {
		list: vi.fn().mockReturnValue([]),
		get: vi.fn().mockReturnValue(undefined),
		getApi: vi.fn().mockReturnValue(undefined),
		unregister: vi.fn(),
	},
	// Stub bridge: active-bridge.ts constructs one at module load. Keep it a
	// no-op so the registry stays fully isolated from stores/panel (the real
	// pushContext dynamic-imports the store). (#313 added ActivePanelBridge.)
	ActivePanelBridge: class {
		pushContext = vi.fn();
		onToolCall = vi.fn().mockReturnValue(() => {});
		callTool = vi.fn().mockResolvedValue("ok");
		logBehavior = vi.fn().mockResolvedValue(undefined);
	},
}));

vi.mock("../../lib/i18n", () => ({
	t: (k: string) => k,
	getLocale: () => "ko",
}));

vi.mock("../../lib/logger", () => ({
	Logger: {
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

const mockPushModal = vi.fn();
const mockPopModal = vi.fn();

vi.mock("../../stores/app", () => {
	// state 는 lazy 생성(호출 시점) — 팩토리는 hoist 되어 module-level mock 보다 먼저 실행되므로.
	const getState = () => ({
		activeApp: null,
		setActiveApp: vi.fn(),
		setActiveAppContext: vi.fn(),
		appListVersion: 0,
		bumpAppListVersion: vi.fn(),
		pushModal: mockPushModal,
		popModal: mockPopModal,
	});
	// zustand 정적 getState 도 제공 — active-bridge 의 동적 import 가 useAppStore.getState() 호출.
	const useAppStore: any = vi.fn((selector?: (s: any) => any) => {
		const state = getState();
		return selector ? selector(state) : state;
	});
	useAppStore.getState = getState;
	return { useAppStore };
});

import { act } from "@testing-library/react";
import { AppBar } from "../AppBar";

const SHORTCUT = {
	title: "Google",
	url: "https://google.com",
	iconUrl: undefined,
	createdAt: 1000,
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("AppBar — add dialog", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("renders + button", () => {
		render(<AppBar />);
		expect(screen.getByTitle("appbar.addItem")).toBeDefined();
	});

	it("opens add-url dialog when + clicked", () => {
		render(<AppBar />);
		fireEvent.click(screen.getByTitle("appbar.addItem"));
		expect(screen.getByText("appbar.addShortcut")).toBeDefined();
		expect(screen.getByText("appbar.addPanel")).toBeDefined();
	});

	it("calls pushModal when add dialog opens", () => {
		render(<AppBar />);
		fireEvent.click(screen.getByTitle("appbar.addItem"));
		expect(mockPushModal).toHaveBeenCalledTimes(1);
	});

	it("calls popModal when overlay is clicked (dialog closes)", () => {
		render(<AppBar />);
		fireEvent.click(screen.getByTitle("appbar.addItem"));
		// click overlay (dialog backdrop)
		const overlay = document.querySelector(".app-bar-url-dialog-overlay")!;
		fireEvent.click(overlay);
		expect(mockPopModal).toHaveBeenCalledTimes(1);
	});

	it("opens URL input dialog when 링크 추가 section clicked", () => {
		render(<AppBar />);
		fireEvent.click(screen.getByTitle("appbar.addItem"));
		fireEvent.click(screen.getByText("appbar.addShortcut").closest("button")!);
		expect(screen.getByPlaceholderText("appbar.enterUrl")).toBeDefined();
	});

	it("pushModal stays at 1 during addUrlDialog→urlInputDialog transition", () => {
		render(<AppBar />);
		fireEvent.click(screen.getByTitle("appbar.addItem"));
		// pushModal called once when isAnyDialogOpen first becomes true
		expect(mockPushModal).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByText("appbar.addShortcut").closest("button")!);
		// isAnyDialogOpen stays true during transition — effect does NOT re-run,
		// so pushModal is NOT called again (single-boolean optimization prevents
		// browser_wv_show/hide flash between dialogs)
		expect(mockPushModal).toHaveBeenCalledTimes(1);
	});
});

// ── Edit mode (#295) ─────────────────────────────────────────────────────────

describe("AppBar — edit mode (#295)", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("edit button hidden when no shortcuts", async () => {
		mockLoadBrowserShortcuts.mockResolvedValue([]);
		render(<AppBar />);
		// Wait for shortcuts to load (async)
		await act(async () => {});
		expect(document.querySelector(".app-bar-edit")).toBeNull();
	});

	it("edit button appears when shortcuts exist", async () => {
		mockLoadBrowserShortcuts.mockResolvedValue([SHORTCUT]);
		render(<AppBar />);
		await act(async () => {});
		expect(document.querySelector(".app-bar-edit")).toBeDefined();
	});

	it("clicking edit button toggles app-bar-edit--active class", async () => {
		mockLoadBrowserShortcuts.mockResolvedValue([SHORTCUT]);
		render(<AppBar />);
		await act(async () => {});
		const btn = document.querySelector(".app-bar-edit") as HTMLButtonElement;
		expect(btn.classList.contains("app-bar-edit--active")).toBe(false);
		fireEvent.click(btn);
		expect(btn.classList.contains("app-bar-edit--active")).toBe(true);
	});

	it("in edit mode, ✕ delete button appears on each shortcut", async () => {
		mockLoadBrowserShortcuts.mockResolvedValue([SHORTCUT]);
		render(<AppBar />);
		await act(async () => {});
		// Enter edit mode
		fireEvent.click(document.querySelector(".app-bar-edit")!);
		// ✕ button should appear
		expect(screen.getByTitle("바로가기 삭제")).toBeDefined();
	});

	it("clicking ✕ calls removeBrowserShortcut with correct url", async () => {
		const updated: (typeof SHORTCUT)[] = [];
		mockLoadBrowserShortcuts.mockResolvedValue([SHORTCUT]);
		mockRemoveBrowserShortcut.mockResolvedValue(updated);
		render(<AppBar />);
		await act(async () => {});
		fireEvent.click(document.querySelector(".app-bar-edit")!);
		fireEvent.click(screen.getByTitle("바로가기 삭제"));
		expect(mockRemoveBrowserShortcut).toHaveBeenCalledWith(SHORTCUT.url);
	});

	it("clicking shortcut in edit mode opens icon editor dialog", async () => {
		mockLoadBrowserShortcuts.mockResolvedValue([SHORTCUT]);
		render(<AppBar />);
		await act(async () => {});
		fireEvent.click(document.querySelector(".app-bar-edit")!);
		// In edit mode, clicking shortcut opens icon editor (not browser navigation)
		const shortcutBtn = document.querySelector(
			".app-bar-tab--edit",
		) as HTMLButtonElement;
		fireEvent.click(shortcutBtn);
		// Icon editor input should appear
		expect(
			screen.getByPlaceholderText("이모지 또는 이미지 URL (비우면 기본값)"),
		).toBeDefined();
	});

	it("icon editor save calls updateBrowserShortcutIcon", async () => {
		const afterUpdate = [{ ...SHORTCUT, iconUrl: "🎯" }];
		mockLoadBrowserShortcuts.mockResolvedValue([SHORTCUT]);
		mockUpdateBrowserShortcutIcon.mockResolvedValue(afterUpdate);
		render(<AppBar />);
		await act(async () => {});
		fireEvent.click(document.querySelector(".app-bar-edit")!);
		fireEvent.click(document.querySelector(".app-bar-tab--edit")!);
		// Type new icon
		const input = screen.getByPlaceholderText(
			"이모지 또는 이미지 URL (비우면 기본값)",
		);
		fireEvent.change(input, { target: { value: "🎯" } });
		// Submit
		fireEvent.click(screen.getByText("settings.save"));
		await act(async () => {});
		expect(mockUpdateBrowserShortcutIcon).toHaveBeenCalledWith(
			SHORTCUT.url,
			"🎯",
		);
	});
});
