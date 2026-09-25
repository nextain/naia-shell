import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioQueue } from "../audio-queue";
import {
	AudibleMediaClock,
	VOICE_LEVEL_WINDOW_SEC,
	VoiceLevelTimeline,
	audibleContextTime,
	envelopeLevelAt,
	envelopeLevelsAhead,
	envelopeLevelsAheadThen,
	readActiveVoiceLevel,
	readActiveVoiceLevelsAhead,
	releaseVoiceLevelSource,
	rmsEnvelope,
	setActiveVoiceLevelSource,
	wavEnvelope,
} from "../voice-level";

/** 16-bit mono PCM WAV (base64) from normalised samples. */
function wavBase64(samples: number[], sampleRate = 16000): string {
	const data = samples.length * 2;
	const bytes = new Uint8Array(44 + data);
	const view = new DataView(bytes.buffer);
	const ascii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++)
			bytes[offset + i] = text.charCodeAt(i);
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + data, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	ascii(36, "data");
	view.setUint32(40, data, true);
	samples.forEach((sample, i) =>
		view.setInt16(44 + i * 2, Math.round(sample * 0x7fff), true),
	);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** `voiced` seconds of a 0.3-amplitude tone, then `silent` seconds of silence. */
function toneThenSilence(voiced: number, silent: number, rate = 16000) {
	const out: number[] = [];
	for (let i = 0; i < voiced * rate; i++)
		out.push(0.3 * Math.sin((2 * Math.PI * 220 * i) / rate));
	for (let i = 0; i < silent * rate; i++) out.push(0);
	return out;
}

describe("voice level envelope", () => {
	it("measures RMS per 20 ms window", () => {
		const envelope = rmsEnvelope(toneThenSilence(0.1, 0.1), 16000);
		expect(envelope.length).toBe(10);
		expect(envelope[0]).toBeCloseTo(0.3 / Math.SQRT2, 2);
		expect(envelope[9]).toBe(0);
	});

	it("reads a 16-bit PCM WAV and rejects MP3", () => {
		const envelope = wavEnvelope(wavBase64(toneThenSilence(0.2, 0.2)));
		expect(envelope).not.toBeNull();
		expect(envelope?.length).toBe(20);
		expect(envelope?.[2]).toBeGreaterThan(0.015);
		expect(envelope?.[15]).toBe(0);
		expect(wavEnvelope(btoa("ID3 not a wav"))).toBeNull();
	});

	it("looks up streamed segments by playback clock and reads gaps as silence", () => {
		const timeline = new VoiceLevelTimeline();
		timeline.add(10, new Float32Array([0.2, 0.2]));
		timeline.add(10.1, new Float32Array([0.5]));
		expect(timeline.levelAt(10.01)).toBeCloseTo(0.2);
		expect(timeline.levelAt(10.05)).toBe(0);
		expect(timeline.levelAt(10.11)).toBeCloseTo(0.5);
		expect(timeline.levelAt(12)).toBe(0);
	});
});

