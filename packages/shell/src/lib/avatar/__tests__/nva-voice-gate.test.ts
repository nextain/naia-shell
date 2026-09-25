// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NvaManifest } from "../../nva";
import { levelsAround } from "../../voice/voice-level";
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

describe("NvaAudioGate.processAround (shell, pause measured on the audio clock)", () => {
	const V = 0.05; // voiced window
	/** `ms` of levels in 20 ms windows. */
	const run = (value: number, ms: number) =>
		new Array(Math.round(ms / 20)).fill(value);
	const shellGate = (initial: "idle" | "talking" = "talking") =>
		new NvaAudioGate(NVA_GATE_THRESHOLD, NVA_SHELL_HOLD_MS, initial);

	it("closes at the very start of a pause that will last at least the hold", () => {
		const gate = shellGate();
		// Now = first silent window, 500 ms of silence ahead.
		expect(gate.processAround([V, ...run(0, 500), V], 1, 20)).toBe("idle");
	});

	it("a pause of exactly the hold (20 windows) closes; one window less does not", () => {
		expect(shellGate().processAround([V, ...run(0, 400), V], 1, 20)).toBe(
			"idle",
		);
		expect(shellGate().processAround([V, ...run(0, 380), V], 1, 20)).toBe(
			"talking",
		);
	});

	it("counts the silence already heard: mid-pause, the windows behind decide", () => {
		// 500 ms pause; now is its 15th window: 14 behind, 10 ahead.
		const levels = [V, ...run(0, 500), V];
		expect(shellGate().processAround(levels, 15, 20)).toBe("idle");
	});

	it("keeps the state while the pause runs into audio that is not known yet, then closes once the heard silence alone reaches the hold", () => {
		const gate = shellGate();
		expect(gate.processAround([V, ...run(0, 100)], 1, 20)).toBe("talking");
		expect(gate.processAround([V, ...run(0, 380)], 19, 20)).toBe("talking");
		expect(gate.processAround([V, ...run(0, 400)], 20, 20)).toBe("idle");
	});

	it("keeps the state when now itself is not known", () => {
		expect(shellGate().processAround([], -1, 20)).toBe("talking");
		expect(shellGate("idle").processAround([V], 3, 20)).toBe("idle");
	});

	it("opens on the voiced window now and stays closed through silence", () => {
		const gate = shellGate("idle");
		expect(gate.processAround(run(0, 100), 2, 20)).toBe("idle");
		expect(gate.processAround([0, V, 0], 1, 20)).toBe("talking");
	});

	it("uses the real length of a window (playback rate)", () => {
		// 20 windows of 10 ms (2x): 200 ms of real silence, under the hold.
		expect(shellGate().processAround([V, ...run(0, 400), V], 1, 10)).toBe(
			"talking",
		);
	});

	describe.each([24, 30, 60, 144])(
		"no frame-rate dependence at %i fps (review hole 1)",
		(fps) => {
			const frameMs = 1000 / fps;
			// voice 0-1.0 s, pause 380 ms, voice 1.38-2.0 s, pause 460 ms, voice 2.46-3.0 s
			const env = new Float32Array(150).map((_, i) => {
				const t = i * 20;
				return t < 1000 || (t >= 1380 && t < 2000) || t >= 2460 ? V : 0;
			});
			for (const phase of [0, 3, 7, 11, 13, 17, 19]) {
				it(`phase ${phase} ms: a 380 ms pause never closes, a 460 ms pause closes for its whole length`, () => {
					const gate = shellGate();
					for (let t = phase; t < 2900; t += frameMs) {
						const around = levelsAround(
							[{ start: 0, envelope: env }],
							t / 1000,
							NVA_SHELL_HOLD_MS / 1000,
							NVA_SHELL_HOLD_MS / 1000,
							"unknown",
						);
						const state = gate.processAround(
							around.levels,
							around.now,
							around.stepMs,
						);
						const inShort = t >= 1000 && t < 1380;
						const inLong = t >= 2000 + 1e-9 && t < 2460;
						if (inShort) expect(state).toBe("talking");
						if (inLong) expect(state).toBe("idle");
						if (!inShort && !inLong && t < 2900) {
							const voiced =
								env[Math.floor(t / 20 + 1e-9)] >= NVA_GATE_THRESHOLD;
							if (voiced) expect(state).toBe("talking");
						}
					}
				});
			}
		},
	);
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

	/** Renderer reading `env` (20 ms windows from t=0) around `clock.sec`. */
	async function aroundRenderer(
		env: Float32Array,
		clock: { sec: number },
		after: "unknown" | "silence" = "unknown",
		asked: number[][] = [],
	) {
		const renderer = new PrebakedAvatarRenderer({
			manifest: studioManifest(),
			locale: "ko-KR",
			resolveAssetUrl: async (path) => `blob:${path}`,
			voiceLevel: () => null,
			voiceLevelsAround: (q) => {
				asked.push([q.leadSec, q.backSec, q.aheadSec]);
				return levelsAround(
					[{ start: 0, envelope: env }],
					clock.sec + q.leadSec,
					q.backSec,
					q.aheadSec,
					after,
				);
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
		return { renderer, idle, talking };
	}

	/** 20 ms windows: voiced where `voiced(ms)` is true. */
	const envelopeOf = (ms: number, voiced: (t: number) => boolean) =>
		new Float32Array(Math.round(ms / 20)).map((_, i) =>
			voiced(i * 20) ? 0.08 : 0,
		);

	it("reads NVA_LEVEL_LEAD_MS early around the audible moment and closes at the start of a long pause", async () => {
		const asked: number[][] = [];
		// Voice until t=1.0 s, silence 1.0-1.6 s, voice again.
		const env = envelopeOf(2000, (t) => t < 1000 || t >= 1600);
		const clock = { sec: 0 };
		const { renderer, idle, talking } = await aroundRenderer(
			env,
			clock,
			"unknown",
			asked,
		);
		clock.sec = 0.9;
		expect(renderer.drawSource(900)).toBe(talking);
		// 60 ms before the pause is audible the gate already reads it.
		clock.sec = 0.93;
		expect(renderer.drawSource(930)).toBe(talking);
		clock.sec = 0.95;
		expect(renderer.drawSource(950)).toBe(idle);
		// And 60 ms before the voice returns it opens again.
		clock.sec = 1.53;
		expect(renderer.drawSource(1530)).toBe(idle);
		clock.sec = 1.55;
		expect(renderer.drawSource(1550)).toBe(talking);
		expect(asked[0][0]).toBeCloseTo(NVA_LEVEL_LEAD_MS / 1000);
		expect(asked[0][1]).toBeCloseTo(NVA_SHELL_HOLD_MS / 1000);
		expect(asked[0][2]).toBeCloseTo(NVA_SHELL_HOLD_MS / 1000);
		renderer.stop();
	});

	it.each([24, 30, 60, 144])(
		"at %i fps, no closure in a 380 ms pause and one closure for a 460 ms pause (review hole 1, through the renderer)",
		async (fps) => {
			const env = envelopeOf(
				3000,
				(t) => t < 1000 || (t >= 1380 && t < 2000) || t >= 2460,
			);
			for (const phase of [0, 5, 11, 17]) {
				const clock = { sec: 0 };
				const { renderer, idle } = await aroundRenderer(env, clock);
				let closures = 0;
				let shortClosures = 0;
				let wasIdle = false;
				for (let t = phase; t < 2900; t += 1000 / fps) {
					clock.sec = t / 1000;
					const isIdle = renderer.drawSource(t) === idle;
					if (isIdle && !wasIdle) {
						closures++;
						const heard = t + NVA_LEVEL_LEAD_MS;
						if (heard >= 1000 && heard < 1380) shortClosures++;
					}
					wasIdle = isIdle;
				}
				expect(shortClosures).toBe(0);
				expect(closures).toBe(1);
				renderer.stop();
				document.body.innerHTML = "";
			}
		},
	);

	it("a second 'speaking' signal keeps the running talking loop (no restart, no gate reset)", async () => {
		// A 300 ms pause at 0.5-0.8 s: the mouth stays open through it.
		const env = envelopeOf(2000, (t) => t < 500 || t >= 800);
		const clock = { sec: 0.4 };
		const { renderer, talking } = await aroundRenderer(env, clock);
		expect(renderer.drawSource(400)).toBe(talking);
		clock.sec = 0.55; // inside the pause
		expect(renderer.drawSource(550)).toBe(talking);
		const plays = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
		renderer.setSpeakingVisual(true); // e.g. the next sentence's start signal
		await flush();
		expect(vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length).toBe(
			plays,
		);
		// A reset gate would sit closed through the rest of the short pause.
		clock.sec = 0.6;
		expect(renderer.drawSource(600)).toBe(talking);
		renderer.stop();
	});

	it("a coarse stop waits for the gate: talking until the voice ends, then idle; a new start meanwhile does not restart", async () => {
		const env = envelopeOf(2000, (t) => t < 1000);
		const clock = { sec: 0.5 };
		const { renderer, idle, talking } = await aroundRenderer(
			env,
			clock,
			"silence",
		);
		expect(renderer.drawSource(500)).toBe(talking);
		renderer.setSpeakingVisual(false); // queue ran dry for a moment
		expect(renderer.drawSource(516)).toBe(talking);
		const plays = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
		renderer.setSpeakingVisual(true); // next sentence started
		await flush();
		expect(vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length).toBe(
			plays,
		);
		renderer.setSpeakingVisual(false);
		clock.sec = 0.95; // lead reaches the end of the voice, silence after
		expect(renderer.drawSource(950)).toBe(idle);
		await flush();
		clock.sec = 1.2;
		expect(renderer.drawSource(1200)).toBe(idle);
		renderer.stop();
	});

	it("starts the talking loop from the level when the voice is heard before the coarse start signal", async () => {
		const env = envelopeOf(2000, (t) => t >= 200);
		const clock = { sec: 0 };
		const renderer = new PrebakedAvatarRenderer({
			manifest: studioManifest(),
			locale: "ko-KR",
			resolveAssetUrl: async (path) => `blob:${path}`,
			voiceLevel: () => null,
			voiceLevelsAround: (q) =>
				levelsAround(
					[{ start: 0, envelope: env }],
					clock.sec + q.leadSec,
					q.backSec,
					q.aheadSec,
					"unknown",
				),
		});
		const mounted = document.createElement("video");
		document.body.appendChild(mounted);
		renderer.start(mounted, document.createElement("canvas"));
		await flush();
		clock.sec = 0.1;
		renderer.drawSource(100);
		await flush();
		expect(() => clipElements("blob:clips/talking.webm")).toThrow();
		clock.sec = 0.15; // 0.15 + 0.06 lead = voiced
		renderer.drawSource(150);
		await flush();
		for (const element of [
			...clipElements("blob:clips/idle.webm"),
			...clipElements("blob:clips/talking.webm"),
		])
			markDecoded(element);
		const talking = playingElement("blob:clips/talking.webm");
		clock.sec = 0.17;
		expect(renderer.drawSource(170)).toBe(talking);
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
