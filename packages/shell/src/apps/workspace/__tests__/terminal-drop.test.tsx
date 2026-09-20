// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../pty-ipc", () => ({
	attachPty: vi.fn(() => Promise.resolve()),
	resizePty: vi.fn(() => Promise.resolve()),
	writePty: vi.fn(() => Promise.resolve()),
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

describe("Terminal — Drag and Drop capture (#679)", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("stops propagation on dragOver and drop when files are dragged", () => {
		const { container } = render(
			<Terminal pty_id="pty-drag-test" active onExit={() => {}} />,
		);
		const terminalDiv = container.querySelector(".workspace-app__terminal");
		expect(terminalDiv).toBeInTheDocument();

		// DragOver with Files
		const dragOverEvent = new Event("dragover", {
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(dragOverEvent, "dataTransfer", {
			value: { types: ["Files"] },
		});
		const stopPropagationSpyOver = vi.spyOn(dragOverEvent, "stopPropagation");
		const preventDefaultSpyOver = vi.spyOn(dragOverEvent, "preventDefault");
		terminalDiv?.dispatchEvent(dragOverEvent);
		expect(stopPropagationSpyOver).toHaveBeenCalled();
		expect(preventDefaultSpyOver).toHaveBeenCalled();

		// Drop with Files
		const dropEvent = new Event("drop", {
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(dropEvent, "dataTransfer", {
			value: { types: ["Files"] },
		});
		const stopPropagationSpyDrop = vi.spyOn(dropEvent, "stopPropagation");
		const preventDefaultSpyDrop = vi.spyOn(dropEvent, "preventDefault");
		terminalDiv?.dispatchEvent(dropEvent);
		expect(stopPropagationSpyDrop).toHaveBeenCalled();
		expect(preventDefaultSpyDrop).toHaveBeenCalled();
	});

	it("does not stop propagation when non-file items are dragged", () => {
		const { container } = render(
			<Terminal pty_id="pty-drag-test" active onExit={() => {}} />,
		);
		const terminalDiv = container.querySelector(".workspace-app__terminal");
		expect(terminalDiv).toBeInTheDocument();

		// DragOver with text
		const dragOverEvent = new Event("dragover", {
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(dragOverEvent, "dataTransfer", {
			value: { types: ["text/plain"] },
		});
		const stopPropagationSpyOver = vi.spyOn(dragOverEvent, "stopPropagation");
		terminalDiv?.dispatchEvent(dragOverEvent);
		expect(stopPropagationSpyOver).not.toHaveBeenCalled();

		// Drop with text
		const dropEvent = new Event("drop", {
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(dropEvent, "dataTransfer", {
			value: { types: ["text/plain"] },
		});
		const stopPropagationSpyDrop = vi.spyOn(dropEvent, "stopPropagation");
		terminalDiv?.dispatchEvent(dropEvent);
		expect(stopPropagationSpyDrop).not.toHaveBeenCalled();
	});
});
