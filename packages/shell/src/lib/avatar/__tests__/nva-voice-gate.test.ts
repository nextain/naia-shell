// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NvaManifest } from "../../nva";
import {
	NVA_GATE_HOLD_MS,
	NVA_GATE_THRESHOLD,
	NVA_SHELL_HOLD_MS,
	NvaAudioGate,
} from "../nva-audio-gate";
import {
	NVA_LEVEL_LEAD_MS,
	PrebakedAvatarRenderer,
	SwitchCrossfade,
} from "../prebaked-renderer";

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

	it("with the shell hold, a pause inside a sentence keeps the mouth moving instead of snapping shut", () => {
		const gate = new NvaAudioGate(NVA_GATE_THRESHOLD, NVA_SHELL_HOLD_MS);
		// The first word of an utterance opens at once.
		expect(gate.process(0.05, 33)).toBe("talking");
		// 350 ms of silence: under the 400 ms shell hold, still talking.
		expect(gate.process(0, 200)).toBe("talking");
		expect(gate.process(0, 150)).toBe("talking");
		// The voice returns before the hold elapses: it never closed.
		expect(gate.process(0.05, 33)).toBe("talking");
	});

	it("with the shell hold, a pause at or past 400 ms closes and reopens at once (no minimum closed time)", () => {
		const gate = new NvaAudioGate(NVA_GATE_THRESHOLD, NVA_SHELL_HOLD_MS);
		gate.process(0.05, 33);
		expect(gate.process(0, 399)).toBe("talking");
		expect(gate.process(0, 1)).toBe("idle");
		// Voice returns 1 ms after closing: opens at once, unlike the removed
		// NVA_SHELL_MIN_IDLE_MS rule that used to hold it shut for 250 ms more.
		expect(gate.process(0.05, 1)).toBe("talking");
	});

	it("contrast: the 200 ms web hold closes on a 300 ms in-sentence pause that the 400 ms shell hold keeps open", () => {
		const gate = new NvaAudioGate(NVA_GATE_THRESHOLD, NVA_GATE_HOLD_MS);
		gate.process(0.05, 33);
		expect(gate.process(0, 300)).toBe("idle");
	});
});

