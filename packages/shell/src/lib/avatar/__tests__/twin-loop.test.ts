// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	TWIN_REWIND_DELAY_MS,
	TWIN_STALL_CHECK_MS,
	TWIN_STALL_MS,
	TwinLoop,
} from "../twin-loop";

/** A <video> whose play/pause/currentTime behave like a browser's, and record seeks. */
function fakeVideo(name: string) {
	const element = document.createElement("video");
	element.dataset.name = name;
	let playing = false;
	let time = 0;
	const seeks: { to: number; whilePlaying: boolean }[] = [];
	Object.defineProperty(element, "paused", { get: () => !playing });
	Object.defineProperty(element, "currentTime", {
		get: () => time,
		set: (value: number) => {
			seeks.push({ to: value, whilePlaying: playing });
			time = value;
		},
	});
	const play = vi.fn(async () => {
		playing = true;
	});
	const pause = vi.fn(() => {
		playing = false;
	});
	element.play = play;
	element.pause = pause;
	return {
		element,
		play,
		pause,
		seeks,
		/** Playback moves the clock (a stalled pipeline does not). */
		advance(seconds: number) {
			time += seconds;
		},
		/** End of stream without `loop`: the browser pauses it at the end. */
		end() {
			time = 9;
			playing = false;
			element.dispatchEvent(new Event("ended"));
		},
	};
}

describe("TwinLoop", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("clears the loop attribute on both elements", () => {
		const a = fakeVideo("a");
		const b = fakeVideo("b");
		a.element.loop = true;
		b.element.loop = true;
		new TwinLoop(a.element, b.element);
		expect(a.element.loop).toBe(false);
		expect(b.element.loop).toBe(false);
	});

	it("hands over to the twin at the end and rewinds the ended one later, while paused", async () => {
		const a = fakeVideo("a");
		const b = fakeVideo("b");
		const loop = new TwinLoop(a.element, b.element);
		await loop.play();
		expect(loop.current).toBe(a.element);

		a.end();
		expect(loop.current).toBe(b.element);
		expect(b.play).toHaveBeenCalledTimes(1);
		// Not rewound in the end handler itself.
		expect(a.seeks).toEqual([]);
		vi.advanceTimersByTime(TWIN_REWIND_DELAY_MS);
		expect(a.seeks).toEqual([{ to: 0, whilePlaying: false }]);

		b.end();
		expect(loop.current).toBe(a.element);
		expect(a.play).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(TWIN_REWIND_DELAY_MS);
		expect(b.seeks).toEqual([{ to: 0, whilePlaying: false }]);
	});

	it("does not restart or seek a loop that is already playing", async () => {
		const a = fakeVideo("a");
		const b = fakeVideo("b");
		const loop = new TwinLoop(a.element, b.element);
		await loop.play();
		await loop.play();
		await loop.play();
		expect(a.play).toHaveBeenCalledTimes(1);
		expect(a.seeks).toEqual([]);
		expect(b.seeks).toEqual([]);
	});

	it("stop() pauses and seeks nothing; the pass runs out and the loop does not hand over", async () => {
		const a = fakeVideo("a");
		const b = fakeVideo("b");
		const loop = new TwinLoop(a.element, b.element);
		await loop.play();
		loop.stop();
		expect(a.pause).not.toHaveBeenCalled();
		expect(b.pause).not.toHaveBeenCalled();
		expect(a.element.paused).toBe(false); // still running, hidden

		a.end();
		expect(b.play).not.toHaveBeenCalled();
		expect(loop.current).toBe(a.element);
		vi.advanceTimersByTime(TWIN_REWIND_DELAY_MS);
		// Ended and paused by the browser, so the rewind is safe now.
		expect(a.seeks).toEqual([{ to: 0, whilePlaying: false }]);

		await loop.play();
		expect(a.play).toHaveBeenCalledTimes(2);
	});

	it("keeps a stopping loop going without a restart when it is wanted again", async () => {
		const a = fakeVideo("a");
		const b = fakeVideo("b");
		const loop = new TwinLoop(a.element, b.element);
		await loop.play();
		loop.stop();
		await loop.play();
		expect(a.play).toHaveBeenCalledTimes(1);
		a.end();
		expect(b.play).toHaveBeenCalledTimes(1);
		expect(a.seeks).toEqual([]);
	});

	it("skips the rewind when the ended element is shown again before the delay", async () => {
		const a = fakeVideo("a");
		const b = fakeVideo("b");
		const loop = new TwinLoop(a.element, b.element);
		await loop.play();
		a.end();
		b.end(); // a very short clip: a is current again and playing
		vi.advanceTimersByTime(TWIN_REWIND_DELAY_MS);
		expect(a.seeks).toEqual([]);
		expect(b.seeks).toEqual([{ to: 0, whilePlaying: false }]);
	});

	it("stops handing over after dispose", async () => {
		const a = fakeVideo("a");
		const b = fakeVideo("b");
		const loop = new TwinLoop(a.element, b.element);
		await loop.play();
		loop.dispose();
		a.end();
		vi.advanceTimersByTime(TWIN_REWIND_DELAY_MS);
		expect(b.play).not.toHaveBeenCalled();
		expect(a.seeks).toEqual([]);
	});
});

