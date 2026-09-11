import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	AudioQueue,
	PcmStreamSource,
	wavDurationSeconds,
} from "../audio-queue";

class FakeAudio {
	static instances: FakeAudio[] = [];
	static playImpl: () => Promise<void> = () => Promise.resolve();
	onplay: (() => void) | null = null;
	onended: (() => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	src: string;
	pause = vi.fn();
	play = vi.fn<() => Promise<void>>(() => FakeAudio.playImpl());

	constructor(src: string) {
		this.src = src;
		FakeAudio.instances.push(this);
	}
}

describe("AudioQueue sentence callbacks", () => {
	beforeEach(() => {
		FakeAudio.instances = [];
		FakeAudio.playImpl = () => Promise.resolve();
		vi.stubGlobal("Audio", FakeAudio);
	});

	it("advances only once when play rejection and error both fire", async () => {
		const unavailable = vi.fn();
		const queue = new AudioQueue();
		FakeAudio.playImpl = () => Promise.reject(new Error("blocked"));
		queue.enqueue("first", { onPlaybackUnavailable: unavailable });
		queue.enqueue("second");
		const first = FakeAudio.instances[0];
		await Promise.resolve();
		await Promise.resolve();
		first.onerror?.(new Event("error"));
		await Promise.resolve();
		expect(unavailable).toHaveBeenCalledTimes(1);
		expect(FakeAudio.instances).toHaveLength(2);
	});

	it("ignores stale playback callbacks after clear", () => {
		const started = vi.fn();
		const unavailable = vi.fn();
		const queue = new AudioQueue();
		queue.enqueue("first", {
			onPlaybackStart: started,
			onPlaybackUnavailable: unavailable,
		});
		const first = FakeAudio.instances[0];
		queue.clear();
		first.onplay?.();
		first.onerror?.(new Event("error"));
		expect(started).not.toHaveBeenCalled();
		expect(unavailable).not.toHaveBeenCalled();
	});

	it("prebuffers queued sentences until playback is resumed", () => {
		const queue = new AudioQueue();
		queue.pauseBeforePlayback();
		queue.enqueue("first");
		queue.enqueue("second");
		expect(FakeAudio.instances).toHaveLength(0);
		queue.resumePlayback();
		expect(FakeAudio.instances).toHaveLength(1);
	});

	it("reads PCM duration from a RIFF/WAVE payload", () => {
		const pcmBytes = 48_000;
		const bytes = new Uint8Array(44 + pcmBytes);
		const view = new DataView(bytes.buffer);
		const chunks = [
			[0, "RIFF"],
			[8, "WAVE"],
			[12, "fmt "],
			[36, "data"],
		] as const;
		for (const [offset, text] of chunks) {
			for (let i = 0; i < text.length; i++)
				bytes[offset + i] = text.charCodeAt(i);
		}
		view.setUint32(4, bytes.length - 8, true);
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, 1, true);
		view.setUint32(24, 24_000, true);
		view.setUint32(28, 48_000, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		view.setUint32(40, pcmBytes, true);
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		expect(wavDurationSeconds(btoa(binary))).toBe(1);
	});
});

/** Minimal Web Audio doubles — jsdom has no AudioContext. */
class FakeBufferSource {
	buffer: { duration: number } | null = null;
	onended: (() => void) | null = null;
	startedAt: number | null = null;
	stopped = false;
	connect = vi.fn();
	start(at: number) {
		this.startedAt = at;
	}
	stop() {
		this.stopped = true;
	}
}

class FakeAudioContext {
	static sources: FakeBufferSource[] = [];
	static now = 0;
	state = "running";
	destination = {};
	resume = vi.fn(async () => {});
	get currentTime() {
		return FakeAudioContext.now;
	}
	createBuffer(_channels: number, length: number, rate: number) {
		return {
			duration: length / rate,
			getChannelData: () => new Float32Array(length),
		};
	}
	createBufferSource() {
		const source = new FakeBufferSource();
		FakeAudioContext.sources.push(source);
		return source;
	}
}

const pcm = (...samples: number[]) => Int16Array.from(samples);

describe("PcmStreamSource (streaming TTS contract)", () => {
	it("replays buffered chunks to a late subscriber and ends exactly once", () => {
		const stream = new PcmStreamSource(24_000);
		stream.push(pcm(1, 2));
		stream.push(pcm(3));
		const received: number[] = [];
		let ended = 0;
		stream.subscribe(
			(chunk) => received.push(...chunk),
			() => ended++,
		);
		// Chunks that arrived before the subscriber must not be lost.
		expect(received).toEqual([1, 2, 3]);
		expect(ended).toBe(0);
		stream.push(pcm(4));
		expect(received).toEqual([1, 2, 3, 4]);
		stream.end();
		stream.push(pcm(5));
		stream.end();
		expect(received).toEqual([1, 2, 3, 4]);
		expect(ended).toBe(1);
	});

	it("signals a failed stream to a subscriber that arrives afterwards", () => {
		const stream = new PcmStreamSource(24_000);
		stream.fail();
		let ended = 0;
		stream.subscribe(
			() => {},
			() => ended++,
		);
		expect(ended).toBe(1);
		expect(stream.failed).toBe(true);
		expect(stream.chunks).toHaveLength(0);
	});

	it("stops delivering to a detached subscriber", () => {
		const stream = new PcmStreamSource(24_000);
		const received: number[] = [];
		stream.subscribe(
			(chunk) => received.push(...chunk),
			() => {},
		);
		stream.push(pcm(7));
		stream.unsubscribe();
		stream.push(pcm(8));
		expect(received).toEqual([7]);
	});
});

describe("AudioQueue streamed PCM playback", () => {
	beforeEach(() => {
		FakeAudio.instances = [];
		FakeAudio.playImpl = () => Promise.resolve();
		FakeAudioContext.sources = [];
		FakeAudioContext.now = 0;
		vi.stubGlobal("Audio", FakeAudio);
		vi.stubGlobal("AudioContext", FakeAudioContext);
	});

	it("holds a later stream until the earlier reserved sentence has played", () => {
		const queue = new AudioQueue();
		const stream = new PcmStreamSource(24_000);
		const started = vi.fn();
		queue.enqueueOrderedStream(1, stream, { onPlaybackStart: started });
		stream.push(pcm(1, 2, 3));
		// seq 1 must not jump ahead of the still-missing seq 0.
		expect(FakeAudioContext.sources).toHaveLength(0);
		expect(started).not.toHaveBeenCalled();

		queue.enqueueOrdered(0, "first-sentence");
		expect(FakeAudio.instances).toHaveLength(1);
		expect(FakeAudioContext.sources).toHaveLength(0);

		FakeAudio.instances[0].onended?.();
		expect(FakeAudioContext.sources).toHaveLength(1);
		expect(started).toHaveBeenCalledTimes(1);
	});

	it("starts playback on the first chunk and schedules later chunks back-to-back", () => {
		const onPlaybackStart = vi.fn();
		const queue = new AudioQueue({ onPlaybackStart });
		const stream = new PcmStreamSource(24_000);
		const itemStart = vi.fn();
		queue.enqueueOrderedStream(0, stream, { onPlaybackStart: itemStart });
		stream.push(new Int16Array(2_400)); // 100 ms
		expect(itemStart).toHaveBeenCalledTimes(1);
		expect(onPlaybackStart).toHaveBeenCalledTimes(1);
		stream.push(new Int16Array(2_400));
		expect(itemStart).toHaveBeenCalledTimes(1); // only the first chunk starts
		const [first, second] = FakeAudioContext.sources;
		expect(first.startedAt).toBeGreaterThan(0);
		// Gapless: the second chunk starts exactly where the first one ends.
		expect(second.startedAt).toBeCloseTo((first.startedAt ?? 0) + 0.1, 5);
	});

	it("treats an empty stream as unavailable and advances to the next sentence", () => {
		const queue = new AudioQueue();
		const stream = new PcmStreamSource(24_000);
		const unavailable = vi.fn();
		queue.enqueueOrderedStream(0, stream, {
			onPlaybackUnavailable: unavailable,
		});
		queue.enqueueOrdered(1, "second-sentence");
		expect(FakeAudio.instances).toHaveLength(0);
		stream.end();
		expect(unavailable).toHaveBeenCalledTimes(1);
		expect(FakeAudio.instances).toHaveLength(1);
	});

	it("keeps a base64 sentence behind a stream until its chunks have drained", () => {
		const queue = new AudioQueue();
		const stream = new PcmStreamSource(24_000);
		queue.enqueueOrderedStream(0, stream);
		queue.enqueueOrdered(1, "second-sentence");
		stream.push(new Int16Array(2_400));
		stream.end();
		// end() alone must not cut the scheduled audio short.
		expect(FakeAudio.instances).toHaveLength(0);
		FakeAudioContext.sources[0].onended?.();
		expect(FakeAudio.instances).toHaveLength(1);
	});

	it("stops scheduled sources on clear and ignores chunks that arrive later", () => {
		const queue = new AudioQueue();
		const stream = new PcmStreamSource(24_000);
		const started = vi.fn();
		queue.enqueueOrderedStream(0, stream, { onPlaybackStart: started });
		stream.push(new Int16Array(2_400));
		expect(FakeAudioContext.sources).toHaveLength(1);
		queue.clear();
		expect(FakeAudioContext.sources[0].stopped).toBe(true);
		stream.push(new Int16Array(2_400));
		expect(FakeAudioContext.sources).toHaveLength(1);
		expect(started).toHaveBeenCalledTimes(1);
	});
});