describe("NvaAudioGate.processAhead (shell, levels known ahead)", () => {
	const V = 0.05; // voiced window
	/** `ms` of levels in 20 ms windows. */
	const run = (value: number, ms: number) =>
		new Array(Math.round(ms / 20)).fill(value);
	const shellGate = () =>
		new NvaAudioGate(NVA_GATE_THRESHOLD, NVA_SHELL_HOLD_MS);

	it("closes at the very start of a pause that will last at least the hold", () => {
		const gate = shellGate();
		gate.processAhead([V, ...run(0, 600)], 20, 16);
		// First silent frame, 500 ms of silence ahead: closes now, not 400 ms later.
		expect(gate.processAhead([...run(0, 500), V], 20, 16)).toBe("idle");
	});

	it("never closes on a pause shorter than the hold, even one just under it", () => {
		const gate = shellGate();
		gate.processAhead([V], 20, 16);
		// 380 ms pause (0 now + 18 more windows), then voice.
		let levels = [...run(0, 380), V, V];
		for (let t = 0; t < 380; t += 20) {
			expect(gate.processAhead(levels, 20, 20)).toBe("talking");
			levels = levels.slice(1);
		}
		expect(gate.processAhead(levels, 20, 20)).toBe("talking");
	});

	it("a pause just over the hold closes for its whole length instead of blinking at its end", () => {
		const gate = shellGate();
		gate.processAhead([V], 20, 16);
		let levels = [...run(0, 460), V, V];
		const states: string[] = [];
		while (levels.length > 1) {
			states.push(gate.processAhead(levels.slice(0, 22), 20, 20));
			levels = levels.slice(1);
		}
		// Closed from the first silent window to the last, then open.
		expect(states.slice(0, 23)).toEqual(new Array(23).fill("idle"));
		expect(states[23]).toBe("talking");
	});

	it("closes at once when the speech ends (silence to the end of the audio)", () => {
		const gate = shellGate();
		gate.processAhead([V], 20, 16);
		expect(gate.processAhead(run(0, 420), 20, 16)).toBe("idle");
	});

	it("falls back to waiting out the hold when the levels do not reach far enough", () => {
		const gate = shellGate();
		gate.processAhead([V], 20, 16);
		// Only 100 ms known, all silent: cannot tell yet.
		expect(gate.processAhead(run(0, 100), 20, 200)).toBe("talking");
		expect(gate.processAhead(run(0, 100), 20, 120)).toBe("idle");
	});

	it("opens on the first voiced window", () => {
		const gate = shellGate();
		expect(gate.processAhead(run(0, 400), 20, 16)).toBe("idle");
		expect(gate.processAhead([V, ...run(0, 400)], 20, 16)).toBe("talking");
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

	it("keeps talking through an in-sentence pause and closes only near the 400 ms shell hold", async () => {
		const level = { value: 0.08 as number | null };
		const { renderer, idle, talking } = await speakingRenderer(level);
		expect(renderer.drawSource(1000)).toBe(talking);
		level.value = 0;
		// 300 ms of silence, under the 400 ms shell hold: still talking.
		expect(renderer.drawSource(1100)).toBe(talking);
		expect(renderer.drawSource(1300)).toBe(talking);
		// Past the hold: idle.
		expect(renderer.drawSource(1401)).toBe(idle);
		// Voice returns right away: opens at once, no minimum closed time.
		level.value = 0.08;
		expect(renderer.drawSource(1420)).toBe(talking);
		renderer.stop();
	});

	it("with levels ahead, reads NVA_LEVEL_LEAD_MS early and closes at the start of a long pause", async () => {
		const level = { value: 0.08 as number | null };
		const asked: number[] = [];
		// Voice until t=1.0 s, silence 1.0-1.6 s, voice again (20 ms windows).
		const timeline = (t: number) => (t < 1 || t >= 1.6 ? 0.08 : 0);
		let clockSec = 0;
		const renderer = new PrebakedAvatarRenderer({
			manifest: studioManifest(),
			locale: "ko-KR",
			resolveAssetUrl: async (path) => `blob:${path}`,
			voiceLevel: () => level.value,
			voiceLevelsAhead: (aheadSec) => {
				asked.push(aheadSec);
				const out: number[] = [];
				for (let i = 0; i * 0.02 <= aheadSec + 1e-9; i++)
					out.push(timeline(clockSec + i * 0.02));
				return out;
			},
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
		const idle = playingElement("blob:clips/idle.webm");
		const talking = playingElement("blob:clips/talking.webm");
		clockSec = 0.9;
		expect(renderer.drawSource(900)).toBe(talking);
		// 60 ms before the pause is audible the gate already reads it.
		clockSec = 0.93;
		expect(renderer.drawSource(930)).toBe(talking);
		clockSec = 0.95;
		expect(renderer.drawSource(950)).toBe(idle);
		// And 60 ms before the voice returns it opens again.
		clockSec = 1.53;
		expect(renderer.drawSource(1530)).toBe(idle);
		clockSec = 1.55;
		expect(renderer.drawSource(1550)).toBe(talking);
		expect(asked[0]).toBeCloseTo(
			(NVA_LEVEL_LEAD_MS + NVA_SHELL_HOLD_MS) / 1000,
		);
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
			// 400 ms shell hold elapses (from 1033): idle is chosen, talking is
			// laid over it at full strength.
			expect(frame(1433)).toEqual([
				{ source: idle, alpha: 1 },
				{ source: talking, alpha: 1 },
			]);
			const mid = frame(1483);
			expect(mid[0]).toEqual({ source: idle, alpha: 1 });
			expect(mid[1].source).toBe(talking);
			expect(mid[1].alpha).toBeCloseTo(0.5);
			// Fade over: only idle is drawn.
			expect(frame(1593)).toEqual([{ source: idle, alpha: 1 }]);
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
		// Short gap between syllables (< 400 ms shell hold): stays talking.
		level.value = 0;
		expect(renderer.drawSource(1133)).toBe(talking);
		// Pause between sentences (past the hold): back to the closed-mouth idle clip.
		expect(renderer.drawSource(1500)).toBe(idle);
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

	it("keeps the closed-mouth idle clip while speech ends and the switch to idle resolves", async () => {
		const level = { value: 0.08 as number | null };
		const { renderer, idle, talking } = await speakingRenderer(level);
		expect(renderer.drawSource(1000)).toBe(talking);
		level.value = 0;
		expect(renderer.drawSource(1500)).toBe(idle);
		// Narration settles: playIdle has not landed yet, the talking loop is
		// still the active clip, and it must not flash back on screen.
		renderer.setSpeakingVisual(false);
		expect(renderer.drawSource(1533)).toBe(idle);
		expect(renderer.drawSource(1566)).toBe(idle);
		await flush();
		expect(renderer.drawSource(1600)).toBe(idle);
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
