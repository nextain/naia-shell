// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NvaManifest } from "../../nva";
import { drawWithMotion } from "../nva-procedural-motion";
import {
	PrebakedAvatarRenderer,
	canCarryAlpha,
	containRect,
} from "../prebaked-renderer";

vi.mock("../nva-procedural-motion", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../nva-procedural-motion")>();
	return {
		...actual,
		drawWithMotion: vi.fn(
			(
				target: CanvasRenderingContext2D,
				source: CanvasImageSource,
				rect: import("../nva-procedural-motion").DrawRect,
				spec: import("../nva-procedural-motion").MotionSpec | null,
				tMs: number,
			) => {
				return actual.drawWithMotion(target, source, rect, spec, tMs);
			},
		),
	};
});

describe("containRect", () => {
	it("letterboxes a portrait source inside a wider target", () => {
		const rect = containRect(200, 100, 100, 200);
		expect(rect.dh).toBe(100);
		expect(rect.dw).toBe(50);
		expect(rect.dx).toBe(75);
		expect(rect.dy).toBe(0);
	});

	it("returns an empty rect for a zero-size source or target", () => {
		expect(containRect(0, 100, 100, 100)).toEqual({
			dx: 0,
			dy: 0,
			dw: 0,
			dh: 0,
		});
		expect(containRect(100, 100, 0, 0)).toEqual({ dx: 0, dy: 0, dw: 0, dh: 0 });
	});
});

describe("canCarryAlpha", () => {
	it("only webm containers can carry a real alpha channel", () => {
		expect(canCarryAlpha("clips/idle.webm")).toBe(true);
		expect(canCarryAlpha("clips/speech-ko.mp4")).toBe(false);
		expect(canCarryAlpha("clips/talking.MOV")).toBe(false);
	});
});

function baseManifest(): NvaManifest {
	return {
		nva_version: "0.2",
		canvas: { width: 100, height: 100 },
		background: { type: "transparent", color: "#cad8cc" },
		animations: {
			idle: { clip: "clips/idle.webm", loop: true, can_talk: false },
			talking: { clip: "clips/speech-ko.mp4", loop: true, can_talk: true },
		},
		speech_clips: {
			greeting: {
				clip: "clips/greeting.webm",
				locale: "ko-KR",
				text: "안녕하세요",
			},
		},
	};
}

function makeVideo(): HTMLVideoElement {
	const video = document.createElement("video");
	vi.spyOn(video, "play").mockResolvedValue();
	return video;
}

/** The element the renderer is keeping for this clip URL (not its loop twin). */
function videoForUrl(url: string): HTMLVideoElement {
	const found = [...document.querySelectorAll("video")].find(
		(element) =>
			(element as HTMLVideoElement).dataset.naiaClipUrl === url &&
			!(element as HTMLVideoElement).dataset.naiaLoopTwin,
	);
	if (!found) throw new Error(`no <video> holds ${url}`);
	return found as HTMLVideoElement;
}

