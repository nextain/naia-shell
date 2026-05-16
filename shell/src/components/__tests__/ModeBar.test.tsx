// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));

const mockLoadBrowserShortcuts = vi.fn().mockResolvedValue([]);
const mockRemoveBrowserShortcut = vi.fn();
const mockReorderBrowserShortcuts = vi.fn();
const mockUpdateBrowserShortcutIcon = vi.fn();

vi.mock("../../lib/browser-prefs", () => ({
	loadBrowserShortcuts: (...a: unknown[]) => mockLoadBrowserShortcuts(...a),
	addBrowserShortcut: vi.fn().mockResolvedValue([]),
	removeBrowserShortcut: (...a: unknown[]) => mockRemoveBrowserShortcut(...a),
	reorderBrowserShortcuts: (...a: unknown[]) => mockReorderBrowserShortcuts(...a),
	updateBrowserShortcutIcon: (...a: unknown[]) => mockUpdateBrowserShortcutIcon(...a),
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

vi.mock("../../stores/panel", () => ({
	usePanelStore: vi.fn((selector?: (s: any) => any) => {
		const state = {
			activePanel: null,
			setActivePanel: vi.fn(),
			panelListVersion: 0,
			bumpPanelListVersion: vi.fn(),
			pushModal: mockPushModal,
			popModal: mockPopModal,
		};
		return selector ? selector(state) : state;
	}),
}));

import { act } from "@testing-library/react";
import { ModeBar } from "../ModeBar";

const SHORTCUT = { title: "Google", url: "https://google.com", iconUrl: undefined, createdAt: 1000 };

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ModeBar — add dialog", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("renders + button", () => {
		render(<ModeBar />);
		expect(screen.getByTitle("modebar.addItem")).toBeDefined();
	});

	it("opens add-url dialog when + clicked", () => {
		render(<ModeBar />);
		fireEvent.click(screen.getByTitle("modebar.addItem"));
		expect(screen.getByText("modebar.addShortcut")).toBeDefined();
		expect(screen.getByText("modebar.addPanel")).toBeDefined();
	});

	it("calls pushModal when add dialog opens", () => {
		render(<ModeBar />);
		fireEvent.click(screen.getByTitle("modebar.addItem"));
		expect(mockPushModal).toHaveBeenCalledTimes(1);
	});

	it("calls popModal when overlay is clicked (dialog closes)", () => {
		render(<ModeBar />);
		fireEvent.click(screen.getByTitle("modebar.addItem"));
		// click overlay (dialog backdrop)
		const overlay = document.querySelector(".mode-bar-url-dialog-overlay")!;
		fireEvent.click(overlay);
		expect(mockPopModal).toHaveBeenCalledTimes(1);
	});

	it("opens URL input dialog when 링크 추가 section clicked", () => {
		render(<ModeBar />);
		fireEvent.click(screen.getByTitle("modebar.addItem"));
		fireEvent.click(screen.getByText("modebar.addShortcut").closest("button")!);
		expect(screen.getByPlaceholderText("modebar.enterUrl")).toBeDefined();
	});

	it("pushModal stays at 1 during addUrlDialog→urlInputDialog transition", () => {
		render(<ModeBar />);
		fireEvent.click(screen.getByTitle("modebar.addItem"));
		// pushModal called once when isAnyDialogOpen first becomes true
		expect(mockPushModal).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByText("modebar.addShortcut").closest("button")!);
		// isAnyDialogOpen stays true during transition — effect does NOT re-run,
		// so pushModal is NOT called again (single-boolean optimization prevents
		// browser_wv_show/hide flash between dialogs)
		expect(mockPushModal).toHaveBeenCalledTimes(1);
	});
});

// ── Edit mode (#295) ─────────────────────────────────────────────────────────

describe("ModeBar — edit mode (#295)", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("edit button hidden when no shortcuts", async () => {
		mockLoadBrowserShortcuts.mockResolvedValue([]);
		render(<ModeBar />);
		// Wait for shortcuts to load (async)
		await act(async () => {});
		expect(document.querySelector(".mode-bar-edit")).toBeNull();
	});

	it("edit button appears when shortcuts exist", async () => {
		mockLoadBrowserShortcuts.mockResolvedValue([SHORTCUT]);
		render(<ModeBar />);
		await act(async () => {});
		expect(document.querySelector(".mode-bar-edit")).toBeDefined();
	});

	it("clicking edit button toggles mode-bar-edit--active class", async () => {
		mockLoadBrowserShortcuts.mockResolvedValue([SHORTCUT]);
		render(<ModeBar />);
		await act(async () => {});
		const btn = document.querySelector(".mode-bar-edit") as HTMLButtonElement;
		expect(btn.classList.contains("mode-bar-edit--active")).toBe(false);
		fireEvent.click(btn);
		expect(btn.classList.contains("mode-bar-edit--active")).toBe(true);
	});

	it("in edit mode, ✕ delete button appears on each shortcut", async () => {
		mockLoadBrowserShortcuts.mockResolvedValue([SHORTCUT]);
		render(<ModeBar />);
		await act(async () => {});
		// Enter edit mode
		fireEvent.click(document.querySelector(".mode-bar-edit")!);
		// ✕ button should appear
		expect(screen.getByTitle("바로가기 삭제")).toBeDefined();
	});

	it("clicking ✕ calls removeBrowserShortcut with correct url", async () => {
		const updated: typeof SHORTCUT[] = [];
		mockLoadBrowserShortcuts.mockResolvedValue([SHORTCUT]);
		mockRemoveBrowserShortcut.mockResolvedValue(updated);
		render(<ModeBar />);
		await act(async () => {});
		fireEvent.click(document.querySelector(".mode-bar-edit")!);
		fireEvent.click(screen.getByTitle("바로가기 삭제"));
		expect(mockRemoveBrowserShortcut).toHaveBeenCalledWith(SHORTCUT.url);
	});

	it("clicking shortcut in edit mode opens icon editor dialog", async () => {
		mockLoadBrowserShortcuts.mockResolvedValue([SHORTCUT]);
		render(<ModeBar />);
		await act(async () => {});
		fireEvent.click(document.querySelector(".mode-bar-edit")!);
		// In edit mode, clicking shortcut opens icon editor (not browser navigation)
		const shortcutBtn = document.querySelector(".mode-bar-tab--edit") as HTMLButtonElement;
		fireEvent.click(shortcutBtn);
		// Icon editor input should appear
		expect(screen.getByPlaceholderText("이모지 또는 이미지 URL (비우면 기본값)")).toBeDefined();
	});

	it("icon editor save calls updateBrowserShortcutIcon", async () => {
		const afterUpdate = [{ ...SHORTCUT, iconUrl: "🎯" }];
		mockLoadBrowserShortcuts.mockResolvedValue([SHORTCUT]);
		mockUpdateBrowserShortcutIcon.mockResolvedValue(afterUpdate);
		render(<ModeBar />);
		await act(async () => {});
		fireEvent.click(document.querySelector(".mode-bar-edit")!);
		fireEvent.click(document.querySelector(".mode-bar-tab--edit")!);
		// Type new icon
		const input = screen.getByPlaceholderText("이모지 또는 이미지 URL (비우면 기본값)");
		fireEvent.change(input, { target: { value: "🎯" } });
		// Submit
		fireEvent.click(screen.getByText("settings.save"));
		await act(async () => {});
		expect(mockUpdateBrowserShortcutIcon).toHaveBeenCalledWith(SHORTCUT.url, "🎯");
	});
});
