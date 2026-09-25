// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Terminal } from "../Terminal";

let capturedLinkProvider: {
	provideLinks: (
		bufferLineNumber: number,
		callback: (links: Array<{ activate: (e: MouseEvent, text: string) => void; text: string }> | undefined) => void,
	) => void;
} | null = null;

let lineContent = "";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn((cmd: string, args: Record<string, unknown>) => {
		if (cmd === "fs_exists") {
			if (args.path === "src/exists.ts") return Promise.resolve(true);
			return Promise.resolve(false);
		}
		return Promise.resolve();
	}),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("../pty-ipc", () => ({
	attachPty: vi.fn(() => Promise.resolve()),
	resizePty: vi.fn(() => Promise.resolve()),
	writePty: vi.fn(() => Promise.resolve()),
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
		registerLinkProvider = vi.fn((provider) => {
			capturedLinkProvider = provider;
		});
		onData = vi.fn(() => ({ dispose: vi.fn() }));
		onBinary = vi.fn(() => ({ dispose: vi.fn() }));
		buffer = {
			active: {
				getLine: () => ({
					translateToString: () => lineContent,
				}),
			},
		};
		options: Record<string, unknown> = {};
	},
}));

vi.mock("../../../lib/i18n", () => ({ t: (key: string) => key }));
vi.mock("../../../lib/logger", () => ({
	Logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

globalThis.ResizeObserver = class {
	observe = vi.fn();
	unobserve = vi.fn();
	disconnect = vi.fn();
};

describe("Terminal File Link Provider (#678)", () => {
	it("opens file when fs_exists returns true", async () => {
		lineContent = "error at src/exists.ts:10:5";
		const onFileLocation = vi.fn();
		const onExit = vi.fn();

		render(
			<Terminal
				pty_id="test-pty"
				active={true}
				onExit={onExit}
				onFileLocation={onFileLocation}
			/>,
		);

		expect(capturedLinkProvider).not.toBeNull();
		let linksResult: Array<{ activate: (e: MouseEvent, text: string) => void; text: string }> = [];
		capturedLinkProvider?.provideLinks(1, (links) => {
			linksResult = links ?? [];
		});

		expect(linksResult.length).toBeGreaterThan(0);
		const link = linksResult[0];

		// Activate link
		link.activate(new MouseEvent("click", { ctrlKey: true }), link.text);

		await waitFor(() => {
			expect(onFileLocation).toHaveBeenCalledWith({
				path: "src/exists.ts",
				line: 10,
				column: 5,
			});
		});
	});

	it("shows toast and does not open file when fs_exists returns false", async () => {
		lineContent = "error at src/missing.ts:20:1";
		const onFileLocation = vi.fn();
		const onExit = vi.fn();

		render(
			<Terminal
				pty_id="test-pty"
				active={true}
				onExit={onExit}
				onFileLocation={onFileLocation}
			/>,
		);

		let linksResult: Array<{ activate: (e: MouseEvent, text: string) => void; text: string }> = [];
		capturedLinkProvider?.provideLinks(1, (links) => {
			linksResult = links ?? [];
		});

		expect(linksResult.length).toBeGreaterThan(0);
		const link = linksResult[0];

		// Activate link for missing file
		link.activate(new MouseEvent("click", { ctrlKey: true }), link.text);

		await waitFor(() => {
			expect(screen.getByRole("alert")).toHaveTextContent(
				"workspace.fileNotFound",
			);
		});
		expect(onFileLocation).not.toHaveBeenCalled();
	});
});
