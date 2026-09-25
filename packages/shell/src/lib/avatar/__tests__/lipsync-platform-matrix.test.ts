// @vitest-environment jsdom
/**
 * Mouth against voice across the conditions the shell meets on Windows
 * (WebView2), macOS (WKWebView) and Linux (WebKitGTK): device latency,
 * display frame rate, and when an <audio> element's `play` event fires
 * relative to its sound. A simulated clock drives the real AudioQueue and
 * the real PrebakedAvatarRenderer, wired the way ChatArea wires them.
 *
 * Model (the parts no unit test can take from a real engine):
 * - Web Audio: a chunk scheduled at context time `at` is heard at
 *   `at + latency`, and the context reports that latency through
 *   `baseLatency`/`outputLatency`.
 * - <audio>: `currentTime` is the position being heard (see
 *   `AudioQueue.mediaReader`); the `play` event fires 100 ms before or after
 *   the sound starts.
 * - A clip switch decided in a frame shows one frame later and reaches the
 *   middle of the crossfade `NVA_SWITCH_FADE_MS / 2` after that.
 *
 * Checks, per case: every open and close of the mouth lands within 0.1 s of
 * the voice it follows, and no pause under the 400 ms hold closes it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NvaManifest } from "../../nva";
import { AudioQueue, PcmStreamSource } from "../../voice/audio-queue";
import { NVA_SHELL_HOLD_MS } from "../nva-audio-gate";
import {
	NVA_SWITCH_FADE_MS,
	PrebakedAvatarRenderer,
} from "../prebaked-renderer";

let simMs = 0;

class FakeBufferSource {
	buffer: { duration: number } | null = null;
	onended: (() => void) | null = null;
	endsAt = Number.POSITIVE_INFINITY;
	connect() {}
	start(at: number) {
		this.endsAt = at + (this.buffer?.duration ?? 0);
		FakeContext.sources.push(this);
	}
	stop() {
		this.endsAt = Number.POSITIVE_INFINITY;
	}
}

class FakeContext {
	static sources: FakeBufferSource[] = [];
	static baseLatency: number | undefined = undefined;
	static outputLatency: number | undefined = undefined;
	static timestampMode: "normal" | "zero" | "none" = "none";
	destination = {};
	state = "running";
	get currentTime() {
		return simMs / 1000;
	}
	get baseLatency() {
		return FakeContext.baseLatency;
	}
	get outputLatency() {
		return FakeContext.outputLatency;
	}
	getOutputTimestamp(): AudioTimestamp | undefined {
		if (FakeContext.timestampMode === "none") return undefined;
		if (FakeContext.timestampMode === "zero") {
			return {
				contextTime: this.currentTime,
				performanceTime: performance.now(),
			};
		}
		const lat =
			(FakeContext.baseLatency ?? 0) + (FakeContext.outputLatency ?? 0);
		return {
			contextTime: Math.max(0, this.currentTime - lat),
			performanceTime: performance.now(),
		};
	}
	resume() {
		return Promise.resolve();
	}
	createBuffer(_channels: number, length: number, rate: number) {
		const data = new Float32Array(length);
		return { duration: length / rate, getChannelData: () => data };
	}
	createBufferSource() {
		return new FakeBufferSource();
	}
}

/** <audio>: sound starts `decodeMs` after creation; `play` fires `eventMs` from the sound. */
class FakeAudio {
	static instances: FakeAudio[] = [];
	static eventMs = 0;
	static decodeMs = 50;
	static clockMode: "heard" | "decode" = "heard";
	static latencySec = 0;
	onplay: (() => void) | null = null;
	onended: (() => void) | null = null;
	onerror: ((e: Event) => void) | null = null;
	playbackRate = 1;
	soundAtMs: number;
	playEventAtMs: number;
	durationMs: number;
	firedPlay = false;
	firedEnd = false;
	pause = vi.fn();
	constructor(public src: string) {
		this.soundAtMs = simMs + FakeAudio.decodeMs;
		this.playEventAtMs = Math.max(simMs, this.soundAtMs + FakeAudio.eventMs);
		const b64 = src.slice(src.indexOf(",") + 1);
		const bytes = atob(b64).length;
		this.durationMs = ((bytes - 44) / 2 / 16000) * 1000;
		FakeAudio.instances.push(this);
	}
	play() {
		return Promise.resolve();
	}
	get currentTime() {
		// "decode": reports position ahead of sound by latencySec
		const offset = FakeAudio.clockMode === "decode" ? FakeAudio.latencySec : 0;
		const t = (simMs - this.soundAtMs + offset * 1000) / 1000;
		return Math.min(Math.max(0, t), this.durationMs / 1000);
	}
	set currentTime(_v: number) {}
	tick() {
		if (!this.firedPlay && simMs >= this.playEventAtMs) {
			this.firedPlay = true;
			this.onplay?.();
		}
		if (!this.firedEnd && simMs >= this.soundAtMs + this.durationMs) {
			this.firedEnd = true;
			this.onended?.();
		}
	}
}

