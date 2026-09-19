// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// #438: the embedded Herdr client only repaints on a real SIGWINCH. Terminal
// must nudge the PTY size (distinct → final) on attach and on reactivation so a
// lost opening frame or a no-op reattach resize cannot leave a blank surface.

const resizePty = vi.fn((_id: string, _rows: number, _cols: number) =>
	Promise.resolve(),
);
const writePty = vi.fn((_id: string, _data: string) => Promise.resolve());
const attachPty = vi.fn((_id: string) => Promise.resolve());

vi.mock("../pty-ipc", () => ({
	attachPty: (id: string) => attachPty(id),
	resizePty: (id: string, rows: number, cols: number) =>
		resizePty(id, rows, cols),
	writePty: (id: string, data: string) => writePty(id, data),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(() => Promise.resolve()),
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		fit = vi.fn();
	},
}));

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		rows = 30;
		cols = 100;
		loadAddon = vi.fn();
		open = vi.fn();
		write = vi.fn();
		focus = vi.fn();
		dispose = vi.fn();
		registerLinkProvider = vi.fn();
		onData = vi.fn(() => ({ dispose: vi.fn() }));
		onBinary = vi.fn(() => ({ dispose: vi.fn() }));
		buffer = { active: { getLine: () => null } };
		options: Record<string, unknown> = {};
	},
}));

vi.mock("../../../lib/i18n", () => ({ t: (key: string) => key }));
vi.mock("../../../lib/logger", () => ({
	Logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

globalThis.ResizeObserver = class {
	observe() {}
	disconnect() {}
	unobserve() {}
} as unknown as typeof ResizeObserver;

import { Terminal } from "../Terminal";

describe("Terminal — Herdr redraw guard (#438)", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("nudges the PTY size distinct→final on initial attach", async () => {
		render(<Terminal pty_id="pty-7" active onExit={() => {}} />);
		await waitFor(() => expect(attachPty).toHaveBeenCalledWith("pty-7"));
		// A no-op resize (same size) would not repaint; a distinct size then the
		// real size guarantees a SIGWINCH and a full redraw.
		await waitFor(() =>
			expect(resizePty).toHaveBeenCalledWith("pty-7", 29, 100),
		);
		await waitFor(() =>
			expect(resizePty).toHaveBeenCalledWith("pty-7", 30, 100),
		);
	});

	it("does not touch the PTY while the surface is inactive, then redraws on reactivation", async () => {
		const { rerender } = render(
			<Terminal pty_id="pty-8" active={false} onExit={() => {}} />,
		);
		// Inactive: no forced resize.
		await new Promise((r) => setTimeout(r, 20));
		expect(resizePty).not.toHaveBeenCalled();

		rerender(<Terminal pty_id="pty-8" active onExit={() => {}} />);
		await waitFor(() =>
			expect(resizePty).toHaveBeenCalledWith("pty-8", 29, 100),
		);
		await waitFor(() =>
			expect(resizePty).toHaveBeenCalledWith("pty-8", 30, 100),
		);
	});
});
