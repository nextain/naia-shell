// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isNativeSlidesHost,
	isTrustedSlidesEntry,
	isTrustedSlidesFrame,
	RECORDING_ERROR_DETAIL_LIMIT,
	recordingFailure,
	sanitizeSlidesThemeTokens,
	SLIDES_HOST,
	SLIDES_HOST_ACTIONS,
	startSlidesHostClientBridge,
	startSlidesRecording,
	stopSlidesRecording,
} from "../slides-host";

const startNative = vi.fn<() => Promise<void>>();
const stopNative = vi.fn<() => Promise<string>>();

vi.mock("../app-sandbox", () => ({
	startSlidesRecording: startNative,
	stopSlidesRecording: stopNative,
}));

describe("Slides host client contract", () => {
	beforeEach(() => {
		startNative.mockReset().mockResolvedValue(undefined);
		stopNative.mockReset().mockResolvedValue("recordings/fixture.webm");
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: {},
		});
	});

	afterEach(() => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: undefined,
		});
	});

	it("allows only the exact installed Slides entry and frame URL", () => {
		const frame = document.createElement("iframe");
		const entry = "C:/apps/land.naia.slides/index.html";
		const source =
			"asset://localhost/C%3A%2Fapps%2Fland.naia.slides%2Findex.html";
		frame.src = source;

		expect(isTrustedSlidesEntry(entry)).toBe(true);
		expect(
			isTrustedSlidesEntry("C:/apps/land.naia.slides-copy/index.html"),
		).toBe(false);
		expect(
			isTrustedSlidesEntry(
				"https://attacker.invalid/land.naia.slides/index.html",
			),
		).toBe(false);
		expect(isTrustedSlidesFrame(frame, entry, source)).toBe(true);
		expect(isTrustedSlidesFrame(frame, entry, `${source}?other`)).toBe(false);
	});

	it("drops unknown theme properties and CSS injection values", () => {
		expect(
			sanitizeSlidesThemeTokens({
				"--bg-primary": "#faf8f2",
				"--font-family": "Inter, ui-sans-serif",
				"--not-allowlisted": "url(https://attacker.invalid)",
				"--accent-color": "red; background-image:url(https://attacker.invalid)",
			}),
		).toEqual({
			"--bg-primary": "#faf8f2",
			"--font-family": "Inter, ui-sans-serif",
		});
	});

	it("delegates native recording without accepting path or command arguments", async () => {
		expect(isNativeSlidesHost()).toBe(true);

		await startSlidesRecording();
		await expect(stopSlidesRecording()).resolves.toBe(
			"recordings/fixture.webm",
		);

		expect(startNative).toHaveBeenCalledExactlyOnceWith();
		expect(stopNative).toHaveBeenCalledExactlyOnceWith();
	});

	it("keeps a failed stop retryable, but leaves the recording state when the host reports it lost", async () => {
		await startSlidesRecording();
		stopNative.mockRejectedValueOnce("recording lock poisoned");
		await expect(stopSlidesRecording()).rejects.toBe("recording lock poisoned");
		// Still active: a retry stops the same recording.
		stopNative.mockRejectedValueOnce(
			"recording_lost: ffmpeg did not finish within 8s; the MP4 was not finalized",
		);
		await expect(stopSlidesRecording()).rejects.toMatch(/^recording_lost/);
		// Lost: the client is idle again, so a new recording can start.
		await expect(stopSlidesRecording()).rejects.toThrow("recording_not_active");
		await startSlidesRecording();
		await expect(stopSlidesRecording()).resolves.toBe(
			"recordings/fixture.webm",
		);
	});

	it("cancels a timed out iframe start so a late host start is cleaned up", async () => {
		vi.useFakeTimers();
		const originalParent = window.parent;
		const postMessage = vi.fn();
		const parentWindow = { postMessage } as unknown as Window;
		Object.defineProperty(window, "parent", {
			configurable: true,
			value: parentWindow,
		});
		const client = startSlidesHostClientBridge();
		try {
			const hello = postMessage.mock.calls[0]?.[0] as {
				id: string;
			};
			window.dispatchEvent(
				new MessageEvent("message", {
					source: parentWindow,
					origin: "http://shell.local",
					data: {
						type: SLIDES_HOST,
						action: SLIDES_HOST_ACTIONS.init,
						id: hello.id,
						capability: "capability-1",
						locale: "en",
						theme: {},
					},
				}),
			);
			await client.ready;
			const start = startSlidesRecording();
			await vi.runAllTicks();
			const request = postMessage.mock.calls.find(
				([message]) =>
					(message as { action?: string }).action ===
					SLIDES_HOST_ACTIONS.recordingStart,
			)![0] as { id: string };
			const timedOut = expect(start).rejects.toThrow("slides_host_timeout");
			await vi.advanceTimersByTimeAsync(15_000);
			await timedOut;
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: SLIDES_HOST,
					action: SLIDES_HOST_ACTIONS.recordingCancelStart,
					id: request.id,
					capability: "capability-1",
				}),
				"http://shell.local",
			);
		} finally {
			client.dispose();
			Object.defineProperty(window, "parent", {
				configurable: true,
				value: originalParent,
			});
			vi.useRealTimers();
		}
	});
});

describe("recordingFailure", () => {
	it("keeps the code first and appends the host error", () => {
		expect(
			recordingFailure(
				"recording_failed",
				new Error("current webview is not a WebviewWindow"),
			),
		).toBe("recording_failed: current webview is not a WebviewWindow");
		expect(recordingFailure("recording_failed", "x11 missing")).toBe(
			"recording_failed: x11 missing",
		);
	});

	it("falls back to the bare code for an empty or identical error", () => {
		expect(recordingFailure("recording_failed", "")).toBe("recording_failed");
		expect(recordingFailure("recording_failed", "recording_failed")).toBe(
			"recording_failed",
		);
	});

	it("strips control characters and bounds the detail length", () => {
		const result = recordingFailure(
			"recording_failed",
			`line1\nline2\u0007${"x".repeat(1000)}`,
		);
		expect(result.startsWith("recording_failed: line1 line2 ")).toBe(true);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the test asserts control characters are gone
		expect(result).not.toMatch(/[\u0000-\u001f]/);
		expect(result.length).toBe(
			"recording_failed: ".length + RECORDING_ERROR_DETAIL_LIMIT,
		);
	});
});
