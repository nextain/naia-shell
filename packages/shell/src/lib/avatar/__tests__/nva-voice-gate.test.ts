// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NvaManifest } from "../../nva";
import {
	NVA_GATE_HOLD_MS,
	NVA_GATE_THRESHOLD,
	NVA_SHELL_MIN_IDLE_MS,
	NvaAudioGate,
} from "../nva-audio-gate";
import { PrebakedAvatarRenderer, SwitchCrossfade } from "../prebaked-renderer";

describe("NvaAudioGate (same rule as the naia.land Studio clip engine)", () => {
	it("opens on voice and closes only after 200 ms of silence", () => {
		const gate = new NvaAudioGate();
		expect(gate.process(0, 33)).toBe("idle");
		expect(gate.process(0.05, 33)).toBe("talking");
		expect(gate.process(0.001, 100)).toBe("talking");
		expect(gate.process(0.001, 99)).toBe("talking");
		expect(gate.process(0.001, 1)).toBe("idle");
	});

	it("without a minimum idle time, a word right after the hold reopens at once (web rule)", () => {
		const gate = new NvaAudioGate();
		gate.process(0.05, 33);
		expect(gate.process(0, 200)).toBe("idle");
		expect(gate.process(0.05, 33)).toBe("talking");
	});

	it("with the shell minimum, a closed gate stays closed for 250 ms so no idle flash is shorter", () => {
		const gate = new NvaAudioGate(
			NVA_GATE_THRESHOLD,
			NVA_GATE_HOLD_MS,
			"idle",
			NVA_SHELL_MIN_IDLE_MS,
		);
		// The first word of an utterance opens at once.
		expect(gate.process(0.05, 33)).toBe("talking");
		expect(gate.process(0, 200)).toBe("idle");
		// Voice returns 33 ms later: still idle, the head does not flash.
		expect(gate.process(0.05, 33)).toBe("idle");
		expect(gate.process(0.05, 200)).toBe("idle");
		// 250 ms after closing, the voice opens it again.
		expect(gate.process(0.05, 17)).toBe("talking");
		// After a reset the next word opens at once again.
		expect(gate.process(0, 200)).toBe("idle");
		gate.reset();
		expect(gate.process(0.05, 0)).toBe("talking");
	});
});

describe("SwitchCrossfade", () => {
	it("fades the previous clip out over 150 ms after a switch", () => {
		const fade = new SwitchCrossfade<string>(150);
		expect(fade.next("talking", 0)).toBeNull();
		expect(fade.next("talking", 500)).toBeNull();
		expect(fade.next("idle", 1000)).toEqual({ from: "talking", alpha: 1 });
		expect(fade.next("idle", 1075)).toEqual({ from: "talking", alpha: 0.5 });
		expect(fade.next("idle", 1150)).toBeNull();
		expect(fade.next("idle", 1300)).toBeNull();
	});

	it("switching back mid-fade continues from the same mix instead of jumping", () => {
		const fade = new SwitchCrossfade<string>(150);
		fade.next("talking", 0);
		fade.next("idle", 1000);
		// 30 ms into the fade, talking is still at 80 %.
		expect(fade.next("idle", 1030)?.alpha).toBeCloseTo(0.8);
		// Voice returns: now idle fades out from 20 %, so talking shows at 80 %.
		const back = fade.next("talking", 1030);
		expect(back?.from).toBe("idle");
		expect(back?.alpha).toBeCloseTo(0.2);
		expect(fade.next("talking", 1060)).toBeNull();
	});
});

/** Studio .nva shape: idle + one looping talking clip, no per-sentence clips. */
function studioManifest(): NvaManifest {
	return {
		nva_version: "0.2",
		canvas: { width: 720, height: 1280, fps: 24 },
		background: { type: "transparent" },
		animations: {
			idle: { clip: "clips/idle.webm", loop: true, can_talk: false },
			talking: { clip: "clips/talking.webm", loop: true, can_talk: true },
		},
		expressions: { neutral: "idle", speaking: "talking" },
	};
}

