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
	currentTime = 0;
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

	it("#688: a stream slot that ends with whole audio plays that audio in its own order", () => {
		const queuePlaybackStart = vi.fn();
		const queue = new AudioQueue({ onPlaybackStart: queuePlaybackStart });
		const a0 = vi.fn();
		const a1 = vi.fn();
		const s0 = new PcmStreamSource(24_000);
		const s1 = new PcmStreamSource(24_000);
		const seq0 = queue.reserveSeq();
		const seq1 = queue.reserveSeq();
		expect(seq0).toBe(0);
		expect(seq1).toBe(1);
		queue.enqueueOrderedStream(0, s0, { onPlaybackStart: a0 });
		queue.enqueueOrderedStream(1, s1, { onPlaybackStart: a1 });
		s0.endWithAudio("UklGRAAA");
		s1.endWithAudio("UklGRBBB");
		expect(FakeAudio.instances).toHaveLength(1);
		expect(FakeAudio.instances[0].src).toContain("UklGRAAA");
		FakeAudio.instances[0].onplay?.();
		expect(a0).toHaveBeenCalledTimes(1);
		expect(queuePlaybackStart).toHaveBeenCalledTimes(1);
		FakeAudio.instances[0].onended?.();
		expect(FakeAudio.instances).toHaveLength(2);
		expect(FakeAudio.instances[1].src).toContain("UklGRBBB");
	});

	it("#688: whole audio on a paused queue plays after resumePlayback", () => {
		const queue = new AudioQueue();
		queue.pauseBeforePlayback();
		const stream = new PcmStreamSource(24_000);
		queue.enqueueOrderedStream(0, stream);
		stream.endWithAudio("UklGR_PAUSED");
		expect(FakeAudio.instances).toHaveLength(0);
		queue.resumePlayback();
		expect(FakeAudio.instances).toHaveLength(1);
		expect(FakeAudio.instances[0].src).toContain("UklGR_PAUSED");
	});

	it("treats a failed stream without whole audio as unavailable", () => {
		const queue = new AudioQueue();
		const stream = new PcmStreamSource(24_000);
		const unavailable = vi.fn();
		queue.enqueueOrderedStream(0, stream, {
			onPlaybackUnavailable: unavailable,
		});
		stream.fail();
		expect(unavailable).toHaveBeenCalledTimes(1);
	});

	it("reports lookahead level in streamed PCM: null beyond scheduled chunks when unended, 0 when ended", () => {
		const queue = new AudioQueue();
		const stream = new PcmStreamSource(24_000);
		queue.enqueueOrderedStream(0, stream);
		// Push 100ms chunk (2400 samples)
		stream.push(new Int16Array(2_400));
		const firstSource = FakeAudioContext.sources[0];
		expect(firstSource).toBeDefined();

		// Playhead is at the scheduled start (e.g. 0.04s)
		FakeAudioContext.now = firstSource.startedAt ?? 0.04;

		// Ahead within scheduled chunk (50ms ahead = 0.09s, within [0.04, 0.14])
		expect(queue.voiceLevelAhead(0.05)).not.toBeNull();

		// Ahead past scheduled chunk while stream is NOT ended: returns null (unknown future)
		expect(queue.voiceLevelAhead(0.2)).toBeNull();

		// Stream ends
		stream.end();

		// Ahead past scheduled chunk after stream ended: returns 0 (speech finished)
		expect(queue.voiceLevelAhead(0.2)).toBe(0);
	});
});

