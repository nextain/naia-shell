import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

	it("gap-review-7 (2026-09-25) 구멍 5-1: HTMLAudioElement 경로(WAV 대체 합성 포함)도 실제 재생 시작/종료에 맞춰 audible 을 켜고 끈다", () => {
		const onAudibleChange = vi.fn();
		const queue = new AudioQueue({ onAudibleChange });
		queue.enqueue("YmFzZTY0");
		const audio = FakeAudio.instances[0];
		// 디코딩/합성 대기 동안(onplay 전)에는 아직 안 켜진다.
		expect(onAudibleChange).not.toHaveBeenCalled();
		audio.onplay?.();
		expect(onAudibleChange).toHaveBeenLastCalledWith(true);
		audio.onended?.();
		expect(onAudibleChange).toHaveBeenLastCalledWith(false);
	});

	it("구멍 5-1: onerror 도 audible 을 false 로 되돌린다", () => {
		const onAudibleChange = vi.fn();
		const queue = new AudioQueue({ onAudibleChange });
		queue.enqueue("YmFzZTY0");
		const audio = FakeAudio.instances[0];
		audio.onplay?.();
		expect(onAudibleChange).toHaveBeenLastCalledWith(true);
		audio.onerror?.(new Event("error"));
		expect(onAudibleChange).toHaveBeenLastCalledWith(false);
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
	// gap-review-7 (2026-09-25) 구멍 5-2: 이 클래스는 파일 전체에서 사실상
	// 싱글턴이다(audio-queue.ts 의 `sharedAudioContext` 캐시가 첫 호출에서
	// 만든 인스턴스를 계속 재사용) — 그래서 `state`/`outputLatency`/재개
	// 동작을 인스턴스 필드가 아니라 static 으로 둬서, 이미 만들어진 단일
	// 인스턴스를 테스트마다 재설정할 수 있게 한다.
	static state: "running" | "suspended" = "running";
	static outputLatency = 0;
	static resumeImpl: () => Promise<void> = async () => {
		FakeAudioContext.state = "running";
	};
	static resumeCalls = 0;
	destination = {};
	resume = vi.fn(() => {
		FakeAudioContext.resumeCalls++;
		return FakeAudioContext.resumeImpl();
	});
	get state() {
		return FakeAudioContext.state;
	}
	get currentTime() {
		return FakeAudioContext.now;
	}
	get outputLatency() {
		return FakeAudioContext.outputLatency;
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

		it("버퍼 고갈(다음 조각이 아직 없는데 재생이 앞선 조각을 다 씀) 동안은 false, 새 조각이 오면 다시 true", () => {
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
			expect(onAudibleChange).toHaveBeenLastCalledWith(false);
			stream.push(new Int16Array(2_400)); // 고갈 뒤 재개
			vi.advanceTimersByTime(200);
			expect(onAudibleChange).toHaveBeenLastCalledWith(true);
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
});
