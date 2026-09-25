import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	NVA_GATE_THRESHOLD,
	NVA_SHELL_HOLD_MS,
	NvaAudioGate,
} from "../../avatar/nva-audio-gate";
import {
	AUDIBLE_OFF_HOLD_MS,
	AUDIO_CONTEXT_RESUME_TIMEOUT_MS,
	AudioQueue,
	PcmStreamSource,
	SUSPENDED_ENDED_STREAM_MAX_WAIT_MS,
	wavDurationSeconds,
} from "../audio-queue";

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

class FakeAudio {
	static instances: FakeAudio[] = [];
	static playImpl: () => Promise<void> = () => Promise.resolve();
	onplay: (() => void) | null = null;
	onended: (() => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	src: string;
	pause = vi.fn();
	play = vi.fn<() => Promise<void>>(() => FakeAudio.playImpl());
	currentTime = 0.01;
	private listeners: Record<string, Array<() => void>> = {};

	addEventListener(event: string, fn: () => void) {
		if (!this.listeners[event]) {
			this.listeners[event] = [];
		}
		this.listeners[event].push(fn);
	}
	removeEventListener(event: string, fn: () => void) {
		this.listeners[event] = (this.listeners[event] ?? []).filter(
			(f) => f !== fn,
		);
	}
	dispatchEvent(event: Event) {
		for (const fn of this.listeners[event.type] ?? []) fn();
	}

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

	it("gap-review-7 (2026-09-25) 구멍 5-1: HTMLAudioElement 경로(WAV 대체 합성 포함)도 실제 재생 시작/종료에 맞춰 audible 을 켜고 끈다", () => {
		vi.useFakeTimers();
		try {
			const onAudibleChange = vi.fn();
			const queue = new AudioQueue({ onAudibleChange });
			queue.enqueue("YmFzZTY0");
			const audio = FakeAudio.instances[0];
			// 디코딩/합성 대기 동안(onplay 전)에는 아직 안 켜진다.
			expect(onAudibleChange).not.toHaveBeenCalled();
			audio.onplay?.();
			expect(onAudibleChange).toHaveBeenLastCalledWith(true);
			audio.onended?.();
			// review 8: nothing else queued → off with the last sound, no hold.
			vi.advanceTimersByTime(0);
			expect(onAudibleChange).toHaveBeenLastCalledWith(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("구멍 5-1: onerror 도 audible 을 false 로 되돌린다", () => {
		vi.useFakeTimers();
		try {
			const onAudibleChange = vi.fn();
			const queue = new AudioQueue({ onAudibleChange });
			queue.enqueue("YmFzZTY0");
			const audio = FakeAudio.instances[0];
			audio.onplay?.();
			expect(onAudibleChange).toHaveBeenLastCalledWith(true);
			audio.onerror?.(new Event("error"));
			vi.advanceTimersByTime(0);
			expect(onAudibleChange).toHaveBeenLastCalledWith(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("review 8 hole 2: two queued sentences play back to back without the audible signal going off between them", () => {
		vi.useFakeTimers();
		try {
			const onAudibleChange = vi.fn();
			const queue = new AudioQueue({ onAudibleChange });
			queue.enqueue("first");
			queue.enqueue("second");
			FakeAudio.instances[0].onplay?.();
			FakeAudio.instances[0].onended?.();
			vi.advanceTimersByTime(30); // decode of the next sentence
			FakeAudio.instances[1].onplay?.();
			vi.advanceTimersByTime(AUDIBLE_OFF_HOLD_MS * 2);
			expect(onAudibleChange.mock.calls).toEqual([[true]]);
			FakeAudio.instances[1].onended?.();
			vi.advanceTimersByTime(0);
			expect(onAudibleChange.mock.calls).toEqual([[true], [false]]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("review 8 hole 2: with a sentence still being synthesized, the signal goes off only after the hold", () => {
		vi.useFakeTimers();
		try {
			const onAudibleChange = vi.fn();
			const queue = new AudioQueue({ onAudibleChange });
			const first = queue.reserveSeq();
			queue.reserveSeq(); // second sentence: synthesis still running
			queue.enqueueOrdered(first, "first");
			FakeAudio.instances[0].onplay?.();
			FakeAudio.instances[0].onended?.();
			vi.advanceTimersByTime(AUDIBLE_OFF_HOLD_MS - 1);
			expect(onAudibleChange).toHaveBeenLastCalledWith(true);
			vi.advanceTimersByTime(1);
			expect(onAudibleChange).toHaveBeenLastCalledWith(false);
		} finally {
			vi.useRealTimers();
		}
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
	start = vi.fn((at: number) => {
		this.startedAt = at;
	});
	stop = vi.fn(() => {
		if (this.stopped) return;
		this.stopped = true;
		setTimeout(() => {
			this.onended?.();
		}, 0);
	});
	disconnect = vi.fn();
}

class FakeAudioContext {
	static sources: FakeBufferSource[] = [];
	static now = 0;
	// gap-review-7 (2026-09-25) 구멍 5-2: 이 클래스는 파일 전체에서 사실상
	// 싱글턴이다(audio-queue.ts 의 `sharedAudioContext` 캐시가 첫 호출에서
	// 만든 인스턴스를 계속 재사용) — 그래서 `state`/`outputLatency`/재개
	// 동작을 인스턴스 필드가 아니라 static 으로 둬서, 이미 만들어진 단일
	// 인스턴스를 테스트마다 재설정할 수 있게 한다.
	static state: "running" | "suspended" = "running";
	static outputLatency = 0;
	static baseLatency: number | undefined = undefined;
	static resumeImpl: () => Promise<void> = async () => {
		FakeAudioContext.state = "running";
	};
	static resumeCalls = 0;
	static listeners: Record<string, Array<() => void>> = {};

	static dispatchEvent(event: string) {
		for (const fn of FakeAudioContext.listeners[event] ?? []) fn();
	}
	static clearListeners() {
		FakeAudioContext.listeners = {};
	}
	destination = {};
	resume = vi.fn(() => {
		FakeAudioContext.resumeCalls++;
		return FakeAudioContext.resumeImpl();
	});
	addEventListener(event: string, fn: () => void) {
		if (!FakeAudioContext.listeners[event]) {
			FakeAudioContext.listeners[event] = [];
		}
		FakeAudioContext.listeners[event].push(fn);
	}
	removeEventListener(event: string, fn: () => void) {
		FakeAudioContext.listeners[event] = (
			FakeAudioContext.listeners[event] ?? []
		).filter((f) => f !== fn);
	}
	get state() {
		return FakeAudioContext.state;
	}
	get currentTime() {
		return FakeAudioContext.now;
	}
	get outputLatency() {
		return FakeAudioContext.outputLatency;
	}
	get baseLatency() {
		return FakeAudioContext.baseLatency;
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
		// gap-review-7 (2026-09-25) 구멍 5-2: 매 시험 기본값으로 되돌린다 —
		// "running", 레이턴시 없음, 재개는 즉시 성공.
		FakeAudioContext.state = "running";
		FakeAudioContext.outputLatency = 0;
		FakeAudioContext.resumeCalls = 0;
		FakeAudioContext.clearListeners();
		FakeAudioContext.resumeImpl = async () => {
			FakeAudioContext.state = "running";
		};
		vi.stubGlobal("Audio", FakeAudio);
		vi.stubGlobal("AudioContext", FakeAudioContext);
		// gap-review-2 (2026-09-25): onPlaybackStart now fires on a timer keyed
		// to the scheduled `at` time (real sound onset), not synchronously at
		// schedule time — see "playStream:first chunk scheduled".
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
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
		// gap-review-2: onPlaybackStart fires when the sound actually starts
		// (the scheduled `at`, here a 40ms lead), not the instant it was
		// scheduled.
		expect(started).not.toHaveBeenCalled();
		vi.advanceTimersByTime(40);
		expect(started).toHaveBeenCalledTimes(1);
	});

	it("starts playback on the first chunk and schedules later chunks back-to-back", () => {
		const onPlaybackStart = vi.fn();
		const queue = new AudioQueue({ onPlaybackStart });
		const stream = new PcmStreamSource(24_000);
		const itemStart = vi.fn();
		queue.enqueueOrderedStream(0, stream, { onPlaybackStart: itemStart });
		stream.push(new Int16Array(2_400)); // 100 ms
		// gap-review-2: deferred to the scheduled `at` (40ms lead), not fired
		// the instant the chunk was scheduled.
		expect(itemStart).not.toHaveBeenCalled();
		vi.advanceTimersByTime(40);
		expect(itemStart).toHaveBeenCalledTimes(1);
		expect(onPlaybackStart).toHaveBeenCalledTimes(1);
		stream.push(new Int16Array(2_400));
		vi.advanceTimersByTime(1000);
		expect(itemStart).toHaveBeenCalledTimes(1); // only the first chunk starts
		const [first, second] = FakeAudioContext.sources;
		expect(first.startedAt).toBeGreaterThan(0);
		// Gapless: the second chunk starts exactly where the first one ends.
		expect(second.startedAt).toBeCloseTo((first.startedAt ?? 0) + 0.1, 5);
	});

	it("gap-review-3: a large pre-roll actually delays the start notification until `at`, not just the 40ms floor", () => {
		// Guards against a leadMs that gets silently capped (e.g. Math.min(40,
		// leadMs)) — with startDelaySeconds=1.3, onPlaybackStart must NOT fire
		// until close to 1.2s have elapsed (1.3s target - the 100ms chunk's
		// own duration, which now counts as already-buffered), not at 40ms.
		const queue = new AudioQueue();
		const stream = new PcmStreamSource(24_000);
		const started = vi.fn();
		stream.startDelaySeconds = 1.3;
		queue.enqueueOrderedStream(0, stream, { onPlaybackStart: started });
		stream.push(new Int16Array(2_400)); // 100 ms → effective delay 1.2s
		vi.advanceTimersByTime(40);
		expect(started).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1159); // total 1199ms — still short of 1200ms
		expect(started).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1); // total 1200ms
		expect(started).toHaveBeenCalledTimes(1);
	});

	it("FR-VOICE.22: startDelaySeconds pushes the first chunk's scheduled start out (pre-roll)", () => {
		const queue = new AudioQueue();
		const stream = new PcmStreamSource(24_000);
		stream.startDelaySeconds = 0.7;
		queue.enqueueOrderedStream(0, stream, {});
		stream.push(new Int16Array(2_400)); // 100 ms
		const [first] = FakeAudioContext.sources;
		// Default lead is 0.04s; startDelaySeconds must win when it is larger.
		// gap-review-3: the buffered amount is read LIVE at the moment this
		// very chunk is scheduled, and PcmStreamSource.push() appends to
		// `chunks` before invoking the callback — so this chunk's own 100ms
		// already counts as "buffered ahead" and is subtracted from the
		// target (0.7 - 0.1 = 0.6). Excluding it would leave the original
		// bug unfixed (see the exact repro test below).
		expect(first.startedAt).toBeCloseTo(FakeAudioContext.now + 0.6, 5);
	});

	it("startDelaySeconds=0 (default) keeps the existing 40ms lead unchanged", () => {
		const queue = new AudioQueue();
		const stream = new PcmStreamSource(24_000);
		expect(stream.startDelaySeconds).toBe(0);
		queue.enqueueOrderedStream(0, stream, {});
		stream.push(new Int16Array(2_400));
		const [first] = FakeAudioContext.sources;
		expect(first.startedAt).toBeCloseTo(FakeAudioContext.now + 0.04, 5);
	});

	it("gap-review-2 repro: pre-roll only covers what is not already buffered by turn-arrival", () => {
		const queue = new AudioQueue();
		const stream = new PcmStreamSource(24_000);
		// Background synthesis kept running while the previous sentence played:
		// 1.0s of audio is already sitting in the stream BEFORE this stream's
		// turn arrives (before enqueueOrderedStream/subscribe).
		stream.push(new Int16Array(24_000)); // 1.0s already buffered
		stream.startDelaySeconds = 1.3; // target pre-roll (e.g. RTF-based)
		stream.expectedDurationSeconds = 5;
		queue.enqueueOrderedStream(0, stream, {});
		const [first] = FakeAudioContext.sources;
		// Without the fix this would wait the full 1.3s target. With the fix,
		// only the still-missing 0.3s (1.3 - 1.0) is added.
		expect(first.startedAt).toBeCloseTo(FakeAudioContext.now + 0.3, 5);
	});

	it("gap-review-7 (2026-09-25) 구멍 6-2 (M23 변이 방지): 구독 전 여러 조각이 쌓였으면 그 합계를 반영한다(현재 조각 하나가 아니라)", () => {
		// M23: bufferedSecondsNow 계산을 "지금 조각 하나 길이"로 바꿔도 기존
		// 시험이 통과했다 — 기존 시험은 구독 전에 청크를 "하나만" 밀어넣어서,
		// "전체 합"과 "이 조각 하나"가 우연히 같은 값이었기 때문이다. 이 시험은
		// 서로 다른 두 조각(각 0.5s)을 구독 전에 미리 쌓아, 첫 재생 콜백이
		// 발화하는 순간(loop 의 첫 조각) 합계(1.0s)와 "이 조각 하나"(0.5s)가
		// 갈라지게 만든다.
		const queue = new AudioQueue();
		const stream = new PcmStreamSource(24_000);
		stream.push(new Int16Array(12_000)); // 0.5s
		stream.push(new Int16Array(12_000)); // 0.5s — 합계 1.0s, 이 조각만은 0.5s
		stream.startDelaySeconds = 1.3;
		stream.expectedDurationSeconds = 5;
		queue.enqueueOrderedStream(0, stream, {});
		const [first] = FakeAudioContext.sources;
		// 올바른 합계(1.0s) 기준: 1.3 - 1.0 = 0.3s. "이 조각만"(0.5s) 기준이면
		// 1.3 - 0.5 = 0.8s 로, 서로 다른 값이라 변이를 잡는다.
		expect(first.startedAt).toBeCloseTo(FakeAudioContext.now + 0.3, 5);
	});

	it("gap-review-2: a fully-buffered-ahead stream gets no extra pre-roll (just the 40ms jitter floor)", () => {
		const queue = new AudioQueue();
		const stream = new PcmStreamSource(24_000);
		stream.push(new Int16Array(5 * 24_000)); // 5.0s — the whole sentence already buffered
		stream.startDelaySeconds = 1.3;
		stream.expectedDurationSeconds = 5;
		queue.enqueueOrderedStream(0, stream, {});
		const [first] = FakeAudioContext.sources;
		expect(first.startedAt).toBeCloseTo(FakeAudioContext.now + 0.04, 5);
	});

	it("gap-review-2: an already-ended stream (fully synthesized) never waits for pre-roll", () => {
		const queue = new AudioQueue();
		const stream = new PcmStreamSource(24_000);
		stream.push(new Int16Array(2_400)); // 100 ms
		stream.end();
		stream.startDelaySeconds = 1.3;
		stream.expectedDurationSeconds = 5;
		queue.enqueueOrderedStream(0, stream, {});
		const [first] = FakeAudioContext.sources;
		expect(first.startedAt).toBeCloseTo(FakeAudioContext.now + 0.04, 5);
	});

	it("gap-review-3 repro: a whole-WAV fallback landing on an already-subscribed, still-empty stream is not double-delayed", () => {
		// Exact coordinator repro: subscribe (enqueueOrderedStream) on an EMPTY
		// stream FIRST — this is what happens at turn-arrival for a normal
		// streaming slot — and only AFTERWARDS does the whole-WAV fallback
		// (sentence-pipeline.ts) land the entire sentence as one push()+end()
		// call. A pre-subscribe snapshot would have captured "0 buffered" for
		// good, since nothing had arrived yet when subscribe() ran, and would
		// wait out the full 1.3s pre-roll target for audio that, by the time
		// it actually arrived, had nothing left to wait for.
		const queue = new AudioQueue();
		const stream = new PcmStreamSource(24_000);
		stream.startDelaySeconds = 1.3;
		stream.expectedDurationSeconds = 5;
		queue.enqueueOrderedStream(0, stream, {}); // subscribe while empty
		stream.push(new Int16Array(5 * 24_000)); // the whole 5s WAV lands at once
		stream.end();
		const [first] = FakeAudioContext.sources;
		// Without the fix: now+1.3. With the fix: just the 40ms jitter floor.
		expect(first.startedAt).toBeCloseTo(FakeAudioContext.now + 0.04, 5);
	});

	it("gap-review-4 repro 1: pushFinal() on an already-subscribed, still-empty stream is not delayed even when buffered < expected duration", () => {
		// Coordinator's exact repro: startDelaySeconds=3.3, expectedDurationSeconds=10,
		// subscribe empty, then a single 2s chunk that is ALSO the last one. The
		// old push()+end() pair fails here specifically because 2s < 10s never
		// hits the "buffered >= expected" shortcut in effectivePreRollSeconds —
		// it can only reach delay=0 through the `ended` branch, and push()
		// invokes onChunk (and therefore reads `stream.ended`) synchronously,
		// BEFORE a caller's separate end() call could ever run.
		const queue = new AudioQueue();
		const stream = new PcmStreamSource(24_000);
		stream.startDelaySeconds = 3.3;
		stream.expectedDurationSeconds = 10;
		queue.enqueueOrderedStream(0, stream, {}); // subscribe while empty
		stream.pushFinal(new Int16Array(2 * 24_000)); // 2s, and the last chunk
		const [first] = FakeAudioContext.sources;
		// Without the fix: now+1.30 (3.3 target − 2s buffered). With the fix:
		// just the 40ms jitter floor, since the sentence had already finished.
		expect(first.startedAt).toBeCloseTo(FakeAudioContext.now + 0.04, 5);
	});

	it("gap-review-4 repro 2: pushFinal() is not delayed when expectedDurationSeconds is unknown (null)", () => {
		// Coordinator's second repro: startDelaySeconds=1.3, expectedDurationSeconds
		// left at its default (null) — the "buffered >= expected" shortcut in
		// effectivePreRollSeconds is skipped entirely when expected is null, so
		// this scenario can ONLY reach delay=0 through the `ended` branch.
		const queue = new AudioQueue();
		const stream = new PcmStreamSource(24_000);
		stream.startDelaySeconds = 1.3;
		queue.enqueueOrderedStream(0, stream, {}); // subscribe while empty
		stream.pushFinal(new Int16Array(0.5 * 24_000)); // 0.5s WAV, and the last chunk
		const [first] = FakeAudioContext.sources;
		// Without the fix: now+0.80 (1.3 target − 0.5s buffered). With the fix:
		// just the 40ms jitter floor.
		expect(first.startedAt).toBeCloseTo(FakeAudioContext.now + 0.04, 5);
	});

	it("gap-review-3: onended racing ahead of the deferred start timer still fires onPlaybackStart", () => {
		// A very short clip (or a test double that drives onended
		// synchronously, as this test does) can have its source finish —
		// and therefore reach advance() via maybeFinish() — before the
		// setTimeout scheduled for the pre-roll-delayed start notification
		// has had a chance to fire. Without a fix, advance() clears
		// currentStream, isCurrent() turns false, and the still-pending timer
		// later fires into a no-op — the reveal/speaking notification is
		// lost forever for a sentence that DID play.
		const queue = new AudioQueue();
		const stream = new PcmStreamSource(24_000);
		const started = vi.fn();
		stream.startDelaySeconds = 1.3;
		queue.enqueueOrderedStream(0, stream, { onPlaybackStart: started });
		stream.push(new Int16Array(2_400)); // 100 ms, scheduled ~1.3s out
		expect(started).not.toHaveBeenCalled(); // timer hasn't fired yet
		// Simulate onended firing (and the stream ending) before any fake-timer
		// advancement — the race the coordinator described.
		FakeAudioContext.sources[0].onended?.();
		stream.end();
		expect(started).toHaveBeenCalledTimes(1);
		// The original timer must have been cancelled, not merely raced —
		// advancing past its delay must not fire it a second time.
		vi.advanceTimersByTime(2000);
		expect(started).toHaveBeenCalledTimes(1);
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
		// gap-review-2: onPlaybackStart is still pending on a timer (the
		// scheduled `at` has not arrived yet) when clear() runs.
		queue.clear();
		expect(FakeAudioContext.sources[0].stopped).toBe(true);
		stream.push(new Int16Array(2_400));
		expect(FakeAudioContext.sources).toHaveLength(1);
		// The pending start timer must be cancelled by clear(), so it never
		// fires for a cancelled/stale item -- proves timer cleanup on cancel.
		vi.advanceTimersByTime(1000);
		expect(started).toHaveBeenCalledTimes(0);
	});

	describe("gap-review-7 (2026-09-25) 구멍 5-1: onAudibleChange — 조용한 구간과 분리된 세밀한 신호", () => {
		it("첫 조각이 예약된 시각(at)에 도달해야 true 다 — 예약 시점이 아니라", () => {
			const onAudibleChange = vi.fn();
			const queue = new AudioQueue({ onAudibleChange });
			const stream = new PcmStreamSource(24_000);
			queue.enqueueOrderedStream(0, stream, {});
			stream.push(new Int16Array(2_400)); // 100ms
			expect(onAudibleChange).not.toHaveBeenCalled();
			vi.advanceTimersByTime(40);
			expect(onAudibleChange).toHaveBeenCalledTimes(1);
			expect(onAudibleChange).toHaveBeenLastCalledWith(true);
		});

		it("버퍼 고갈(다음 조각이 아직 없는데 재생이 앞선 조각을 다 씀)이 유지 시간을 넘으면 false, 새 조각이 오면 다시 true", () => {
			const onAudibleChange = vi.fn();
			const queue = new AudioQueue({ onAudibleChange });
			const stream = new PcmStreamSource(24_000);
			queue.enqueueOrderedStream(0, stream, {});
			stream.push(new Int16Array(2_400)); // 100ms
			vi.advanceTimersByTime(40);
			expect(onAudibleChange).toHaveBeenLastCalledWith(true);
			// 이 조각이 다 재생됨 — 다음 조각이 아직 없다(스트림은 아직 안
			// 끝났다 = 진짜 고갈, WAV 대체 합성 대기와 같은 모양의 침묵).
			FakeAudioContext.sources[0].onended?.();
			// review 8 hole 2: a short underrun is not a pause in speech.
			vi.advanceTimersByTime(AUDIBLE_OFF_HOLD_MS - 1);
			expect(onAudibleChange).toHaveBeenLastCalledWith(true);
			vi.advanceTimersByTime(1);
			expect(onAudibleChange).toHaveBeenLastCalledWith(false);
			stream.push(new Int16Array(2_400)); // 고갈 뒤 재개
			vi.advanceTimersByTime(200);
			expect(onAudibleChange).toHaveBeenLastCalledWith(true);
		});

		it("review 8 hole 2: chunks arriving 10 ms late do not toggle the signal per chunk", () => {
			const onAudibleChange = vi.fn();
			const queue = new AudioQueue({ onAudibleChange });
			const stream = new PcmStreamSource(24_000);
			queue.enqueueOrderedStream(0, stream, {});
			stream.push(new Int16Array(2_400)); // 100ms
			vi.advanceTimersByTime(40);
			for (let i = 0; i < 4; i++) {
				FakeAudioContext.sources[i].onended?.(); // underrun
				vi.advanceTimersByTime(10);
				stream.push(new Int16Array(2_400)); // 10 ms late
				vi.advanceTimersByTime(1);
			}
			expect(onAudibleChange.mock.calls).toEqual([[true]]);
		});

		it("스트림이 끝까지 재생되면(advance) false 로 닫힌다", () => {
			const onAudibleChange = vi.fn();
			const queue = new AudioQueue({ onAudibleChange });
			const stream = new PcmStreamSource(24_000);
			queue.enqueueOrderedStream(0, stream, {});
			stream.push(new Int16Array(2_400));
			stream.end();
			vi.advanceTimersByTime(40);
			expect(onAudibleChange).toHaveBeenLastCalledWith(true);
			FakeAudioContext.sources[0].onended?.();
			// Nothing else queued: off with the last sound (device latency 0 here).
			vi.advanceTimersByTime(0);
			expect(onAudibleChange).toHaveBeenLastCalledWith(false);
		});

		it("clear() 는 들리는 중이었다면 즉시 false 를 알린다", () => {
			const onAudibleChange = vi.fn();
			const queue = new AudioQueue({ onAudibleChange });
			const stream = new PcmStreamSource(24_000);
			queue.enqueueOrderedStream(0, stream, {});
			stream.push(new Int16Array(2_400));
			vi.advanceTimersByTime(40);
			expect(onAudibleChange).toHaveBeenLastCalledWith(true);
			queue.clear();
			expect(onAudibleChange).toHaveBeenLastCalledWith(false);
		});

		it("아직 소리가 나기 전(첫 조각 대기/미리 채움 구간)에 clear() 되면 true 를 한 번도 부르지 않는다", () => {
			const onAudibleChange = vi.fn();
			const queue = new AudioQueue({ onAudibleChange });
			const stream = new PcmStreamSource(24_000);
			stream.startDelaySeconds = 1.3; // 미리 채움 구간
			queue.enqueueOrderedStream(0, stream, {});
			stream.push(new Int16Array(2_400));
			queue.clear(); // 예약된 audible 타이머가 아직 안 울렸다
			vi.advanceTimersByTime(2000);
			expect(onAudibleChange).not.toHaveBeenCalledWith(true);
		});

		it("VL-review1 시계 부류: 소리 버퍼(80ms)가 출력 지연(300ms)보다 짧아도 advance 시점에 입이 즉시 열리지 않고 실제 들리는 시각(340ms)에 열린다", () => {
			FakeAudioContext.outputLatency = 0.3; // 300ms 출력 지연
			try {
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });
				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});
				// 80ms 분량 PCM (24000 * 0.08 = 1920)
				stream.pushFinal(new Int16Array(1_920));

				// 120ms 시점에 버퍼 렌더링 종료 (40ms lead + 80ms buffer = 120ms)
				FakeAudioContext.now = 0.12;
				vi.advanceTimersByTime(120);
				FakeAudioContext.sources[0].onended?.();

				// advance() 가 불렸지만 소리는 340ms 에 나므로 입은 아직 열리지 않아야 한다 (220ms 앞섬 방지)
				expect(onAudibleChange).not.toHaveBeenCalled();

				// 339ms 시점까지도 아직 소리가 스피커에 안 나옴 -> 입 닫힘 유지
				FakeAudioContext.now = 0.339;
				vi.advanceTimersByTime(219);
				expect(onAudibleChange).not.toHaveBeenCalled();

				// 340ms (40ms lead + 300ms latency): 스피커에서 소리가 시작되는 순간 입이 열린다!
				FakeAudioContext.now = 0.341;
				vi.advanceTimersByTime(2);
				expect(onAudibleChange).toHaveBeenCalledTimes(1);
				expect(onAudibleChange).toHaveBeenLastCalledWith(true);

				// 420ms (340ms 시작 + 80ms 소리): 소리가 스피커에서 다 나온 뒤 닫힘 예약
				FakeAudioContext.now = 0.421;
				vi.advanceTimersByTime(80);
				// 소리가 끝났으므로 끄기 타이머 동작
				FakeAudioContext.now = 0.921;
				vi.advanceTimersByTime(500);
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
			}
		});

		it("VL-review1 문장 경계 부류: 응답 스트림이 이어지는 중(isResponseActive)이면 큐가 비어도 400ms 유지를 건너뛰지 않는다", () => {
			let streaming = true;
			const onAudibleChange = vi.fn();
			const queue = new AudioQueue({
				onAudibleChange,
				isResponseActive: () => streaming,
			});
			const first = queue.reserveSeq();
			queue.enqueueOrdered(first, "first-sentence");
			const [audio1] = FakeAudio.instances;
			audio1.onplay?.();
			expect(onAudibleChange).toHaveBeenLastCalledWith(true);

			// 첫 번째 문장 재생 끝남 -> 큐는 일시적으로 비어있음
			audio1.onended?.();

			// 하지만 응답 스트림이 진행 중(streaming === true)이므로 즉시 끄지 않고 400ms 유지
			vi.advanceTimersByTime(200);
			expect(onAudibleChange.mock.calls).toEqual([[true]]); // false 로 꺼지지 않음!

			// 200ms 뒤 다음 문장 도착
			const second = queue.reserveSeq();
			queue.enqueueOrdered(second, "second-sentence");
			const audio2 = FakeAudio.instances[1];
			audio2.onplay?.();

			// 400ms 가 지난 뒤에도 말하기 상태가 꺼지지 않고 유지됨
			vi.advanceTimersByTime(300);
			expect(onAudibleChange.mock.calls).toEqual([[true]]);

			// 두 번째 문장 끝남 + 응답 스트림 완료
			streaming = false;
			audio2.onended?.();
			// 이제 응답이 완전히 끝났으므로 소리 종료와 함께 닫힌다
			vi.advanceTimersByTime(0);
			expect(onAudibleChange).toHaveBeenLastCalledWith(false);
		});
	});

	describe("gap-review-7 (2026-09-25) 구멍 5-2: AudioContext 재개 대기 + outputLatency/baseLatency 보정", () => {
		it("ctx 가 suspended 면 재개(resume)가 끝날 때까지 첫 조각을 스케줄하지 않는다", async () => {
			let resolveResume!: () => void;
			FakeAudioContext.state = "suspended";
			FakeAudioContext.resumeImpl = () =>
				new Promise<void>((res) => {
					resolveResume = res;
				});
			const queue = new AudioQueue();
			const stream = new PcmStreamSource(24_000);
			queue.enqueueOrderedStream(0, stream, {});
			stream.push(new Int16Array(2_400));
			// currentTime 이 멈춰 있는 동안(suspended) 스케줄하면 `at`/leadMs 가
			// 거짓말을 한다 — 재개를 기다리는 동안은 아무 소스도 만들지 않는다.
			// (ensureAudioContext 자신도 suspended 를 보면 이미 한 번 resume()
			// 을 걸어 두므로 정확한 호출 횟수가 아니라 "적어도 한 번"만 본다.)
			expect(FakeAudioContext.resumeCalls).toBeGreaterThanOrEqual(1);
			expect(FakeAudioContext.sources).toHaveLength(0);
			FakeAudioContext.state = "running";
			resolveResume();
			await Promise.resolve();
			await Promise.resolve();
			// 재개가 끝난 뒤에야 첫 조각이 스케줄된다.
			expect(FakeAudioContext.sources).toHaveLength(1);
		});

		it("gap-review-8 구멍 5-2: ctx.resume() 이 영영 끝나지 않아도 타임아웃 fallback 으로 대기열이 영구 정지되지 않고 첫 조각 소스를 준비하되 start()는 0회 호출된다", async () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.state = "suspended";
				// resumeImpl never resolves (hanging promise)
				FakeAudioContext.resumeImpl = () => new Promise<void>(() => {});
				const queue = new AudioQueue();
				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});
				stream.push(new Int16Array(2_400));

				// Initially suspended and waiting for resume: no sources scheduled yet
				expect(FakeAudioContext.sources).toHaveLength(0);

				// Advance time past the resume timeout (AUDIO_CONTEXT_RESUME_TIMEOUT_MS)
				await vi.advanceTimersByTimeAsync(
					AUDIO_CONTEXT_RESUME_TIMEOUT_MS + 100,
				);

				// Fallback must have triggered beginSubscribe, scheduling the first chunk source
				expect(FakeAudioContext.sources).toHaveLength(1);
				// VL-3: 컨텍스트가 suspended 상태인 동안에는 start() 호출 0회 (보류 동작과 일치)
				expect(FakeAudioContext.sources[0].start).toHaveBeenCalledTimes(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it("VL-3: 타임아웃 fallback 후 컨텍스트를 running 으로 올리면 보류되었던 start() 가 정확히 1회 호출된다", async () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.state = "suspended";
				FakeAudioContext.now = 0;
				FakeAudioContext.resumeImpl = () => new Promise<void>(() => {});
				const queue = new AudioQueue();
				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});
				stream.push(new Int16Array(2_400));

				await vi.advanceTimersByTimeAsync(
					AUDIO_CONTEXT_RESUME_TIMEOUT_MS + 100,
				);
				expect(FakeAudioContext.sources).toHaveLength(1);
				expect(FakeAudioContext.sources[0].start).toHaveBeenCalledTimes(0);

				// 이제 컨텍스트를 running 으로 올림
				FakeAudioContext.state = "running";
				FakeAudioContext.now = 5.0;
				FakeAudioContext.dispatchEvent("statechange");
				await Promise.resolve();

				// start() 가 정확히 1회 불린다
				expect(FakeAudioContext.sources[0].start).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		});

		it("VL-review1 경합 부류: resume 타임아웃 경과 후 늦게 재개되어도 멈춘 시계로 입을 열지 않고, 실제 재개된 시계로 입 타이머를 잡으며 중복 구독하지 않는다", async () => {
			vi.useFakeTimers();
			try {
				let resolveResume!: () => void;
				FakeAudioContext.state = "suspended";
				FakeAudioContext.now = 0;
				FakeAudioContext.resumeImpl = () =>
					new Promise<void>((res) => {
						resolveResume = res;
					});

				const onAudibleChange = vi.fn();
				const onPlaybackStart = vi.fn();
				const queue = new AudioQueue({ onAudibleChange, onPlaybackStart });
				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});
				stream.push(new Int16Array(2_400)); // 100ms chunk

				// 2.5초 타임아웃 경과: 컨텍스트는 여전히 suspended
				await vi.advanceTimersByTimeAsync(
					AUDIO_CONTEXT_RESUME_TIMEOUT_MS + 200,
				);

				// 대기열은 멈추지 않고 소스를 준비했지만, 멈춘 시계(currentTime=0)로 입을 열지 않았다!
				expect(FakeAudioContext.sources).toHaveLength(1);
				expect(onAudibleChange).not.toHaveBeenCalled();
				expect(onPlaybackStart).not.toHaveBeenCalled();

				// 10초 시점에 사용자가 화면을 탭하여 컨텍스트가 실제로 running 으로 재개됨
				FakeAudioContext.now = 10.0;
				FakeAudioContext.state = "running";
				resolveResume();
				await Promise.resolve();
				await Promise.resolve();

				// 늦게 resolve 되어도 두 번 구독하지 않아 소스가 2개로 불어나지 않는다
				expect(FakeAudioContext.sources).toHaveLength(1);

				// 실제 재개된 시계(10.0초) 기준으로 40ms 리드 뒤에 비로소 입이 열린다
				vi.advanceTimersByTime(39);
				expect(onAudibleChange).not.toHaveBeenCalled();
				vi.advanceTimersByTime(2);
				expect(onAudibleChange).toHaveBeenCalledWith(true);
				expect(onPlaybackStart).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		});

		it("gap-review-7 5-2 전후 수치: outputLatency 를 반영하면 알림 시각이 실제 출력 시각과 일치한다", () => {
			// 이 시험은 "수정 전/후" 계산을 그대로 코드로 남긴다.
			// 조건: 첫 조각, now=0, 40ms 리드(startDelaySeconds=0) → at=0.04s.
			// 스피커에서 실제로 소리가 나는 시각은 at + outputLatency 다.
			const outputLatencySeconds = 0.12; // 흔한 USB 오디오 인터페이스 값 예시
			const at = 0.04;
			const now = 0;
			// 수정 전(이 라운드 이전 코드): 알림을 `at` 그대로에 걸었다 —
			// leadMsBefore = (at-now)*1000 = 40ms. 그런데 스피커는 at+0.12=0.16s
			// 에야 실제로 울린다. 즉 알림이 실제 출력보다 0.12s(120ms) 먼저 온다
			// — 이게 립싱크 입이 소리보다 먼저 움직이던 0.3~0.5초 지연 원인의
			// 한 갈래다.
			const notifyLeadMsBefore = (at - now) * 1000;
			const actualAudibleAtMs = (at + outputLatencySeconds) * 1000;
			const gapBeforeMs = actualAudibleAtMs - notifyLeadMsBefore;
			expect(gapBeforeMs).toBeCloseTo(120, 5); // 수정 전: 120ms 어긋남

			// 수정 후(이 라운드 코드): leadMs 계산에 outputLatency 를 더한다.
			const notifyLeadMsAfter = (at - now + outputLatencySeconds) * 1000;
			const gapAfterMs = actualAudibleAtMs - notifyLeadMsAfter;
			expect(gapAfterMs).toBeCloseTo(0, 5); // 수정 후: 0ms — 알림=실제 출력

			// 코드가 실제로 이 값을 쓰는지 확인 — FakeBufferSource 스케줄.
			FakeAudioContext.outputLatency = outputLatencySeconds;
			const onAudibleChange = vi.fn();
			const onPlaybackStart = vi.fn();
			const queue = new AudioQueue({ onAudibleChange, onPlaybackStart });
			const stream = new PcmStreamSource(24_000);
			queue.enqueueOrderedStream(0, stream, { onPlaybackStart: vi.fn() });
			stream.push(new Int16Array(2_400));
			vi.advanceTimersByTime(Math.round(notifyLeadMsAfter) - 1);
			expect(onAudibleChange).not.toHaveBeenCalled();
			expect(onPlaybackStart).not.toHaveBeenCalled();
			vi.advanceTimersByTime(2);
			expect(onAudibleChange).toHaveBeenCalledWith(true);
			expect(onPlaybackStart).toHaveBeenCalledTimes(1);
		});

		it("review 8: baseLatency and outputLatency add up (one latency function)", () => {
			FakeAudioContext.outputLatency = 0.05;
			FakeAudioContext.baseLatency = 0.01;
			try {
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });
				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});
				stream.push(new Int16Array(2_400));
				vi.advanceTimersByTime(99); // 40 ms lead + 60 ms latency
				expect(onAudibleChange).not.toHaveBeenCalled();
				vi.advanceTimersByTime(1);
				expect(onAudibleChange).toHaveBeenCalledWith(true);
			} finally {
				FakeAudioContext.baseLatency = undefined;
			}
		});

		it("outputLatency 가 없으면(0) baseLatency 로 대신 보정한다", () => {
			// 실제 AudioContext 는 outputLatency 가 없는 구형 구현에서도
			// baseLatency 는 있다 — 폴백을 검증한다. FakeAudioContext 는
			// baseLatency 필드가 없으므로(undefined) `?? 0` 으로 떨어져 0
			// 이어야 한다(레이턴시 보정이 전혀 없던 예전과 동일).
			FakeAudioContext.outputLatency = 0;
			const onAudibleChange = vi.fn();
			const queue = new AudioQueue({ onAudibleChange });
			const stream = new PcmStreamSource(24_000);
			queue.enqueueOrderedStream(0, stream, {});
			stream.push(new Int16Array(2_400));
			vi.advanceTimersByTime(39);
			expect(onAudibleChange).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(onAudibleChange).toHaveBeenCalledWith(true);
		});
	});