function markDecoded(video: HTMLVideoElement): void {
	Object.defineProperty(video, "readyState", { value: 4, configurable: true });
	Object.defineProperty(video, "videoWidth", {
		value: 720,
		configurable: true,
	});
	Object.defineProperty(video, "videoHeight", {
		value: 1280,
		configurable: true,
	});
}

/** Every element holding a clip (a looping clip has two, see TwinLoop). */
function clipElements(url: string): HTMLVideoElement[] {
	const found = [...document.querySelectorAll("video")].filter(
		(element) => (element as HTMLVideoElement).dataset.naiaClipUrl === url,
	) as HTMLVideoElement[];
	if (found.length === 0) throw new Error(`no <video> holds ${url}`);
	return found;
}

/** Elements the test browser is playing (play() called, not paused or ended). */
const playing = new Set<HTMLMediaElement>();

/** The one element of a clip's loop that is playing now. */
function playingElement(url: string): HTMLVideoElement {
	const found = clipElements(url).filter((element) => playing.has(element));
	expect(found).toHaveLength(1);
	return found[0];
}

async function flush(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe("PrebakedAvatarRenderer voice gating", () => {
	beforeEach(() => {
		playing.clear();
		vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
			function play(this: HTMLMediaElement) {
				playing.add(this);
				return Promise.resolve();
			},
		);
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
			function pause(this: HTMLMediaElement) {
				playing.delete(this);
			},
		);
		vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(
			function paused(this: HTMLMediaElement) {
				return !playing.has(this);
			},
		);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		document.body.innerHTML = "";
	});

	async function speakingRenderer(level: { value: number | null }) {
		const renderer = new PrebakedAvatarRenderer({
			manifest: studioManifest(),
			locale: "ko-KR",
			resolveAssetUrl: async (path) => `blob:${path}`,
			voiceLevel: () => level.value,
		});
		const mounted = document.createElement("video");
		document.body.appendChild(mounted);
		renderer.start(mounted, document.createElement("canvas"));
		await flush();
		renderer.setSpeakingVisual(true);
		await flush();
		for (const element of [
			...clipElements("blob:clips/idle.webm"),
			...clipElements("blob:clips/talking.webm"),
		])
			markDecoded(element);
		// Judge against the element of each loop that is playing now.
		const idle = playingElement("blob:clips/idle.webm");
		const talking = playingElement("blob:clips/talking.webm");
		return { renderer, idle, talking };
	}

	it("keeps the idle clip at least 250 ms once shown, so a short pause does not flash it", async () => {
		const level = { value: 0.08 as number | null };
		const { renderer, idle, talking } = await speakingRenderer(level);
		expect(renderer.drawSource(1000)).toBe(talking);
		level.value = 0;
		expect(renderer.drawSource(1100)).toBe(talking);
		expect(renderer.drawSource(1200)).toBe(idle);
		level.value = 0.08;
		expect(renderer.drawSource(1233)).toBe(idle);
		expect(renderer.drawSource(1450)).toBe(talking);
		renderer.stop();
	});

	it("draws the clip it left over the new one while fading", async () => {
		const level = { value: 0.08 as number | null };
		const draws: { source: unknown; alpha: number }[] = [];
		const ctx = {
			globalAlpha: 1,
			clearRect: vi.fn(),
			drawImage(source: unknown) {
				draws.push({ source, alpha: ctx.globalAlpha });
			},
		};
		const canvas = document.createElement("canvas");
		canvas.width = 360;
		canvas.height = 640;
		Object.defineProperty(canvas, "getContext", { value: () => ctx });
		const frames: FrameRequestCallback[] = [];
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			frames.push(cb);
			return frames.length;
		});
		vi.stubGlobal("cancelAnimationFrame", () => {});
		try {
			const renderer = new PrebakedAvatarRenderer({
				manifest: studioManifest(),
				locale: "ko-KR",
				resolveAssetUrl: async (path) => `blob:${path}`,
				voiceLevel: () => level.value,
			});
			const mounted = document.createElement("video");
			document.body.appendChild(mounted);
			renderer.start(mounted, canvas);
			await flush();
			renderer.setSpeakingVisual(true);
			await flush();
			for (const element of [
				...clipElements("blob:clips/idle.webm"),
				...clipElements("blob:clips/talking.webm"),
			])
				markDecoded(element);
			const idle = playingElement("blob:clips/idle.webm");
			const talking = playingElement("blob:clips/talking.webm");
			const frame = (at: number) => {
				draws.length = 0;
				const cb = frames.shift();
				if (!cb) throw new Error("no frame requested");
				cb(at);
				return draws.slice();
			};
			frame(1000);
			frame(1033);
			level.value = 0;
			// Hold elapses: idle is chosen, talking is laid over it at full strength.
			expect(frame(1240)).toEqual([
				{ source: idle, alpha: 1 },
				{ source: talking, alpha: 1 },
			]);
			const mid = frame(1315);
			expect(mid[0]).toEqual({ source: idle, alpha: 1 });
			expect(mid[1].source).toBe(talking);
			expect(mid[1].alpha).toBeCloseTo(0.5);
			// Fade over: only idle is drawn.
			expect(frame(1400)).toEqual([{ source: idle, alpha: 1 }]);
			renderer.stop();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("shows the talking loop only while the voice is audible", async () => {
		const level = { value: 0 as number | null };
		const { renderer, idle, talking } = await speakingRenderer(level);

		// Pause before the first word: mouth closed.
		expect(renderer.drawSource(1000)).toBe(idle);
		level.value = 0.08;
		expect(renderer.drawSource(1033)).toBe(talking);
		// Short gap between syllables (< 200 ms hold): stays talking.
		level.value = 0;
		expect(renderer.drawSource(1133)).toBe(talking);
		// Pause between sentences: back to the closed-mouth idle clip.
		expect(renderer.drawSource(1300)).toBe(idle);
		renderer.stop();
	});

	it("keeps the idle clip running under the talking loop", async () => {
		const level = { value: 0 as number | null };
		const { renderer, idle, talking } = await speakingRenderer(level);
		// Both loops play at once; neither was paused to make room.
		expect(playing.has(idle)).toBe(true);
		expect(playing.has(talking)).toBe(true);
		// The idle loop still hands over at its end while speech goes on, so a
		// pause in speech always finds a moving, closed-mouth idle frame.
		playing.delete(idle);
		idle.dispatchEvent(new Event("ended"));
		await flush();
		const next = playingElement("blob:clips/idle.webm");
		expect(next).not.toBe(idle);
		expect(renderer.drawSource(1000)).toBe(next);
		renderer.stop();
	});

	it("starts the idle loop again when speech begins after a one-shot clip left it", async () => {
		const manifest = studioManifest();
		manifest.speech_clips = {
			hello: { clip: "clips/hello.webm", locale: "ko-KR", text: "안녕" },
		};
		const renderer = new PrebakedAvatarRenderer({
			manifest,
			locale: "ko-KR",
			resolveAssetUrl: async (path) => `blob:${path}`,
			voiceLevel: () => 0,
		});
		const mounted = document.createElement("video");
		document.body.appendChild(mounted);
		renderer.start(mounted, document.createElement("canvas"));
		await flush();
		void renderer.playAuthoredClip("안녕");
		await flush();
		// The idle loop was left for the one-shot clip and ran out.
		const idle = playingElement("blob:clips/idle.webm");
		playing.delete(idle);
		idle.dispatchEvent(new Event("ended"));
		await flush();
		expect(
			clipElements("blob:clips/idle.webm").filter((e) => playing.has(e)),
		).toEqual([]);

		renderer.setSpeakingVisual(true);
		await flush();
		playingElement("blob:clips/talking.webm");
		playingElement("blob:clips/idle.webm");
		renderer.stop();
	});

	it("falls back to the talking loop when the level is unknown (MP3, browser speech)", async () => {
		const level = { value: null as number | null };
		const { renderer, talking } = await speakingRenderer(level);
		expect(renderer.drawSource(1000)).toBe(talking);
		expect(renderer.drawSource(1500)).toBe(talking);
		renderer.stop();
	});

	it("ignores the level when not speaking", async () => {
		const level = { value: 0.2 as number | null };
		const { renderer, idle } = await speakingRenderer(level);
		renderer.setSpeakingVisual(false);
		await flush();
		expect(renderer.drawSource(2000)).toBe(idle);
		renderer.stop();
	});
});