function makeWavBase64(
	durationSec: number,
	sampleValue = 0x4000,
	sampleRate = 24_000,
): string {
	const sampleCount = Math.round(durationSec * sampleRate);
	const pcmBytes = sampleCount * 2;
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
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	view.setUint32(40, pcmBytes, true);
	for (let i = 0; i < sampleCount; i++) {
		view.setInt16(44 + i * 2, sampleValue, true);
	}
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

describe("AudioQueue lookahead continuation across queue items", () => {
	beforeEach(() => {
		FakeAudio.instances = [];
		FakeAudio.playImpl = () => Promise.resolve();
		FakeAudioContext.sources = [];
		FakeAudioContext.now = 0;
		vi.stubGlobal("Audio", FakeAudio);
		vi.stubGlobal("AudioContext", FakeAudioContext);
	});

	it("(A) 스트림 항목 재생 중, 현재 스트림 ended, 대기열에 다음 스트림 항목이 조각을 받아 둔 상태: 현재 끝 + 0.1초 앞보기가 다음 스트림 봉투의 0.1초 칸 값(0 아님)을 돌려줌", () => {
		const queue = new AudioQueue();
		const stream1 = new PcmStreamSource(24_000);
		const stream2 = new PcmStreamSource(24_000);
		queue.enqueueOrderedStream(0, stream1);
		queue.enqueueOrderedStream(1, stream2);

		// stream1: 100ms (2400 samples)
		stream1.push(new Int16Array(2_400).fill(0x4000));
		stream1.end();

		// stream2: 200ms (4800 samples)
		stream2.push(new Int16Array(4_800).fill(0x4000));

		const firstSource = FakeAudioContext.sources[0];
		expect(firstSource).toBeDefined();
		FakeAudioContext.now = firstSource.startedAt ?? 0.04;

		// current stream ends at FakeAudioContext.now + 0.1s
		// lookahead at current end + 0.1s: offsetSec = 0.2s
		const offsetSec = 0.2;
		const level = queue.voiceLevelAhead(offsetSec);
		expect(level).not.toBeNull();
		expect(level).toBeGreaterThan(0);
		expect(level).toBeCloseTo(0.5, 1);
	});

	it("(B) 같은 상황에서 다음 스트림이 받은 길이를 넘는 시각 + 그 스트림 미종료: null", () => {
		const queue = new AudioQueue();
		const stream1 = new PcmStreamSource(24_000);
		const stream2 = new PcmStreamSource(24_000);
		queue.enqueueOrderedStream(0, stream1);
		queue.enqueueOrderedStream(1, stream2);

		stream1.push(new Int16Array(2_400).fill(0x4000));
		stream1.end();

		// stream2 has received 200ms of audio, not ended
		stream2.push(new Int16Array(4_800).fill(0x4000));
		expect(stream2.ended).toBe(false);

		const firstSource = FakeAudioContext.sources[0];
		FakeAudioContext.now = firstSource.startedAt ?? 0.04;

		// current stream duration is 0.1s. offsetSec = 0.1 + 0.3 = 0.4s (over = 0.3s > stream2 duration 0.2s)
		const offsetSec = 0.4;
		expect(queue.voiceLevelAhead(offsetSec)).toBeNull();
	});

	it("(C) 현재 스트림 ended, 대기열 비었고 예약된 문장 없음: 0. 예약만 된 문장이 있음(reserveSeq 뒤 아직 enqueue 안 함): null", () => {
		const queue = new AudioQueue();
		const seq0 = queue.reserveSeq();
		const stream = new PcmStreamSource(24_000);
		queue.enqueueOrderedStream(seq0, stream);
		stream.push(new Int16Array(2_400).fill(0x4000));
		stream.end();

		const firstSource = FakeAudioContext.sources[0];
		FakeAudioContext.now = firstSource.startedAt ?? 0.04;
		const offsetSec = 0.2; // beyond stream end (over = 0.1s)

		// Case 1: 대기열 비었고 예약된 문장 없음 -> 0
		expect(queue.voiceLevelAhead(offsetSec)).toBe(0);

		// Case 2: reserveSeq 호출되어 예약만 된 문장이 있음 -> null
		queue.reserveSeq();
		expect(queue.voiceLevelAhead(offsetSec)).toBeNull();
	});

	it("(D) WAV 항목 재생 중 봉투 끝 뒤, 대기열에 다음 WAV 항목: 다음 WAV 봉투 값. 다음이 MP3: null", () => {
		const wav1 = makeWavBase64(0.1, 0x4000);
		const wav2 = makeWavBase64(0.2, 0x4000);

		// Case 1: 다음이 WAV 항목 -> 다음 WAV 봉투 값
		const queue1 = new AudioQueue();
		queue1.enqueue(wav1);
		queue1.enqueue(wav2);

		const audio1 = FakeAudio.instances[0];
		audio1.onplay?.();
		audio1.currentTime = 0.05;

		// wav1 duration: 0.1s. currentTime: 0.05s. offsetSec: 0.1s -> time = 0.15s, over = 0.05s
		const val1 = queue1.voiceLevelAhead(0.1);
		expect(val1).not.toBeNull();
		expect(val1).toBeGreaterThan(0);
		expect(val1).toBeCloseTo(0.5, 1);

		// Case 2: 다음이 MP3 -> null
		const queue2 = new AudioQueue();
		queue2.enqueue(wav1);
		queue2.enqueue("bXAzaGVhZGVy"); // MP3, does not start with UklGR

		const audio2 = FakeAudio.instances[FakeAudio.instances.length - 1];
		audio2.onplay?.();
		audio2.currentTime = 0.05;

		expect(queue2.voiceLevelAhead(0.1)).toBeNull();
	});

	it("(E) 현재 스트림 ended, 대기열 다음 항목이 조각 없는 ended 스트림 + wholeAudioBase64(WAV): 그 WAV 봉투 값", () => {
		const queue = new AudioQueue();
		const stream1 = new PcmStreamSource(24_000);
		const stream2 = new PcmStreamSource(24_000);
		queue.enqueueOrderedStream(0, stream1);
		queue.enqueueOrderedStream(1, stream2);

		stream1.push(new Int16Array(2_400).fill(0x4000));
		stream1.end();

		const wav = makeWavBase64(0.2, 0x4000);
		stream2.endWithAudio(wav);

		const firstSource = FakeAudioContext.sources[0];
		FakeAudioContext.now = firstSource.startedAt ?? 0.04;

		// stream1 duration: 0.1s. offsetSec = 0.15s (over = 0.05s into stream2)
		const val = queue.voiceLevelAhead(0.15);
		expect(val).not.toBeNull();
		expect(val).toBeGreaterThan(0);
		expect(val).toBeCloseTo(0.5, 1);
	});

	it("(F) 현재 스트림 미종료 + 예약 끝 뒤: 지금처럼 null (기존 시험 유지)", () => {
		const queue = new AudioQueue();
		const stream = new PcmStreamSource(24_000);
		queue.enqueueOrderedStream(0, stream);
		stream.push(new Int16Array(2_400).fill(0x4000));
		expect(stream.ended).toBe(false);

		const firstSource = FakeAudioContext.sources[0];
		FakeAudioContext.now = firstSource.startedAt ?? 0.04;

		// lookahead past scheduled 100ms
		expect(queue.voiceLevelAhead(0.2)).toBeNull();
	});

	it("(G) 스트림 A 재생 중, 대기열에 조각 없는 미종료 스트림 B, 그 뒤 대기열·예약 없음. A 를 끝내 playNext 가 B 를 꺼낸 뒤(B 의 첫 조각 전) voiceLevelAhead(0.1) 이 null. B 에 첫 조각을 넣으면 숫자(B 봉투 값)를 돌려줌", () => {
		const queue = new AudioQueue();
		const streamA = new PcmStreamSource(24_000);
		const streamB = new PcmStreamSource(24_000);
		queue.enqueueOrderedStream(0, streamA);
		queue.enqueueOrderedStream(1, streamB);

		// 스트림 A: 100ms (2400 samples)
		streamA.push(new Int16Array(2_400).fill(0x4000));
		const sourceA = FakeAudioContext.sources[0];
		expect(sourceA).toBeDefined();
		FakeAudioContext.now = sourceA.startedAt ?? 0.04;

		// A 를 끝냄 -> bufferSource의 onended로 playNext 가 호출되어 B 를 꺼냄
		streamA.end();
		sourceA.onended?.();

		// B 의 첫 조각 전: voiceLevelAhead(0.1) 이 null
		expect(queue.voiceLevelAhead(0.1)).toBeNull();

		// B 에 첫 조각을 넣음 -> startLevel 호출되어 숫자(B 봉투 값)를 돌려줌
		streamB.push(new Int16Array(2_400).fill(0x4000));
		const sourceB = FakeAudioContext.sources[1];
		expect(sourceB).toBeDefined();
		FakeAudioContext.now = sourceB.startedAt ?? 0.14;

		const level = queue.voiceLevelAhead(0.05);
		expect(level).not.toBeNull();
		expect(level).toBeGreaterThan(0);
		expect(level).toBeCloseTo(0.5, 1);
	});

	it("(H) 스트림 A 재생 중, 대기열에 WAV B 와 그 뒤 WAV C. A 가 끝나 B 를 꺼낸 뒤 onplay 전 voiceLevelAhead(0.1) 이 null(C 의 값이 아님). onplay 뒤에는 B 봉투 값", () => {
		const queue = new AudioQueue();
		const streamA = new PcmStreamSource(24_000);
		const wavB = makeWavBase64(0.2, 0x4000);
		const wavC = makeWavBase64(0.2, 0x4000);

		queue.enqueueOrderedStream(0, streamA);
		queue.enqueueOrdered(1, wavB);
		queue.enqueueOrdered(2, wavC);

		// 스트림 A: 100ms
		streamA.push(new Int16Array(2_400).fill(0x4000));
		const sourceA = FakeAudioContext.sources[0];
		expect(sourceA).toBeDefined();
		FakeAudioContext.now = sourceA.startedAt ?? 0.04;

		// A 가 끝나 B 를 꺼냄
		streamA.end();
		sourceA.onended?.();

		// B 를 꺼낸 뒤 onplay 전: voiceLevelAhead(0.1) 이 null (C 의 값이 아님)
		expect(FakeAudio.instances).toHaveLength(1);
		expect(queue.voiceLevelAhead(0.1)).toBeNull();

		// onplay 뒤에는 B 봉투 값
		const audioB = FakeAudio.instances[0];
		audioB.currentTime = 0;
		audioB.onplay?.();

		const level = queue.voiceLevelAhead(0.1);
		expect(level).not.toBeNull();
		expect(level).toBeGreaterThan(0);
		expect(level).toBeCloseTo(0.5, 1);
	});
});
