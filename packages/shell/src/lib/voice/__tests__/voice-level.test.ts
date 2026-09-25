import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	NVA_GATE_THRESHOLD,
	NVA_SHELL_HOLD_MS,
	NvaAudioGate,
} from "../../avatar/nva-audio-gate";
import { AudioQueue } from "../audio-queue";
import {
	VOICE_LEVEL_WINDOW_SEC,
	VoiceLevelTimeline,
	levelsAround,
	outputLatencySeconds,
	readActiveVoiceLevel,
	readActiveVoiceLevelsAround,
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

describe("levelsAround", () => {
	const W = VOICE_LEVEL_WINDOW_SEC;

	it("reads the windows behind and ahead of the moment on consecutive envelope windows", () => {
		const env = new Float32Array([0.2, 0.2, 0, 0, 0.5, 0.5]);
		const around = levelsAround(
			[{ start: 10, envelope: env }],
			10.05,
			0.04,
			0.04,
			"unknown",
		);
		expect(around.now).toBe(2);
		expect(around.levels).toEqual([
			expect.closeTo(0.2),
			expect.closeTo(0.2),
			0,
			0,
			expect.closeTo(0.5),
		]);
		expect(around.stepMs).toBeCloseTo(20);
	});

	it("stops before the first block and, while more audio may come, after the last", () => {
		const env = new Float32Array([0.2, 0, 0]);
		const around = levelsAround(
			[{ start: 0, envelope: env }],
			0.01,
			1,
			1,
			"unknown",
		);
		expect(around).toEqual({
			levels: [expect.closeTo(0.2), 0, 0],
			now: 0,
			stepMs: 20,
		});
		expect(
			levelsAround([{ start: 0, envelope: env }], 0.07, 1, 1, "unknown").now,
		).toBe(-1);
		expect(
			levelsAround([{ start: 1, envelope: env }], 0.5, 1, 1, "silence").now,
		).toBe(-1);
	});

	it("reads the time past the last block as silence once nothing more is coming (page end)", () => {
		const env = new Float32Array([0.3, 0]);
		const around = levelsAround(
			[{ start: 0, envelope: env }],
			0.03,
			0,
			0.4,
			"silence",
		);
		expect(around.levels).toHaveLength(21);
		expect(around.levels.slice(1).every((l) => l === 0)).toBe(true);
	});

	it("reads a gap between two blocks as silence, whatever the phase of the asked time", () => {
		const blocks = [
			{ start: 0, envelope: new Float32Array([0.3, 0.3]) },
			{ start: 0.1, envelope: new Float32Array([0.3]) },
		];
		for (const t of [0.04, 0.047, 0.053, 0.059]) {
			const around = levelsAround(blocks, t, 0.1, 0.1, "unknown");
			const silent = around.levels.filter((l) => l < 0.015).length;
			expect(silent).toBe(3);
		}
	});

	it("counts windows in real time at the playback rate", () => {
		const env = new Float32Array(100);
		const fast = levelsAround(
			[{ start: 0, envelope: env }],
			1,
			0.2,
			0.2,
			"unknown",
			2,
		);
		expect(fast.stepMs).toBeCloseTo(10);
		// 0.2 s of real time covers 0.4 s of media at 2x: 20 windows each way.
		expect(fast.levels).toHaveLength(41);
	});

	it("reports nothing from a source that cannot read around", () => {
		const source = { voiceLevel: () => 0.1 };
		setActiveVoiceLevelSource(source);
		const q = { leadSec: 0, backSec: 0.4, aheadSec: 0.4 };
		expect(readActiveVoiceLevelsAround(q)).toBeNull();
		releaseVoiceLevelSource(source);
		const around = {
			voiceLevel: () => 0.1,
			voiceLevelsAround: () => ({ levels: [0.1], now: 0, stepMs: 20 }),
		};
		setActiveVoiceLevelSource(around);
		expect(readActiveVoiceLevelsAround(q)?.levels).toEqual([0.1]);
		releaseVoiceLevelSource(around);
		expect(readActiveVoiceLevelsAround(q)).toBeNull();
	});

	it("keeps W as the envelope window", () => {
		expect(W).toBe(0.02);
	});
});

describe("outputLatencySeconds", () => {
	it.each([
		[{}, 0],
		[{ baseLatency: 0.0029, outputLatency: 0 }, 0.0029],
		[{ baseLatency: 0.01 }, 0.01],
		[{ outputLatency: 0.04 }, 0.04],
		[{ baseLatency: 0.01, outputLatency: 0.15 }, 0.16],
		[{ baseLatency: 0.01, outputLatency: 0.3 }, 0.31],
		[{ baseLatency: Number.NaN, outputLatency: -1 }, 0],
		[{ outputLatency: 7 }, 1],
	])(
		"declared latencies %o add up to %f s (missing, 0, large, broken)",
		(ctx, want) => {
			expect(outputLatencySeconds(ctx)).toBeCloseTo(want, 6);
		},
	);

	it("prefers a real getOutputTimestamp reading", () => {
		const ctx = {
			currentTime: 10,
			baseLatency: 0.01,
			outputLatency: 0,
			getOutputTimestamp: () => ({ contextTime: 9.8, performanceTime: 1000 }),
		};
		// 50 ms after that reading the device plays context time 9.85.
		expect(outputLatencySeconds(ctx, 1050)).toBeCloseTo(0.15, 6);
	});

	it("ignores an engine that fills getOutputTimestamp with zeros", () => {
		const ctx = {
			currentTime: 10,
			baseLatency: 0.02,
			getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }),
		};
		expect(outputLatencySeconds(ctx, 5000)).toBeCloseTo(0.02, 6);
	});

	it("handles no context", () => {
		expect(outputLatencySeconds(null)).toBe(0);
	});
});

