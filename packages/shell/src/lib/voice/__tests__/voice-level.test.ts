import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioQueue } from "../audio-queue";
import {
	VOICE_LEVEL_WINDOW_SEC,
	VoiceLevelTimeline,
	readActiveVoiceLevel,
	rmsEnvelope,
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
