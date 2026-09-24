// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	SLIDE_PRESENTER_CANCEL_EVENT,
	SLIDE_PRESENTER_PREFETCH_EVENT,
	SLIDE_PRESENTER_SPEAK_EVENT,
	SLIDE_PRESENTER_SPEECH_RESULT_EVENT,
} from "../slide-presenter-events";
import { startSlidePresenterIframeBridge } from "../slide-presenter-iframe-bridge";

const ASSET = "http://asset.localhost";

function fireMessage(data: unknown, origin: string, source: Window | null) {
	// jsdom's MessageEvent ignores `source` in the constructor, so define it.
	const event = new MessageEvent("message", { data, origin });
	Object.defineProperty(event, "source", { value: source, configurable: true });
	window.dispatchEvent(event);
}

describe("slide-presenter iframe bridge", () => {
	let stop: (() => void) | null = null;
	afterEach(() => {
		stop?.();
		stop = null;
	});

	it("forwards a asset-origin speak message into the window SPEAK event", () => {
		stop = startSlidePresenterIframeBridge();
		const handler = vi.fn();
		window.addEventListener(SLIDE_PRESENTER_SPEAK_EVENT, handler);
		const detail = { requestId: "r1", generation: 1, page: 2, text: "안녕" };
		fireMessage({ type: "naia-slides:speak", detail }, ASSET, null);
		window.removeEventListener(SLIDE_PRESENTER_SPEAK_EVENT, handler);
		expect(handler).toHaveBeenCalledTimes(1);
		expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual(detail);
	});

	it("forwards a cancel message into the window CANCEL event", () => {
		stop = startSlidePresenterIframeBridge();
		const handler = vi.fn();
		window.addEventListener(SLIDE_PRESENTER_CANCEL_EVENT, handler);
		fireMessage(
			{ type: "naia-slides:cancel", detail: { requestId: "r1" } },
			ASSET,
			null,
		);
		window.removeEventListener(SLIDE_PRESENTER_CANCEL_EVENT, handler);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("FR-SLIDES-PREFETCH.1: forwards prefetch and discard messages", () => {
		stop = startSlidePresenterIframeBridge();
		const handler = vi.fn();
		window.addEventListener(SLIDE_PRESENTER_PREFETCH_EVENT, handler);
		const detail = { generation: 3, page: 4, text: "다음 쪽." };
		fireMessage({ type: "naia-slides:prefetch", detail }, ASSET, null);
		fireMessage({ type: "naia-slides:prefetch" }, ASSET, null);
		fireMessage(
			{ type: "naia-slides:prefetch", detail },
			"https://evil.test",
			null,
		);
		window.removeEventListener(SLIDE_PRESENTER_PREFETCH_EVENT, handler);
		expect(handler).toHaveBeenCalledTimes(2);
		expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual(detail);
		expect((handler.mock.calls[1][0] as CustomEvent).detail).toEqual({
			generation: 0,
			page: null,
			text: null,
		});
	});

	it("ignores messages from a non-asset origin", () => {
		stop = startSlidePresenterIframeBridge();
		const handler = vi.fn();
		window.addEventListener(SLIDE_PRESENTER_SPEAK_EVENT, handler);
		fireMessage(
			{ type: "naia-slides:speak", detail: { text: "x" } },
			"https://evil.test",
			null,
		);
		window.removeEventListener(SLIDE_PRESENTER_SPEAK_EVENT, handler);
		expect(handler).not.toHaveBeenCalled();
	});

	it("routes the speech result back to the requesting frame only", () => {
		stop = startSlidePresenterIframeBridge();
		const postMessage = vi.fn();
		const frame = { postMessage } as unknown as Window;
		// A speak first, so the bridge remembers the source frame.
		fireMessage(
			{ type: "naia-slides:speak", detail: { requestId: "r1", text: "hi" } },
			ASSET,
			frame,
		);
		const result = {
			requestId: "r1",
			generation: 1,
			page: 2,
			status: "finished" as const,
		};
		window.dispatchEvent(
			new CustomEvent(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, { detail: result }),
		);
		expect(postMessage).toHaveBeenCalledWith(
			{ type: "naia-slides:speech-result", detail: result },
			ASSET,
		);
	});

	it("does not post a result when no iframe speak has been seen", () => {
		stop = startSlidePresenterIframeBridge();
		// No speak message → no remembered frame → nothing to post to.
		expect(() =>
			window.dispatchEvent(
				new CustomEvent(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, {
					detail: { requestId: "x", generation: 0, page: 1, status: "finished" },
				}),
			),
		).not.toThrow();
	});
});
