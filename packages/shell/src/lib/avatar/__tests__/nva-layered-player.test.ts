// @vitest-environment jsdom
/**
 * Double-buffer base clip swapping (nva-layered-player).
 *
 * The behavior under test is the one that froze the whole WebView on Linux
 * during slide narration (2026-09-11, reproduced 2/2 under gdb): assigning
 * `video.src` tears the previous GStreamer pipeline down synchronously, and
 * that teardown deadlocks against the demuxer thread waiting on the main
 * thread. An idle↔talk round trip never needs a new load — each buffer keeps
 * the clip it already decoded — so the fix is to not re-assign `src` when the
 * back buffer already holds that clip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NvaManifest } from "../nva-core";

vi.mock("../nva-head-overlay", () => ({
	NvaHeadOverlay: class {
		draw() {}
		dispose() {}
	},
}));
vi.mock("../nva-sync-driver", () => ({
	NvaSyncDriver: class {
		start() {}
		stop() {}
		stats() {
			return null;
		}
	},
}));

import { NvaLayeredPlayer } from "../nva-layered-player";

const MANIFEST: NvaManifest = {
	nva_version: "0.2",
	canvas: { width: 400, height: 700, fps: 25 },
	animations: {
		idle: { clip: "idle.webm", loop: true, can_talk: false },
		speak: {
			clip: "speak.webm",
			loop: true,
			can_talk: true,
			face_bbox: [0.2, 0.3, 0.4],
		},
		wave: { clip: "wave.webm", loop: false, can_talk: false, label: "손인사" },
	},
};

interface MediaDouble {
	__src?: string;
	__readyState?: number;
	__pendingLoad?: (() => void) | null;
}

const srcAssignments = new Map<HTMLMediaElement, string[]>();
const playCalls: HTMLMediaElement[] = [];
/** false = a load stays in flight until the test releases it. */
let autoComplete = true;

function installMediaDoubles(): () => void {
	const proto = HTMLMediaElement.prototype as unknown as MediaDouble &
		HTMLMediaElement;
	const original = {
		src: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src"),
		readyState: Object.getOwnPropertyDescriptor(
			HTMLMediaElement.prototype,
			"readyState",
		),
		currentTime: Object.getOwnPropertyDescriptor(
			HTMLMediaElement.prototype,
			"currentTime",
		),
		play: proto.play,
		pause: proto.pause,
		load: proto.load,
	};
	Object.defineProperty(HTMLMediaElement.prototype, "src", {
		configurable: true,
		get(this: MediaDouble) {
			return this.__src ?? "";
		},
		set(this: MediaDouble & HTMLMediaElement, value: string) {
			this.__src = value;
			this.__readyState = 0;
			const list = srcAssignments.get(this) ?? [];
			list.push(value);
			srcAssignments.set(this, list);
			const complete = () => {
				this.__pendingLoad = null;
				this.__readyState = 4;
				this.dispatchEvent(new Event("loadeddata"));
			};
			// The listeners are attached right after the assignment, so the load
			// must never complete synchronously inside the setter.
			if (autoComplete) queueMicrotask(complete);
			else this.__pendingLoad = complete;
		},
	});
	Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
		configurable: true,
		get(this: MediaDouble & { __time?: number }) {
			return this.__time ?? 0;
		},
		set(this: { __time?: number }, value: number) {
			this.__time = value;
		},
	});
	Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
		configurable: true,
		get(this: MediaDouble) {
			return this.__readyState ?? 0;
		},
	});
	HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
		playCalls.push(this);
		return Promise.resolve();
	};
	HTMLMediaElement.prototype.pause = () => {};
	// A real `load()` after removeAttribute("src") resets the element to
	// HAVE_NOTHING; the double must do the same or an aborted load would look
	// cached.
	HTMLMediaElement.prototype.load = function load(this: MediaDouble) {
		this.__pendingLoad = null;
		this.__readyState = 0;
	};
	return () => {
		if (original.src)
			Object.defineProperty(HTMLMediaElement.prototype, "src", original.src);
		if (original.readyState)
			Object.defineProperty(
				HTMLMediaElement.prototype,
				"readyState",
				original.readyState,
			);
		if (original.currentTime)
			Object.defineProperty(
				HTMLMediaElement.prototype,
				"currentTime",
				original.currentTime,
			);
		HTMLMediaElement.prototype.play = original.play;
		HTMLMediaElement.prototype.pause = original.pause;
		HTMLMediaElement.prototype.load = original.load;
	};
}