	describe("VL-3 검수 구멍 수정 시험 (경합, 시계, 끄기 지연 중복)", () => {
		it("VL-3 구멍 1: 스트림이 end 까지 받은 뒤 컨텍스트가 늦게 running 이 되면 그 문장의 소스 start() 가 실제로 불리고 입 신호가 켜진다", async () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.state = "suspended";
				FakeAudioContext.now = 0;
				FakeAudioContext.resumeImpl = () => new Promise<void>(() => {});
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });
				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});
				stream.push(new Int16Array(2_400));
				stream.end();

				// 타임아웃 경과 -> 구독은 일어났으나 컨텍스트는 여전히 suspended
				await vi.advanceTimersByTimeAsync(
					AUDIO_CONTEXT_RESUME_TIMEOUT_MS + 100,
				);
				// pendingChunks 에 보관되어 아직 advance 되지 않고 소스 start 도 불리지 않음
				expect(FakeAudioContext.sources).toHaveLength(1);
				expect(FakeAudioContext.sources[0].start).toHaveBeenCalledTimes(0);
				expect(onAudibleChange).not.toHaveBeenCalled();

				// 1초 뒤 컨텍스트가 running 으로 재개됨
				FakeAudioContext.state = "running";
				FakeAudioContext.now = 4.0;
				FakeAudioContext.dispatchEvent("statechange");
				await Promise.resolve();

				// 소스 start() 가 불림
				expect(FakeAudioContext.sources[0].start).toHaveBeenCalledTimes(1);
				// 스케줄 리드(40ms) 뒤 입 신호가 켜짐
				vi.advanceTimersByTime(40);
				expect(onAudibleChange).toHaveBeenCalledWith(true);
			} finally {
				vi.useRealTimers();
			}
		});

		it("VL-3 구멍 1: 스트림 end 후 5초(SUSPENDED_ENDED_STREAM_MAX_WAIT_MS) 넘게 suspended 면 다음 항목으로 넘어간다", async () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.state = "suspended";
				FakeAudioContext.now = 0;
				FakeAudioContext.resumeImpl = () => new Promise<void>(() => {});
				const onPlaybackUnavailable = vi.fn();
				const queue = new AudioQueue();
				const stream1 = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream1, { onPlaybackUnavailable });
				queue.enqueueOrdered(1, "second-sentence");

				stream1.push(new Int16Array(2_400));
				stream1.end();

				// 2.5초 타임아웃 경과
				await vi.advanceTimersByTimeAsync(
					AUDIO_CONTEXT_RESUME_TIMEOUT_MS + 100,
				);
				expect(onPlaybackUnavailable).not.toHaveBeenCalled();
				expect(FakeAudio.instances).toHaveLength(0);

				// 스트림 종료 시점으로부터 5초(SUSPENDED_ENDED_STREAM_MAX_WAIT_MS) 경과
				await vi.advanceTimersByTimeAsync(
					SUSPENDED_ENDED_STREAM_MAX_WAIT_MS + 50,
				);

				// 5초 대기 만료로 첫 번째 문장이 건너뛰어지고 unavailable 알림 발생
				expect(onPlaybackUnavailable).toHaveBeenCalledTimes(1);
				// 다음 항목("second-sentence")으로 진행되어 FakeAudio 인스턴스가 생성됨
				expect(FakeAudio.instances).toHaveLength(1);
			} finally {
				vi.useRealTimers();
			}
		});

		it("VL-3 구멍 1: clear() 뒤 running 이 와도 옛 문장의 소스가 start() 되지 않는다", async () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.state = "suspended";
				FakeAudioContext.now = 0;
				FakeAudioContext.resumeImpl = () => new Promise<void>(() => {});
				const queue = new AudioQueue();
				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});
				stream.push(new Int16Array(2_400));
				stream.end();

				// 타임아웃 경과로 소스 객체는 생성되었으나 start 는 보류
				await vi.advanceTimersByTimeAsync(
					AUDIO_CONTEXT_RESUME_TIMEOUT_MS + 100,
				);
				expect(FakeAudioContext.sources).toHaveLength(1);
				expect(FakeAudioContext.sources[0].start).toHaveBeenCalledTimes(0);

				// 사용자가 clear() 호출
				queue.clear();

				// 그 후 컨텍스트가 뒤늦게 running 으로 전환됨
				FakeAudioContext.state = "running";
				FakeAudioContext.now = 10.0;
				FakeAudioContext.dispatchEvent("statechange");
				await Promise.resolve();

				// 옛 문장의 소스는 start() 되지 않는다!
				expect(FakeAudioContext.sources[0].start).toHaveBeenCalledTimes(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it("VL-3 구멍 2 (가): 출력 지연 300ms 공유 컨텍스트가 있을 때 80ms WAV 가 끝난 뒤 입이 닫혀 있다", () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.3; // 300ms 지연
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });
				// 스트림을 재생하여 sharedAudioContext 가 활성화된 상태를 만듦
				const initStream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, initStream, {});
				initStream.pushFinal(new Int16Array(240));
				FakeAudioContext.sources[0].onended?.();
				vi.advanceTimersByTime(500);
				onAudibleChange.mockClear();

				queue.enqueue(
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				); // WAV base64
				const audio = FakeAudio.instances[0];
				audio.currentTime = 0.01;
				audio.onplay?.();
				expect(onAudibleChange).toHaveBeenCalledWith(true);

				// 80ms 후 재생 끝남
				audio.onended?.();
				// nothingQueued 이므로 미디어 경로는 출력 지연 없이 즉시(0ms) 닫힘
				vi.advanceTimersByTime(0);
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);

				// 300ms(출력 지연) 시점 뒤에도 입이 다시 열리지 않는다!
				vi.advanceTimersByTime(400);
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);
			} finally {
				FakeAudioContext.outputLatency = 0;
				vi.useRealTimers();
			}
		});

		it("VL-3 구멍 2 (나): 공유 컨텍스트가 null 일 때 onplay 순간이 아니라 currentTime 이 0 을 넘은 뒤에 입이 열린다", () => {
			vi.useFakeTimers();
			try {
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });
				queue.enqueue(
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				);
				const audio = FakeAudio.instances[0];
				audio.currentTime = 0; // 아직 재생 헤드가 0에 머무름

				audio.onplay?.();
				// onplay 순간에는 currentTime 이 0 이므로 아직 입이 열리지 않는다
				expect(onAudibleChange).not.toHaveBeenCalled();

				// 10ms 후 currentTime 이 0 을 넘음
				audio.currentTime = 0.02;
				vi.advanceTimersByTime(10);
				expect(onAudibleChange).toHaveBeenCalledWith(true);
			} finally {
				vi.useRealTimers();
			}
		});

		it("VL-3 구멍 2 (다): 긴 WAV 가 끝난 뒤 닫힘 시각에 출력 지연(300ms)이 더해지지 않는다", () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.3; // 300ms 지연
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });
				queue.enqueue(
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				);
				const audio = FakeAudio.instances[0];
				audio.currentTime = 0.5;
				audio.onplay?.();
				expect(onAudibleChange).toHaveBeenCalledWith(true);

				audio.onended?.();
				// 미디어 경로의 마지막 항목 끄기는 출력 지연(300ms)이 더해지지 않고 즉시 닫힘
				vi.advanceTimersByTime(0);
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);
			} finally {
				FakeAudioContext.outputLatency = 0;
				vi.useRealTimers();
			}
		});

		it("VL-3 구멍 3: 출력 지연 300ms, 스트림 문장 사이 500ms 쉼에서 400ms 시점에 VRM 입이 닫힌다 (지연 중복 없음)", () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.3; // 300ms 출력 지연
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const streaming = true;
				const queue = new AudioQueue({
					onAudibleChange,
					isResponseActive: () => streaming,
				});

				const stream1 = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream1, {});
				// 100ms chunk
				stream1.push(new Int16Array(2_400));
				stream1.end();

				// 소리 스케줄: at = 0.04s, duration = 0.1s, lastScheduledEnd = 0.14s
				// 140ms 시점에 버퍼 렌더링 종료
				FakeAudioContext.now = 0.14;
				vi.advanceTimersByTime(140);
				FakeAudioContext.sources[0].onended?.();

				// 340ms 시점(140ms로부터 200ms 후): 스피커에서 소리 시작되어 입 열림
				FakeAudioContext.now = 0.34;
				vi.advanceTimersByTime(200);
				expect(onAudibleChange).toHaveBeenCalledWith(true);

				// 440ms 시점(340ms로부터 100ms 후): 스피커에서 소리 종료 -> delayedOff 가 불림
				// delayedOff 는 setAudible(false, false)를 부르므로 출력 지연 중복 없이 400ms 유지만 적용!
				FakeAudioContext.now = 0.44;
				vi.advanceTimersByTime(100);

				// 440ms + 399ms = 839ms 시점: 아직 400ms 유지 중이라 열려 있음
				vi.advanceTimersByTime(399);
				expect(onAudibleChange.mock.calls).toEqual([[true]]);

				// 440ms + 400ms = 840ms 시점: 정확히 400ms 후 닫힘! (문장 사이 500ms 쉼 안에 닫힘)
				vi.advanceTimersByTime(1);
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
				vi.useRealTimers();
			}
		});

		it("VL-3 구멍 3: 스트림 끝 닫힘은 출력 지연만큼 기다리는 기존 동작이 그대로 유지된다", () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.3; // 300ms 출력 지연
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });

				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});
				// 1초 분량 소리 (at = 0.04s, lastScheduledEnd = 1.04s)
				stream.push(new Int16Array(24_000));
				stream.end();

				// 340ms 시점에 스피커에서 소리가 시작되어 입 열림
				FakeAudioContext.now = 0.34;
				vi.advanceTimersByTime(340);
				expect(onAudibleChange).toHaveBeenCalledWith(true);

				// 1.04s 시점(340ms로부터 700ms 후)에 버퍼 소스 재생 끝남
				FakeAudioContext.now = 1.04;
				vi.advanceTimersByTime(700);
				FakeAudioContext.sources[0].onended?.();

				// 소스 버퍼는 끝났으나 스피커에는 아직 300ms 출력 지연 분량의 소리가 남아있음
				// 299ms 뒤: 아직 출력 지연 대기 중이라 입이 열려있음
				vi.advanceTimersByTime(299);
				expect(onAudibleChange.mock.calls).toEqual([[true]]);

				// 300ms 뒤: 출력 지연이 지나고 마지막 소리가 스피커를 떠난 순간 비로소 닫힘!
				vi.advanceTimersByTime(1);
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
				vi.useRealTimers();
			}
		});
	});

	describe("VL-4 검수 구멍 수정 시험 (재생 도중 suspended 전환, 다음 항목 시작 시 이전 delayedOff 무력화)", () => {
		it("VL-4 구멍 1 (가): running 으로 재생 시작 뒤 suspended 로 바뀌고 5초가 지나면 시작된 소스에 stop() 1회, 입 신호 false, 다음 항목 재생 시작", async () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.state = "running";
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });

				const stream1 = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream1, {});
				queue.enqueueOrdered(1, "second-item-wav");

				// 100ms chunk pushed and scheduled while running
				stream1.push(new Int16Array(2_400));
				expect(FakeAudioContext.sources).toHaveLength(1);
				const src1 = FakeAudioContext.sources[0];
				expect(src1.start).toHaveBeenCalledTimes(1);

				// 스케줄 리드(40ms) 경과하여 입이 열림
				vi.advanceTimersByTime(40);
				expect(onAudibleChange).toHaveBeenCalledWith(true);

				// 재생 도중 컨텍스트가 suspended 로 전환
				FakeAudioContext.state = "suspended";
				FakeAudioContext.dispatchEvent("statechange");

				// 5초(SUSPENDED_ENDED_STREAM_MAX_WAIT_MS) 경과
				await vi.advanceTimersByTimeAsync(
					SUSPENDED_ENDED_STREAM_MAX_WAIT_MS + 50,
				);

				// 시작된 소스에 stop() 이 정확히 1회 불림
				expect(src1.stop).toHaveBeenCalledTimes(1);
				// 입 신호 마지막 값이 false 임
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);
				// 다음 항목의 재생(play())이 시작됨
				expect(FakeAudio.instances).toHaveLength(1);
				expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		});

		it("VL-4 구멍 1 (나): suspended 뒤 5초 안에 running 으로 돌아오면 stop() 0회이고 다음 항목으로 넘어가지 않는다", async () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.state = "running";
				FakeAudioContext.now = 0;
				const queue = new AudioQueue();

				const stream1 = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream1, {});
				queue.enqueueOrdered(1, "second-item-wav");

				stream1.push(new Int16Array(2_400));
				const src1 = FakeAudioContext.sources[0];
				expect(src1.start).toHaveBeenCalledTimes(1);

				// 컨텍스트가 suspended 로 전환
				FakeAudioContext.state = "suspended";
				FakeAudioContext.dispatchEvent("statechange");

				// 2초 경과 (5초 이내)
				await vi.advanceTimersByTimeAsync(2000);

				// 컨텍스트가 다시 running 으로 복구
				FakeAudioContext.state = "running";
				FakeAudioContext.dispatchEvent("statechange");

				// 5초 추가 경과
				await vi.advanceTimersByTimeAsync(
					SUSPENDED_ENDED_STREAM_MAX_WAIT_MS + 50,
				);

				// stop() 은 0회이고 다음 항목으로 넘어가지 않음
				expect(src1.stop).toHaveBeenCalledTimes(0);
				expect(FakeAudio.instances).toHaveLength(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it("VL-4 구멍 1 (다): 끝났는데 대기 청크가 남은 5초 상한 경로에서 시작된 소스는 stop() 1회, 대기 청크는 start() 0회·stop() 0회", async () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.state = "running";
				FakeAudioContext.now = 0;
				const queue = new AudioQueue();

				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});

				// 청크 1: running 상태에서 스케줄됨
				stream.push(new Int16Array(2_400));
				expect(FakeAudioContext.sources).toHaveLength(1);
				const src1 = FakeAudioContext.sources[0];
				expect(src1.start).toHaveBeenCalledTimes(1);

				// 컨텍스트가 suspended 로 전환
				FakeAudioContext.state = "suspended";
				FakeAudioContext.dispatchEvent("statechange");

				// 청크 2: suspended 상태에서 들어와 pendingChunks 에 대기
				stream.push(new Int16Array(2_400));
				expect(FakeAudioContext.sources).toHaveLength(2);
				const src2 = FakeAudioContext.sources[1];

				// 스트림 종료 알림
				stream.end();

				// 5초(SUSPENDED_ENDED_STREAM_MAX_WAIT_MS) 경과
				await vi.advanceTimersByTimeAsync(
					SUSPENDED_ENDED_STREAM_MAX_WAIT_MS + 50,
				);

				// 이미 시작된 소스는 stop() 1회
				expect(src1.start).toHaveBeenCalledTimes(1);
				expect(src1.stop).toHaveBeenCalledTimes(1);

				// 대기 청크는 start() 0회, stop() 0회
				expect(src2.start).toHaveBeenCalledTimes(0);
				expect(src2.stop).toHaveBeenCalledTimes(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it("VL-4 구멍 1 (라): clear() 뒤 컨텍스트 상태가 바뀌어도 stop(), advance, 입 신호 변화가 없다", async () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.state = "running";
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });

				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});
				queue.enqueueOrdered(1, "second-item");

				stream.push(new Int16Array(2_400));
				const src1 = FakeAudioContext.sources[0];

				// clear() 호출
				queue.clear();
				src1.stop.mockClear();
				onAudibleChange.mockClear();

				// clear() 이후 상태가 suspended 로 변경
				FakeAudioContext.state = "suspended";
				FakeAudioContext.dispatchEvent("statechange");

				await vi.advanceTimersByTimeAsync(
					SUSPENDED_ENDED_STREAM_MAX_WAIT_MS + 100,
				);

				// 다시 running 으로 변경
				FakeAudioContext.state = "running";
				FakeAudioContext.dispatchEvent("statechange");

				await vi.advanceTimersByTimeAsync(100);

				// stop() 호출 없음, advance 로 인한 FakeAudio 생성 없음, 입 신호 변화 없음
				expect(src1.stop).toHaveBeenCalledTimes(0);
				expect(FakeAudio.instances).toHaveLength(0);
				expect(onAudibleChange).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it("VL-4 구멍 1 (마): 5초 상한으로 건너뛴 뒤 컨텍스트가 running 이 되어도 옛 소스의 start() 가 추가 호출되지 않는다", async () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.state = "running";
				FakeAudioContext.now = 0;
				const queue = new AudioQueue();

				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});

				stream.push(new Int16Array(2_400));
				const src1 = FakeAudioContext.sources[0];
				expect(src1.start).toHaveBeenCalledTimes(1);

				// suspended 전환 후 청크 2 추가
				FakeAudioContext.state = "suspended";
				FakeAudioContext.dispatchEvent("statechange");
				stream.push(new Int16Array(2_400));
				const src2 = FakeAudioContext.sources[1];
				expect(src2.start).toHaveBeenCalledTimes(0);

				stream.end();

				// 5초 상한 만료로 건너뜀
				await vi.advanceTimersByTimeAsync(
					SUSPENDED_ENDED_STREAM_MAX_WAIT_MS + 50,
				);

				// 건너뛴 이후 컨텍스트가 뒤늦게 running 이 됨
				FakeAudioContext.state = "running";
				FakeAudioContext.dispatchEvent("statechange");

				await vi.advanceTimersByTimeAsync(1000);

				// 옛 소스들에 start() 추가 호출 0회
				expect(src1.start).toHaveBeenCalledTimes(1);
				expect(src2.start).toHaveBeenCalledTimes(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it("VL-4 구멍 2 (가): 출력 지연 300ms, 1초 PCM 스트림 뒤 3초 WAV 에서 WAV 종료 시까지 onAudibleChange(false)가 오지 않는다", () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.3; // 300ms 지연
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });

				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});
				queue.enqueueOrdered(
					1,
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				); // WAV

				// 1초 PCM 스트림
				stream.push(new Int16Array(24_000));
				stream.end();

				// 340ms: 스피커에서 소리 시작되어 입 열림
				FakeAudioContext.now = 0.34;
				vi.advanceTimersByTime(340);
				expect(onAudibleChange).toHaveBeenCalledWith(true);

				// 1.04s: 스트림 버퍼 렌더링 종료 -> advance()가 delayedOff(300ms) 예약 및 다음 WAV playNext() 실행
				FakeAudioContext.now = 1.04;
				vi.advanceTimersByTime(700);
				FakeAudioContext.sources[0].onended?.();

				// WAV 재생 시작 및 currentTime > 0 으로 입 열림 유지
				const wavAudio = FakeAudio.instances[0];
				wavAudio.currentTime = 0.05;
				wavAudio.onplay?.();
				onAudibleChange.mockClear();

				// 300ms 경과: 스트림의 delayedOff 타이머가 발화하는 시점
				// playbackSeq 가 달라 무시되므로 onAudibleChange(false)는 호출되지 않아야 함
				vi.advanceTimersByTime(300);
				expect(onAudibleChange).not.toHaveBeenCalledWith(false);

				// 추가 2초 동안 WAV 재생 중에도 onAudibleChange(false)가 한 번도 오지 않음
				vi.advanceTimersByTime(2000);
				expect(onAudibleChange).not.toHaveBeenCalledWith(false);

				// WAV 재생 종료 시점에 비로소 false 가 옴
				wavAudio.onended?.();
				vi.advanceTimersByTime(0);
				expect(onAudibleChange).toHaveBeenCalledWith(false);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
				vi.useRealTimers();
			}
		});

		it("VL-4 구멍 2 (나): 스트림 바로 뒤 스트림이면 입이 계속 열려 있어 중간에 false 가 0회이다", () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.3; // 300ms 출력 지연
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });

				const stream1 = new PcmStreamSource(24_000);
				const stream2 = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream1, {});
				queue.enqueueOrderedStream(1, stream2, {});

				stream1.push(new Int16Array(2_400)); // 100ms
				stream1.end();
				stream2.push(new Int16Array(2_400)); // 100ms
				stream2.end();

				// 340ms: stream1 소리 시작되어 입 열림
				FakeAudioContext.now = 0.34;
				vi.advanceTimersByTime(340);
				expect(onAudibleChange).toHaveBeenCalledWith(true);

				// stream1 버퍼 렌더링 종료 (at 140ms)
				FakeAudioContext.now = 0.14;
				vi.advanceTimersByTime(0);
				FakeAudioContext.sources[0].onended?.();

				// stream1 delayedOff 발화 및 stream2 재생 구간 동안
				// false 호출 여부 모니터링
				const falseCallsDuringTransition = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsDuringTransition).toHaveLength(0);

				// stream2 재생이 이어지는 동안에도 입이 계속 열려 있음 (중간 false 0회)
				vi.advanceTimersByTime(500);
				const allFalseCalls = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(allFalseCalls).toHaveLength(0);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
				vi.useRealTimers();
			}
		});

		it("VL-4 구멍 2 (다): 스트림 뒤 다음 소리가 400ms 넘게 늦으면 스피커 종료 후 400ms 에 false 가 온다", () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.3; // 300ms 출력 지연
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const streaming = true;
				const queue = new AudioQueue({
					onAudibleChange,
					isResponseActive: () => streaming,
				});

				const stream1 = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream1, {});
				stream1.push(new Int16Array(2_400)); // 100ms
				stream1.end();

				// 140ms 시점에 버퍼 렌더링 종료
				FakeAudioContext.now = 0.14;
				vi.advanceTimersByTime(140);
				FakeAudioContext.sources[0].onended?.();

				// 340ms 시점에 스피커에서 소리 시작되어 입 열림
				FakeAudioContext.now = 0.34;
				vi.advanceTimersByTime(200);
				expect(onAudibleChange).toHaveBeenCalledWith(true);

				// 440ms 시점: 스피커에서 소리 종료 -> delayedOff 가 setAudible(false, false) 호출
				FakeAudioContext.now = 0.44;
				vi.advanceTimersByTime(100);

				// 440ms + 399ms = 839ms 시점: 400ms 유지 중
				vi.advanceTimersByTime(399);
				expect(onAudibleChange.mock.calls).toEqual([[true]]);

				// 440ms + 400ms = 840ms 시점: 스피커 종료 400ms 후 입 닫힘!
				vi.advanceTimersByTime(1);
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
				vi.useRealTimers();
			}
		});

		it("VL-4 구멍 2 (라): 스트림 뒤 아무것도 없으면 끝에서 입이 정상적으로 닫힌다", () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.3;
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });

				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});
				stream.push(new Int16Array(24_000)); // 1초
				stream.end();

				// 340ms: 입 열림
				FakeAudioContext.now = 0.34;
				vi.advanceTimersByTime(340);
				expect(onAudibleChange).toHaveBeenCalledWith(true);

				// 1.04s: 버퍼 종료
				FakeAudioContext.now = 1.04;
				vi.advanceTimersByTime(700);
				FakeAudioContext.sources[0].onended?.();

				// 300ms 출력 지연 경과 시점에 스피커 소리 끝나며 입 닫힘
				vi.advanceTimersByTime(299);
				expect(onAudibleChange.mock.calls).toEqual([[true]]);
				vi.advanceTimersByTime(1);
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
				vi.useRealTimers();
			}
		});
	});

	describe("VL-5 검수 구멍 수정 시험 (비동기 콜백 세대/재생번호 확인 및 끄기 순서 고정)", () => {
		beforeEach(() => {
			FakeAudio.instances = [];
			FakeAudio.playImpl = () => Promise.resolve();
			FakeAudioContext.sources = [];
			FakeAudioContext.clearListeners();
			FakeAudioContext.state = "running";
			FakeAudioContext.now = 0;
			FakeAudioContext.outputLatency = 0;
			FakeAudioContext.baseLatency = undefined;
			FakeAudioContext.resumeCalls = 0;
		});

		it("VL-5 (가): 5초 상한으로 건너뛴 뒤 다음 WAV 가 currentTime > 0 으로 입을 연 다음, 옛 소스의 ended 가 늦게 도착해도 WAV 가 끝날 때까지 onAudibleChange(false) 0회", async () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.state = "running";
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });

				const stream1 = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream1, {});
				queue.enqueueOrdered(
					1,
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				); // WAV

				stream1.push(new Int16Array(2_400));
				const src1 = FakeAudioContext.sources[0];

				// 40ms 경과하여 입 열림
				vi.advanceTimersByTime(40);
				expect(onAudibleChange).toHaveBeenCalledWith(true);

				// 컨텍스트 suspended
				FakeAudioContext.state = "suspended";
				FakeAudioContext.dispatchEvent("statechange");

				// 5초 상한 만료 시점에 stop() 되지만 ended 콜백이 브라우저 지연으로
				// 다음 WAV 입 열림 이후에 도착하도록 onended 핸들러를 보존 후 지연 발화
				const originalOnEnded = src1.onended;
				src1.onended = null;

				// 5초 상한 만료 -> 건너뜀
				await vi.advanceTimersByTimeAsync(
					SUSPENDED_ENDED_STREAM_MAX_WAIT_MS + 50,
				);
				expect(src1.stop).toHaveBeenCalledTimes(1);

				// 다음 WAV 준비 및 currentTime > 0 으로 입 열림
				const wavAudio = FakeAudio.instances[0];
				expect(wavAudio.play).toHaveBeenCalledTimes(1);
				onAudibleChange.mockClear();
				wavAudio.currentTime = 0.05;
				wavAudio.onplay?.();
				expect(onAudibleChange).toHaveBeenCalledWith(true);
				onAudibleChange.mockClear();

				// 옛 소스의 ended 가 늦게 도착
				src1.onended = originalOnEnded;
				src1.onended?.();

				// 2초(400ms 유지보다 충분히 긴 시간) 동안 재생 중 false 0회
				vi.advanceTimersByTime(2000);
				const falseCallsDuringWav = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsDuringWav).toHaveLength(0);

				// WAV 가 끝날 때 비로소 false
				wavAudio.onended?.();
				vi.advanceTimersByTime(0);
				expect(onAudibleChange).toHaveBeenCalledWith(false);
			} finally {
				vi.useRealTimers();
			}
		});

		it("VL-5 (나): clear() 직후 새 문장이 입을 연 뒤 옛 소스의 ended 가 도착해도 false 0회", () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.state = "running";
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });

				const stream1 = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream1, {});
				stream1.push(new Int16Array(2_400));
				const src1 = FakeAudioContext.sources[0];

				vi.advanceTimersByTime(40);
				expect(onAudibleChange).toHaveBeenCalledWith(true);

				// clear() 호출
				queue.clear();
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);
				onAudibleChange.mockClear();

				// 새 문장 등록 및 입 열림
				queue.enqueue(
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				);
				const wavAudio = FakeAudio.instances[0];
				wavAudio.currentTime = 0.05;
				wavAudio.onplay?.();
				expect(onAudibleChange).toHaveBeenCalledWith(true);
				onAudibleChange.mockClear();

				// 옛 소스의 ended 도착
				src1.onended?.();

				// 2초 동안 false 0회
				vi.advanceTimersByTime(2000);
				const falseCalls = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCalls).toHaveLength(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it("VL-5 (다): 출력 지연 300ms, 100ms PCM 뒤 거절된 WAV 시 스트림 delayedOn(340ms) true 1회, delayedOff(440ms) false 1회", async () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.3; // 300ms 출력 지연
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });

				const stream1 = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream1, {});

				// 다음 WAV 는 play() 거절
				FakeAudio.playImpl = () =>
					Promise.reject(new Error("autoplay blocked"));
				queue.enqueueOrdered(
					1,
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				);

				// 100ms PCM: 0.04s ~ 0.14s. audibleTimer 는 340ms 에 예약됨
				stream1.push(new Int16Array(2_400));
				stream1.end();

				// 140ms 시점에 스트림 버퍼 종료 -> advance()에서 delayedOn(200ms) 예약 및 다음 WAV play() 실행
				FakeAudioContext.now = 0.14;
				vi.advanceTimersByTime(140);
				FakeAudioContext.sources[0].onended?.();

				// WAV play() reject 프로미스 처리
				await Promise.resolve();
				await Promise.resolve();

				// 340ms 시각(340ms±50ms 범위): delayedOn 이 발화하여 true 정확히 1회
				FakeAudioContext.now = 0.34;
				vi.advanceTimersByTime(200);
				const trueCallsAt340 = onAudibleChange.mock.calls.filter(
					(args) => args[0] === true,
				);
				expect(trueCallsAt340).toHaveLength(1);
				expect(onAudibleChange).toHaveBeenLastCalledWith(true);

				// 440ms 시각(440ms±50ms 범위, 340ms로부터 100ms 경과): delayedOff 발화로 false 정확히 1회
				FakeAudioContext.now = 0.44;
				vi.advanceTimersByTime(100);
				const falseCallsAt440 = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsAt440).toHaveLength(1);
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);

				// 이후 1초 추가 경과해도 입 신호 변화 없음
				vi.advanceTimersByTime(1000);
				const totalCalls = onAudibleChange.mock.calls.length;
				expect(totalCalls).toBe(2); // true 1회, false 1회

				// 마지막 상태 닫힘
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
				vi.useRealTimers();
			}
		});

		it("VL-5 (라): 815행 분기 공백: 짧은 버퍼(들림 타이머가 남은 상태, leadRemainMs > 0)로 끝난 스트림 뒤에 WAV 가 재생을 시작하면, 옛 delayedOff 가 WAV 재생 중 입을 닫지 않음", () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.3; // 300ms 출력 지연
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });

				const stream1 = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream1, {});
				queue.enqueueOrdered(
					1,
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				); // WAV

				stream1.push(new Int16Array(2_400)); // 100ms: 0.04 ~ 0.14s
				stream1.end();

				// 140ms 시점에 버퍼 종료 (오디오 시계를 되감지 않고 0.14로 전진)
				FakeAudioContext.now = 0.14;
				vi.advanceTimersByTime(140);
				FakeAudioContext.sources[0].onended?.();

				// WAV 재생 시작 및 currentTime > 0 으로 입 열림
				const wavAudio = FakeAudio.instances[0];
				wavAudio.currentTime = 0.05;
				wavAudio.onplay?.();
				expect(onAudibleChange).toHaveBeenCalledWith(true);
				onAudibleChange.mockClear();

				// advance(140ms)로부터 300ms 경과(전체 시각 440ms): 옛 스트림의 delayedOff(815행 분기) 발화 시점
				FakeAudioContext.now = 0.44;
				vi.advanceTimersByTime(300);

				// 추가 2초(400ms 유지보다 충분히 긴 시간) 동안 WAV 재생 중 옛 delayedOff 로 인한 입 닫힘 없음
				vi.advanceTimersByTime(2000);
				const falseCalls = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCalls).toHaveLength(0);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
				vi.useRealTimers();
			}
		});

		it("VL-5 (마-2): 2번 분기의 빈 큐 경우: nothingQueued() 참, leadRemainMs === 0, endRemainMs > outputLatency 에서 outputLatency 경과 시점에 false 0회이고 endRemainMs 시점에 false 1회", () => {
			vi.useFakeTimers();
			try {
				// 스케줄 시점 지연 300ms
				FakeAudioContext.outputLatency = 0.3;
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });

				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});
				// 300ms PCM: 0.04s ~ 0.34s. audibleTimer 는 340ms 에 예약됨
				stream.push(new Int16Array(7_200));
				stream.end();

				// 90ms 경과 (버퍼가 250ms 남은 시점)
				FakeAudioContext.now = 0.09;
				vi.advanceTimersByTime(90);

				// advance 직전에 출력 지연이 50ms 로 감소
				// firstScheduledAt(0.04) - now(0.09) + lat(0.05) = 0ms -> leadRemainMs === 0
				// lastScheduledEnd(0.34) - now(0.09) + lat(0.05) = 300ms -> endRemainMs === 300ms (> 50ms)
				FakeAudioContext.outputLatency = 0.05;

				FakeAudioContext.sources[0].onended?.();
				// 입이 즉시 열림
				expect(onAudibleChange).toHaveBeenCalledWith(true);
				onAudibleChange.mockClear();

				// 출력 지연(50ms)만 지난 시점: 빈 큐 endAudible 이 조기 닫기를 걸지 않았으므로 false 0회
				vi.advanceTimersByTime(50);
				const falseCallsAt50 = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsAt50).toHaveLength(0);

				// endRemainMs(300ms) 시각(추가 250ms 경과): 기존 silenceAudibleNow 가 돌아 false 1회
				vi.advanceTimersByTime(250);
				const falseCallsAtEnd = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsAtEnd).toHaveLength(1);
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
				vi.useRealTimers();
			}
		});

		it("VL-5 (마): 829행 분기 공백: 들림 타이머가 남은 채 leadRemainMs === 0, endRemainMs > 0 인 경우 입이 열렸다가 뒤이은 WAV 재생 중 옛 끄기가 입을 닫지 않음", () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.3; // 스케줄 시점 300ms
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });

				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});
				queue.enqueueOrdered(
					1,
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				); // WAV

				stream.push(new Int16Array(7_200)); // 300ms PCM: 0.04 ~ 0.34s
				stream.end();

				// 90ms 경과 시점에 지연이 50ms 로 감소
				FakeAudioContext.now = 0.09;
				vi.advanceTimersByTime(90);
				FakeAudioContext.outputLatency = 0.05;

				// advance 트리거 (leadRemainMs === 0, endRemainMs === 300ms)
				FakeAudioContext.sources[0].onended?.();

				// 2번 분기에서 입이 열림 ("입이 열렸다가")
				expect(onAudibleChange).toHaveBeenCalledWith(true);
				onAudibleChange.mockClear();

				// WAV 재생 시작
				const wavAudio = FakeAudio.instances[0];
				wavAudio.currentTime = 0.05;
				wavAudio.onplay?.();

				// 829행 분기 delayedOff 가 도는 300ms 경과
				FakeAudioContext.now = 0.39;
				vi.advanceTimersByTime(300);

				// 추가 2초 동안 WAV 재생 중 옛 delayedOff 가 입을 닫지 않음 (false 0회)
				vi.advanceTimersByTime(2000);
				const falseCalls = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCalls).toHaveLength(0);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
				vi.useRealTimers();
			}
		});

		it("VL-5 (바-1): 미디어 onended 가 clear() 뒤, 새 문장이 입을 연 다음에 늦게 와도 2초 재생 중 false 0회·재생 중단 없음·다음 항목 진행 없음", () => {
			vi.useFakeTimers();
			try {
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });

				// 첫 번째 문장 재생 및 입 열림
				queue.enqueue(
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				);
				const audio1 = FakeAudio.instances[0];
				audio1.currentTime = 0.05;
				audio1.onplay?.();
				expect(onAudibleChange).toHaveBeenCalledWith(true);

				// clear() 호출
				queue.clear();
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);
				onAudibleChange.mockClear();

				// 새 문장 2개 등록 (2번째 문장 재생 중 3번째 문장으로 조기 진행되는지 검증용)
				queue.enqueue(
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				);
				queue.enqueue(
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				);
				const audio2 = FakeAudio.instances[1];
				audio2.currentTime = 0.05;
				audio2.onplay?.();
				expect(onAudibleChange).toHaveBeenCalledWith(true);
				onAudibleChange.mockClear();

				// 첫 번째 옛 오디오의 onended 가 뒤늦게 도착
				audio1.onended?.();

				// 2초(400ms 유지보다 충분히 긴 시간) 경과
				vi.advanceTimersByTime(2000);

				// false 0회
				const falseCalls = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCalls).toHaveLength(0);
				// 새 문장 재생 중단 없음 (pause 호출 없음)
				expect(audio2.pause).not.toHaveBeenCalled();
				// 3번째 문장으로 넘어가지 않음 (인스턴스 수 2개 유지)
				expect(FakeAudio.instances).toHaveLength(2);
			} finally {
				vi.useRealTimers();
			}
		});

		it("VL-5 (바-2): 미디어 onerror 가 clear() 뒤, 새 문장이 입을 연 다음에 늦게 와도 2초 재생 중 false 0회·재생 중단 없음·다음 항목 진행 없음", () => {
			vi.useFakeTimers();
			try {
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });

				queue.enqueue(
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				);
				const audio1 = FakeAudio.instances[0];
				audio1.currentTime = 0.05;
				audio1.onplay?.();
				queue.clear();
				onAudibleChange.mockClear();

				queue.enqueue(
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				);
				queue.enqueue(
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				);
				const audio2 = FakeAudio.instances[1];
				audio2.currentTime = 0.05;
				audio2.onplay?.();
				onAudibleChange.mockClear();

				// 첫 번째 옛 오디오의 onerror 가 뒤늦게 도착
				audio1.onerror?.(new Event("error"));

				vi.advanceTimersByTime(2000);

				// false 0회
				const falseCalls = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCalls).toHaveLength(0);
				// 새 문장 재생 중단 없음
				expect(audio2.pause).not.toHaveBeenCalled();
				// 3번째 문장으로 넘어가지 않음
				expect(FakeAudio.instances).toHaveLength(2);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("VL-6 검수 구멍 수정 시험 (소리 시작 시점 번호 증가 및 실패 출구 입 신호 보존)", () => {
		beforeEach(() => {
			FakeAudio.instances = [];
			FakeAudio.playImpl = () => Promise.resolve();
			FakeAudioContext.sources = [];
			FakeAudioContext.clearListeners();
			FakeAudioContext.state = "running";
			FakeAudioContext.now = 0;
			FakeAudioContext.outputLatency = 0;
			FakeAudioContext.baseLatency = undefined;
			FakeAudioContext.resumeCalls = 0;
		});

		it("VL-6 (다-2): delayedOn 번호 비교: 100ms PCM delayedOn 대기 중 뒤 WAV 가 실제로 들린 뒤 끝나고, 옛 delayedOn 시각 도래 시 입을 다시 열지 않음", () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.3; // 300ms 출력 지연
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });

				const stream1 = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream1, {});
				queue.enqueueOrdered(
					1,
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				);

				// 100ms PCM: 0.04s ~ 0.14s. audibleTimer 는 340ms 에 예약됨
				stream1.push(new Int16Array(2_400));
				stream1.end();

				// 140ms 시점에 스트림 버퍼 종료 -> advance()에서 delayedOn(200ms, 즉 340ms 시점) 예약
				FakeAudioContext.now = 0.14;
				vi.advanceTimersByTime(140);
				FakeAudioContext.sources[0].onended?.();

				// WAV 가 시작되고, 200ms 시점에 실제로 소리가 들리기 시작함 (currentTime > 0)
				const wavAudio = FakeAudio.instances[0];
				FakeAudioContext.now = 0.2;
				vi.advanceTimersByTime(60);
				wavAudio.currentTime = 0.05;
				wavAudio.onplay?.();
				// WAV 로 인해 true 1회 발생 (playbackSeq 가 N에서 N+1로 증가함)
				expect(onAudibleChange).toHaveBeenCalledTimes(1);
				expect(onAudibleChange).toHaveBeenCalledWith(true);

				// 250ms 시점에 WAV 가 정상 종료됨
				FakeAudioContext.now = 0.25;
				vi.advanceTimersByTime(50);
				wavAudio.onended?.();
				vi.advanceTimersByTime(0);
				// WAV 종료로 false 1회 발생
				expect(onAudibleChange).toHaveBeenCalledWith(false);

				// 340ms 시점 도래: 옛 스트림의 delayedOn 발화 시각
				FakeAudioContext.now = 0.34;
				vi.advanceTimersByTime(90);

				// playbackSeq 가 달라 delayedOn 이 입을 다시 열지 않음 (WAV 종료 후 true 0회, 전체 true 는 1회뿐)
				const trueCalls = onAudibleChange.mock.calls.filter(
					(args) => args[0] === true,
				);
				expect(trueCalls).toHaveLength(1);

				// 1초 추가 진행해도 입이 열리지 않음
				vi.advanceTimersByTime(1000);
				const trueCallsAfter1s = onAudibleChange.mock.calls.filter(
					(args) => args[0] === true,
				);
				expect(trueCallsAfter1s).toHaveLength(1);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
				vi.useRealTimers();
			}
		});

		it("VL-6 (사): 출력 지연 300ms, 1초 PCM 입 연 뒤 끝나고, 다음 WAV play() 거절 시(응답 스트리밍 중), 꼬리끝+350ms까지 false 0회, 꼬리끝+400ms에 false 1회", async () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.3; // 300ms 출력 지연
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });
				queue.setResponseActive(true); // 응답 스트리밍 중 -> nothingQueued() 거짓

				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});

				FakeAudio.playImpl = () =>
					Promise.reject(new Error("autoplay rejected"));
				queue.enqueueOrdered(
					1,
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				);

				// 1초 PCM (0.04s ~ 1.04s)
				stream.push(new Int16Array(24_000));
				stream.end();

				// 340ms: audibleTimer 발화로 입 열림 (true 1회)
				FakeAudioContext.now = 0.34;
				vi.advanceTimersByTime(340);
				expect(onAudibleChange).toHaveBeenCalledWith(true);
				onAudibleChange.mockClear();

				// 1.04s (스케줄 끝, 1040ms): 렌더링 끝, advance()에서 delayedOff(300ms = 꼬리끝 1340ms) 예약, WAV play() reject
				FakeAudioContext.now = 1.04;
				vi.advanceTimersByTime(700);
				FakeAudioContext.sources[0].onended?.();
				await Promise.resolve();
				await Promise.resolve();

				// 꼬리 끝(스케줄 끝 1040ms + 300ms = 1340ms)까지 false 0회
				FakeAudioContext.now = 1.34;
				vi.advanceTimersByTime(300);
				const falseCallsAtTailEnd = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsAtTailEnd).toHaveLength(0);

				// 꼬리 끝 초과부터 꼬리 끝+350ms(1690ms)까지도 false 0회
				vi.advanceTimersByTime(350);
				const falseCallsAtTailPlus350 = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsAtTailPlus350).toHaveLength(0);

				// 꼬리 끝+400ms(1740ms, 추가 50ms 경과): 400ms 유지 만료로 false 정확히 1회
				vi.advanceTimersByTime(50);
				const falseCallsAtTailPlus400 = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsAtTailPlus400).toHaveLength(1);
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);

				// 그 뒤 1초 동안 true 0회
				vi.advanceTimersByTime(1000);
				const trueCallsAfter = onAudibleChange.mock.calls.filter(
					(args) => args[0] === true,
				);
				expect(trueCallsAfter).toHaveLength(0);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
				vi.useRealTimers();
			}
		});

		it("VL-6 (아): 같은 입력에서 응답 종료(큐 빈 경우): 꼬리 끝(스케줄 끝+300ms)에 false 정확히 1회, 그 전에는 0회", async () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.3; // 300ms 출력 지연
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });
				queue.setResponseActive(false); // 응답 종료

				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});

				FakeAudio.playImpl = () =>
					Promise.reject(new Error("autoplay rejected"));
				queue.enqueueOrdered(
					1,
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				);

				// 1초 PCM
				stream.push(new Int16Array(24_000));
				stream.end();

				// 340ms: 입 열림
				FakeAudioContext.now = 0.34;
				vi.advanceTimersByTime(340);
				expect(onAudibleChange).toHaveBeenCalledWith(true);
				onAudibleChange.mockClear();

				// 1.04s: 스케줄 끝, advance(), WAV reject 처리
				FakeAudioContext.now = 1.04;
				vi.advanceTimersByTime(700);
				FakeAudioContext.sources[0].onended?.();
				await Promise.resolve();
				await Promise.resolve();

				// 꼬리 끝 전 (1040ms로부터 250ms 경과 = 1290ms, 꼬리끝-50ms): false 0회
				vi.advanceTimersByTime(250);
				const falseCallsBefore = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsBefore).toHaveLength(0);

				// 꼬리 끝 (추가 50ms 경과 = 1340ms, 스케줄 끝+300ms): false 정확히 1회
				vi.advanceTimersByTime(50);
				const falseCallsAtTail = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsAtTail).toHaveLength(1);
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);

				// 그 뒤 1초 동안 추가 false/true 없음
				vi.advanceTimersByTime(1000);
				const totalFalseCalls = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(totalFalseCalls).toHaveLength(1);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
				vi.useRealTimers();
			}
		});

		it("VL-6 (자): (사)와 같되 play()는 성공하고 소리 전에 onerror 발생 시, 꼬리끝+350ms까지 false 0회, 꼬리끝+400ms에 false 1회", () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.3; // 300ms 출력 지연
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });
				queue.setResponseActive(true); // 응답 스트리밍 중

				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});
				queue.enqueueOrdered(
					1,
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				);

				// 1초 PCM
				stream.push(new Int16Array(24_000));
				stream.end();

				// 340ms: 입 열림
				FakeAudioContext.now = 0.34;
				vi.advanceTimersByTime(340);
				expect(onAudibleChange).toHaveBeenCalledWith(true);
				onAudibleChange.mockClear();

				// 1.04s: 스케줄 끝, advance(), WAV play() 성공 후 소리 전(currentTime === 0) onerror
				FakeAudioContext.now = 1.04;
				vi.advanceTimersByTime(700);
				FakeAudioContext.sources[0].onended?.();

				const wavAudio = FakeAudio.instances[0];
				wavAudio.currentTime = 0;
				wavAudio.onerror?.(new Event("error"));

				// 꼬리 끝(스케줄 끝 1040ms + 300ms = 1340ms)까지 false 0회
				FakeAudioContext.now = 1.34;
				vi.advanceTimersByTime(300);
				const falseCallsAtTailEnd = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsAtTailEnd).toHaveLength(0);

				// 꼬리 끝 초과부터 꼬리 끝+350ms(1690ms)까지도 false 0회
				vi.advanceTimersByTime(350);
				const falseCallsAtTailPlus350 = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsAtTailPlus350).toHaveLength(0);

				// 꼬리 끝+400ms(1740ms, 추가 50ms): false 정확히 1회
				vi.advanceTimersByTime(50);
				const falseCallsAtTailPlus400 = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsAtTailPlus400).toHaveLength(1);
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);

				// 그 뒤 1초 동안 true 0회
				vi.advanceTimersByTime(1000);
				const trueCallsAfter = onAudibleChange.mock.calls.filter(
					(args) => args[0] === true,
				);
				expect(trueCallsAfter).toHaveLength(0);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
				vi.useRealTimers();
			}
		});

		it("VL-6 (카): 한 미디어 항목에서 onplay 즉시 분기와 checkAudibleStarted 둘 다 불려도 playbackSeq 는 1만 증가", () => {
			vi.useFakeTimers();
			try {
				const queue = new AudioQueue();
				const getSeq = () =>
					(queue as unknown as { playbackSeq: number }).playbackSeq;

				const seqBefore = getSeq();

				queue.enqueue(
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				);
				const wavAudio = FakeAudio.instances[0];

				// 호출 전: 재생 시작 전이므로 playbackSeq 는 아직 오르지 않음
				expect(getSeq()).toBe(seqBefore);

				// 1) onplay 즉시 분기 (currentTime > 0)
				wavAudio.currentTime = 0.05;
				wavAudio.onplay?.();
				expect(getSeq()).toBe(seqBefore + 1);

				// 2) checkAudibleStarted 트리거 (추가 onplay 호출)
				wavAudio.onplay?.();

				// 두 경로 호출 후에도 항목별 1회 가드로 인해 정확히 1만 증가
				expect(getSeq()).toBe(seqBefore + 1);
			} finally {
				vi.useRealTimers();
			}
		});

		it("VL-6 (타): 폴링 경로 단독: onplay 시점 currentTime=0 이고 이후 checkAudibleStarted 로만 입 열릴 때 playbackSeq 1 증가, lastPlaybackType media 설정, 스트림 꼬리 무시, onended 즉시 0ms 닫힘", () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.3; // 300ms 출력 지연
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });
				const getSeq = () =>
					(queue as unknown as { playbackSeq: number }).playbackSeq;
				const getLastType = () =>
					(queue as unknown as { lastPlaybackType: string | null })
						.lastPlaybackType;

				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});
				queue.enqueueOrdered(
					1,
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				);

				// 1초 PCM
				stream.push(new Int16Array(24_000));
				stream.end();

				// 340ms: 스트림 입 열림
				FakeAudioContext.now = 0.34;
				vi.advanceTimersByTime(340);
				expect(onAudibleChange).toHaveBeenCalledWith(true);
				const streamSeq = getSeq();
				expect(streamSeq).toBe(1);
				expect(getLastType()).toBe("stream");

				// 1.04s (스케줄 끝, 1040ms): advance() -> delayedOff(300ms, 시각 1340ms) 예약, WAV 시작
				FakeAudioContext.now = 1.04;
				vi.advanceTimersByTime(700);
				FakeAudioContext.sources[0].onended?.();

				const wavAudio = FakeAudio.instances[0];
				// onplay 호출 시점: currentTime === 0 이라 즉시 분기 타지 않음
				wavAudio.currentTime = 0;
				wavAudio.onplay?.();

				// 아직 폴링 전이므로 playbackSeq 는 1, lastPlaybackType 은 여전히 stream
				expect(getSeq()).toBe(streamSeq);
				expect(getLastType()).toBe("stream");

				// 꼬리 끝 전 (1040ms로부터 50ms 지난 1090ms): currentTime > 0 이 되고 10ms 폴링으로 checkAudibleStarted 실행
				wavAudio.currentTime = 0.05;
				vi.advanceTimersByTime(10); // 10ms 폴링 발화

				// 단언 1: playbackSeq 가 정확히 1 오름
				expect(getSeq()).toBe(streamSeq + 1);
				// 단언 2: lastPlaybackType === "media"
				expect(getLastType()).toBe("media");

				onAudibleChange.mockClear();

				// 직전 스트림 꼬리 끄기 시각 (스케줄 끝 1040ms + 300ms 꼬리 + 400ms 유지 = 1740ms 부근):
				// 현재 1090ms에서 650ms 경과하여 1740ms 도달
				vi.advanceTimersByTime(650);
				// 단언 3: 스트림 delayedOff 는 playbackSeq 가 달라 무시되므로 false 0회
				const falseCallsDuringWav = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsDuringWav).toHaveLength(0);

				// WAV 종료 (빈 큐 상태)
				wavAudio.onended?.();

				// 단언 4: lastPlaybackType === "media" 이므로 출력 지연 없이 0ms 에 false 1회
				vi.advanceTimersByTime(0);
				expect(onAudibleChange).toHaveBeenCalledWith(false);
				const falseCallsAtEnd = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsAtEnd).toHaveLength(1);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
				vi.useRealTimers();
			}
		});
	});

	describe("VL-7 검수 구멍 수정 시험 (스트림 lastPlaybackType 지연 및 레벨 시계 재묶음)", () => {
		it("VL-7 (파): 출력 지연 800ms, WAV 끝난 뒤 fail()된 청크 없는 스트림 빠지면 lastPlaybackType === 'media', onended 뒤 0~50ms 안에 false 1회", () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.8; // 800ms
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });
				queue.setResponseActive(false); // 응답 끝남

				const stream = new PcmStreamSource(24_000);
				stream.fail(); // 이미 fail() 된 청크 없는 스트림

				queue.enqueueOrdered(
					0,
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				);
				queue.enqueueOrderedStream(1, stream, {});

				const wavAudio = FakeAudio.instances[0];
				wavAudio.currentTime = 0.1;
				wavAudio.onplay?.();
				expect(onAudibleChange).toHaveBeenCalledWith(true);
				onAudibleChange.mockClear();

				// WAV 들리고 끝남
				wavAudio.onended?.();

				// 단언 1: 스트림이 빠진 직후 lastPlaybackType === "media" (직접 읽기)
				expect(
					(queue as unknown as { lastPlaybackType: string }).lastPlaybackType,
				).toBe("media");

				// 단언 2: onended 뒤 0~50ms 안에 false 정확히 1회
				vi.advanceTimersByTime(50);
				const falseCallsEarly = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsEarly).toHaveLength(1);
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);

				onAudibleChange.mockClear();

				// 단언 3: onended+800ms 부근(±100ms, 즉 700ms~900ms)에는 입 신호 변화 없음
				vi.advanceTimersByTime(850); // 50ms + 850ms = 900ms
				expect(onAudibleChange).not.toHaveBeenCalled();

				// 단언 4: 그 뒤 1초 동안 true 0회, 마지막 상태 닫힘
				vi.advanceTimersByTime(1000);
				const trueCalls = onAudibleChange.mock.calls.filter(
					(args) => args[0] === true,
				);
				expect(trueCalls).toHaveLength(0);
				expect((queue as unknown as { audible: boolean }).audible).toBe(false);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
				vi.useRealTimers();
			}
		});

		it("VL-7 (파-2): (파)와 같되 스트림이 구독 뒤 청크 없이 fail()되는 경우, 실패 직후 0~50ms 안에 false 1회", () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.8; // 800ms
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });
				queue.setResponseActive(false); // 응답 끝남

				const stream = new PcmStreamSource(24_000);
				// 아직 fail() 안 된 상태로 구독

				queue.enqueueOrdered(
					0,
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				);
				queue.enqueueOrderedStream(1, stream, {});

				const wavAudio = FakeAudio.instances[0];
				wavAudio.currentTime = 0.1;
				wavAudio.onplay?.();
				expect(onAudibleChange).toHaveBeenCalledWith(true);
				onAudibleChange.mockClear();

				// WAV 들리고 끝남 (onended)
				wavAudio.onended?.();

				// onended 뒤 200ms 경과: 아직 400ms 유지 중이고 스트림 살아있으므로 false 0회
				vi.advanceTimersByTime(200);
				expect(
					onAudibleChange.mock.calls.filter((args) => args[0] === false),
				).toHaveLength(0);

				// 200ms 시점에 스트림 실패!
				stream.fail();

				// 기대(고정): 실패 시각 onended+200ms 기준, 실패 직후 0~50ms 안에 false 정확히 1회
				vi.advanceTimersByTime(50);
				const falseCallsAfterFail = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsAfterFail).toHaveLength(1);
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);

				onAudibleChange.mockClear();

				// 스트림 실패 뒤 출력 지연(800ms) 만큼 늦은 false 는 없음 (추가 800ms 진행)
				vi.advanceTimersByTime(800);
				expect(
					onAudibleChange.mock.calls.filter((args) => args[0] === false),
				).toHaveLength(0);

				// 마지막 상태 닫힘
				expect((queue as unknown as { audible: boolean }).audible).toBe(false);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
				vi.useRealTimers();
			}
		});

		it("VL-7 (하): (파)의 입력에서 스트림이 빠진 직후 레벨 시계 around()가 다음 가장자리를 침묵으로 보고 빠진 스트림을 다음 소리로 보지 않음", () => {
			const Q = { leadSec: 0, backSec: 0.4, aheadSec: 0.4 };
			const queue = new AudioQueue();
			queue.setResponseActive(false);

			const stream = new PcmStreamSource(24_000);
			stream.fail();

			queue.enqueueOrdered(0, wavBase64(toneThenSilence(0.3, 0.1)));
			queue.enqueueOrderedStream(1, stream, {});

			const audio = FakeAudio.instances[0];
			audio.currentTime = 0.2;
			audio.onplay?.();
			audio.currentTime = 0.35;
			audio.onended?.();

			// 스트림이 빠진 직후 레벨 시계 검증
			const around = queue.voiceLevelsAround(Q);
			expect(around).not.toBeNull();
			// 빠진 스트림을 다음 소리로 보지 않고, 다음 가장자리를 침묵으로 봄
			const gate = new NvaAudioGate(
				NVA_GATE_THRESHOLD,
				NVA_SHELL_HOLD_MS,
				"talking",
			);
			expect(
				gate.processAround(around!.levels, around!.now, around!.stepMs),
			).toBe("idle");
			for (let i = around!.now + 1; i < around!.levels.length; i++) {
				expect(around!.levels[i]).toBe(0);
			}
		});

		it("VL-7 (하-2): 뒤 항목이 소리 전 play() 거절되는 WAV인 경우 레벨 시계가 다음 가장자리를 침묵으로 봄", async () => {
			const Q = { leadSec: 0, backSec: 0.4, aheadSec: 0.4 };
			const queue = new AudioQueue();
			queue.setResponseActive(false);

			queue.enqueueOrdered(0, wavBase64(toneThenSilence(0.3, 0.1)));
			queue.enqueueOrdered(1, wavBase64(toneThenSilence(0.3, 0)));

			const [a] = FakeAudio.instances;
			a.currentTime = 0.2;
			a.onplay?.();
			a.currentTime = 0.35;

			// 두 번째 WAV의 play() 거절 설정
			FakeAudio.playImpl = () => Promise.reject(new Error("autoplay blocked"));
			a.onended?.();

			// play() reject 프로미스 마이크로태스크 완료 대기
			await Promise.resolve();
			await Promise.resolve();

			// 두 번째 WAV 거절 직후
			const around = queue.voiceLevelsAround(Q);
			expect(around).not.toBeNull();
			const gate = new NvaAudioGate(
				NVA_GATE_THRESHOLD,
				NVA_SHELL_HOLD_MS,
				"talking",
			);
			expect(
				gate.processAround(around!.levels, around!.now, around!.stepMs),
			).toBe("idle");
			for (let i = around!.now + 1; i < around!.levels.length; i++) {
				expect(around!.levels[i]).toBe(0);
			}
		});

		it("VL-7 (하-3): 뒤 항목이 play()는 풀리고 소리 전 onerror가 오는 WAV인 경우 레벨 시계가 다음 가장자리를 침묵으로 봄", () => {
			const Q = { leadSec: 0, backSec: 0.4, aheadSec: 0.4 };
			const queue = new AudioQueue();
			queue.setResponseActive(false);

			queue.enqueueOrdered(0, wavBase64(toneThenSilence(0.3, 0.1)));
			queue.enqueueOrdered(1, wavBase64(toneThenSilence(0.3, 0)));

			const [a] = FakeAudio.instances;
			a.currentTime = 0.2;
			a.onplay?.();
			a.currentTime = 0.35;
			a.onended?.();

			const b = FakeAudio.instances[1];
			b.currentTime = 0; // 소리 전
			b.onerror?.(new Event("error"));

			// b 오류 직후
			const around = queue.voiceLevelsAround(Q);
			expect(around).not.toBeNull();
			const gate = new NvaAudioGate(
				NVA_GATE_THRESHOLD,
				NVA_SHELL_HOLD_MS,
				"talking",
			);
			expect(
				gate.processAround(around!.levels, around!.now, around!.stepMs),
			).toBe("idle");
			for (let i = around!.now + 1; i < around!.levels.length; i++) {
				expect(around!.levels[i]).toBe(0);
			}
		});

		it("VL-7 (하-4): 뒤 항목이 소리 전 onended가 오는 WAV(길이 0)인 경우 앞 문장의 봉투를 유지하고 다음 가장자리만 침묵", () => {
			const Q = { leadSec: 0, backSec: 0.4, aheadSec: 0.4 };
			const queue = new AudioQueue();
			queue.setResponseActive(false);

			queue.enqueueOrdered(0, wavBase64(toneThenSilence(0.3, 0.1)));
			// 길이 0 WAV
			queue.enqueueOrdered(
				1,
				"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
			);

			const [a] = FakeAudio.instances;
			a.currentTime = 0.2;
			a.onplay?.();
			a.currentTime = 0.35;
			a.onended?.();

			const b = FakeAudio.instances[1];
			b.currentTime = 0; // 소리 전 (길이 0)
			b.onended?.();

			// b 빠진 뒤 레벨 시계가 앞 문장의 봉투(길이 0이 아님)를 그대로 유지하고, 다음 가장자리만 침묵임을 단언
			const around = queue.voiceLevelsAround(Q);
			expect(around).not.toBeNull();
			// 앞 문장 봉투 유지 단언: now 이전 레벨에 앞 문장의 유성음 레벨(0.015 초과)이 존재해야 함
			const hasVoicedPast = around!.levels
				.slice(0, around!.now)
				.some((lvl) => lvl > 0.015);
			expect(hasVoicedPast).toBe(true);

			// 다음 가장자리만 침묵: gate 판정 idle
			const gate = new NvaAudioGate(
				NVA_GATE_THRESHOLD,
				NVA_SHELL_HOLD_MS,
				"talking",
			);
			expect(
				gate.processAround(around!.levels, around!.now, around!.stepMs),
			).toBe("idle");
			for (let i = around!.now + 1; i < around!.levels.length; i++) {
				expect(around!.levels[i]).toBe(0);
			}
		});

		it("VL-7 (하-5): WAV 들리고 끝난 뒤 청크 없는 스트림, 그 뒤 실제 소리 낼 WAV 줄 서 있는 경우 스트림 빠진 직후 around()가 그 실제 WAV를 다음 소리로 봄", () => {
			const Q = { leadSec: 0, backSec: 0.4, aheadSec: 0.4 };
			const queue = new AudioQueue();
			queue.setResponseActive(false);

			const stream = new PcmStreamSource(24_000);
			stream.fail();

			queue.enqueueOrdered(0, wavBase64(toneThenSilence(0.3, 0.15)));
			queue.enqueueOrderedStream(1, stream, {});
			queue.enqueueOrdered(2, wavBase64(toneThenSilence(0.3, 0))); // 실제 소리 낼 WAV

			const [a] = FakeAudio.instances;
			a.currentTime = 0.2;
			a.onplay?.();
			a.currentTime = 0.32; // a tail
			a.onended?.();

			const b = FakeAudio.instances[1];
			b.currentTime = 0; // 아직 재생 시작 전 (소리 전)

			// 스트림이 빠진 직후
			const around = queue.voiceLevelsAround(Q);
			expect(around).not.toBeNull();
			// 실제 WAV(seq 2)를 다음 소리로 보므로 gate 판정은 "talking"
			const gate = new NvaAudioGate(
				NVA_GATE_THRESHOLD,
				NVA_SHELL_HOLD_MS,
				"talking",
			);
			expect(
				gate.processAround(around!.levels, around!.now, around!.stepMs),
			).toBe("talking");
			// 미래 구간에 실제 WAV의 유성음 레벨(0.015 초과)이 나타남
			const hasVoicedFuture = around!.levels
				.slice(around!.now + 1)
				.some((lvl) => lvl > 0.015);
			expect(hasVoicedFuture).toBe(true);
		});

		it("VL-7 (하-6): 응답이 아직 살아 있고 뒤 항목이 없는 채로 청크 없는 스트림이 빠지는 경우 다음 가장자리는 unknown 유지", () => {
			const Q = { leadSec: 0, backSec: 0.4, aheadSec: 0.4 };
			const queue = new AudioQueue();
			queue.setResponseActive(true); // 응답 아직 살아있음

			const stream = new PcmStreamSource(24_000);
			stream.fail();

			queue.enqueueOrdered(0, wavBase64(toneThenSilence(0.3, 0.1)));
			queue.enqueueOrderedStream(1, stream, {});

			const [a] = FakeAudio.instances;
			a.currentTime = 0.2;
			a.onplay?.();
			a.currentTime = 0.35;
			a.onended?.();

			// 스트림 빠진 직후: 응답이 아직 살아있으므로 다음 가장자리는 unknown (침묵으로 판단하지 않음)
			const around = queue.voiceLevelsAround(Q);
			// after 가 "unknown" 이므로 gate 판정은 "talking" 유지 (침묵이 아님)
			const gate = new NvaAudioGate(
				NVA_GATE_THRESHOLD,
				NVA_SHELL_HOLD_MS,
				"talking",
			);
			expect(
				gate.processAround(around!.levels, around!.now, around!.stepMs),
			).toBe("talking");
		});

		it("VL-7 (거): 회귀 - WAV 뒤 청크가 오는 정상 스트림은 첫 청크 스케줄 뒤 lastPlaybackType === 'stream', 스트림 꼬리 뒤 빈 큐 닫힘은 출력 지연 포함", () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.3; // 300ms 출력 지연
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });
				queue.setResponseActive(false); // 응답 종료

				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrdered(
					0,
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				);
				queue.enqueueOrderedStream(1, stream, {});

				const wavAudio = FakeAudio.instances[0];
				wavAudio.currentTime = 0.1;
				wavAudio.onplay?.();
				wavAudio.onended?.();

				// WAV 끝난 후 스트림 차례: 첫 청크 투입
				stream.push(new Int16Array(24_000)); // 1초 PCM
				stream.end();

				// 첫 청크 스케줄 시점 확인
				// 40ms lead: 340ms에 입 열림
				FakeAudioContext.now = 0.34;
				vi.advanceTimersByTime(340);

				// 단언 1: 첫 청크 스케줄 뒤 lastPlaybackType === "stream" (직접 읽기)
				expect(
					(queue as unknown as { lastPlaybackType: string }).lastPlaybackType,
				).toBe("stream");
				onAudibleChange.mockClear();

				// 스케줄 끝 1040ms (now 0.34s에서 700ms 경과)
				FakeAudioContext.now = 1.04;
				vi.advanceTimersByTime(700);
				FakeAudioContext.sources[0].onended?.();

				// 꼬리 끝 전 (1040ms로부터 250ms 경과 = 1290ms, 꼬리끝 1340ms - 50ms): false 0회
				vi.advanceTimersByTime(250);
				expect(
					onAudibleChange.mock.calls.filter((args) => args[0] === false),
				).toHaveLength(0);

				// 꼬리 끝 (추가 50ms 경과 = 1340ms, 스케줄 끝+300ms 출력 지연 포함): false 정확히 1회
				vi.advanceTimersByTime(50);
				const falseCallsAtTail = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsAtTail).toHaveLength(1);
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
				vi.useRealTimers();
			}
		});

		it("VL-7 (너): VL-6 에서 빠진 되돌림 시험 - 스트림 꼬리(300ms) 동안 다음 WAV 가 currentTime > 0 되기 전에 onended 를 받는 경우(길이 0 파일), if (audibleStarted) 가드로 false 지연 보존", () => {
			vi.useFakeTimers();
			try {
				FakeAudioContext.outputLatency = 0.3; // 300ms 출력 지연
				FakeAudioContext.now = 0;
				const onAudibleChange = vi.fn();
				const queue = new AudioQueue({ onAudibleChange });
				queue.setResponseActive(true); // 응답 스트리밍 중

				const stream = new PcmStreamSource(24_000);
				queue.enqueueOrderedStream(0, stream, {});
				queue.enqueueOrdered(
					1,
					"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
				); // 길이 0 파일

				// 1초 PCM
				stream.push(new Int16Array(24_000));
				stream.end();

				// 340ms: 입 열림
				FakeAudioContext.now = 0.34;
				vi.advanceTimersByTime(340);
				expect(onAudibleChange).toHaveBeenCalledWith(true);
				onAudibleChange.mockClear();

				// 1.04s: 스케줄 끝(꼬리 끝 - 300ms). advance() 호출 및 WAV onended 를 이 시각에 고정
				FakeAudioContext.now = 1.04;
				vi.advanceTimersByTime(700);
				FakeAudioContext.sources[0].onended?.();

				const wavAudio = FakeAudio.instances[0];
				wavAudio.currentTime = 0; // currentTime > 0 되기 전 (길이 0 파일)
				wavAudio.onended?.();

				// 꼬리 끝(스케줄 끝 1040ms + 300ms = 1340ms)까지 false 0회
				FakeAudioContext.now = 1.34;
				vi.advanceTimersByTime(300);
				const falseCallsAtTailEnd = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsAtTailEnd).toHaveLength(0);

				// 꼬리 끝 초과부터 꼬리 끝+350ms(1690ms)까지도 false 0회
				vi.advanceTimersByTime(350);
				const falseCallsAtTailPlus350 = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsAtTailPlus350).toHaveLength(0);

				// 꼬리 끝+400ms(1740ms, 추가 50ms): false 정확히 1회
				vi.advanceTimersByTime(50);
				const falseCallsAtTailPlus400 = onAudibleChange.mock.calls.filter(
					(args) => args[0] === false,
				);
				expect(falseCallsAtTailPlus400).toHaveLength(1);
				expect(onAudibleChange).toHaveBeenLastCalledWith(false);

				// 그 뒤 1초 동안 true 0회
				vi.advanceTimersByTime(1000);
				const trueCallsAfter = onAudibleChange.mock.calls.filter(
					(args) => args[0] === true,
				);
				expect(trueCallsAfter).toHaveLength(0);
			} finally {
				FakeAudioContext.outputLatency = 0;
				FakeAudioContext.now = 0;
				vi.useRealTimers();
			}
		});
	});
});