/** Voiced stretches of one sentence, in ms from its first sample. */
interface Sentence {
	voiced: Array<[number, number]>;
	lengthMs: number;
}

// Sentence A: lead-in 150 ms, a 380 ms pause (under the hold), a 460 ms and
// a 700 ms pause (over it), a 200 ms breath, 100 ms tail. Sentence B follows
// right behind: the pause between them (A's tail, the start gap, B's lead-in)
// stays under the hold.
const SENTENCE_A: Sentence = {
	voiced: [
		[150, 650],
		[1030, 1550],
		[2010, 2550],
		[2750, 3150],
		[3850, 4350],
	],
	lengthMs: 4450,
};
const SENTENCE_B: Sentence = { voiced: [[150, 750]], lengthMs: 850 };

function samples(sentence: Sentence, rate: number): Float32Array {
	const out = new Float32Array(Math.round((sentence.lengthMs / 1000) * rate));
	for (const [from, to] of sentence.voiced)
		for (let i = Math.round((from / 1000) * rate); i < (to / 1000) * rate; i++)
			out[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate);
	return out;
}

function pcm16(sentence: Sentence): Int16Array {
	return Int16Array.from(samples(sentence, 24000), (v) =>
		Math.round(v * 0x7fff),
	);
}

function wav16k(sentence: Sentence): string {
	const s = samples(sentence, 16000);
	const bytes = new Uint8Array(44 + s.length * 2);
	const view = new DataView(bytes.buffer);
	const ascii = (o: number, t: string) => {
		for (let i = 0; i < t.length; i++) bytes[o + i] = t.charCodeAt(i);
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + s.length * 2, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 16000, true);
	view.setUint32(28, 32000, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	ascii(36, "data");
	view.setUint32(40, s.length * 2, true);
	s.forEach((v, i) => view.setInt16(44 + i * 2, Math.round(v * 0x7fff), true));
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

function manifest(): NvaManifest {
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

function markAllDecoded(): void {
	for (const video of document.querySelectorAll("video")) {
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
	}
}

async function flush(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** Mouth-open stretches the voice calls for: voiced stretches joined across pauses under the hold. */
function expectedOpen(
	stretches: Array<[number, number]>,
): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (const [a, b] of stretches) {
		const last = out[out.length - 1];
		if (last && a - last[1] < NVA_SHELL_HOLD_MS) last[1] = b;
		else out.push([a, b]);
	}
	return out;
}

interface Outcome {
	/** Visible mouth changes: [ms, open]. */
	changes: Array<[number, boolean]>;
	/** Heard voiced stretches, ms. */
	heard: Array<[number, number]>;
}

async function simulate(
	path: "stream" | "media",
	latencySec: number,
	fps: number,
	eventMs: number,
	timestampMode: "normal" | "zero" | "none" = "none",
	clockMode: "heard" | "decode" = "heard",
): Promise<Outcome> {
	simMs = 0;
	FakeContext.sources = [];
	FakeContext.baseLatency = latencySec > 0 ? 0.005 : undefined;
	FakeContext.outputLatency = latencySec > 0 ? latencySec - 0.005 : 0;
	FakeContext.timestampMode = timestampMode;
	FakeAudio.instances = [];
	FakeAudio.eventMs = eventMs;
	FakeAudio.clockMode = clockMode;
	FakeAudio.latencySec = latencySec;

	const renderer = new PrebakedAvatarRenderer({
		manifest: manifest(),
		locale: "ko-KR",
		resolveAssetUrl: async (p) => `blob:${p}`,
	});
	const mounted = document.createElement("video");
	document.body.appendChild(mounted);
	renderer.start(mounted, document.createElement("canvas"));
	await flush();
	markAllDecoded();

	const queue = new AudioQueue({
		onPlaybackStart: () => renderer.setSpeakingVisual(true),
		onPlaybackEnd: () => renderer.setSpeakingVisual(false),
	});
	const heard: Array<[number, number]> = [];
	const sentences = [SENTENCE_A, SENTENCE_B];
	if (path === "stream") {
		for (const s of sentences) {
			const stream = new PcmStreamSource(24000);
			stream.pushFinal(pcm16(s));
			queue.enqueueOrderedStream(queue.reserveSeq(), stream, {});
		}
	} else {
		for (const s of sentences)
			queue.enqueueOrdered(queue.reserveSeq(), wav16k(s));
	}

	const frameMs = 1000 / fps;
	let nextFrame = 0;
	let wasOpen = false;
	const changes: Array<[number, boolean]> = [];
	const endMs = 7000;
	const seenSources = new Set<FakeBufferSource>();
	const seenAudio = new Set<FakeAudio>();
	let sentenceIndex = 0;
	while (simMs < endMs) {
		simMs += 1;
		vi.advanceTimersByTime(1);
		// Heard stretches: a new sound source is heard `latency` after it starts.
		for (const src of FakeContext.sources) {
			if (!seenSources.has(src)) {
				seenSources.add(src);
				const startMs = (src.endsAt - (src.buffer?.duration ?? 0)) * 1000;
				const s = sentences[sentenceIndex++];
				for (const [a, b] of s.voiced)
					heard.push([
						startMs + latencySec * 1000 + a,
						startMs + latencySec * 1000 + b,
					]);
			}
			if (simMs / 1000 >= src.endsAt) {
				src.endsAt = Number.POSITIVE_INFINITY;
				src.onended?.();
			}
		}
		for (const audio of FakeAudio.instances) {
			if (!seenAudio.has(audio)) {
				seenAudio.add(audio);
				const s = sentences[sentenceIndex++];
				for (const [a, b] of s.voiced)
					heard.push([audio.soundAtMs + a, audio.soundAtMs + b]);
			}
			audio.tick();
		}
		await flush();
		if (simMs >= nextFrame) {
			nextFrame += frameMs;
			markAllDecoded();
			const drawn = renderer.drawSource(simMs);
			const open = drawn?.dataset.naiaClipUrl === "blob:clips/talking.webm";
			if (open !== wasOpen) {
				// Visible one frame later, at the middle of the crossfade.
				changes.push([simMs + frameMs + NVA_SWITCH_FADE_MS / 2, open]);
				wasOpen = open;
			}
		}
	}
	queue.clear();
	renderer.stop();
	document.body.innerHTML = "";
	return { changes, heard };
}

const LATENCIES = [0, 0.04, 0.15, 0.3];
const FPS = [24, 30, 60, 144];
const TIMESTAMP_MODES: Array<"normal" | "zero" | "none"> = [
	"normal",
	"zero",
	"none",
];

describe("lipsync across platforms (latency x frame rate x play event x getOutputTimestamp)", () => {
	beforeEach(() => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "performance", "Date"],
		});
		vi.stubGlobal("AudioContext", FakeContext);
		vi.stubGlobal("Audio", FakeAudio);
		vi.stubGlobal("requestAnimationFrame", () => 1);
		vi.stubGlobal("cancelAnimationFrame", () => {});
		vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
			Promise.resolve(),
		);
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	type CaseRow = [
		"stream" | "media",
		number,
		number,
		number,
		"normal" | "zero" | "none",
	];
	const cases: CaseRow[] = [];
	for (const latency of LATENCIES)
		for (const fps of FPS)
			for (const timestampMode of TIMESTAMP_MODES) {
				cases.push(["stream", latency, fps, 0, timestampMode]);
				cases.push(["media", latency, fps, -100, timestampMode]);
				cases.push(["media", latency, fps, 100, timestampMode]);
			}

	it.each(cases)(
		"%s path, latency %f s, %i fps, play event %i ms, timestampMode %s",
		async (path, latency, fps, eventMs, timestampMode) => {
			const { changes, heard } = await simulate(
				path,
				latency,
				fps,
				eventMs,
				timestampMode,
				"heard",
			);
			const want = expectedOpen(heard);
			const wantChanges: Array<[number, boolean]> = [];
			for (const [a, b] of want) wantChanges.push([a, true], [b, false]);
			// Two sentences: opens at 150 ms, closes/opens at the 460 ms and
			// 700 ms pauses, closes at the end: at least 6 changes.
			expect(wantChanges.length).toBeGreaterThanOrEqual(6);
			// Same changes in the same order: no extra blink, none missing.
			expect(changes.map(([, open]) => open)).toEqual(
				wantChanges.map(([, open]) => open),
			);
			const offsets = changes.map(([t], i) => t - wantChanges[i][0]);
			const out = process.env.LIPSYNC_MATRIX_OUT;
			if (out) {
				const fs = await import("node:fs");
				fs.appendFileSync(
					out,
					`${JSON.stringify({ path, latency, fps, eventMs, timestampMode, offsets: offsets.map((o) => Math.round(o)) })}\n`,
				);
			}
			for (const off of offsets) expect(Math.abs(off)).toBeLessThanOrEqual(100);
		},
	);

	describe("VL-review1 플랫폼 부류: <audio>.currentTime 디코드 위치 시 드리프트 포착 검증", () => {
		// 알려진 한계: WebView2·WKWebView 실기 확인 필요
		// 현재 계약은 "currentTime 을 들림 위치로 본다"이다. 미디어 요소의 currentTime 이
		// 실제 들림 위치가 아닌 하드웨어/드라이버 디코드 위치를 반환하는 엔진 환경에서는
		// 입이 출력 지연만큼 앞서서 열리는 알려진 한계가 존재한다.
		it.each([
			[
				0.15,
				30,
				-116.67,
				[-82.67, -116.67, -109.67, -115.67, -115.67, -116.67],
			],
			[0.3, 24, -266.33, [-66.33, -258.33, -259.33, -233.33, -266.33, -249.33]],
			[
				0.3,
				60,
				-299.33,
				[-116.33, -283.33, -292.33, -283.33, -299.33, -282.33],
			],
		])(
			"알려진 한계: WebView2·WKWebView 실기 확인 필요 - media 경로에서 currentTime 이 들림 위치보다 출력 지연(%f s, %i fps)만큼 앞선 디코드 위치이면 선행 수치가 고정 기대값과 일치한다",
			async (latency, fps, expectedMaxLead, expectedOffsets) => {
				const { changes, heard } = await simulate(
					"media",
					latency,
					fps,
					0,
					"none",
					"decode",
				);
				const want = expectedOpen(heard);
				const wantChanges: Array<[number, boolean]> = [];
				for (const [a, b] of want) wantChanges.push([a, true], [b, false]);
				// t_visual - t_heard_sound: 입이 소리보다 앞서 열리면 음수 오프셋 발생
				const offsets = changes.map(([t], i) => t - wantChanges[i][0]);
				const maxLead = Math.min(...offsets);
				expect(maxLead).toBeCloseTo(expectedMaxLead, 1);
				expect(offsets.length).toBe(expectedOffsets.length);
				for (let i = 0; i < offsets.length; i++) {
					expect(offsets[i]).toBeCloseTo(expectedOffsets[i], 1);
				}
			},
		);
	});
});