function makePlayer() {
	const canvas = document.createElement("canvas");
	canvas.width = 400;
	canvas.height = 700;
	vi.spyOn(canvas, "getContext").mockReturnValue({
		clearRect: vi.fn(),
		drawImage: vi.fn(),
		save: vi.fn(),
		restore: vi.fn(),
		beginPath: vi.fn(),
		rect: vi.fn(),
		clip: vi.fn(),
	} as unknown as CanvasRenderingContext2D);
	return new NvaLayeredPlayer(canvas, MANIFEST, {
		resolveClip: (clip) => `blob:${clip}`,
	});
}

const head = () => ({
	video: document.createElement("video"),
	audioClock: () => 0,
});

/** endSpeak() starts its swap without returning it — let it finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const assignmentsOf = (url: string) =>
	[...srcAssignments.values()].flat().filter((value) => value === url).length;

let restore: () => void;

describe("NvaLayeredPlayer base clip swapping", () => {
	beforeEach(() => {
		srcAssignments.clear();
		playCalls.length = 0;
		autoComplete = true;
		restore = installMediaDoubles();
	});
	afterEach(() => {
		restore();
		vi.restoreAllMocks();
	});

	it("reloads neither clip on an idle→talk→idle→talk round trip", async () => {
		const player = makePlayer();
		await player.start();
		await player.speak(head());
		player.endSpeak();
		await settle();
		await player.speak(head());
		player.stop();

		// Two buffers, one clip each — the round trip re-uses both decoders.
		expect(assignmentsOf("blob:idle.webm")).toBe(1);
		expect(assignmentsOf("blob:speak.webm")).toBe(1);
		for (const list of srcAssignments.values()) expect(list).toHaveLength(1);
		// Every transition still swapped: each buffer was started twice.
		expect(playCalls).toHaveLength(4);
		expect(playCalls[0]).toBe(playCalls[2]);
		expect(playCalls[1]).toBe(playCalls[3]);
		expect(playCalls[0]).not.toBe(playCalls[1]);
	});

	it("rewinds the reused clip instead of leaving it where it stopped", async () => {
		const player = makePlayer();
		await player.start();
		await player.speak(head());
		const idleBuffer = [...srcAssignments.entries()].find(
			([, list]) => list[0] === "blob:idle.webm",
		)?.[0] as HTMLMediaElement;
		idleBuffer.currentTime = 3.2;
		player.endSpeak();
		await settle();
		player.stop();
		expect(idleBuffer.currentTime).toBe(0);
	});

	it("loads the clip again after its load was aborted", async () => {
		const player = makePlayer();
		await player.start();
		autoComplete = false;
		const pending = player.speak(head()); // in flight, never completes
		expect(assignmentsOf("blob:speak.webm")).toBe(1);
		autoComplete = true;
		player.endSpeak(); // aborts the in-flight speak load
		await pending;
		await settle();
		await player.speak(head());
		player.stop();
		// The aborted buffer must not be treated as already holding the clip.
		expect(assignmentsOf("blob:speak.webm")).toBe(2);
	});

	it("loads a different clip normally", async () => {
		const player = makePlayer();
		await player.start();
		await player.gesture("wave");
		player.stop();
		expect(assignmentsOf("blob:wave.webm")).toBe(1);
	});
});