class FakeAudio {
	static instances: FakeAudio[] = [];
	onplay: (() => void) | null = null;
	onended: (() => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	currentTime = 0;
	playbackRate = 1;
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

	it("reports the level of the WAV sentence at its playback time, then silence once nothing more comes", () => {
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
		expect(readActiveVoiceLevel()).toBe(0);
		queue.clear();
		expect(readActiveVoiceLevel()).toBeNull();
	});

	const Q = { leadSec: 0, backSec: 0.4, aheadSec: 0.4 };
	const gate = () =>
		new NvaAudioGate(NVA_GATE_THRESHOLD, NVA_SHELL_HOLD_MS, "talking");
	const judge = (queue: AudioQueue) => {
		const around = queue.voiceLevelsAround(Q);
		if (!around) throw new Error("no levels");
		return gate().processAround(around.levels, around.now, around.stepMs);
	};

	it("review hole 2: past the end of a sentence the lookahead reads the sentence queued right behind it", () => {
		const queue = new AudioQueue();
		// A ends with 150 ms of silence; B starts voiced at once; C starts with
		// 600 ms of silence. The pause between A and B is 150 ms: keep talking.
		queue.enqueue(wavBase64(toneThenSilence(0.3, 0.15)));
		queue.enqueue(wavBase64(toneThenSilence(0.3, 0)));
		queue.enqueue(
			wavBase64([...toneThenSilence(0, 0.6), ...toneThenSilence(0.3, 0)]),
		);
		const [a] = FakeAudio.instances;
		a.onplay?.();
		a.currentTime = 0.32; // in A's tail
		expect(judge(queue)).toBe("talking");
		a.onended?.();
		// playNext has shifted B off the queue; C is queue[0] now. The gap
		// reader stays bound to B.
		expect(FakeAudio.instances).toHaveLength(2);
		expect(judge(queue)).toBe("talking");
	});

	it("review hole 2: after a sentence whose successor cannot be measured, the time past its end is unknown", () => {
		const queue = new AudioQueue();
		queue.enqueue(wavBase64(toneThenSilence(0.3, 0.1)));
		queue.enqueue("SUQzBAAAAAAA"); // MP3
		const [a] = FakeAudio.instances;
		a.onplay?.();
		a.currentTime = 0.35;
		const around = queue.voiceLevelsAround(Q);
		// 0.35 s is window 17; the payload has 20 windows: 2 more, then unknown.
		expect(around?.levels.length).toBe((around?.now ?? 0) + 3);
		expect(judge(queue)).toBe("talking");
	});

	it("review hole 5: the last sentence with nothing queued closes the mouth as the voice stops", () => {
		const queue = new AudioQueue();
		queue.enqueue(wavBase64(toneThenSilence(0.3, 0.1)));
		const [a] = FakeAudio.instances;
		a.onplay?.();
		a.currentTime = 0.31; // just after the last voiced window
		expect(judge(queue)).toBe("idle");
	});

	it("review hole 5: while a later sentence is still being synthesized, the end is not read as silence", () => {
		const queue = new AudioQueue();
		const first = queue.reserveSeq();
		queue.reserveSeq();
		queue.enqueueOrdered(first, wavBase64(toneThenSilence(0.3, 0.1)));
		const [a] = FakeAudio.instances;
		a.onplay?.();
		a.currentTime = 0.31;
		expect(judge(queue)).toBe("talking");
	});

	it("review hole 4: windows last 1/playbackRate of real time", () => {
		const queue = new AudioQueue();
		queue.enqueue(wavBase64(toneThenSilence(1, 1)));
		const [a] = FakeAudio.instances;
		a.playbackRate = 2;
		a.onplay?.();
		a.currentTime = 1.5;
		const around = queue.voiceLevelsAround(Q);
		expect(around?.stepMs).toBeCloseTo(10);
		// 0.4 s real at 2x = 0.8 s of media: 40 windows behind.
		expect(around?.now).toBe(40);
		queue.clear();
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
