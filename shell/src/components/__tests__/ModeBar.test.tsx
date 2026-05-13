// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/browser-prefs", () => ({
	loadBrowserShortcuts: vi.fn().mockResolvedValue([]),
	addBrowserShortcut: vi.fn().mockResolvedValue([]),
	removeBrowserShortcut: vi.fn().mockResolvedValue([]),
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

import { ModeBar } from "../ModeBar";

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

	it("calls pushModal for URL input dialog too", () => {
		render(<ModeBar />);
		fireEvent.click(screen.getByTitle("modebar.addItem"));
		// pushModal called once for addUrlDialog
		expect(mockPushModal).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByText("modebar.addShortcut").closest("button")!);
		// addUrlDialog closes (popModal) then urlInputDialog opens (pushModal) → net 2 calls
		expect(mockPushModal).toHaveBeenCalledTimes(2);
	});
});
