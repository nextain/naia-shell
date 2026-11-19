// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getWebWorkspaceFile = vi.hoisted(() => vi.fn());
const adk = vi.hoisted(() => {
	let status = { phase: "ready" };
	const listeners = new Set<() => void>();
	return {
		get: () => status,
		subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		setPhase: (phase: string) => { status = { phase }; listeners.forEach((listener) => listener()); },
	};
});
vi.mock("../../../lib/web-runtime/web-workspace-files", () => ({ getWebWorkspaceFile }));
vi.mock("../Editor", () => ({ Editor: () => <div>editor</div> }));
vi.mock("../../../lib/i18n", () => ({ t: (key: string) => key }));
vi.mock("../../../lib/kiosk-demo/flag", () => ({ isKioskDemo: () => false }));
vi.mock("../../../lib/ui-preferences", () => ({ getStoredLayoutOrientation: () => null }));
vi.mock("../../../lib/kiosk-demo/knowledge", () => ({
	listKioskKnowledgeManuscripts: () => [], seedKioskAdkWorkspace: vi.fn(), seedKioskKnowledge: vi.fn(),
}));
vi.mock("../../../lib/web-runtime/web-adk-status", () => ({ getWebAdkStatus: adk.get, subscribeWebAdkStatus: adk.subscribe }));

import WebWorkspace from "../WebWorkspace";

describe("web workspace directory recovery", () => {
	afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); getWebWorkspaceFile.mockReset(); });
	beforeEach(() => { adk.setPhase("ready"); Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 }); });

	it("shows an error, prevents duplicate retry while loading and displays recovered files", async () => {
		let finish!: (value: IteratorResult<FileSystemHandle>) => void;
		const values = vi.fn()
			.mockImplementationOnce(async function* () { throw new Error("read failed"); })
			.mockImplementationOnce(() => ({
				[Symbol.asyncIterator]() { return this; },
				next: () => new Promise<IteratorResult<FileSystemHandle>>((resolve) => { finish = resolve; }),
			}));
		const dir = { values };
		vi.stubGlobal("navigator", { ...navigator, storage: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }) } });
		render(<WebWorkspace />);
		expect(await screen.findByRole("alert")).toHaveTextContent("webExplorer.readFailed");
		fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
		await waitFor(() => expect(values).toHaveBeenCalledTimes(2));
		expect(screen.getByRole("button", { name: "common.retry" })).toBeDisabled();
		expect(screen.getByRole("status")).toHaveTextContent("fileTree.loading");
		finish({ done: true, value: undefined });
		expect(await screen.findByText("fileTree.empty")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("renders the returned file list", async () => {
		const dir = { values: async function* () { yield { kind: "file", name: "notes.md" }; } };
		vi.stubGlobal("navigator", { ...navigator, storage: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }) } });
		render(<WebWorkspace />);
		expect(await screen.findByRole("button", { name: /notes\.md/ })).toBeTruthy();
	});
	it("retries a failed root open", async () => {
		const dir = { values: async function* () { yield { kind: "file", name: "root.md" }; } };
		const getDirectory = vi.fn().mockRejectedValueOnce(new Error("root failed"))
			.mockResolvedValueOnce({ getDirectoryHandle: async () => dir });
		vi.stubGlobal("navigator", { ...navigator, storage: { getDirectory } });
		render(<WebWorkspace />);
		expect(await screen.findByRole("alert")).toHaveTextContent("webExplorer.readFailed");
		fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
		expect(await screen.findByRole("button", { name: /root\.md/ })).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(getDirectory).toHaveBeenCalledTimes(2);
	});

	it("retries a failed child folder and clears its error", async () => {
		const child = { values: async function* () { yield { kind: "file", name: "child.md" }; } };
		const open = vi.fn().mockRejectedValueOnce(new Error("folder failed")).mockResolvedValueOnce(child);
		const dir = { values: async function* () { yield { kind: "directory", name: "docs" }; }, getDirectoryHandle: open };
		vi.stubGlobal("navigator", { ...navigator, storage: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }) } });
		render(<WebWorkspace />);
		fireEvent.click(await screen.findByText(/docs/));
		expect(await screen.findByRole("alert")).toHaveTextContent("webExplorer.readFailed");
		fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
		expect(await screen.findByRole("button", { name: /child\.md/ })).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(open).toHaveBeenCalledTimes(2);
	});

	it("retries a failed download and clears its error", async () => {
		const dir = { values: async function* () { yield { kind: "file", name: "notes.md" }; } };
		vi.stubGlobal("navigator", { ...navigator, storage: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }) } });
		getWebWorkspaceFile.mockRejectedValueOnce(new Error("download failed"))
			.mockResolvedValueOnce(new File(["content"], "notes.md"));
		vi.stubGlobal("URL", { createObjectURL: () => "blob:test", revokeObjectURL: vi.fn() });
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		render(<WebWorkspace />);
		fireEvent.click(await screen.findByRole("button", { name: /notes\.md/ }));
		fireEvent.click(screen.getByRole("button", { name: "webExplorer.download" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("webExplorer.readFailed");
		fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
		expect(getWebWorkspaceFile).toHaveBeenCalledTimes(2);
	});

	it("ignores a late directory response after the root changes", async () => {
		let finish!: (value: IteratorResult<FileSystemHandle>) => void;
		let first = true;
		const oldDir = { values: () => ({
			[Symbol.asyncIterator]() { return this; },
			next: () => {
				if (!first) return Promise.resolve({ done: true, value: undefined });
				first = false;
				return new Promise<IteratorResult<FileSystemHandle>>((resolve) => { finish = resolve; });
			},
		}) };
		const newDir = { values: async function* () { yield { kind: "file", name: "current.md" }; } };
		const getDirectory = vi.fn().mockResolvedValueOnce({ getDirectoryHandle: async () => oldDir })
			.mockResolvedValue({ getDirectoryHandle: async () => newDir });
		vi.stubGlobal("navigator", { ...navigator, storage: { getDirectory } });
		render(<WebWorkspace />);
		await waitFor(() => expect(finish).toBeTypeOf("function"));
		act(() => adk.setPhase("checking"));
		expect(await screen.findByRole("button", { name: /current\.md/ })).toBeTruthy();
		await act(async () => { finish({ done: false, value: { kind: "file", name: "stale.md" } as FileSystemHandle }); });
		expect(screen.queryByRole("button", { name: /stale\.md/ })).toBeNull();
		expect(screen.getByRole("button", { name: /current\.md/ })).toBeTruthy();
	});

});
