// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../../logger";
import type { NvaManifest } from "../../nva";
import { canonicalSpeechAssetPaths } from "../nva-speech/canonical-speech-stage";
import type { SpeechPlan } from "../nva-speech/speech-timing";
import { SpeechPlayer } from "../nva-speech/vendor/speech-player.js";
import {
	PrebakedAvatarRenderer,
	canCarryAlpha,
	containRect,
} from "../prebaked-renderer";

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

/** The element the renderer is keeping for this clip URL. */
function videoForUrl(url: string): HTMLVideoElement {
	const found = [...document.querySelectorAll("video")].find(
		(element) => (element as HTMLVideoElement).dataset.naiaClipUrl === url,
	);
	if (!found) throw new Error(`no <video> holds ${url}`);
	return found as HTMLVideoElement;
}

describe("PrebakedAvatarRenderer", () => {
	it.each(["interrupt", "switch"])(
		"cancels the previous loop watchdog on %s",
		async (action) => {
			vi.useFakeTimers();
			const failure = vi.fn();
			let rejectOld!: (reason: Error) => void;
			const video = makeVideo();
			vi.mocked(video.play).mockImplementationOnce(
				() =>
					new Promise<void>((_, reject) => {
						rejectOld = reject;
					}),
			);
			vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
			document.body.appendChild(video);
			const manifest = baseManifest();
			manifest.animations.alternate = {
				clip: "clips/alternate.webm",
				loop: true,
				can_talk: false,
			};
			const renderer = new PrebakedAvatarRenderer({
				manifest,
				locale: "ko-KR",
				resolveAssetUrl: async (p) => `blob:${p}`,
				onPlaybackFailure: failure,
			});
			renderer.start(video, document.createElement("canvas"));
			await vi.advanceTimersByTimeAsync(0);
			if (action === "interrupt") renderer.interrupt();
			else renderer.setIdleOverride("alternate");
			await vi.advanceTimersByTimeAsync(8001);
			expect(failure).not.toHaveBeenCalled();
			rejectOld(new Error("superseded playback"));
			await vi.advanceTimersByTimeAsync(0);
			expect(failure).not.toHaveBeenCalled();
			renderer.stop();
			video.remove();
			vi.useRealTimers();
			vi.restoreAllMocks();
		},
	);

	it("still reports the current loop's real startup timeout", async () => {
		vi.useFakeTimers();
		const failure = vi.fn();
		const renderer = new PrebakedAvatarRenderer({
			manifest: baseManifest(),
			locale: "ko-KR",
			resolveAssetUrl: async (p) => `blob:${p}`,
			onPlaybackFailure: failure,
		});
		const video = makeVideo();
		vi.mocked(video.play).mockImplementation(() => new Promise(() => {}));
		renderer.start(video, document.createElement("canvas"));
		await vi.advanceTimersByTimeAsync(8001);
		expect(failure).toHaveBeenCalledExactlyOnceWith(
			"NVA playback start timeout",
		);
		renderer.stop();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("records decoder state without source paths and reports failure", async () => {
		const warn = vi.spyOn(Logger, "warn");
		const failure = vi.fn();
		const renderer = new PrebakedAvatarRenderer({
			manifest: baseManifest(),
			locale: "ko-KR",
			resolveAssetUrl: async () => "blob:private-path",
			onPlaybackFailure: failure,
		});
		const video = makeVideo();
		renderer.start(video, document.createElement("canvas"));
		await Promise.resolve();
		await Promise.resolve();
		Object.defineProperty(video, "error", {
			value: { code: 3, message: "Could not demultiplex" },
		});
		video.dispatchEvent(new Event("error"));
		expect(warn).toHaveBeenCalledWith(
			"PrebakedAvatarRenderer",
			"decoder error",
			expect.objectContaining({
				errorCode: 3,
				errorMessage: "Could not demultiplex",
				sourceKind: "blob",
				readyState: 0,
				networkState: 0,
			}),
		);
		expect(failure).toHaveBeenCalledOnce();
		expect(JSON.stringify(warn.mock.calls)).not.toContain("private-path");
		renderer.stop();
		warn.mockRestore();
	});

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

	it("keeps the idle clip on setSpeakingVisual(true) — no talking/aiueo loop (SoT 8)", async () => {
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
		expect(resolveAssetUrl).not.toHaveBeenCalledWith("clips/speech-ko.mp4");
		expect(resolveAssetUrl.mock.calls.map(([path]) => path)).toEqual([
			"clips/idle.webm",
		]);

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

	it("resumes idle from its last position after speech finishes", async () => {
		const playSpy = vi
			.spyOn(HTMLMediaElement.prototype, "play")
			.mockResolvedValue();
		const renderer = new PrebakedAvatarRenderer({
			manifest: baseManifest(),
			locale: "ko-KR",
			resolveAssetUrl: async (path) => `blob:${path}`,
		});
		const video = makeVideo();
		document.body.appendChild(video);
		renderer.start(video, document.createElement("canvas"));
		await Promise.resolve();
		await Promise.resolve();
		const idle = videoForUrl("blob:clips/idle.webm");
		Object.defineProperty(idle, "currentTime", {
			configurable: true,
			writable: true,
			value: 4.25,
		});

		renderer.setSpeakingVisual(true);
		await Promise.resolve();
		await Promise.resolve();
		renderer.setSpeakingVisual(false);
		await Promise.resolve();
		await Promise.resolve();

		expect(idle.currentTime).toBe(4.25);
		expect(idle.play).toHaveBeenCalled();
		renderer.stop();
		video.remove();
		playSpy.mockRestore();
	});

	it("plays only listed gestures once, muted, then returns to idle", async () => {
		const playSpy = vi
			.spyOn(HTMLMediaElement.prototype, "play")
			.mockResolvedValue();
		const manifest = baseManifest();
		manifest.animations.wave = {
			clip: "clips/wave.webm",
			loop: false,
			can_talk: false,
			label: "Wave",
		};
		const renderer = new PrebakedAvatarRenderer({
			manifest,
			locale: "ko-KR",
			resolveAssetUrl: async (path) => `blob:${path}`,
		});
		const video = makeVideo();
		document.body.appendChild(video);
		renderer.start(video, document.createElement("canvas"));
		await Promise.resolve();
		await Promise.resolve();
		expect(renderer.getGestureActions()).toEqual([
			{ key: "wave", label: "Wave" },
		]);

		const action = renderer.playAction("wave");
		await Promise.resolve();
		await Promise.resolve();
		const wave = videoForUrl("blob:clips/wave.webm");
		expect(wave.loop).toBe(false);
		expect(wave.muted).toBe(true);
		wave.dispatchEvent(new Event("ended"));
		expect(await action).toBe(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(
			playSpy.mock.contexts.filter(
				(context) =>
					(context as HTMLVideoElement).dataset.naiaClipUrl ===
					"blob:clips/idle.webm",
			),
		).toHaveLength(2);
		renderer.stop();
		video.remove();
		playSpy.mockRestore();
	});

	it("loops the idle override and goes back to the default when cleared", async () => {
		const playSpy = vi
			.spyOn(HTMLMediaElement.prototype, "play")
			.mockResolvedValue();
		const manifest = baseManifest();
		manifest.animations["keyboard-idle"] = {
			clip: "clips/keyboard-idle.webm",
			loop: true,
			can_talk: false,
		};
		const renderer = new PrebakedAvatarRenderer({
			manifest,
			locale: "ko-KR",
			resolveAssetUrl: async (path) => `blob:${path}`,
		});
		const video = makeVideo();
		document.body.appendChild(video);
		renderer.setIdleOverride("keyboard-idle");
		renderer.start(video, document.createElement("canvas"));
		await Promise.resolve();
		await Promise.resolve();
		const keyboard = videoForUrl("blob:clips/keyboard-idle.webm");
		expect(keyboard.loop).toBe(true);
		renderer.setIdleOverride("missing");
		await Promise.resolve();
		await Promise.resolve();
		expect(
			playSpy.mock.contexts.filter(
				(context) =>
					(context as HTMLVideoElement).dataset.naiaClipUrl ===
					"blob:clips/idle.webm",
			),
		).toHaveLength(1);
		renderer.stop();
		video.remove();
		playSpy.mockRestore();
	});

	it("returns to idle when a gesture clip reports a playback error", async () => {
		const playSpy = vi
			.spyOn(HTMLMediaElement.prototype, "play")
			.mockResolvedValue();
		const manifest = baseManifest();
		manifest.animations.wave = {
			clip: "clips/wave.webm",
			loop: false,
			can_talk: false,
			label: "Wave",
		};
		const renderer = new PrebakedAvatarRenderer({
			manifest,
			locale: "ko-KR",
			resolveAssetUrl: async (path) => `blob:${path}`,
		});
		const video = makeVideo();
		document.body.appendChild(video);
		renderer.start(video, document.createElement("canvas"));
		await Promise.resolve();
		await Promise.resolve();

		const action = renderer.playAction("wave");
		await Promise.resolve();
		await Promise.resolve();
		videoForUrl("blob:clips/wave.webm").dispatchEvent(new Event("error"));
		expect(await action).toBe(true);

		await vi.waitFor(() => {
			expect(
				playSpy.mock.contexts.filter(
					(context) =>
						(context as HTMLVideoElement).dataset.naiaClipUrl ===
						"blob:clips/idle.webm",
				),
			).toHaveLength(2);
		});
		renderer.stop();
		video.remove();
		playSpy.mockRestore();
	});

	it("confirms that TTS speaking visuals interrupt a gesture clip", async () => {
		vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
		const manifest = baseManifest();
		manifest.animations.wave = {
			clip: "clips/wave.webm",
			loop: false,
			can_talk: false,
			label: "Wave",
		};
		const renderer = new PrebakedAvatarRenderer({
			manifest,
			locale: "ko-KR",
			resolveAssetUrl: async (path) => `blob:${path}`,
		});
		const video = makeVideo();
		document.body.appendChild(video);
		renderer.start(video, document.createElement("canvas"));
		await Promise.resolve();
		await Promise.resolve();

		const action = renderer.playAction("wave");
		await Promise.resolve();
		await Promise.resolve();
		const wave = videoForUrl("blob:clips/wave.webm");
		const pauseWave = vi.spyOn(wave, "pause").mockImplementation(() => {});
		renderer.setSpeakingVisual(true);
		await action;

		expect(pauseWave).toHaveBeenCalled();
		renderer.stop();
		video.remove();
	});

	it("ignores unknown gestures and gestures requested during speech", async () => {
		const playSpy = vi
			.spyOn(HTMLMediaElement.prototype, "play")
			.mockResolvedValue();
		const manifest = baseManifest();
		manifest.animations.wave = {
			clip: "clips/wave.webm",
			loop: false,
			can_talk: false,
			label: "Wave",
		};
		const resolveAssetUrl = vi.fn(async (path: string) => `blob:${path}`);
		const renderer = new PrebakedAvatarRenderer({
			manifest,
			locale: "ko-KR",
			resolveAssetUrl,
		});
		const video = makeVideo();
		renderer.start(video, document.createElement("canvas"));
		await Promise.resolve();
		await Promise.resolve();
		const loadedAssets = resolveAssetUrl.mock.calls.length;

		expect(await renderer.playAction("missing")).toBe(false);
		renderer.setSpeakingVisual(true);
		expect(await renderer.playAction("wave")).toBe(false);

		expect(resolveAssetUrl).toHaveBeenCalledTimes(loadedAssets);
		expect(resolveAssetUrl).not.toHaveBeenCalledWith("clips/wave.webm");
		renderer.stop();
		playSpy.mockRestore();
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

		/** Start the authored greeting clip; returns a function that ends it. */
		async function beginGreeting(renderer: PrebakedAvatarRenderer) {
			const done = renderer.playAuthoredClip("안녕하세요");
			await settleClips();
			return async () => {
				videoForUrl("blob:clips/greeting.webm").dispatchEvent(
					new Event("ended"),
				);
				await done;
				await settleClips();
			};
		}

		it("assigns src once per clip across idle→greeting round trips", async () => {
			const { renderer, video } = await mounted();
			expect(srcAssignments).toHaveLength(1); // idle
			const end = await beginGreeting(renderer);
			expect(srcAssignments).toHaveLength(2); // greeting, on a second element
			await end();

			const before = srcAssignments.length;
			await (await beginGreeting(renderer))();
			// Every later switch re-uses a decoder that is already loaded.
			expect(srcAssignments).toHaveLength(before);
			expect(srcAssignments[0].element).toBe(video);
			expect(srcAssignments[1].element).not.toBe(video);
			expect(srcAssignments.map((entry) => entry.url)).toEqual([
				"blob:clips/idle.webm",
				"blob:clips/greeting.webm",
			]);
			renderer.stop();
		});

		it("plays the element that owns the clip and pauses the one it left", async () => {
			const { renderer, video } = await mounted();
			playCalls.length = 0;
			pauseCalls.length = 0;
			const end = await beginGreeting(renderer);
			const greeting = videoForUrl("blob:clips/greeting.webm");
			expect(playCalls).toContain(greeting);
			expect(playCalls).not.toContain(video);
			expect(pauseCalls).toContain(video);
			await end();
			renderer.stop();
		});

		it("keeps the extra clip element next to the mounted one and removes it on stop", async () => {
			const { renderer, host, video } = await mounted();
			const end = await beginGreeting(renderer);
			await end();
			const talking = videoForUrl("blob:clips/greeting.webm");
			expect(talking.parentElement).toBe(host);
			expect(video.nextSibling).toBe(talking);
			expect(host.querySelectorAll("video")).toHaveLength(2);

			renderer.stop();
			// The element the host mounted stays; the ones the renderer added leave.
			expect(host.querySelectorAll("video")).toHaveLength(1);
			expect(host.querySelector("video")).toBe(video);
		});
	});

	it("supports greeting motion during initial greeting and round-robin idle gestures (idea/guidance)", async () => {
		const playSpy = vi
			.spyOn(HTMLMediaElement.prototype, "play")
			.mockResolvedValue();
		const manifest = baseManifest();
		manifest.animations.greeting = {
			clip: "clips/greeting.webm",
			loop: false,
			can_talk: false,
			label: "손 흔들며 인사",
		};
		manifest.animations.guidance = {
			clip: "clips/guidance.webm",
			loop: false,
			can_talk: false,
			label: "손짓하며 안내",
		};
		manifest.animations.idea = {
			clip: "clips/idea.webm",
			loop: false,
			can_talk: false,
			label: "떠오른 생각",
		};
		const renderer = new PrebakedAvatarRenderer({
			manifest,
			locale: "ko-KR",
			resolveAssetUrl: async (path) => `blob:${path}`,
		});
		const video = makeVideo();
		document.body.appendChild(video);
		renderer.start(video, document.createElement("canvas"));
		await Promise.resolve();
		await Promise.resolve();

		expect(renderer.getIdleGestureActions().map((a) => a.key)).toEqual([
			"guidance",
			"idea",
		]);

		// Greeting gesture is preserved even when setSpeakingVisual(true) is called during initial greeting
		const greetingPromise = renderer.playGreetingAction();
		await Promise.resolve();
		await Promise.resolve();
		renderer.setSpeakingVisual(true);
		const greetingVid = videoForUrl("blob:clips/greeting.webm");
		expect(await greetingPromise).toBe("greeting");
		renderer.setSpeakingVisual(false);
		greetingVid.dispatchEvent(new Event("ended"));
		await Promise.resolve();
		await Promise.resolve();

		// Round-robin idle variation cycles through non-greeting clips (guidance -> idea)
		const firstIdle = renderer.triggerNextIdleGesture();
		await Promise.resolve();
		await Promise.resolve();
		expect(await firstIdle).toBe("guidance");
		videoForUrl("blob:clips/guidance.webm").dispatchEvent(new Event("ended"));
		await Promise.resolve();
		await Promise.resolve();

		const secondIdle = renderer.triggerNextIdleGesture();
		await Promise.resolve();
		await Promise.resolve();
		expect(await secondIdle).toBe("idea");
		videoForUrl("blob:clips/idea.webm").dispatchEvent(new Event("ended"));
		await Promise.resolve();

		renderer.stop();
		video.remove();
		playSpy.mockRestore();
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

			// Offscreen received the video draw with high smoothing quality
			expect(mockOffscreenCtx.drawImage).toHaveBeenCalledWith(
				video,
				0,
				0,
				100,
				100,
			);
			expect((mockOffscreenCtx as any).imageSmoothingEnabled).toBe(true);
			expect((mockOffscreenCtx as any).imageSmoothingQuality).toBe("high");
			expect((mockCtx as any).imageSmoothingEnabled).toBe(true);
			expect((mockCtx as any).imageSmoothingQuality).toBe("high");
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

		it("composites .stacked.mp4 clips via stacked-alpha compositor with half videoHeight and skips compositor for .webm clips", async () => {
			const stackedCanvas = document.createElement("canvas");
			const mockCompositor = {
				canvas: stackedCanvas,
				draw: vi.fn(() => true),
				dispose: vi.fn(),
			};
			const createStackedAlpha = vi.fn(() => mockCompositor);

			const manifest = { ...baseManifest(), motion: false };
			let resolvedUrl = "/nva/naia/clips/idle.stacked.mp4";
			const renderer = new PrebakedAvatarRenderer({
				manifest,
				locale: "ko-KR",
				resolveAssetUrl: async () => resolvedUrl,
				createStackedAlpha,
			});

			const host = document.createElement("div");
			const video = makeVideo();
			host.appendChild(video);
			document.body.appendChild(host);
			Object.defineProperty(video, "readyState", {
				value: 4,
				configurable: true,
			});
			Object.defineProperty(video, "videoWidth", {
				value: 720,
				configurable: true,
			});
			Object.defineProperty(video, "videoHeight", {
				value: 2560,
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
			canvas.width = 720;
			canvas.height = 1280;
			vi.spyOn(canvas, "getContext").mockReturnValue(mockCtx as any);

			renderer.start(video, canvas);
			await Promise.resolve();
			await Promise.resolve();
			const [firstFrame] = rafCallbacks;
			firstFrame?.(100);

			// .stacked.mp4 (720x2560) uses half height (720x1280) for containRect -> full 720x1280 target
			expect(createStackedAlpha).toHaveBeenCalledTimes(1);
			expect((renderer as unknown as { keyer: unknown }).keyer).toBeNull();
			expect(
				(renderer as unknown as { keyerFailed: boolean }).keyerFailed,
			).toBe(false);
			expect(mockCompositor.draw).toHaveBeenCalledWith(video);
			expect(mockCtx.drawImage).toHaveBeenCalledWith(
				stackedCanvas,
				0,
				0,
				720,
				1280,
			);

			// Regular .webm clip does not pass through stacked-alpha compositor
			mockCompositor.draw.mockClear();
			mockCtx.drawImage.mockClear();
			resolvedUrl = "/nva/naia/clips/idle.webm";
			const webmRenderer = new PrebakedAvatarRenderer({
				manifest,
				locale: "ko-KR",
				resolveAssetUrl: async () => resolvedUrl,
				createStackedAlpha,
			});
			const webmVideo = makeVideo();
			Object.defineProperty(webmVideo, "readyState", {
				value: 4,
				configurable: true,
			});
			Object.defineProperty(webmVideo, "videoWidth", {
				value: 720,
				configurable: true,
			});
			Object.defineProperty(webmVideo, "videoHeight", {
				value: 1280,
				configurable: true,
			});
			webmRenderer.start(webmVideo, canvas);
			await Promise.resolve();
			await Promise.resolve();
			const lastFrame = rafCallbacks[rafCallbacks.length - 1];
			lastFrame?.(200);
			expect(mockCompositor.draw).not.toHaveBeenCalled();
			expect(mockCtx.drawImage).toHaveBeenCalledWith(
				webmVideo,
				0,
				0,
				720,
				1280,
			);

			renderer.stop();
			expect(mockCompositor.dispose).toHaveBeenCalledTimes(1);
			webmRenderer.stop();
			host.remove();
		});

		it("draws only the top half of a .stacked.mp4 clip without falling back to chromakey when WebGL fails", async () => {
			const manifest = {
				...baseManifest(),
				chroma_key: "#00ff00",
				motion: false,
			};
			const renderer = new PrebakedAvatarRenderer({
				manifest,
				locale: "ko-KR",
				resolveAssetUrl: async () => "/nva/naia/clips/idle.stacked.mp4",
				createStackedAlpha: () => {
					throw new Error("WebGL unavailable");
				},
			});
			const video = makeVideo();
			Object.defineProperty(video, "readyState", {
				value: 4,
				configurable: true,
			});
			Object.defineProperty(video, "videoWidth", {
				value: 720,
				configurable: true,
			});
			Object.defineProperty(video, "videoHeight", {
				value: 2560,
				configurable: true,
			});
			const mockCtx = {
				clearRect: vi.fn(),
				drawImage: vi.fn(),
			};
			const canvas = document.createElement("canvas");
			canvas.width = 720;
			canvas.height = 1280;
			vi.spyOn(canvas, "getContext").mockReturnValue(mockCtx as any);

			renderer.start(video, canvas);
			await Promise.resolve();
			await Promise.resolve();
			const [firstFrame] = rafCallbacks;
			firstFrame?.(100);

			expect(mockCtx.drawImage).toHaveBeenCalledWith(
				video,
				0,
				0,
				720,
				1280,
				0,
				0,
				720,
				1280,
			);
			renderer.stop();
		});

		it("processes transparent WebM clips through NvaChromakeyGL alpha-repair mode when WebGL2 is available", async () => {
			const manifest = {
				...baseManifest(),
				background: { type: "transparent" as const },
				motion: false,
			};
			const renderer = new PrebakedAvatarRenderer({
				manifest,
				locale: "ko-KR",
				resolveAssetUrl: async () => "/nva/jina/clips/idle.webm",
			});
			const repairedCanvas = document.createElement("canvas");
			const mockKeyer = {
				setParams: vi.fn(),
				process: vi.fn(() => repairedCanvas),
				dispose: vi.fn(),
			};
			(renderer as unknown as { keyer: typeof mockKeyer }).keyer = mockKeyer;

			const video = makeVideo();
			Object.defineProperty(video, "readyState", {
				value: 4,
				configurable: true,
			});
			Object.defineProperty(video, "videoWidth", {
				value: 720,
				configurable: true,
			});
			Object.defineProperty(video, "videoHeight", {
				value: 1280,
				configurable: true,
			});
			const mockCtx = {
				clearRect: vi.fn(),
				drawImage: vi.fn(),
			};
			const canvas = document.createElement("canvas");
			canvas.width = 720;
			canvas.height = 1280;
			vi.spyOn(canvas, "getContext").mockReturnValue(mockCtx as any);

			renderer.start(video, canvas);
			await Promise.resolve();
			await Promise.resolve();
			const [firstFrame] = rafCallbacks;
			firstFrame?.(100);

			expect(mockKeyer.setParams).toHaveBeenCalledWith({
				mode: "alpha-repair",
			});
			expect(mockKeyer.process).toHaveBeenCalledWith(video, 720, 1280);
			expect(mockCtx.drawImage).toHaveBeenCalledWith(
				repairedCanvas,
				0,
				0,
				720,
				1280,
			);
			renderer.stop();
		});

		it("processes alpha-repair at native video texel resolution even when target canvas rect is upscaled and eliminates crown notches, anime hair dotted islands, and skirt staircase dark fringes at pixel level (fix7f)", async () => {
			const manifest = {
				...baseManifest(),
				background: { type: "transparent" as const },
				motion: false,
			};
			const renderer = new PrebakedAvatarRenderer({
				manifest,
				locale: "ko-KR",
				resolveAssetUrl: async () => "/nva/jina/clips/idle.webm",
			});
			const repairedCanvas = document.createElement("canvas");
			const mockKeyer = {
				setParams: vi.fn(),
				process: vi.fn(() => repairedCanvas),
				dispose: vi.fn(),
			};
			(renderer as unknown as { keyer: typeof mockKeyer }).keyer = mockKeyer;

			const video = makeVideo();
			Object.defineProperty(video, "readyState", {
				value: 4,
				configurable: true,
			});
			Object.defineProperty(video, "videoWidth", {
				value: 720,
				configurable: true,
			});
			Object.defineProperty(video, "videoHeight", {
				value: 1280,
				configurable: true,
			});
			const mockCtx = {
				clearRect: vi.fn(),
				drawImage: vi.fn(),
				imageSmoothingEnabled: false,
				imageSmoothingQuality: "low",
			};
			const canvas = document.createElement("canvas");
			canvas.width = 988;
			canvas.height = 1756;
			vi.spyOn(canvas, "getContext").mockReturnValue(mockCtx as any);

			renderer.start(video, canvas);
			await Promise.resolve();
			await Promise.resolve();
			const [firstFrame] = rafCallbacks;
			firstFrame?.(100);

			// Keyer must run at 1:1 native video resolution (720x1280), not upscaled 988x1756
			expect(mockKeyer.process).toHaveBeenCalledWith(video, 720, 1280);
			expect(mockCtx.imageSmoothingEnabled).toBe(true);
			expect(mockCtx.imageSmoothingQuality).toBe("high");
			renderer.stop();

			// Verify NvaChromakeyGL shader source contains the fix7f guards and run pixel-level evaluation
			const { NvaChromakeyGL } = await import("../nva-chromakey-gl");
			let capturedFragSource = "";
			const fakeGl = {
				VERTEX_SHADER: 0x8b31,
				FRAGMENT_SHADER: 0x8b30,
				COMPILE_STATUS: 0x8b81,
				LINK_STATUS: 0x8b82,
				ARRAY_BUFFER: 0x8892,
				STATIC_DRAW: 0x88e4,
				FLOAT: 0x1406,
				TEXTURE_2D: 0x0de1,
				TEXTURE_WRAP_S: 0x2802,
				TEXTURE_WRAP_T: 0x2803,
				TEXTURE_MIN_FILTER: 0x2801,
				TEXTURE_MAG_FILTER: 0x2800,
				CLAMP_TO_EDGE: 0x812f,
				LINEAR: 0x2601,
				createShader: vi.fn(() => ({})),
				shaderSource: vi.fn((_sh: unknown, src: string) => {
					if (src.includes("u_mode")) capturedFragSource = src;
				}),
				compileShader: vi.fn(),
				getShaderParameter: vi.fn(() => true),
				getShaderInfoLog: vi.fn(() => ""),
				deleteShader: vi.fn(),
				createProgram: vi.fn(() => ({})),
				attachShader: vi.fn(),
				linkProgram: vi.fn(),
				getProgramParameter: vi.fn(() => true),
				getProgramInfoLog: vi.fn(() => ""),
				deleteProgram: vi.fn(),
				useProgram: vi.fn(),
				createBuffer: vi.fn(() => ({})),
				bindBuffer: vi.fn(),
				bufferData: vi.fn(),
				getAttribLocation: vi.fn(() => 0),
				enableVertexAttribArray: vi.fn(),
				vertexAttribPointer: vi.fn(),
				createTexture: vi.fn(() => ({})),
				bindTexture: vi.fn(),
				texParameteri: vi.fn(),
				getUniformLocation: vi.fn(() => ({})),
				uniform1i: vi.fn(),
			};
			const getContextSpy = vi
				.spyOn(HTMLCanvasElement.prototype, "getContext")
				.mockImplementation(((type: string) =>
					type === "webgl2" ? fakeGl : null) as never);
			new NvaChromakeyGL({ mode: "alpha-repair" });
			getContextSpy.mockRestore();

			expect(capturedFragSource).toContain("sampleBaseA");
			expect(capturedFragSource).toContain("sampleCleanA");
			expect(capturedFragSource).toContain("sampleBgReach");
			expect(capturedFragSource).toContain("sampleBoundaryA");
			expect(capturedFragSource).toContain("isConnectedStrand");
			expect(capturedFragSource).toContain("u_maskTex");
			expect(capturedFragSource).not.toMatch(/v_uv\.y\s*[<>]/);
			expect(capturedFragSource).not.toMatch(/v_uv\.x\s*[<>]/);

			// Pixel-level reference evaluation of the position-invariant alpha-repair shader on a 64x64 patch
			const W = 64;
			const H = 64;
			const makeGrid = () => new Uint8ClampedArray(W * H * 4);
			const setPx = (
				grid: Uint8ClampedArray,
				x: number,
				y: number,
				r: number,
				g: number,
				b: number,
				a: number,
			) => {
				if (x < 0 || x >= W || y < 0 || y >= H) return;
				const idx = (y * W + x) * 4;
				grid[idx] = r;
				grid[idx + 1] = g;
				grid[idx + 2] = b;
				grid[idx + 3] = a;
			};
			const getPx = (grid: Uint8ClampedArray, x: number, y: number) => {
				const cx = Math.max(0, Math.min(W - 1, Math.round(x)));
				const cy = Math.max(0, Math.min(H - 1, Math.round(y)));
				const idx = (cy * W + cx) * 4;
				return [
					grid[idx] / 255,
					grid[idx + 1] / 255,
					grid[idx + 2] / 255,
					grid[idx + 3] / 255,
				] as const;
			};
			const luma = (rgb: readonly [number, number, number]) =>
				rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
			const smoothstep = (e0: number, e1: number, x: number) => {
				const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
				return t * t * (3 - 2 * t);
			};
			const evalPixel = (
				grid: Uint8ClampedArray,
				x: number,
				y: number,
			): [number, number, number, number] => {
				const sampleBaseA = (sx: number, sy: number) => {
					const s0 = getPx(grid, sx, sy);
					const a0 = s0[3];
					if (a0 > 0.02 && a0 < 0.8) {
						const aU1 = getPx(grid, sx, sy - 1)[3];
						const aU2 = getPx(grid, sx, sy - 2)[3];
						const aD1 = getPx(grid, sx, sy + 1)[3];
						const aL1 = getPx(grid, sx - 1, sy)[3];
						const aR1 = getPx(grid, sx + 1, sy)[3];
						const exposedTop = aU1 < 0.05 || (aU1 < 0.8 && aU2 < 0.05);
						const exposedBottom = aD1 < 0.05;
						const exposedSide = aL1 < 0.05 || aR1 < 0.05;
						const coolTint = s0[2] > s0[0] + 0.03 || s0[1] > s0[0] + 0.03;
						const lowChromaGray =
							Math.max(s0[0], s0[1], s0[2]) - Math.min(s0[0], s0[1], s0[2]) <
								0.06 && luma([s0[0], s0[1], s0[2]]) > 0.12;
						if (
							(exposedTop || exposedBottom || exposedSide) &&
							(coolTint || lowChromaGray)
						) {
							return 0;
						}
					}
					return a0;
				};
				const sampleCleanA = (sx: number, sy: number) => {
					let baseA = sampleBaseA(sx, sy);
					const aU1 = sampleBaseA(sx, sy - 1);
					const aU2 = sampleBaseA(sx, sy - 2);
					const aD1 = sampleBaseA(sx, sy + 1);
					const aD2 = sampleBaseA(sx, sy + 2);
					const aD3 = sampleBaseA(sx, sy + 3);
					const aL1 = sampleBaseA(sx - 1, sy);
					const aL2 = sampleBaseA(sx - 2, sy);
					const aR1 = sampleBaseA(sx + 1, sy);
					const aR2 = sampleBaseA(sx + 2, sy);
					const vBridge =
						Math.max(aU1, aU2) >= 0.8 &&
						Math.max(aD1, aD2) >= 0.8 &&
						Math.max(Math.max(aD1, aD2), aD3) >= 0.85 &&
						aU2 >= 0.55;
					const hBridge =
						Math.max(aL1, aL2) >= 0.8 &&
						Math.max(aR1, aR2) >= 0.8 &&
						Math.max(aD1, aD2) >= 0.8 &&
						aL2 >= 0.8 &&
						aR2 >= 0.8;
					if (vBridge) {
						baseA = Math.max(
							baseA,
							Math.min(Math.max(aU1, aU2), Math.max(aD1, aD2)),
						);
					}
					if (hBridge) {
						baseA = Math.max(
							baseA,
							Math.min(Math.max(aL1, aL2), Math.max(aR1, aR2)),
						);
					}
					return baseA;
				};

				const [cr, cg, cb, ca] = getPx(grid, x, y);
				let rgb: [number, number, number] = [cr, cg, cb];
				let a = ca;
				const cleanA = sampleCleanA(x, y);
				const dirs: [number, number][] = [
					[1, 0],
					[0.7071, -0.7071],
					[0, -1],
					[-0.7071, -0.7071],
					[-1, 0],
					[-0.7071, 0.7071],
					[0, 1],
					[0.7071, 0.7071],
				];
				let minA1 = cleanA;
				let minA2 = cleanA;
				let minA3 = cleanA;
				let sumA1 = cleanA;
				let sumA2 = 0;
				let op1 = 0;
				for (const [dx, dy] of dirs) {
					const a1 = sampleCleanA(x + dx * 1.25, y + dy * 1.25);
					const a2 = sampleCleanA(x + dx * 2.25, y + dy * 2.25);
					const a3 = sampleCleanA(x + dx * 3.25, y + dy * 3.25);
					minA1 = Math.min(minA1, a1);
					minA2 = Math.min(minA2, a2);
					minA3 = Math.min(minA3, a3);
					sumA1 += a1;
					sumA2 += a2;
					if (a1 >= 0.75) op1++;
				}
				const avgA1 = sumA1 / 9;
				const avgA2 = sumA2 / 8;
				if (a >= 0.98 && minA3 >= 0.96) {
					return [
						Math.round(rgb[0] * 255),
						Math.round(rgb[1] * 255),
						Math.round(rgb[2] * 255),
						255,
					];
				}
				const dirHair22 = new Array<number>(8).fill(0);
				let holeFillR = 0;
				let holeFillG = 0;
				let holeFillB = 0;
				let holeFillW = 0;
				for (let d = 0; d < 8; d++) {
					const [dx, dy] = dirs[d];
					let h22 = 0;
					for (let step = 3; step <= 15; step++) {
						const r = step <= 8 ? step : 8 + (step - 8) * 2;
						const [srR, srG, srB] = getPx(grid, x + dx * r, y + dy * r);
						const sra = sampleCleanA(x + dx * r, y + dy * r);
						const srL = luma([srR, srG, srB]);
						const srChroma =
							Math.max(srR, srG, srB) - Math.min(srR, srG, srB);
						if (sra >= 0.08 && srL < 0.3 && srChroma < 0.12) {
							h22 = Math.max(h22, sra);
						}
						if (sra >= 0.65 && srL < 0.28 && srChroma < 0.12) {
							const cleanG = Math.min(srG, Math.max(srR, srB) + 0.02);
							const w = (sra * sra) / r;
							holeFillR += srR * w;
							holeFillG += cleanG * w;
							holeFillB += srB * w;
							holeFillW += w;
						}
					}
					dirHair22[d] = h22;
				}
				const hairDirs22 = dirHair22.filter((v) => v >= 0.35).length;
				const cardinalEnclosed =
					dirHair22[2] >= 0.55 &&
					dirHair22[6] >= 0.75 &&
					dirHair22[4] >= 0.55 &&
					dirHair22[0] >= 0.55 &&
					hairDirs22 >= 6;
				const fillRgb: [number, number, number] =
					holeFillW > 0
						? [
								holeFillR / holeFillW,
								holeFillG / holeFillW,
								holeFillB / holeFillW,
							]
						: rgb;
				if (holeFillW > 0 && luma(fillRgb) < 0.26 && cardinalEnclosed) {
					rgb[1] = Math.min(rgb[1], Math.max(rgb[0], rgb[2]) + 0.02);
					if (fillRgb[2] <= fillRgb[0] + 0.04) {
						rgb[1] = Math.min(rgb[1], rgb[0] + 0.02);
						rgb[2] = Math.min(rgb[2], rgb[0] + 0.03);
					}
					const t = smoothstep(0.15, 0.85, a);
					rgb = [
						fillRgb[0] * (1 - t) + rgb[0] * t,
						fillRgb[1] * (1 - t) + rgb[1] * t,
						fillRgb[2] * (1 - t) + rgb[2] * t,
					];
					return [
						Math.round(rgb[0] * 255),
						Math.round(rgb[1] * 255),
						Math.round(rgb[2] * 255),
						255,
					];
				}
				if (cleanA <= 0.02) return [0, 0, 0, 0];
				let bestLuma = 0;
				let bestRgb: [number, number, number] = [...rgb];
				let sumInR = 0;
				let sumInG = 0;
				let sumInB = 0;
				let inWeight = 0;
				for (const [dx, dy] of dirs) {
					for (let r = 3; r <= 6; r++) {
						const s = getPx(grid, x + dx * r, y + dy * r);
						const sNext = getPx(grid, x + dx * (r + 1), y + dy * (r + 1));
						if (s[3] >= 0.96 && sNext[3] >= 0.96) {
							const sl = luma([s[0], s[1], s[2]]);
							const sc = Math.max(s[0], s[1], s[2]) - Math.min(s[0], s[1], s[2]);
							const w = sl + sc * 0.8 + 0.1;
							sumInR += s[0] * w;
							sumInG += s[1] * w;
							sumInB += s[2] * w;
							inWeight += w;
							if (sl + sc * 0.5 > bestLuma) {
								bestLuma = sl + sc * 0.5;
								bestRgb = [s[0], s[1], s[2]];
							}
						}
					}
				}
				const avgInRgb: [number, number, number] =
					inWeight > 0
						? [sumInR / inWeight, sumInG / inWeight, sumInB / inWeight]
						: rgb;
				const inLuma = inWeight > 0 ? luma(avgInRgb) : luma(rgb);
				const inChroma =
					Math.max(avgInRgb[0], avgInRgb[1], avgInRgb[2]) -
					Math.min(avgInRgb[0], avgInRgb[1], avgInRgb[2]);
				const isDarkHairEdge =
					inLuma < 0.22 && luma(rgb) < 0.25 && inChroma < 0.12;
				if (a < 0.98 && !isDarkHairEdge) {
					const d = Math.max(a, 0.28);
					rgb = [
						Math.min(1, rgb[0] / d),
						Math.min(1, rgb[1] / d),
						Math.min(1, rgb[2] / d),
					];
				}
				rgb[1] = Math.min(rgb[1], Math.max(rgb[0], rgb[2]) + 0.03);
				if (inWeight > 0 && !isDarkHairEdge) {
					const targetRgb: [number, number, number] = [
						avgInRgb[0] * 0.4 + bestRgb[0] * 0.6,
						avgInRgb[1] * 0.4 + bestRgb[1] * 0.6,
						avgInRgb[2] * 0.4 + bestRgb[2] * 0.6,
					];
					const curL = luma(rgb);
					const targetL = luma(targetRgb);
					const curC = Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
					const targetC =
						Math.max(targetRgb[0], targetRgb[1], targetRgb[2]) -
						Math.min(targetRgb[0], targetRgb[1], targetRgb[2]);
					const lumaLoss = Math.max(0, targetL - curL);
					const chromaLoss = Math.max(0, targetC - curC);
					if (lumaLoss > 0.03 || (targetC > 0.12 && chromaLoss > 0.06)) {
						const repL =
							lumaLoss > 0.03
								? Math.max(0.35, Math.min(1, lumaLoss / Math.max(0.08, targetL)))
								: 0;
						const repC =
							targetC > 0.12 && chromaLoss > 0.06
								? Math.max(0.55, Math.min(1, chromaLoss / Math.max(0.08, targetC)))
								: 0;
						const repT = Math.max(repL, repC);
						rgb = [
							rgb[0] * (1 - repT) + targetRgb[0] * repT,
							rgb[1] * (1 - repT) + targetRgb[1] * repT,
							rgb[2] * (1 - repT) + targetRgb[2] * repT,
						];
					}
				}
				const aL_1 = sampleCleanA(x - 1, y);
				const aR_1 = sampleCleanA(x + 1, y);
				const aL_2 = sampleCleanA(x - 2, y);
				const aR_2 = sampleCleanA(x + 2, y);
				const aU_1 = sampleCleanA(x, y - 1);
				const aD_1 = sampleCleanA(x, y + 1);
				const aU_2 = sampleCleanA(x, y - 2);
				const aD_2 = sampleCleanA(x, y + 2);
				const aL_3 = sampleCleanA(x - 3, y);
				const aR_3 = sampleCleanA(x + 3, y);
				const aU_3 = sampleCleanA(x, y - 3);
				const aD_3 = sampleCleanA(x, y + 3);
				const aU_5 = sampleCleanA(x, y - 5);
				const aD_5 = sampleCleanA(x, y + 5);
				const aL_5 = sampleCleanA(x - 5, y);
				const aR_5 = sampleCleanA(x + 5, y);
				const vSpan = aU_1 >= 0.75 && aD_1 >= 0.75 && (aU_5 >= 0.75 || aD_5 >= 0.75);
				const hSpan = aL_1 >= 0.75 && aR_1 >= 0.75 && (aL_5 >= 0.75 || aR_5 >= 0.75);
				const thinH = Math.min(aL_1, aR_1) < 0.2 && Math.min(aL_2, aR_2) < 0.2;
				const thinV = Math.min(aU_1, aD_1) < 0.2 && Math.min(aU_2, aD_2) < 0.2;
				const trenchH =
					(aL_1 < 0.15 && aL_2 >= 0.85 && aL_3 >= 0.85) ||
					(aR_1 < 0.15 && aR_2 >= 0.85 && aR_3 >= 0.85);
				const trenchV =
					(aU_1 < 0.15 && aU_2 >= 0.85 && aU_3 >= 0.85) ||
					(aD_1 < 0.15 && aD_2 >= 0.85 && aD_3 >= 0.85);
				const isThinConnectedLine =
					cleanA >= 0.85 &&
					((vSpan && thinH && !trenchH) || (hSpan && thinV && !trenchV));
				const isCardinalInterior =
					cleanA >= 0.85 &&
					aL_1 >= 0.8 &&
					aR_1 >= 0.8 &&
					aU_1 >= 0.8 &&
					aD_1 >= 0.8;
				const isIsolatedIsland =
					Math.max(aU_3, aD_3) < 0.2 && Math.max(aL_3, aR_3) < 0.2;
				const isTrenchIsland =
					(thinH && trenchH && a < 0.95) || (thinV && trenchV && a < 0.95);
				if (isIsolatedIsland || isTrenchIsland) {
					a = 0;
				} else if (isThinConnectedLine || isCardinalInterior) {
					a = cleanA;
				} else if (cleanA < 0.85 || minA1 < 0.5 || op1 < 5) {
					const erode1 = smoothstep(0.45, 0.96, minA1);
					const erode2 = smoothstep(0.25, 0.9, minA2 * 0.65 + avgA2 * 0.35);
					a = Math.min(cleanA, avgA1) * erode1 * (0.2 + 0.8 * erode2);
				} else {
					a = cleanA;
				}
				if (a < 0.05) a = 0;
				return [
					Math.round(rgb[0] * 255),
					Math.round(rgb[1] * 255),
					Math.round(rgb[2] * 255),
					Math.round(a * 255),
				];
			};

			// Case 1 (Jina crown): semi-transparent cyan top fringe (y=10) + 1px scanline dropout (y=13)
			const crownGrid = makeGrid();
			for (let py = 11; py <= 35; py++) {
				for (let px = 12; px <= 52; px++) {
					setPx(crownGrid, px, py, 22, 18, 17, 255);
				}
			}
			for (let px = 24; px <= 40; px++) {
				setPx(crownGrid, px, 10, 25, 39, 49, 193);
			}
			for (let px = 26; px <= 38; px++) {
				setPx(crownGrid, px, 13, 25, 39, 49, 0);
			}
			const topFringeOut = evalPixel(crownGrid, 32, 10);
			expect(topFringeOut[3]).toBe(0); // Cyan top fringe stripped to alpha 0
			const scanlineHoleOut = evalPixel(crownGrid, 32, 13);
			expect(scanlineHoleOut[3]).toBe(255); // 1px scanline dropout bridged and filled to opaque

			// Case 2 (Jina-anime hair outer boundary): 1px detached dark island at x=18 separated by x=19 (a=0) from solid hair x>=20
			const animeGrid = makeGrid();
			for (let py = 10; py <= 50; py++) {
				setPx(animeGrid, 18, py, 18, 20, 25, 210); // detached 1px dark island
				setPx(animeGrid, 19, py, 0, 0, 0, 0); // 1px trench
				for (let px = 20; px <= 48; px++) {
					setPx(animeGrid, px, py, 35, 38, 46, 255); // solid hair interior
				}
			}
			const detachedIslandOut = evalPixel(animeGrid, 18, 30);
			const trenchOut = evalPixel(animeGrid, 19, 30);
			expect(detachedIslandOut[3]).toBe(0); // Detached 1px dark island eroded to 0
			expect(trenchOut[3]).toBe(0); // Trench not falsely filled as an interior hole

			// Case 3 (Photoreal Jina burgundy skirt edge): interior burgundy (72,9,16) + 2px black/gray border at x=41..42
			const skirtGrid = makeGrid();
			for (let py = 10; py <= 50; py++) {
				for (let px = 15; px <= 40; px++) {
					setPx(skirtGrid, px, py, 72, 9, 16, 255);
				}
				setPx(skirtGrid, 41, py, 8, 9, 14, 240); // black border
				setPx(skirtGrid, 42, py, 59, 60, 65, 160); // outer gray border
			}
			const skirtEdgeOut = evalPixel(skirtGrid, 41, 30);
			const skirtOuterOut = evalPixel(skirtGrid, 42, 30);
			expect(skirtEdgeOut[0]).toBeGreaterThanOrEqual(50); // Decontaminated from black (8) to burgundy red (>=50)
			expect(skirtEdgeOut[0]).toBeGreaterThan(skirtEdgeOut[1] * 2);
			expect(skirtOuterOut[3]).toBe(0); // Outer gray fringe eroded away

			// Case 4 (fix7g connected 2x20 thin line vs detached 2x3 island):
			const lineGrid = makeGrid();
			for (let py = 25; py <= 55; py++) {
				for (let px = 16; px <= 48; px++) {
					setPx(lineGrid, px, py, 40, 28, 24, 255);
				}
			}
			for (let py = 5; py < 25; py++) {
				setPx(lineGrid, 32, py, 40, 28, 24, 255);
				setPx(lineGrid, 33, py, 40, 28, 24, 255);
			}
			for (let py = 10; py < 13; py++) {
				setPx(lineGrid, 8, py, 40, 28, 24, 255);
				setPx(lineGrid, 9, py, 40, 28, 24, 255);
			}
			expect(evalPixel(lineGrid, 32, 12)[3]).toBeGreaterThanOrEqual(240);
			expect(evalPixel(lineGrid, 8, 11)[3]).toBe(0);

			// Case 5 (fix7g position-invariant 4x4 interior hole restoration):
			const makeHolePatch = (centerY: number) => {
				const g = makeGrid();
				for (let py = centerY - 12; py <= centerY + 12; py++) {
					for (let px = 16; px <= 48; px++) {
						setPx(g, px, py, 20, 20, 25, 255);
					}
				}
				for (let py = centerY - 2; py < centerY + 2; py++) {
					for (let px = 30; px < 34; px++) {
						setPx(g, px, py, 0, 0, 0, 0);
					}
				}
				return evalPixel(g, 32, centerY);
			};
			const holeTop = makeHolePatch(16);
			const holeBot = makeHolePatch(46);
			expect(holeTop[3]).toBe(255);
			expect(holeBot).toEqual(holeTop);
		});

		it("runs multi-pass FBO flood at lowered resolution and caches unchanged video frames in NvaChromakeyGL (fix7h)", async () => {
			const { NvaChromakeyGL } = await import("../nva-chromakey-gl");
			const shaderSources: string[] = [];
			const drawCalls: number[] = [];
			const viewports: [number, number][] = [];
			const fakeGl = {
				VERTEX_SHADER: 0x8b31,
				FRAGMENT_SHADER: 0x8b30,
				COMPILE_STATUS: 0x8b81,
				LINK_STATUS: 0x8b82,
				ARRAY_BUFFER: 0x8892,
				STATIC_DRAW: 0x88e4,
				FLOAT: 0x1406,
				TEXTURE_2D: 0x0de1,
				TEXTURE0: 0x84c0,
				TEXTURE1: 0x84c1,
				TEXTURE_WRAP_S: 0x2802,
				TEXTURE_WRAP_T: 0x2803,
				TEXTURE_MIN_FILTER: 0x2801,
				TEXTURE_MAG_FILTER: 0x2800,
				CLAMP_TO_EDGE: 0x812f,
				LINEAR: 0x2601,
				NEAREST: 0x2600,
				RGBA: 0x1908,
				UNSIGNED_BYTE: 0x1401,
				FRAMEBUFFER: 0x8d40,
				COLOR_ATTACHMENT0: 0x8ce0,
				COLOR_BUFFER_BIT: 0x4000,
				TRIANGLES: 0x0004,
				UNPACK_FLIP_Y_WEBGL: 0x9240,
				isContextLost: vi.fn(() => false),
				createShader: vi.fn(() => ({})),
				shaderSource: vi.fn((_sh: unknown, src: string) => {
					shaderSources.push(src);
				}),
				compileShader: vi.fn(),
				getShaderParameter: vi.fn(() => true),
				getShaderInfoLog: vi.fn(() => ""),
				deleteShader: vi.fn(),
				createProgram: vi.fn(() => ({})),
				attachShader: vi.fn(),
				linkProgram: vi.fn(),
				getProgramParameter: vi.fn(() => true),
				getProgramInfoLog: vi.fn(() => ""),
				deleteProgram: vi.fn(),
				useProgram: vi.fn(),
				createBuffer: vi.fn(() => ({})),
				bindBuffer: vi.fn(),
				bufferData: vi.fn(),
				deleteBuffer: vi.fn(),
				getAttribLocation: vi.fn(() => 0),
				enableVertexAttribArray: vi.fn(),
				vertexAttribPointer: vi.fn(),
				createTexture: vi.fn(() => ({})),
				bindTexture: vi.fn(),
				deleteTexture: vi.fn(),
				activeTexture: vi.fn(),
				texParameteri: vi.fn(),
				texImage2D: vi.fn(),
				pixelStorei: vi.fn(),
				createFramebuffer: vi.fn(() => ({})),
				bindFramebuffer: vi.fn(),
				framebufferTexture2D: vi.fn(),
				deleteFramebuffer: vi.fn(),
				getUniformLocation: vi.fn(() => ({})),
				uniform1i: vi.fn(),
				uniform1f: vi.fn(),
				uniform2f: vi.fn(),
				uniform3f: vi.fn(),
				viewport: vi.fn((_x: number, _y: number, w: number, h: number) => {
					viewports.push([w, h]);
				}),
				clearColor: vi.fn(),
				clear: vi.fn(),
				drawArrays: vi.fn((_mode: number, _first: number, count: number) => {
					drawCalls.push(count);
				}),
				getExtension: vi.fn(() => ({ loseContext: vi.fn() })),
			};
			const getContextSpy = vi
				.spyOn(HTMLCanvasElement.prototype, "getContext")
				.mockImplementation(((type: string) =>
					type === "webgl2" ? fakeGl : null) as never);

			const keyer = new NvaChromakeyGL({ mode: "alpha-repair" });
			getContextSpy.mockRestore();

			// Verify 3 programs compiled: final composite, seed pass, flood pass
			expect(
				shaderSources.some(
					(s) => s.includes("passBg") && s.includes("isCore"),
				),
			).toBe(true);
			expect(
				shaderSources.some(
					(s) => s.includes("openBg") && s.includes("openFg"),
				),
			).toBe(true);

			const video = makeVideo();
			Object.defineProperty(video, "videoWidth", {
				value: 720,
				configurable: true,
			});
			Object.defineProperty(video, "videoHeight", {
				value: 1280,
				configurable: true,
			});
			Object.defineProperty(video, "currentTime", {
				value: 1.0,
				writable: true,
				configurable: true,
			});
			video.dataset.naiaClipUrl = "blob:clips/idle.webm";

			// First frame at t=1.0 runs lowered-resolution (360x640) seed + 16 flood passes + 1 full-res (720x1280) composite = 18 draws
			keyer.process(video, 720, 1280);
			expect(drawCalls).toHaveLength(18);
			expect(viewports).toContainEqual([360, 640]);
			expect(viewports).toContainEqual([720, 1280]);

			// Second call with identical video source and currentTime=1.0 reuses cached canvas with 0 additional GPU draws
			keyer.process(video, 720, 1280);
			expect(drawCalls).toHaveLength(18);

			// Advancing video.currentTime invalidates cache and runs GPU passes again
			video.currentTime = 1.033;
			keyer.process(video, 720, 1280);
			expect(drawCalls).toHaveLength(36);

			keyer.dispose();
		});
	});

	it("does not call onPlaybackFailure when pending idle play() is interrupted by pause() with AbortError during gesture transition", async () => {
		const playSpy = vi
			.spyOn(HTMLMediaElement.prototype, "play")
			.mockResolvedValue();
		const pauseSpy = vi
			.spyOn(HTMLMediaElement.prototype, "pause")
			.mockImplementation(() => {});
		const manifest = baseManifest();
		manifest.animations.greeting = {
			clip: "clips/greeting.webm",
			loop: false,
			can_talk: false,
			label: "반가운 인사",
		};
		const onPlaybackFailure = vi.fn();
		const renderer = new PrebakedAvatarRenderer({
			manifest,
			locale: "ko-KR",
			resolveAssetUrl: async (path) => `blob:${path}`,
			onPlaybackFailure,
		});
		const video = document.createElement("video");
		document.body.appendChild(video);
		renderer.start(video, document.createElement("canvas"));
		await Promise.resolve();
		await Promise.resolve();

		const idleVideo = videoForUrl("blob:clips/idle.webm");
		// Start first gesture ("guidance" aliases to "greeting" when guidance is removed from manifest)
		const firstGesture = renderer.playAction("guidance");
		await Promise.resolve();
		await Promise.resolve();
		const greetingVideo = videoForUrl("blob:clips/greeting.webm");
		greetingVideo.dispatchEvent(new Event("playing"));
		expect(await firstGesture).toBe(true);

		// Make the next idle.play() stay pending until pause() interrupts it with AbortError
		let rejectPendingIdlePlay!: (reason?: unknown) => void;
		vi.spyOn(idleVideo, "play").mockImplementationOnce(
			() =>
				new Promise<void>((_, reject) => {
					rejectPendingIdlePlay = reject;
				}),
		);
		vi.spyOn(idleVideo, "pause").mockImplementationOnce(() => {
			rejectPendingIdlePlay?.(
				new DOMException(
					"The play() request was interrupted by a call to pause.",
					"AbortError",
				),
			);
		});

		// Finishing the first gesture triggers playIdle() -> idleVideo.play() is now pending
		greetingVideo.dispatchEvent(new Event("ended"));
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// Triggering the next gesture while idleVideo.play() is pending pauses idleVideo and rejects play() with AbortError
		const secondGesture = renderer.playAction("greeting");
		await Promise.resolve();
		await Promise.resolve();
		greetingVideo.dispatchEvent(new Event("playing"));
		expect(await secondGesture).toBe(true);
		await Promise.resolve();
		await Promise.resolve();

		expect(onPlaybackFailure).not.toHaveBeenCalled();

		// Finishing the second gesture returns cleanly to idle
		greetingVideo.dispatchEvent(new Event("ended"));
		await Promise.resolve();
		await Promise.resolve();
		expect(onPlaybackFailure).not.toHaveBeenCalled();

		renderer.stop();
		video.remove();
		playSpy.mockRestore();
		pauseSpy.mockRestore();
	});

	it("still calls onPlaybackFailure and clears the canvas on a genuine non-abort playback rejection", async () => {
		const onPlaybackFailure = vi.fn();
		const renderer = new PrebakedAvatarRenderer({
			manifest: baseManifest(),
			locale: "ko-KR",
			resolveAssetUrl: async (path) => `blob:${path}`,
			onPlaybackFailure,
		});
		const video = document.createElement("video");
		vi.spyOn(video, "play").mockRejectedValue(
			new DOMException("Failed to initialize decoder", "NotSupportedError"),
		);
		const clearRect = vi.fn();
		const canvas = document.createElement("canvas");
		canvas.width = 412;
		canvas.height = 733;
		vi.spyOn(canvas, "getContext").mockReturnValue({
			clearRect,
			drawImage: vi.fn(),
		} as never);

		renderer.start(video, canvas);
		await vi.waitFor(() => {
			expect(onPlaybackFailure).toHaveBeenCalledOnce();
		});
		expect(onPlaybackFailure).toHaveBeenCalledWith("NVA playback rejected");
		expect(clearRect).toHaveBeenCalledWith(0, 0, 412, 733);
		renderer.stop();
	});

	it("caches speech bundle asset Blobs per renderer so prefetchSpeechTiming does not re-fetch speech/atlas.bin across stages", async () => {
		const origCreateImageBitmap = globalThis.createImageBitmap;
		globalThis.createImageBitmap = vi.fn() as never;
		const getContextSpy = vi
			.spyOn(HTMLCanvasElement.prototype, "getContext")
			.mockReturnValue({
				clearRect: vi.fn(),
				drawImage: vi.fn(),
			} as never);
		const loadAudioClockSpy = vi
			.spyOn(SpeechPlayer.prototype, "loadAudioClock")
			.mockResolvedValue({} as never);
		const playAudioClockSpy = vi
			.spyOn(SpeechPlayer.prototype, "playAudioClock")
			.mockResolvedValue(undefined as never);
		const stopSpy = vi
			.spyOn(SpeechPlayer.prototype, "stop")
			.mockImplementation(() => {});
		const disposeSpy = vi
			.spyOn(SpeechPlayer.prototype, "dispose")
			.mockImplementation(() => {});

		const speechManifest: NvaManifest = {
			...baseManifest(),
			speech_motion: {
				version: "1",
				representation: "whole-head-layer",
				region: [0, 0, 10, 10],
				neutral_head: "speech/neutral-head.png",
				atlas: "speech/atlas.bin",
				atlas_index: "speech/atlas-index.json",
				validation_report: "speech/validation.json",
				quality_report: "speech/quality.json",
				provenance: "speech/provenance.json",
			},
		} as NvaManifest;

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input) => {
				return new Response(String(input), { status: 200 });
			});

		const playSpy = vi
			.spyOn(HTMLMediaElement.prototype, "play")
			.mockResolvedValue();
		const pauseSpy = vi
			.spyOn(HTMLMediaElement.prototype, "pause")
			.mockImplementation(() => {});
		const host = document.createElement("div");
		const video = makeVideo();
		host.appendChild(video);
		document.body.appendChild(host);

		const renderer = new PrebakedAvatarRenderer({
			manifest: speechManifest,
			locale: "ko-KR",
			resolveAssetUrl: async (path) => `/nva/jina/${path}`,
		});
		renderer.start(video, document.createElement("canvas"));
		await Promise.resolve();
		await Promise.resolve();

		const samplePlan: SpeechPlan = {
			version: "1",
			quality_mode: "aligned",
			audio: { duration_us: 400_000 },
			events: [{ unit: "sil", start_us: 0, end_us: 400_000 }],
		};

		// 1. Before warmSpeechAssets resolves, speaking uses animations.talking.clip fallback
		renderer.setSpeakingVisual(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(videoForUrl("/nva/jina/clips/speech-ko.mp4")).toBeDefined();
		renderer.setSpeakingVisual(false);
		await Promise.resolve();
		await Promise.resolve();

		// 2. Warm speech assets on initial stage
		await renderer.warmSpeechAssets();
		// 2. Prepare on initial stage
		await renderer.prepareSpeechTiming(samplePlan);
		// 3. Prefetch across two new CanonicalSpeechStage instances
		const firstPrefetch = await renderer.prefetchSpeechTiming(samplePlan);
		expect(firstPrefetch).not.toBeNull();
		await firstPrefetch?.play(() => 0);
		const secondPrefetch = await renderer.prefetchSpeechTiming(samplePlan);
		expect(secondPrefetch).not.toBeNull();

		const expectedPaths = canonicalSpeechAssetPaths(speechManifest);
		expect(expectedPaths).toContain("speech/atlas.bin");
		expect(fetchSpy).toHaveBeenCalledTimes(expectedPaths.length);
		const atlasCalls = fetchSpy.mock.calls.filter(([url]) =>
			String(url).endsWith("speech/atlas.bin"),
		);
		expect(atlasCalls).toHaveLength(1);

		renderer.stop();
		host.remove();
		playSpy.mockRestore();
		pauseSpy.mockRestore();
		globalThis.createImageBitmap = origCreateImageBitmap;
		getContextSpy.mockRestore();
		loadAudioClockSpy.mockRestore();
		playAudioClockSpy.mockRestore();
		stopSpy.mockRestore();
		disposeSpy.mockRestore();
		fetchSpy.mockRestore();
	});
});