describe("TwinLoop stall recovery", () => {
	beforeEach(() => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"setInterval",
				"clearInterval",
				"Date",
			],
		});
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("hands over from an element whose clock stopped, without pausing or seeking it", async () => {
		const a = fakeVideo("a");
		const b = fakeVideo("b");
		const fresh = fakeVideo("fresh");
		const replace = vi.fn(() => fresh.element);
		const remove = vi.fn();
		const loop = new TwinLoop(a.element, b.element, { replace, remove });
		await loop.play();
		a.advance(0.5);
		vi.advanceTimersByTime(TWIN_STALL_CHECK_MS);
		// a says it is playing, but its time stays put from here on
		vi.advanceTimersByTime(TWIN_STALL_MS + 2 * TWIN_STALL_CHECK_MS);

		expect(replace).toHaveBeenCalledTimes(1);
		expect(loop.current).toBe(b.element);
		expect(b.play).toHaveBeenCalledTimes(1);
		expect(a.pause).not.toHaveBeenCalled();
		expect(a.seeks).toEqual([]);
		expect(a.element.muted).toBe(true);

		// The fresh element takes the stalled one's turn.
		b.end();
		expect(loop.current).toBe(fresh.element);
		expect(fresh.play).toHaveBeenCalledTimes(1);

		// The stalled element is removed only when it ends by itself.
		expect(remove).not.toHaveBeenCalled();
		a.end();
		expect(remove).toHaveBeenCalledWith(a.element);
		loop.dispose();
	});

	it("leaves a loop alone while its clock moves", async () => {
		const a = fakeVideo("a");
		const b = fakeVideo("b");
		const replace = vi.fn(() => fakeVideo("fresh").element);
		const loop = new TwinLoop(a.element, b.element, { replace });
		await loop.play();
		for (let i = 0; i < 10; i++) {
			a.advance(0.04 * (TWIN_STALL_CHECK_MS / 40));
			vi.advanceTimersByTime(TWIN_STALL_CHECK_MS);
		}
		expect(replace).not.toHaveBeenCalled();
		expect(loop.current).toBe(a.element);
		loop.dispose();
	});

	it("does not treat a stopped loop as stalled", async () => {
		const a = fakeVideo("a");
		const b = fakeVideo("b");
		const replace = vi.fn(() => fakeVideo("fresh").element);
		const loop = new TwinLoop(a.element, b.element, { replace });
		await loop.play();
		loop.stop();
		vi.advanceTimersByTime(TWIN_STALL_MS * 3);
		expect(replace).not.toHaveBeenCalled();
		loop.dispose();
	});
});