describe("voice level lookahead", () => {
	it("reads the timeline ahead of the clock, one level per window", () => {
		const timeline = new VoiceLevelTimeline();
		timeline.add(10, new Float32Array([0.2, 0.2, 0, 0, 0.5, 0.5]));
		const ahead = timeline.levelsAhead(10.01, 0.08);
		expect(ahead).toHaveLength(5);
		expect(ahead[0]).toBeCloseTo(0.2);
		expect(ahead[2]).toBe(0);
		expect(ahead[4]).toBeCloseTo(0.5);
	});

	it("stops the timeline lookahead where the scheduled audio ends (next chunk unknown)", () => {
		const timeline = new VoiceLevelTimeline();
		timeline.add(10, new Float32Array([0.2, 0, 0]));
		expect(timeline.levelsAhead(10.01, 0.4)).toHaveLength(3);
		expect(timeline.levelsAhead(10.07, 0.4)).toEqual([]);
	});

	it("reads a whole-payload envelope ahead and stops at its end (next sentence unknown)", () => {
		const envelope = new Float32Array([0.3, 0, 0.3, 0]);
		expect(envelopeLevelAt(envelope, 0.045)).toBeCloseTo(0.3);
		expect(envelopeLevelsAhead(envelope, 0.02, 0.2)).toEqual([
			0,
			expect.closeTo(0.3),
			0,
		]);
		expect(envelopeLevelsAhead(envelope, 0.09, 0.2)).toEqual([]);
	});

	it("continues the lookahead into the sentence queued next", () => {
		const current = new Float32Array([0.3, 0, 0]);
		const next = new Float32Array([0, 0.3, 0.3]);
		// From 0.02 s: two windows left of this sentence, then the next one.
		expect(envelopeLevelsAheadThen(current, 0.02, 0.1, next)).toEqual([
			0,
			0,
			0,
			expect.closeTo(0.3),
			expect.closeTo(0.3),
		]);
		expect(envelopeLevelsAheadThen(current, 0.02, 0.1, null)).toEqual([0, 0]);
	});

	it("reports no lookahead from a source that cannot look ahead", () => {
		const source = { voiceLevel: () => 0.1 };
		setActiveVoiceLevelSource(source);
		expect(readActiveVoiceLevelsAhead(0.4)).toBeNull();
		releaseVoiceLevelSource(source);
		const ahead = {
			voiceLevel: () => 0.1,
			voiceLevelsAhead: (sec: number) => [sec],
		};
		setActiveVoiceLevelSource(ahead);
		expect(readActiveVoiceLevelsAhead(0.4)).toEqual([0.4]);
		releaseVoiceLevelSource(ahead);
		expect(readActiveVoiceLevelsAhead(0.4)).toBeNull();
	});

	it("puts the context clock back by the device latency", () => {
		expect(
			audibleContextTime({
				currentTime: 5,
				baseLatency: 0.01,
				outputLatency: 0.04,
			}),
		).toBeCloseTo(4.95);
		expect(audibleContextTime({ currentTime: 5 })).toBe(5);
	});
});

describe("AudibleMediaClock", () => {
	it("runs on the wall clock from 'playing' while currentTime trails it", () => {
		let now = 1000;
		const clock = new AudibleMediaClock(() => now);
		expect(clock.time(0)).toBe(0); // before 'playing': the element's own time
		clock.playing(0);
		now = 1300;
		// currentTime still says 0.18 s; 0.3 s of sound has played.
		expect(clock.time(0.18)).toBeCloseTo(0.3);
	});

	it("re-anchors when currentTime runs ahead of the wall clock", () => {
		let now = 0;
		const clock = new AudibleMediaClock(() => now);
		clock.playing(0);
		now = 100;
		expect(clock.time(0.2)).toBeCloseTo(0.2);
		now = 150;
		expect(clock.time(0.2)).toBeCloseTo(0.25);
	});

	it("follows the element on a real stall and after a pause", () => {
		let now = 0;
		const clock = new AudibleMediaClock(() => now, 0.25);
		clock.playing(0);
		now = 2000; // stuck at 0.5 s for 1.5 s
		expect(clock.time(0.5)).toBeCloseTo(0.75);
		clock.halt();
		expect(clock.time(0.5)).toBe(0.5);
	});
});

class FakeAudio {
	static instances: FakeAudio[] = [];
	onplay: (() => void) | null = null;
	onended: (() => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	currentTime = 0;
	pause = vi.fn();
	play = vi.fn(() => Promise.resolve());
	constructor(public src: string) {
		FakeAudio.instances.push(this);
	}
}

describe("AudioQueue voice level", () => {
	beforeEach(() => {
		FakeAudio.instances = [];
		vi.stubGlobal("Audio", FakeAudio);
	});
	afterEach(() => vi.unstubAllGlobals());

	it("reports the level of the WAV sentence at its playback time, then releases it", () => {
		const queue = new AudioQueue();
		expect(readActiveVoiceLevel()).toBeNull();
		queue.enqueue(wavBase64(toneThenSilence(0.5, 0.5)));
		const audio = FakeAudio.instances[0];
		audio.onplay?.();

		audio.currentTime = 0.25;
		expect(readActiveVoiceLevel()).toBeGreaterThan(0.015);
		audio.currentTime = 0.75; // a pause inside the sentence
		expect(readActiveVoiceLevel()).toBe(0);

		audio.onended?.();
		expect(readActiveVoiceLevel()).toBeNull();
	});

	it("keeps the level unknown for MP3 so the avatar falls back to the talking loop", () => {
		const queue = new AudioQueue();
		queue.enqueue("SUQzBAAAAAAA");
		FakeAudio.instances[0].onplay?.();
		expect(queue.voiceLevel()).toBeNull();
		queue.clear();
	});

	it("uses a window small enough for one video frame", () => {
		expect(VOICE_LEVEL_WINDOW_SEC).toBeLessThanOrEqual(1 / 30);
	});
});
