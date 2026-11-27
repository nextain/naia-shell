// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../lib/i18n";

const {
	mockMinimize,
	mockMaximize,
	mockUnmaximize,
	mockIsMaximized,
	mockClose,
	mockStartDragging,
} = vi.hoisted(() => ({
	mockMinimize: vi.fn(),
	mockMaximize: vi.fn(),
	mockUnmaximize: vi.fn(),
	mockIsMaximized: vi.fn<() => Promise<boolean>>(),
	mockClose: vi.fn(),
	mockStartDragging: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		minimize: mockMinimize,
		maximize: mockMaximize,
		unmaximize: mockUnmaximize,
		isMaximized: mockIsMaximized,
		close: mockClose,
		startDragging: mockStartDragging,
	}),
}));

import { TitleBar } from "../TitleBar";

function stubNavigatorPlatform(platform: string, userAgent: string) {
	vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
}

describe("TitleBar platform window controls and shortcut labels", () => {
	beforeEach(() => {
		mockMinimize.mockReset();
		mockMaximize.mockReset();
		mockUnmaximize.mockReset();
		mockIsMaximized.mockReset();
		mockIsMaximized.mockResolvedValue(false);
		mockClose.mockReset();
		mockStartDragging.mockReset();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("renders Windows/Linux button order on the right with Ctrl+B shortcut tooltip", () => {
		stubNavigatorPlatform(
			"Linux x86_64",
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15",
		);
		const onToggleApp = vi.fn();
		const { container, rerender } = render(
			<TitleBar appVisible={true} onToggleApp={onToggleApp} title="Naia" />,
		);

		const bar = container.querySelector(".titlebar");
		expect(bar).not.toHaveClass("titlebar--macos");
		expect(bar?.getAttribute("data-titlebar-platform")).toBe("other");
		expect(container.querySelector("[data-macos-window-controls]")).toBeNull();

		const buttons = screen.getAllByRole("button");
		expect(buttons.map((b) => b.getAttribute("title"))).toEqual([
			`${t("hardkoG1a.titleBar.hideChat")} (Ctrl+B)`,
			t("hardkoG1a.titleBar.minimize"),
			t("hardkoG1a.titleBar.maximize"),
			t("hardkoG1a.close"),
		]);

		rerender(
			<TitleBar appVisible={false} onToggleApp={onToggleApp} title="Naia" />,
		);
		expect(screen.getByTitle(`${t("hardkoG1a.titleBar.showChat")} (Ctrl+B)`)).toBeInTheDocument();
	});

	it("renders left-side macOS traffic lights (close -> minimize -> maximize) and ⌘B tooltip on Darwin", async () => {
		stubNavigatorPlatform(
			"",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
		);
		const onToggleApp = vi.fn();
		const { container, rerender } = render(
			<TitleBar appVisible={true} onToggleApp={onToggleApp} title="Studio" />,
		);

		const bar = container.querySelector(".titlebar");
		expect(bar).toHaveClass("titlebar--macos");
		expect(bar?.getAttribute("data-titlebar-platform")).toBe("macos");

		const trafficGroup = container.querySelector(
			"[data-macos-window-controls='true']",
		);
		expect(trafficGroup).not.toBeNull();

		const buttons = screen.getAllByRole("button");
		expect(buttons.map((b) => b.getAttribute("title"))).toEqual([
			t("hardkoG1a.close"),
			t("hardkoG1a.titleBar.minimize"),
			t("hardkoG1a.titleBar.maximize"),
			`${t("hardkoG1a.titleBar.hideChat")} (⌘B)`,
		]);
		expect(
			buttons.slice(0, 3).map((b) => b.getAttribute("data-macos-traffic")),
		).toEqual(["close", "minimize", "maximize"]);

		const [closeButton, minimizeButton, maximizeButton, toggleButton] = buttons;
		expect(closeButton).toBeDefined();
		expect(minimizeButton).toBeDefined();
		expect(maximizeButton).toBeDefined();
		expect(toggleButton).toBeDefined();

		// Clicking traffic lights triggers Tauri window actions and never starts dragging.
		fireEvent.mouseDown(closeButton!);
		fireEvent.click(closeButton!);
		expect(mockClose).toHaveBeenCalledTimes(1);
		expect(mockStartDragging).not.toHaveBeenCalled();

		fireEvent.click(minimizeButton!);
		expect(mockMinimize).toHaveBeenCalledTimes(1);

		fireEvent.click(maximizeButton!);
		await waitFor(() => {
			expect(mockMaximize).toHaveBeenCalledTimes(1);
		});

		fireEvent.click(toggleButton!);
		expect(onToggleApp).toHaveBeenCalledTimes(1);

		rerender(
			<TitleBar appVisible={false} onToggleApp={onToggleApp} title="Studio" />,
		);
		expect(screen.getByTitle(`${t("hardkoG1a.titleBar.showChat")} (⌘B)`)).toBeInTheDocument();

		// Dragging and double-clicking the titlebar surface still work on macOS.
		fireEvent.mouseDown(bar!, { detail: 1 });
		expect(mockStartDragging).toHaveBeenCalledTimes(1);

		mockIsMaximized.mockResolvedValueOnce(true);
		fireEvent.mouseDown(bar!, { detail: 2 });
		await waitFor(() => {
			expect(mockUnmaximize).toHaveBeenCalledTimes(1);
		});
	});
});
