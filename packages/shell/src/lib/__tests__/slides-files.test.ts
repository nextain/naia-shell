// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
	decodeSlidesPdf,
	openSlidesDocument,
	openSlidesPdf,
	SLIDES_FILES,
	watchSlidesPickerAvailable,
} from "../slides-files";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const payload = {
	pdfName: "발표.pdf",
	pdfBase64: btoa("%PDF-fixture"),
	scriptName: "발표.md",
	scriptText: "## 1. 제목\n대본",
	scriptReadFailed: false,
};
beforeEach(() => vi.mocked(invoke).mockReset());
afterEach(() => {
	vi.useRealTimers();
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
	vi.restoreAllMocks();
});
describe("Slides native file selection", () => {
	it("preserves PDF bytes and companion including empty text", () => {
		const selected = decodeSlidesPdf(payload);
		expect(selected.file.name).toBe("발표.pdf");
		expect(selected.file.size).toBe(12);
		expect(selected.file.type).toBe("application/pdf");
		expect(selected.script).toEqual({
			name: "발표.md",
			text: "## 1. 제목\n대본",
		});
		expect(decodeSlidesPdf({ ...payload, scriptText: "" }).script?.text).toBe(
			"",
		);
	});
	it("preserves the browser input when no native host exists", () => {
		const available = vi.fn();
		watchSlidesPickerAvailable(available)();
		expect(available).toHaveBeenCalledWith(false);
		expect(invoke).not.toHaveBeenCalled();
	});
	it("correlates browser opens with the negotiated document capability", async () => {
		const originalParent = window.parent;
		const parentFrame = document.createElement("iframe");
		document.body.append(parentFrame);
		const parentWindow = parentFrame.contentWindow!;
		const postMessage = vi.spyOn(parentWindow, "postMessage");
		Object.defineProperty(window, "parent", {
			configurable: true,
			value: parentWindow,
		});
		try {
			const available = vi.fn();
			const dispose = watchSlidesPickerAvailable(available);
			await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());
			const firstCall = postMessage.mock.calls[0] as unknown as [
				{ id: string },
				string,
				MessagePort[],
			];
			const probe = firstCall[0] as {
				id: string;
			};
			const hostPort = firstCall[2][0];
			hostPort.start();
			hostPort.postMessage({
				type: SLIDES_FILES,
				action: "available",
				id: probe.id,
				capability: "document-capability",
			});
			await vi.waitFor(() => expect(available).toHaveBeenCalledWith(true));
			hostPort.addEventListener("message", (event) => {
				const message = event.data;
				const data = message as {
					type: string;
					action: string;
					id: string;
					capability: string;
				};
				if (data.action !== "open") return;
				const { capability: _capability, ...withoutCapability } = data;
				hostPort.postMessage({
					...withoutCapability,
					action: "result",
					selection: null,
				});
			});
			hostPort.start();
			expect(await openSlidesDocument()).toBeNull();
			expect(hostPort).toBeDefined();
			dispose();
		} finally {
			Object.defineProperty(window, "parent", {
				configurable: true,
				value: originalParent,
			});
			parentFrame.remove();
		}
	});
	it("cancels a deferred probe when disposed before the first task", () => {
		const originalParent = window.parent;
		const parentFrame = document.createElement("iframe");
		document.body.append(parentFrame);
		const parentWindow = parentFrame.contentWindow!;
		const postMessage = vi.spyOn(parentWindow, "postMessage");
		Object.defineProperty(window, "parent", {
			configurable: true,
			value: parentWindow,
		});
		vi.useFakeTimers();
		try {
			const dispose = watchSlidesPickerAvailable(vi.fn());
			dispose();
			vi.advanceTimersByTime(0);
			expect(postMessage).not.toHaveBeenCalled();
		} finally {
			Object.defineProperty(window, "parent", {
				configurable: true,
				value: originalParent,
			});
			parentFrame.remove();
		}
	});
	it("does not queue a stale first probe across StrictMode cleanup", () => {
		const originalParent = window.parent;
		const parentFrame = document.createElement("iframe");
		document.body.append(parentFrame);
		const parentWindow = parentFrame.contentWindow!;
		const postMessage = vi.spyOn(parentWindow, "postMessage");
		Object.defineProperty(window, "parent", {
			configurable: true,
			value: parentWindow,
		});
		vi.useFakeTimers();
		try {
			const firstDispose = watchSlidesPickerAvailable(vi.fn());
			firstDispose();
			const secondDispose = watchSlidesPickerAvailable(vi.fn());
			vi.advanceTimersByTime(0);
			expect(postMessage).toHaveBeenCalledTimes(1);
			secondDispose();
		} finally {
			Object.defineProperty(window, "parent", {
				configurable: true,
				value: originalParent,
			});
			parentFrame.remove();
		}
	});
	it("invokes user-mediated selection with no pathname arguments", async () => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: {},
			configurable: true,
		});
		vi.mocked(invoke).mockResolvedValue(payload);
		const available = vi.fn();
		watchSlidesPickerAvailable(available)();
		expect(available).toHaveBeenCalledWith(true);
		expect((await openSlidesPdf())?.file.name).toBe("발표.pdf");
		expect(invoke).toHaveBeenCalledExactlyOnceWith("slides_open_pdf");
	});
	it("preserves cancellation", async () => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: {},
			configurable: true,
		});
		vi.mocked(invoke).mockResolvedValue(null);
		expect(await openSlidesPdf()).toBeNull();
	});
	it("opens a PDF or PPTX through the request-scoped native command", async () => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: {},
			configurable: true,
		});
		vi.mocked(invoke).mockResolvedValue(payload);
		const progress = vi.fn();
		const selected = await openSlidesDocument(undefined, progress);
		expect(selected?.file.name).toBe(payload.pdfName);
		expect(vi.mocked(invoke)).toHaveBeenCalledWith(
			"slides_open_document",
			expect.objectContaining({ requestId: expect.any(String) }),
		);
	});
	it("forwards abort to the matching native import request", async () => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: {},
			configurable: true,
		});
		let resolve!: (value: unknown) => void;
		vi.mocked(invoke).mockImplementation((command) => {
			if (command === "slides_open_document")
				return new Promise((r) => {
					resolve = r;
				});
			return Promise.resolve();
		});
		const abort = new AbortController();
		const pending = openSlidesDocument(abort.signal);
		await vi.waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"slides_open_document",
				expect.objectContaining({ requestId: expect.any(String) }),
			),
		);
		abort.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(invoke).toHaveBeenCalledWith(
			"slides_cancel_open",
			expect.objectContaining({ requestId: expect.any(String) }),
		);
		resolve(null);
	});
	it("does not open after unmount cancellation", async () => {
		const abort = new AbortController();
		abort.abort();
		await expect(openSlidesPdf(abort.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(invoke).not.toHaveBeenCalled();
	});
});