describe("PrebakedAvatarRenderer", () => {
	it("never synthesizes speech itself — it only resolves and plays clips", async () => {
		const manifest = baseManifest();
		const resolveAssetUrl = vi.fn(async (path: string) => `blob:${path}`);
		const renderer = new PrebakedAvatarRenderer({
			manifest,
			locale: "ko-KR",
			resolveAssetUrl,
		});
		expect(renderer.hasAuthoredClip("안녕하세요")).toBe(true);
		expect(renderer.hasAuthoredClip("no match")).toBe(false);
		// Not implemented in this class at all — the type itself has no speak/speakAudio.
		expect((renderer as unknown as { speak?: unknown }).speak).toBeUndefined();
	});

	it("plays the idle clip on start and the talking clip on setSpeakingVisual(true)", async () => {
		const manifest = baseManifest();
		const resolveAssetUrl = vi.fn(async (path: string) => `blob:${path}`);
		const onSpeaking = vi.fn();
		const renderer = new PrebakedAvatarRenderer({
			manifest,
			locale: "ko-KR",
			resolveAssetUrl,
			onSpeaking,
		});
		const video = makeVideo();
		const canvas = document.createElement("canvas");
		renderer.start(video, canvas);
		await Promise.resolve();
		await Promise.resolve();
		expect(resolveAssetUrl).toHaveBeenCalledWith("clips/idle.webm");

		renderer.setSpeakingVisual(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(onSpeaking).toHaveBeenCalledWith(true);
		expect(resolveAssetUrl).toHaveBeenCalledWith("clips/speech-ko.mp4");

		renderer.setSpeakingVisual(false);
		await Promise.resolve();
		await Promise.resolve();
		expect(onSpeaking).toHaveBeenCalledWith(false);
		renderer.stop();
	});

	it("plays an authored clip end-to-end and returns to idle", async () => {
		const manifest = baseManifest();
		const resolveAssetUrl = vi.fn(async (path: string) => `blob:${path}`);
		const renderer = new PrebakedAvatarRenderer({
			manifest,
			locale: "ko-KR",
			resolveAssetUrl,
		});
		const video = makeVideo();
		// Each clip keeps its own <video>, so the authored clip plays on a sibling
		// of the mounted element — it must be in the DOM for that sibling to land.
		document.body.appendChild(video);
		const canvas = document.createElement("canvas");
		renderer.start(video, canvas);
		await Promise.resolve();

		const onPlaybackReady = vi.fn();
		const playPromise = renderer.playAuthoredClip("안녕하세요", {
			onPlaybackReady,
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(resolveAssetUrl).toHaveBeenCalledWith("clips/greeting.webm");
		const active = videoForUrl("blob:clips/greeting.webm");
		active.dispatchEvent(new Event("playing"));
		expect(onPlaybackReady).toHaveBeenCalled();
		active.dispatchEvent(new Event("ended"));
		await playPromise;
		renderer.stop();
		video.remove();
	});

	/**
	 * The renderer used by VideoAvatarCanvas is this one, and re-assigning `src`
	 * on every idle/talking switch is what froze the WebView on Linux during
	 * slide narration (WebKitGTK tears the old GStreamer pipeline down on the
	 * main thread and deadlocks against its demuxer; reproduced 3/3 under gdb,
	 * 2026-09-11). One <video> per clip removes the teardown entirely.
	 */
	describe("one <video> per clip (WebKitGTK pipeline teardown)", () => {
		const srcAssignments: { element: HTMLVideoElement; url: string }[] = [];
		const playCalls: HTMLVideoElement[] = [];
		const pauseCalls: HTMLVideoElement[] = [];
		let restore: (() => void) | null = null;

		beforeEach(() => {
			srcAssignments.length = 0;
			playCalls.length = 0;
			pauseCalls.length = 0;
			const original = {
				src: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src"),
				play: HTMLMediaElement.prototype.play,
				pause: HTMLMediaElement.prototype.pause,
			};
			Object.defineProperty(HTMLMediaElement.prototype, "src", {
				configurable: true,
				get(this: { __src?: string }) {
					return this.__src ?? "";
				},
				set(this: { __src?: string } & HTMLVideoElement, url: string) {
					this.__src = url;
					srcAssignments.push({ element: this, url });
				},
			});
			HTMLMediaElement.prototype.play = function play(this: HTMLVideoElement) {
				playCalls.push(this);
				return Promise.resolve();
			};
			HTMLMediaElement.prototype.pause = function pause(
				this: HTMLVideoElement,
			) {
				pauseCalls.push(this);
			};
			restore = () => {
				if (original.src)
					Object.defineProperty(
						HTMLMediaElement.prototype,
						"src",
						original.src,
					);
				HTMLMediaElement.prototype.play = original.play;
				HTMLMediaElement.prototype.pause = original.pause;
			};
		});
		afterEach(() => {
			restore?.();
			restore = null;
			document.body.innerHTML = "";
		});

		async function mounted() {
			const renderer = new PrebakedAvatarRenderer({
				manifest: baseManifest(),
				locale: "ko-KR",
				resolveAssetUrl: async (path: string) => `blob:${path}`,
			});
			const host = document.createElement("div");
			const video = document.createElement("video");
			host.appendChild(video);
			document.body.appendChild(host);
			renderer.start(video, document.createElement("canvas"));
			await settleClips();
			return { renderer, host, video };
		}

		const settleClips = async () => {
			for (let i = 0; i < 6; i++) await Promise.resolve();
		};

		it("assigns src once per element across idle→talking round trips", async () => {
			const { renderer, video } = await mounted();
			// idle, then its loop twin (TwinLoop: a loop takes two elements)
			expect(srcAssignments).toHaveLength(2);
			renderer.setSpeakingVisual(true);
			await settleClips();
			expect(srcAssignments).toHaveLength(4); // talking and its twin

			const before = srcAssignments.length;
			renderer.setSpeakingVisual(false);
			await settleClips();
			renderer.setSpeakingVisual(true);
			await settleClips();
			renderer.setSpeakingVisual(false);
			await settleClips();
			// Every later switch re-uses a decoder that is already loaded.
			expect(srcAssignments).toHaveLength(before);
			expect(srcAssignments[0].element).toBe(video);
			expect(new Set(srcAssignments.map((entry) => entry.element)).size).toBe(
				4,
			);
			expect(srcAssignments.map((entry) => entry.url)).toEqual([
				"blob:clips/idle.webm",
				"blob:clips/idle.webm",
				"blob:clips/speech-ko.mp4",
				"blob:clips/speech-ko.mp4",
			]);
			renderer.stop();
		});

		it("plays the element that owns the clip, keeps idle under talking and lets talking run out", async () => {
			const { renderer, video } = await mounted();
			playCalls.length = 0;
			pauseCalls.length = 0;
			renderer.setSpeakingVisual(true);
			await settleClips();
			const talking = videoForUrl("blob:clips/speech-ko.mp4");
			expect(playCalls).toContain(talking);
			// The idle loop keeps playing under the talking loop so the voice
			// gate can show a closed mouth in pauses. Nothing is paused: pausing a
			// playing element can freeze WebKitGTK.
			expect(pauseCalls).toEqual([]);
			const idleTwin = [...document.querySelectorAll("video")].find(
				(element) =>
					(element as HTMLVideoElement).dataset.naiaClipUrl ===
						"blob:clips/idle.webm" && element !== video,
			) as HTMLVideoElement;
			// At the end of its pass the idle loop hands over to its twin.
			playCalls.length = 0;
			video.dispatchEvent(new Event("ended"));
			await settleClips();
			expect(playCalls).toEqual([idleTwin]);

			// Speech over: the talking loop finishes its pass hidden and does not
			// hand over at the end; still nothing is paused.
			renderer.setSpeakingVisual(false);
			await settleClips();
			expect(pauseCalls).toEqual([]);
			playCalls.length = 0;
			talking.dispatchEvent(new Event("ended"));
			await settleClips();
			expect(playCalls).toEqual([]);
			renderer.stop();
		});

		/**
		 * The recording shell froze with the main thread in didEnd → doSeek (the
		 * `loop` attribute rewinding at end of stream) waiting for the video sink
		 * lock, while the sink's thread held it in triggerRepaint waiting for the
		 * main thread (gdb, 2026-09-24). Loops must not use `loop`, and no element
		 * may be sought while it plays.
		 */
		it("loops without the loop attribute, keeps idle looping under talking, and seeks only paused, hidden elements", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const playing = new Set<HTMLVideoElement>();
			const seeks: { element: HTMLVideoElement; whilePlaying: boolean }[] = [];
			const originalCurrentTime = Object.getOwnPropertyDescriptor(
				HTMLMediaElement.prototype,
				"currentTime",
			);
			const originalPaused = Object.getOwnPropertyDescriptor(
				HTMLMediaElement.prototype,
				"paused",
			);
			HTMLMediaElement.prototype.play = function play(this: HTMLVideoElement) {
				playCalls.push(this);
				playing.add(this);
				return Promise.resolve();
			};
			const pausedWhilePlaying: HTMLVideoElement[] = [];
			let tearingDown = false;
			HTMLMediaElement.prototype.pause = function pause(
				this: HTMLVideoElement,
			) {
				pauseCalls.push(this);
				if (playing.has(this) && !tearingDown) pausedWhilePlaying.push(this);
				playing.delete(this);
			};
			Object.defineProperty(HTMLMediaElement.prototype, "paused", {
				configurable: true,
				get(this: HTMLVideoElement) {
					return !playing.has(this);
				},
			});
			Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
				configurable: true,
				get(this: { __t?: number }) {
					return this.__t ?? 0;
				},
				set(this: HTMLVideoElement & { __t?: number }, value: number) {
					seeks.push({ element: this, whilePlaying: playing.has(this) });
					this.__t = value;
				},
			});
			/** What the browser does at end of stream without `loop`. */
			const endOf = (element: HTMLVideoElement) => {
				(element as unknown as { __t: number }).__t = 9;
				playing.delete(element);
				element.dispatchEvent(new Event("ended"));
			};
			try {
				const { renderer } = await mounted();
				const loopedEnds: HTMLVideoElement[] = [];
				const idleUrl = "blob:clips/idle.webm";
				const talkingUrl = "blob:clips/speech-ko.mp4";
				/** The one element of a clip's loop that is playing now. */
				const playingOf = (url: string) => {
					const found = [...playing].filter(
						(element) => element.dataset.naiaClipUrl === url,
					);
					expect(found).toHaveLength(1);
					return found[0];
				};
				/** Let a loop reach its end once; its twin must take over at once. */
				const wrap = async (url: string) => {
					const current = playingOf(url);
					endOf(current);
					loopedEnds.push(current);
					await settleClips();
					expect(playingOf(url)).not.toBe(current);
					vi.advanceTimersByTime(300);
				};
				let speaking = false;
				for (let round = 0; round < 4; round++) {
					for (let pass = 0; pass < 3; pass++) {
						if (speaking) await wrap(talkingUrl);
						// The idle loop keeps looping under the talking loop too.
						await wrap(idleUrl);
					}
					const leftTalking = speaking
						? [...playing].filter(
								(element) => element.dataset.naiaClipUrl === talkingUrl,
							)
						: [];
					speaking = !speaking;
					renderer.setSpeakingVisual(speaking);
					await settleClips();
					// The talking loop that was left finishes its pass and stops there.
					for (const element of leftTalking) {
						endOf(element);
						await settleClips();
						vi.advanceTimersByTime(300);
					}
					playingOf(idleUrl);
					if (speaking) playingOf(talkingUrl);
					else
						expect(
							[...playing].filter(
								(element) => element.dataset.naiaClipUrl === talkingUrl,
							),
						).toEqual([]);
				}
				const all = [...document.querySelectorAll("video")];
				expect(all).toHaveLength(4);
				for (const element of all) expect(element.loop).toBe(false);
				// Every loop wrap alternated elements and rewound the one that ended.
				expect(new Set(loopedEnds).size).toBeGreaterThanOrEqual(4);
				expect(seeks.length).toBeGreaterThanOrEqual(loopedEnds.length);
				expect(seeks.filter((seek) => seek.whilePlaying)).toEqual([]);
				expect(pausedWhilePlaying).toEqual([]);
				tearingDown = true;
				renderer.stop();
			} finally {
				vi.useRealTimers();
				if (originalCurrentTime)
					Object.defineProperty(
						HTMLMediaElement.prototype,
						"currentTime",
						originalCurrentTime,
					);
				if (originalPaused)
					Object.defineProperty(
						HTMLMediaElement.prototype,
						"paused",
						originalPaused,
					);
			}
		});

		it("keeps the extra clip element next to the mounted one and removes it on stop", async () => {
			const { renderer, host, video } = await mounted();
			renderer.setSpeakingVisual(true);
			await settleClips();
			const talking = videoForUrl("blob:clips/speech-ko.mp4");
			expect(talking.parentElement).toBe(host);
			// mounted idle, its twin, talking and its twin — all in the host
			expect(host.querySelectorAll("video")).toHaveLength(4);
			expect(host.firstElementChild).toBe(video);

			renderer.stop();
			// The element the host mounted stays; the ones the renderer added leave.
			expect(host.querySelectorAll("video")).toHaveLength(1);
			expect(host.querySelector("video")).toBe(video);
		});
	});

	describe("procedural motion integration", () => {
		let rafCallbacks: ((time: number) => void)[] = [];
		let origRaf: typeof requestAnimationFrame;

		beforeEach(() => {
			rafCallbacks = [];
			origRaf = window.requestAnimationFrame;
			window.requestAnimationFrame = vi.fn((cb) => {
				rafCallbacks.push(cb);
				return rafCallbacks.length;
			});
			vi.mocked(drawWithMotion).mockClear();
		});

		afterEach(() => {
			window.requestAnimationFrame = origRaf;
		});

		it("draws directly to canvas without offscreen when motion: false", async () => {
			const manifest = { ...baseManifest(), motion: false };
			const renderer = new PrebakedAvatarRenderer({
				manifest,
				locale: "ko-KR",
				resolveAssetUrl: async (p) => `blob:${p}`,
			});
			const video = makeVideo();
			Object.defineProperty(video, "readyState", {
				value: 4,
				configurable: true,
			});
			Object.defineProperty(video, "videoWidth", {
				value: 100,
				configurable: true,
			});
			Object.defineProperty(video, "videoHeight", {
				value: 100,
				configurable: true,
			});

			const mockCtx = {
				clearRect: vi.fn(),
				drawImage: vi.fn(),
				save: vi.fn(),
				restore: vi.fn(),
				translate: vi.fn(),
				rotate: vi.fn(),
			};
			const canvas = document.createElement("canvas");
			canvas.width = 100;
			canvas.height = 100;
			vi.spyOn(canvas, "getContext").mockReturnValue(mockCtx as any);

			renderer.start(video, canvas);
			expect(rafCallbacks.length).toBeGreaterThan(0);
			const [firstFrame] = rafCallbacks;
			firstFrame?.(100);

			// Direct draw to mockCtx
			expect(mockCtx.drawImage).toHaveBeenCalledWith(video, 0, 0, 100, 100);
			// No rotation applied
			expect(mockCtx.rotate).not.toHaveBeenCalled();
			renderer.stop();
		});

		it("uses offscreen canvas and applies motion when motion is enabled (default)", async () => {
			const manifest = baseManifest();
			const renderer = new PrebakedAvatarRenderer({
				manifest,
				locale: "ko-KR",
				resolveAssetUrl: async (p) => `blob:${p}`,
			});
			const video = makeVideo();
			Object.defineProperty(video, "readyState", {
				value: 4,
				configurable: true,
			});
			Object.defineProperty(video, "videoWidth", {
				value: 100,
				configurable: true,
			});
			Object.defineProperty(video, "videoHeight", {
				value: 100,
				configurable: true,
			});

			const mockCtx = {
				clearRect: vi.fn(),
				drawImage: vi.fn(),
				save: vi.fn(),
				restore: vi.fn(),
				translate: vi.fn(),
				rotate: vi.fn(),
			};
			const canvas = document.createElement("canvas");
			canvas.width = 100;
			canvas.height = 100;

			const mockOffscreenCtx = {
				clearRect: vi.fn(),
				drawImage: vi.fn(),
			};
			const getContextSpy = vi
				.spyOn(HTMLCanvasElement.prototype, "getContext")
				.mockImplementation(function (this: HTMLCanvasElement) {
					if (this === canvas) return mockCtx as any;
					return mockOffscreenCtx as any;
				});

			renderer.start(video, canvas);
			expect(rafCallbacks.length).toBeGreaterThan(0);
			const [firstFrame] = rafCallbacks;
			firstFrame?.(2000);

			// Offscreen received the video draw
			expect(mockOffscreenCtx.drawImage).toHaveBeenCalledWith(
				video,
				0,
				0,
				100,
				100,
			);
			// Target canvas received motion draw (save, restore, rotate)
			expect(mockCtx.save).toHaveBeenCalled();
			expect(mockCtx.restore).toHaveBeenCalled();

			renderer.stop();
			getContextSpy.mockRestore();
		});

		it("resolves chest_y from manifest talking animation face_bbox", async () => {
			const manifest = {
				...baseManifest(),
				animations: {
					...baseManifest().animations,
					talking: {
						clip: "clips/speech-ko.mp4",
						loop: true,
						can_talk: true,
						face_bbox: [0.2, 0.3, 0.4] as [number, number, number],
					},
				},
			};
			const renderer = new PrebakedAvatarRenderer({
				manifest,
				locale: "ko-KR",
				resolveAssetUrl: async (p) => `blob:${p}`,
			});
			// 아래끝 0.7 + 0.4 * 0.35 = 0.84
			expect((renderer as any).motionSpec?.chest_y).toBeCloseTo(0.84, 5);
			renderer.stop();
		});

		it("invokes drawWithMotion once per frame and draws both fading clips to offscreen canvas during crossfade", async () => {
			const manifest = {
				...baseManifest(),
				background: { type: "transparent" as const },
			};
			const renderer = new PrebakedAvatarRenderer({
				manifest,
				locale: "ko-KR",
				resolveAssetUrl: async (p) => `blob:${p}`,
			});

			const v1 = makeVideo();
			Object.defineProperty(v1, "readyState", { value: 4, configurable: true });
			Object.defineProperty(v1, "videoWidth", {
				value: 100,
				configurable: true,
			});
			Object.defineProperty(v1, "videoHeight", {
				value: 100,
				configurable: true,
			});

			const v2 = makeVideo();
			Object.defineProperty(v2, "readyState", { value: 4, configurable: true });
			Object.defineProperty(v2, "videoWidth", {
				value: 100,
				configurable: true,
			});
			Object.defineProperty(v2, "videoHeight", {
				value: 100,
				configurable: true,
			});

			const mockCtx = {
				clearRect: vi.fn(),
				drawImage: vi.fn(),
				save: vi.fn(),
				restore: vi.fn(),
				translate: vi.fn(),
				rotate: vi.fn(),
			};
			const canvas = document.createElement("canvas");
			canvas.width = 100;
			canvas.height = 100;

			const mockOffscreenCtx = {
				clearRect: vi.fn(),
				drawImage: vi.fn(),
			};
			const getContextSpy = vi
				.spyOn(HTMLCanvasElement.prototype, "getContext")
				.mockImplementation(function (this: HTMLCanvasElement) {
					if (this === canvas) return mockCtx as any;
					return mockOffscreenCtx as any;
				});

			const drawSourceSpy = vi
				.spyOn(renderer, "drawSource")
				.mockReturnValueOnce(v1)
				.mockReturnValue(v2);

			renderer.start(v1, canvas);
			expect(rafCallbacks.length).toBeGreaterThan(0);

			// Frame 1: v1 is drawn and established in crossfade
			const firstFrame = rafCallbacks[0];
			firstFrame?.(1000);

			mockOffscreenCtx.drawImage.mockClear();
			vi.mocked(drawWithMotion).mockClear();

			// Frame 2: switches to v2, fading v1 in crossfade
			const secondFrame = rafCallbacks[rafCallbacks.length - 1];
			secondFrame?.(1050);

			// (가)-1: 한 프레임에 drawWithMotion이 정확히 1번 불리는지
			expect(drawWithMotion).toHaveBeenCalledTimes(1);
			// (가)-2: 페이드 중이면 오프스크린에 drawImage가 2번(현재 v2, 이전 클립 v1) 불리는지
			expect(mockOffscreenCtx.drawImage).toHaveBeenCalledTimes(2);
			expect(mockOffscreenCtx.drawImage).toHaveBeenNthCalledWith(
				1,
				v2,
				0,
				0,
				100,
				100,
			);
			expect(mockOffscreenCtx.drawImage).toHaveBeenNthCalledWith(
				2,
				v1,
				0,
				0,
				100,
				100,
			);

			renderer.stop();
			getContextSpy.mockRestore();
			drawSourceSpy.mockRestore();
		});

		it("does not invoke drawWithMotion and draws both fading clips directly to screen canvas when motion is disabled", async () => {
			const manifest = {
				...baseManifest(),
				motion: false,
				background: { type: "transparent" as const },
			};
			const renderer = new PrebakedAvatarRenderer({
				manifest,
				locale: "ko-KR",
				resolveAssetUrl: async (p) => `blob:${p}`,
			});

			const v1 = makeVideo();
			Object.defineProperty(v1, "readyState", { value: 4, configurable: true });
			Object.defineProperty(v1, "videoWidth", {
				value: 100,
				configurable: true,
			});
			Object.defineProperty(v1, "videoHeight", {
				value: 100,
				configurable: true,
			});

			const v2 = makeVideo();
			Object.defineProperty(v2, "readyState", { value: 4, configurable: true });
			Object.defineProperty(v2, "videoWidth", {
				value: 100,
				configurable: true,
			});
			Object.defineProperty(v2, "videoHeight", {
				value: 100,
				configurable: true,
			});

			const mockCtx = {
				clearRect: vi.fn(),
				drawImage: vi.fn(),
				save: vi.fn(),
				restore: vi.fn(),
				translate: vi.fn(),
				rotate: vi.fn(),
			};
			const canvas = document.createElement("canvas");
			canvas.width = 100;
			canvas.height = 100;
			vi.spyOn(canvas, "getContext").mockReturnValue(mockCtx as any);

			const drawSourceSpy = vi
				.spyOn(renderer, "drawSource")
				.mockReturnValueOnce(v1)
				.mockReturnValue(v2);

			renderer.start(v1, canvas);
			expect(rafCallbacks.length).toBeGreaterThan(0);

			// Frame 1: v1 is drawn and established in crossfade
			const firstFrame = rafCallbacks[0];
			firstFrame?.(1000);

			mockCtx.drawImage.mockClear();
			vi.mocked(drawWithMotion).mockClear();

			// Frame 2: switches to v2, fading v1 in crossfade directly on target ctx
			const secondFrame = rafCallbacks[rafCallbacks.length - 1];
			secondFrame?.(1050);

			// (나)-1: drawWithMotion이 불리지 않는지
			expect(drawWithMotion).not.toHaveBeenCalled();
			// (나)-2: 화면 ctx에 페이드 두 번 그리기가 되는지 (현재 v2, 이전 클립 v1)
			expect(mockCtx.drawImage).toHaveBeenCalledTimes(2);
			expect(mockCtx.drawImage).toHaveBeenNthCalledWith(1, v2, 0, 0, 100, 100);
			expect(mockCtx.drawImage).toHaveBeenNthCalledWith(2, v1, 0, 0, 100, 100);

			renderer.stop();
			drawSourceSpy.mockRestore();
		});
	});
});
