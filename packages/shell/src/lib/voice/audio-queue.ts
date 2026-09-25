/**
 * Sequential audio playback queue for pipeline voice.
 *
 * Queues MP3 base64 chunks and plays them in order.
 * Supports interrupt (clear all), avatar speaking state,
 * and ordered enqueue for out-of-order TTS responses.
 */

import { Logger } from "../logger";
import { effectivePreRollSeconds } from "../tts/voice-playback-mode";
import {
	type LevelBlock,
	type LevelEdge,
	type LevelsAround,
	type LevelsAroundQuery,
	VOICE_LEVEL_WINDOW_SEC,
	type VoiceLevelSource,
	VoiceLevelTimeline,
	envelopeLevelAt,
	levelsAround,
	outputLatencySeconds,
	releaseVoiceLevelSource,
	rmsEnvelope,
	setActiveVoiceLevelSource,
	wavEnvelope,
} from "./voice-level";

/**
 * How long the audible signal (`onAudibleChange`) stays on through silence
 * before it reports false. Same length as the NVA shell hold
 * (`NVA_SHELL_HOLD_MS`): a pause shorter than this is part of speaking — a
 * breath, the gap between two sentences that are both already synthesized,
 * or a chunk that arrives a few ms late — and must not switch the avatar's
 * speaking state off and on again (2026-09-25 review 8, hole 2). When nothing
 * more is queued or being synthesized, the signal goes off without this wait.
 */
export const AUDIBLE_OFF_HOLD_MS = 400;

/** Earliest a stream item can start after the one before it (first-chunk lead). */
const STREAM_MIN_START_LEAD_SEC = 0.04;

/** Reads the level of what the queue is playing, on that item's own clock. */
interface LevelReader {
	level(): number | null;
	around(query: LevelsAroundQuery): LevelsAround | null;
}

export interface AudioQueueCallbacks {
	onPlaybackStart?: () => void;
	onPlaybackEnd?: () => void;
	/**
	 * gap-review-7 (2026-09-25) 구멍 5-1: `onPlaybackStart`/`onPlaybackEnd` 는
	 * 큐가 바쁜지(대기 중인 항목이 있는지)를 알리는 거친 신호로 남는다(STT
	 * 마이크 정지/쿨다운, ttsPlayingRef 등 기존 소비자는 그대로 이 신호를
	 * 쓴다). 이 콜백은 그와 별개로, 스피커에서 실제로 소리가 나는 동안만
	 * true — 첫 조각 대기·미리 채움·버퍼 고갈(mid-stream underrun)·WAV 대체
	 * 합성 시간에는 false. 립싱크의 "말하는 중" 신호(아바타 입) 처럼 조용한
	 * 구간에 움직이면 안 되는 소비자가 이걸 구독한다.
	 */
	onAudibleChange?: (audible: boolean) => void;
	/** Audio output device ID (from enumerateDevices). Applied via setSinkId. */
	outputDeviceId?: string;
}

export interface AudioQueueItemCallbacks {
	/** Fires when this exact sentence starts playing, not merely when queued. */
	onPlaybackStart?: () => void;
	/** Fires if this sentence cannot start playback. */
	onPlaybackUnavailable?: () => void;
}

interface AudioQueueItem extends AudioQueueItemCallbacks {
	audioBase64?: string;
	/** Streaming PCM item (local voice engines that stream `audio/pcm`). */
	stream?: PcmStreamSource;
}

/**
 * PCM16 chunk stream produced by a streaming TTS response. The producer
 * (`synthNaiaLocalVoice`) pushes chunks as they arrive; the AudioQueue
 * subscribes when the item's turn comes and schedules chunks back-to-back on
 * a Web Audio timeline (same scheme as the naia.land realtime demo), so the
 * first chunk plays while the engine is still synthesizing the rest.
 */
export class PcmStreamSource {
	readonly chunks: Int16Array[] = [];
	ended = false;
	failed = false;
	/**
	 * FR-VOICE.22 (2026-09-25) — "auto" 재생 방식이 RTF 를 실시간보다 약간
	 * 느리다고 판정했을 때(`voice-playback-mode.ts` pre-roll), 첫 청크를 이만큼
	 * 늦게 재생 시작하라는 지시. 0 이면 기존 동작(첫 청크에 40ms 리드만 두고
	 * 바로 재생) 그대로다. `AudioQueue.playStream` 이 최초 스케줄에만 반영한다
	 * — 청크는 그동안에도 계속 쌓이므로(버퍼가 이미 있는 배열), 재생 시작
	 * 시점만 늦추면 그 사이 도착한 뒷 청크들이 실질적인 pre-roll 버퍼가 된다.
	 */
	startDelaySeconds = 0;
	/**
	 * FR-VOICE.22 gap-review-2 (2026-09-25) — 이 문장의 예상 길이(초). 이미
	 * 이만큼(또는 그 이상) 버퍼가 쌓였으면 `startDelaySeconds` 를 더 기다릴
	 * 이유가 없다(`effectivePreRollSeconds` 가 쓴다). 없으면(undefined) 그
	 * 판단을 건너뛰고 "이미 쌓인 만큼 빼기"만 적용한다.
	 */
	expectedDurationSeconds: number | null = null;
	private onChunk: ((chunk: Int16Array) => void) | null = null;
	private onEnd: (() => void) | null = null;
	constructor(public sampleRate = 24000) {}
	push(chunk: Int16Array): void {
		if (this.ended || chunk.length === 0) return;
		this.chunks.push(chunk);
		this.onChunk?.(chunk);
	}
	end(): void {
		if (this.ended) return;
		this.ended = true;
		this.onEnd?.();
	}
	/**
	 * gap-review-4 (2026-09-25): push a chunk that is ALSO the last one, e.g.
	 * a whole-WAV fallback decoded into a single chunk. `push(chunk); end();`
	 * looks equivalent but is not: `push()` invokes `onChunk` synchronously,
	 * and only AFTER that call returns does the caller get to call `end()` —
	 * so `AudioQueue.playStream`'s first-chunk delay calculation, which reads
	 * `stream.ended` live at the moment `onChunk` fires, still sees `false`
	 * and applies the full pre-roll target to audio that has, in fact,
	 * already finished synthesizing. Setting `ended` BEFORE calling `onChunk`
	 * closes that window: the live read inside `onChunk` sees the true final
	 * state instead of a transient in-progress one.
	 */
	pushFinal(chunk: Int16Array): void {
		if (this.ended) return;
		this.ended = true;
		if (chunk.length > 0) {
			this.chunks.push(chunk);
			this.onChunk?.(chunk);
		}
		this.onEnd?.();
	}
	fail(): void {
		this.failed = true;
		this.end();
	}
	subscribe(onChunk: (chunk: Int16Array) => void, onEnd: () => void): void {
		this.onChunk = onChunk;
		this.onEnd = onEnd;
		for (const c of this.chunks) onChunk(c);
		if (this.ended) onEnd();
	}
	unsubscribe(): void {
		this.onChunk = null;
		this.onEnd = null;
	}
}

export class AudioQueue implements VoiceLevelSource {
	private queue: AudioQueueItem[] = [];
	/** Level of the audio heard now and around it (null = cannot measure). */
	private levelReader: LevelReader | null = null;
	/** Envelope of streamed PCM chunks on the shared AudioContext clock. */
	private streamLevels = new VoiceLevelTimeline();
	/** Envelope per queued item, computed once when the avatar first asks. */
	private itemEnvelopes = new WeakMap<
		AudioQueueItem,
		{ chunks: number; envelope: Float32Array | null }
	>();
	/** The stream item `currentStream` belongs to, and whether it has scheduled audio. */
	private currentStreamItem: AudioQueueItem | null = null;
	private currentStreamScheduled = false;
	private audibleOffTimer: ReturnType<typeof setTimeout> | null = null;
	private current: HTMLAudioElement | null = null;
	private currentStream: PcmStreamSource | null = null;
	private streamSources = new Set<AudioBufferSourceNode>();
	/**
	 * FR-VOICE.22 gap-review-2 (2026-09-25) — timers that will fire
	 * `onPlaybackStart` at the moment a scheduled chunk actually becomes
	 * audible (see `playStream`). Tracked so `clear()` can cancel one that
	 * hasn't fired yet instead of leaving it to run after playback was cut.
	 */
	private pendingStartTimers = new Set<ReturnType<typeof setTimeout>>();
	private playing = false;
	private playbackPaused = false;
	private generation = 0;
	private callbacks: AudioQueueCallbacks;
	/** gap-review-7 구멍 5-1: 스피커에서 실제로 소리가 나는 중인가. */
	private audible = false;

	/**
	 * gap-review-8 hole 2: `true` is reported at once; `false` only after
	 * `AUDIBLE_OFF_HOLD_MS` of continued silence (plus the device latency, the
	 * sound already sent keeps playing that long). Anything audible again in
	 * that time cancels it, so an item boundary with the next item ready, a
	 * breath, or a slightly late chunk never flips the signal.
	 */
	private setAudible(value: boolean): void {
		if (value) {
			this.cancelAudibleOff();
			if (this.audible) return;
			this.audible = true;
			this.callbacks.onAudibleChange?.(true);
			return;
		}
		if (!this.audible || this.audibleOffTimer !== null) return;
		this.armAudibleOff(AUDIBLE_OFF_HOLD_MS);
	}

	/** Nothing more will play: report false once the last sound has left the speaker. */
	private endAudible(): void {
		if (!this.audible) return;
		this.cancelAudibleOff();
		this.armAudibleOff(0);
	}

	/** Playback was cut: nothing is heard any more. */
	private silenceAudibleNow(): void {
		this.cancelAudibleOff();
		if (!this.audible) return;
		this.audible = false;
		this.callbacks.onAudibleChange?.(false);
	}

	private armAudibleOff(holdMs: number): void {
		const delayMs = holdMs + outputLatencySeconds(sharedAudioContext) * 1000;
		this.audibleOffTimer = setTimeout(() => {
			this.audibleOffTimer = null;
			if (!this.audible) return;
			this.audible = false;
			this.callbacks.onAudibleChange?.(false);
		}, delayMs);
	}

	private cancelAudibleOff(): void {
		if (this.audibleOffTimer === null) return;
		clearTimeout(this.audibleOffTimer);
		this.audibleOffTimer = null;
	}

	// Ordered enqueue: buffer out-of-order items until their turn.
	// A `null` value marks a reserved slot whose synthesis failed / fell back —
	// it advances the cursor without playing, so later seqs don't stall.
	private nextExpectedSeq = 0;
	private pendingOrdered: Map<number, AudioQueueItem | null> = new Map();

	constructor(callbacks: AudioQueueCallbacks = {}) {
		this.callbacks = callbacks;
	}

	/** Add MP3 base64 audio to the queue. Starts playback if idle. */
	enqueue(mp3Base64: string, callbacks: AudioQueueItemCallbacks = {}): void {
		this.queue.push({ audioBase64: mp3Base64, ...callbacks });
		if (!this.playing && !this.playbackPaused) {
			this.playNext();
		} else {
			Logger.debug("AudioQueue", "enqueue:held", {
				playing: this.playing,
				paused: this.playbackPaused,
				queued: this.queue.length,
			});
		}
	}

	private enqueueItem(item: AudioQueueItem): void {
		this.queue.push(item);
		if (!this.playing && !this.playbackPaused) this.playNext();
	}

	/** Hold queued audio without stopping an item that is already playing. */
	pauseBeforePlayback(): void {
		this.playbackPaused = true;
	}

	/** Release a prebuffered queue and start its first item. */
	resumePlayback(): void {
		this.playbackPaused = false;
		if (!this.playing && this.queue.length > 0) this.playNext();
	}

	/**
	 * Reserve a sequence number for ordered enqueue.
	 * Call this BEFORE sending the TTS request to guarantee ordering.
	 */
	reserveSeq(): number {
		return this.nextExpectedSeq++;
	}

	/**
	 * Enqueue audio by sequence number. Buffers out-of-order items
	 * and flushes them in order when their turn arrives.
	 */
	enqueueOrdered(
		seq: number,
		mp3Base64: string,
		callbacks: AudioQueueItemCallbacks = {},
	): void {
		Logger.debug("AudioQueue", "enqueueOrdered", {
			seq,
			cursor: this.flushCursor,
			playing: this.playing,
			paused: this.playbackPaused,
		});
		this.pendingOrdered.set(seq, { audioBase64: mp3Base64, ...callbacks });
		this.flushOrdered();
	}

	/**
	 * Enqueue a streaming PCM item by sequence number. Playback starts on the
	 * first chunk once this seq's turn arrives; `stream.end()`/`fail()` closes it.
	 */
	enqueueOrderedStream(
		seq: number,
		stream: PcmStreamSource,
		callbacks: AudioQueueItemCallbacks = {},
	): void {
		Logger.debug("AudioQueue", "enqueueOrderedStream", {
			seq,
			cursor: this.flushCursor,
		});
		this.pendingOrdered.set(seq, { stream, ...callbacks });
		this.flushOrdered();
	}

	/**
	 * Release a reserved sequence slot without audio (synthesis failed or fell
	 * back to a non-queued path, e.g. browser TTS). Without this, the contiguous
	 * flush cursor would stall forever waiting for the missing seq.
	 */
	skipOrdered(seq: number): void {
		this.pendingOrdered.set(seq, null);
		this.flushOrdered();
	}

	/** Reset sequence counter (call when starting a new response). */
	resetSeq(): void {
		this.nextExpectedSeq = 0;
		this.flushCursor = 0;
		this.pendingOrdered.clear();
	}

	private flushCursor = 0;

	private flushOrdered(): void {
		while (this.pendingOrdered.has(this.flushCursor)) {
			const item = this.pendingOrdered.get(this.flushCursor);
			this.pendingOrdered.delete(this.flushCursor);
			this.flushCursor++;
			// null = skipped slot (failed/fell-back synthesis); advance only.
			if (item?.stream) this.enqueueItem(item);
			else if (item?.audioBase64) this.enqueue(item.audioBase64, item);
		}
	}

	/** Stop current playback and clear all queued audio. */
	clear(): void {
		this.generation++;
		this.queue = [];
		this.playbackPaused = false;
		this.pendingOrdered.clear();
		this.flushCursor = 0;
		this.nextExpectedSeq = 0;
		if (this.current) {
			this.current.pause();
			this.current.src = "";
			this.current = null;
		}
		if (this.currentStream) {
			this.currentStream.unsubscribe();
			this.currentStream = null;
		}
		this.currentStreamItem = null;
		this.currentStreamScheduled = false;
		for (const src of this.streamSources) {
			try {
				src.stop();
			} catch {
				/* already stopped */
			}
		}
		this.streamSources.clear();
		for (const timer of this.pendingStartTimers) clearTimeout(timer);
		this.pendingStartTimers.clear();
		// gap-review-7 구멍 5-1: 중단된 재생은 더 이상 들리지 않는다.
		this.silenceAudibleNow();
		this.stopLevel();
		if (this.playing) {
			this.playing = false;
			this.callbacks.onPlaybackEnd?.();
		}
	}

	/** RMS of the audio heard now, or null when unknown. */
	voiceLevel(): number | null {
		return this.levelReader ? this.levelReader.level() : null;
	}

	/** Levels around the audible moment, or null when they cannot be measured. */
	voiceLevelsAround(query: LevelsAroundQuery): LevelsAround | null {
		return this.levelReader ? this.levelReader.around(query) : null;
	}

	private startLevel(reader: LevelReader): void {
		this.levelReader = reader;
		setActiveVoiceLevelSource(this);
	}

	private stopLevel(): void {
		this.levelReader = null;
		this.streamLevels.clear();
		releaseVoiceLevelSource(this);
	}

	/**
	 * Nothing queued, nothing held for ordering, and every reserved slot
	 * already flushed: no sentence is waiting or being synthesized. The time
	 * after the audio still playing is then real silence (review hole 5).
	 */
	private nothingQueued(): boolean {
		return (
			this.queue.length === 0 &&
			this.pendingOrdered.size === 0 &&
			this.flushCursor >= this.nextExpectedSeq
		);
	}

	/**
	 * What follows the audio the reader knows, when no next item is bound.
	 * `self` is the <audio> element the reader is reading, if any.
	 */
	private edgeWhenNoNext(self: HTMLAudioElement | null): LevelEdge {
		return this.nothingQueued() &&
			(this.current === null || this.current === self) &&
			(this.currentStream === null || this.currentStream.ended)
			? "silence"
			: "unknown";
	}

	/**
	 * Envelope of an item not yet playing (null: cannot be measured, e.g. MP3,
	 * or a stream with nothing synthesized yet). `complete` = nothing more
	 * will be added to it.
	 */
	private upcomingLevels(
		item: AudioQueueItem,
	): { envelope: Float32Array; complete: boolean } | null {
		const stream = item.stream;
		const cached = this.itemEnvelopes.get(item);
		if (stream) {
			if (!cached || cached.chunks !== stream.chunks.length) {
				const parts = stream.chunks.map((c) =>
					rmsEnvelope(c, stream.sampleRate, VOICE_LEVEL_WINDOW_SEC, 1 / 0x8000),
				);
				const total = parts.reduce((n, p) => n + p.length, 0);
				const envelope = new Float32Array(total);
				let offset = 0;
				for (const p of parts) {
					envelope.set(p, offset);
					offset += p.length;
				}
				this.itemEnvelopes.set(item, {
					chunks: stream.chunks.length,
					envelope: total > 0 ? envelope : null,
				});
			}
			const envelope = this.itemEnvelopes.get(item)?.envelope ?? null;
			return envelope ? { envelope, complete: stream.ended } : null;
		}
		if (!cached) {
			const audio = item.audioBase64 ?? "";
			this.itemEnvelopes.set(item, {
				chunks: 0,
				envelope: audio.startsWith("UklGR") ? wavEnvelope(audio) : null,
			});
		}
		const envelope = this.itemEnvelopes.get(item)?.envelope ?? null;
		return envelope ? { envelope, complete: true } : null;
	}

	/**
	 * Blocks and edge for the item queued after the known audio, placed at
	 * `earliestStart` — the soonest it can be heard, so a pause is never
	 * counted longer than it will be (review hole 2).
	 */
	private withUpcoming(
		blocks: LevelBlock[],
		next: AudioQueueItem | null,
		earliestStart: number,
		self: HTMLAudioElement | null = null,
	): LevelEdge {
		if (!next) return this.edgeWhenNoNext(self);
		const up = this.upcomingLevels(next);
		if (up) blocks.push({ start: earliestStart, envelope: up.envelope });
		return "unknown";
	}

	/** Reader for streamed PCM on the AudioContext clock (all stream items share it). */
	private streamReader(ctx: AudioContext): LevelReader {
		const audibleNow = () => ctx.currentTime - outputLatencySeconds(ctx);
		return {
			level: () => this.streamLevels.levelAt(audibleNow()),
			around: (query) => {
				const now = audibleNow();
				const blocks = [...this.streamLevels.blocks(now)];
				const lastEnd = this.streamLevels.end();
				const stream = this.currentStream;
				let after: LevelEdge;
				if (stream && !this.currentStreamScheduled) {
					// The current item has not scheduled anything yet (pre-roll,
					// resume): it starts no sooner than one lead after the later of
					// the previous audio's end and the render clock now.
					after = this.withUpcoming(
						blocks,
						this.currentStreamItem,
						Math.max(lastEnd, ctx.currentTime) + STREAM_MIN_START_LEAD_SEC,
					);
				} else if (stream && !stream.ended) {
					after = "unknown"; // more chunks of this sentence are coming
				} else if (stream || this.current === null) {
					after = this.withUpcoming(
						blocks,
						this.queue[0] ?? null,
						Math.max(lastEnd, ctx.currentTime) + STREAM_MIN_START_LEAD_SEC,
					);
				} else {
					after = "unknown"; // an <audio> item on another clock is next
				}
				return levelsAround(
					blocks,
					now + query.leadSec,
					query.backSec,
					query.aheadSec,
					after,
				);
			},
		};
	}

	/**
	 * Reader for a WAV sentence played by an <audio> element, on its media
	 * clock. The next queued item (FIFO `queue[0]` while this one plays) is
	 * placed right after its end.
	 *
	 * `currentTime` alone is the audible position (review hole 4: the wall
	 * clock anchored on the `playing` event is gone — when that event fires
	 * relative to the sound differs per engine). A media element's clock is
	 * already the playout position: Chromium/WebView2 reports the timestamp of
	 * the audio the device is playing (its audio renderer counts the output
	 * delay), GStreamer (WebKitGTK) and AVFoundation (WKWebView) report the
	 * sink/presentation position. Subtracting a Web Audio latency here would
	 * count the device delay twice. `playbackRate` scales the media clock
	 * against real time (`levelsAround`).
	 */
	private mediaReader(
		audio: HTMLAudioElement,
		envelope: Float32Array,
		prior: LevelReader | null,
	): LevelReader {
		const rate = () =>
			Number.isFinite(audio.playbackRate) && audio.playbackRate > 0
				? audio.playbackRate
				: 1;
		const audibleNow = () => audio.currentTime || 0;
		const duration = envelope.length * VOICE_LEVEL_WINDOW_SEC;
		// Until the media clock moves, this sentence is not heard yet: the
		// reader before it (the gap after the previous sentence, which has this
		// one bound as next) still describes what is audible. The `play` and
		// `playing` events are not used for timing — engines fire them at
		// different distances from the sound.
		let before = prior;
		const started = () => {
			if ((audio.currentTime || 0) <= 0) return false;
			before = null; // heard now; let the earlier reader go
			return true;
		};
		return {
			level: () =>
				started()
					? envelopeLevelAt(envelope, audibleNow())
					: (before?.level() ?? null),
			around: (query) => {
				if (!started())
					return before
						? before.around(query)
						: { levels: [], now: -1, stepMs: VOICE_LEVEL_WINDOW_SEC * 1000 };
				const r = rate();
				const blocks: LevelBlock[] = [{ start: 0, envelope }];
				const after = this.withUpcoming(
					blocks,
					this.queue[0] ?? null,
					duration,
					audio,
				);
				return levelsAround(
					blocks,
					audibleNow() + query.leadSec * r,
					query.backSec,
					query.aheadSec,
					after,
					r,
				);
			},
		};
	}

	/**
	 * Reader for the gap after an <audio> sentence ended. `next` is the item
	 * that was queued behind it when it ended, bound here because `playNext`
	 * is about to shift it off the queue (review hole 2: reading `queue[0]`
	 * after that shift read the sentence after next). The ended sentence's
	 * tail and the silence since it ended are known; the next sentence can be
	 * heard at the earliest now. With no next item and nothing queued, what
	 * follows is silence (review hole 5).
	 */
	private gapReader(
		envelope: Float32Array,
		rate: number,
		next: AudioQueueItem | null,
	): LevelReader {
		const endedAt = performance.now();
		const duration = envelope.length * VOICE_LEVEL_WINDOW_SEC;
		// Only the silence since the end is timed by the wall clock: nothing
		// is playing, so there is no media clock left to read.
		const audibleSinceEnd = () => ((performance.now() - endedAt) / 1000) * rate;
		return {
			level: () => envelopeLevelAt(envelope, duration + audibleSinceEnd()),
			around: (query) => {
				const now = duration + audibleSinceEnd();
				const blocks: LevelBlock[] = [{ start: 0, envelope }];
				const after = this.withUpcoming(blocks, next, Math.max(duration, now));
				return levelsAround(
					blocks,
					now + query.leadSec * rate,
					query.backSec,
					query.aheadSec,
					after,
					rate,
				);
			},
		};
	}

	/** Whether audio is currently playing or queued. */
	get isActive(): boolean {
		return this.playing || this.queue.length > 0;
	}

	/** Destroy the queue and release resources. */
	destroy(): void {
		this.clear();
	}

	/** Play a streaming PCM item: schedule chunks back-to-back as they arrive. */
	private playStream(
		item: AudioQueueItem,
		stream: PcmStreamSource,
		generation: number,
		wasPlaying: boolean,
	): void {
		const ctx = ensureAudioContext(this.callbacks.outputDeviceId);
		Logger.debug("AudioQueue", "playStream:begin", {
			ctxState: ctx.state,
			buffered: stream.chunks.length,
			ended: stream.ended,
		});
		this.currentStream = stream;
		this.currentStreamItem = item;
		this.currentStreamScheduled = false;
		let nextStart = 0;
		let started = false;
		let advanced = false;
		let pending = 0;
		let ended = false;
		// gap-review-3 (2026-09-25): the timer that will fire `onPlaybackStart`
		// once the first chunk's scheduled `at` arrives — hoisted to this outer
		// scope (not just inside the `!started` branch below) so `advance()`
		// can fire it early instead of losing it (see `advance` below).
		let startTimer: ReturnType<typeof setTimeout> | null = null;
		let fireStart: (() => void) | null = null;
		// gap-review-7 (2026-09-25) 구멍 5-1: 위 `startTimer`/`fireStart` 는
		// 아이템의 "첫" 조각에만 한 번 쓰이는 거친 신호(onPlaybackStart)용이다.
		// 이 타이머는 그와 별개로, 조용한 구간(첫 조각 대기·미리 채움·버퍼
		// 고갈 뒤 재개) 뒤에 나오는 "이번" 조각이 실제로 들리기 시작하는
		// 순간마다 다시 걸린다 — 아이템 생애 동안 여러 번 걸릴 수 있다(버퍼
		// 고갈이 여러 번이면). 한 번에 하나만 대기하면 되므로(고갈→침묵→다음
		// 조각 도착까지는 새 타이머가 없다) 변수 하나로 충분하다.
		let audibleTimer: ReturnType<typeof setTimeout> | null = null;
		let fireAudible: (() => void) | null = null;
		const isCurrent = () =>
			generation === this.generation && this.currentStream === stream;
		const advance = () => {
			if (!isCurrent() || advanced) return;
			advanced = true;
			// gap-review-3: a very short clip (or a test double that drives
			// `onended` synchronously) can have every scheduled source finish
			// — and thus reach here — before the deferred `startTimer` below
			// has fired. Once `currentStream` is cleared, `isCurrent()` turns
			// false and the still-pending timer would fire into a no-op,
			// permanently dropping the reveal/speaking notification for a
			// sentence that DID play. Fire it now instead of letting it race.
			if (startTimer !== null) {
				clearTimeout(startTimer);
				this.pendingStartTimers.delete(startTimer);
				startTimer = null;
				fireStart?.();
			}
			if (audibleTimer !== null) {
				clearTimeout(audibleTimer);
				this.pendingStartTimers.delete(audibleTimer);
				audibleTimer = null;
				fireAudible?.();
			}
			// gap-review-7 구멍 5-1: 이 아이템의 소리는 끝났다 — 다음 항목이
			// 곧바로 이어 재생되면 그 항목이 스스로 다시 true 를 켠다.
			this.setAudible(false);
			stream.unsubscribe();
			this.currentStream = null;
			this.currentStreamItem = null;
			this.playNext();
		};
		const maybeFinish = () => {
			if (ended && pending === 0) advance();
		};
		const beginSubscribe = () => {
			stream.subscribe(
				(chunk) => {
					if (!isCurrent()) return;
					const buf = ctx.createBuffer(1, chunk.length, stream.sampleRate);
					const ch = buf.getChannelData(0);
					for (let i = 0; i < chunk.length; i++) ch[i] = chunk[i] / 0x8000;
					const src = ctx.createBufferSource();
					src.buffer = buf;
					src.connect(ctx.destination);
					const now = ctx.currentTime;
					// 40 ms lead on the very first chunk absorbs scheduling jitter;
					// startDelaySeconds (FR-VOICE.22 pre-roll) can push that lead out
					// further when "auto" judged the engine only slightly slower than
					// realtime. gap-review-3 (2026-09-25): the buffered state used to
					// subtract from that target is read LIVE, right here, instead of
					// from a one-time snapshot taken before subscribe() —
					// `PcmStreamSource.push()` appends to `stream.chunks` before
					// invoking this callback, so this correctly reflects everything
					// available at the moment THIS chunk is actually being scheduled.
					// That covers background synthesis that buffered chunks before
					// this stream's turn (still present in `stream.chunks` when
					// subscribe() replays them here).
					//
					// gap-review-4 (2026-09-25): `stream.ended` read here is ALSO
					// live, but that alone is not enough for a producer that calls
					// `push(chunk); end();` back to back — `push()` invokes this
					// callback SYNCHRONOUSLY, before the caller's next line can call
					// `end()`, so `stream.ended` is still `false` at exactly the
					// moment it matters most: the whole-WAV fallback landing its
					// entire sentence as one chunk on an already-subscribed, empty
					// stream. `PcmStreamSource.pushFinal()` exists for exactly that
					// case — it sets `ended = true` BEFORE calling `onChunk`, so the
					// live read below sees the true final state and skips the
					// pre-roll wait for audio that has nothing left to wait for.
					const bufferedSecondsNow =
						stream.chunks.reduce((sum, c) => sum + c.length, 0) /
						(stream.sampleRate || 1);
					const effectiveDelay = effectivePreRollSeconds(
						stream.startDelaySeconds,
						bufferedSecondsNow,
						stream.expectedDurationSeconds,
						stream.ended,
					);
					const firstChunkLead = Math.max(0.04, effectiveDelay);
					const at = Math.max(now + (started ? 0 : firstChunkLead), nextStart);
					src.start(at);
					nextStart = at + buf.duration;
					// Level envelope on the same clock as `at` (after pre-roll and
					// after resume — beginSubscribe runs only once the context runs).
					this.streamLevels.add(at, rmsEnvelope(ch, stream.sampleRate));
					this.currentStreamScheduled = true;
					// gap-review-7 구멍 5-1: 이 조각이 도착하기 전(방금 this
					// 시점) 아무 소스도 재생 중이 아니었으면(pending===0) — 첫
					// 조각이거나, 버퍼 고갈 뒤 재개 — 그 직전까지는 조용했다는
					// 뜻이다. 그 경우에만 "들리기 시작함" 타이머를 다시 건다.
					const wasSilent = pending === 0;
					pending++;
					this.streamSources.add(src);
					src.onended = () => {
						this.streamSources.delete(src);
						pending--;
						// gap-review-7 구멍 5-1: 버퍼 고갈(다음 조각이 아직 안
						// 왔는데 재생할 게 떨어짐) — 스트림은 안 끝났지만
						// 지금 이 순간은 조용하다. 즉시 false.
						if (pending === 0 && !ended) this.setAudible(false);
						maybeFinish();
					};
					// gap-review-7 구멍 5-2 / review 8: 스피커에서 실제로 들리는
					// 시각은 `at` 보다 baseLatency + outputLatency 만큼 늦다(두
					// 단계가 이어지므로 합). 아바타 입의 음성 크기 시계와 같은
					// 함수(`outputLatencySeconds`)를 쓴다 — 두 알림(거친
					// onPlaybackStart, 세밀한 audible)과 입이 같은 순간을 본다.
					const audibleLeadMs = Math.max(
						0,
						(at - now + outputLatencySeconds(ctx)) * 1000,
					);
					if (wasSilent) {
						if (audibleTimer !== null) {
							clearTimeout(audibleTimer);
							this.pendingStartTimers.delete(audibleTimer);
						}
						fireAudible = () => {
							if (audibleTimer !== null)
								this.pendingStartTimers.delete(audibleTimer);
							audibleTimer = null;
							if (!isCurrent()) return;
							this.setAudible(true);
						};
						audibleTimer = setTimeout(fireAudible, audibleLeadMs);
						this.pendingStartTimers.add(audibleTimer);
					}
					if (!started) {
						started = true;
						this.startLevel(this.streamReader(ctx));
						Logger.debug("AudioQueue", "playStream:first chunk scheduled", {
							at: Number(at.toFixed(3)),
							now: Number(now.toFixed(3)),
							ctxState: ctx.state,
							effectiveDelay: Number(effectiveDelay.toFixed(3)),
						});
						// gap-review-2: fire onPlaybackStart (text reveal, speaking
						// state, avatar mouth) when the sound actually becomes
						// audible (`at`), not the instant it was scheduled — pre-roll
						// would otherwise show the answer and move the mouth while
						// the speaker is still silent.
						//
						// gap-review-7 구멍 5-2: 같은 출력 레이턴시 보정을 여기도
						// 적용 — 이 알림도 "실제 재생 시각"을 뜻하기 때문.
						const leadMs = audibleLeadMs;
						fireStart = () => {
							if (startTimer !== null)
								this.pendingStartTimers.delete(startTimer);
							startTimer = null;
							if (!isCurrent()) return;
							item.onPlaybackStart?.();
							if (!wasPlaying) this.callbacks.onPlaybackStart?.();
						};
						startTimer =
							leadMs > 0
								? setTimeout(fireStart, leadMs)
								: setTimeout(fireStart, 0);
						this.pendingStartTimers.add(startTimer);
					}
				},
				() => {
					if (!isCurrent()) return;
					ended = true;
					Logger.debug("AudioQueue", "playStream:source ended", {
						pending,
						started,
					});
					if (!started) {
						// Nothing arrived (failed/empty synthesis): release the slot.
						item.onPlaybackUnavailable?.();
						advance();
						return;
					}
					maybeFinish();
				},
			);
		};
		// gap-review-7 구멍 5-2: ctx 가 suspended 면 `ctx.currentTime` 이 멈춰
		// 있다 — 그 값으로 계산한 `at`/`leadMs` 는 재개 후 실제 재생 시각과
		// 어긋난다(알림이 실제보다 일찍 옴). 재개를 기다린 뒤에야 첫 조각을
		// 스케줄한다. `FakeAudioContext` 테스트 더블은 항상 "running" 이므로
		// 이 분기는 기존 시험에서는 타지 않는다(동일한 동기 경로 유지).
		if (ctx.state !== "running") {
			Logger.debug("AudioQueue", "playStream:awaiting resume", {
				ctxState: ctx.state,
			});
			void ctx
				.resume()
				.catch(() => {})
				.then(() => {
					if (!isCurrent()) return;
					beginSubscribe();
				});
		} else {
			beginSubscribe();
		}
	}

	private playNext(): void {
		if (this.queue.length === 0) {
			Logger.debug("AudioQueue", "playNext:empty → end", {});
			// Nothing waiting or being synthesized: the voice has ended, the
			// speaking signal goes off with the last sound (no hold).
			if (this.nothingQueued()) this.endAudible();
			this.playing = false;
			this.callbacks.onPlaybackEnd?.();
			return;
		}
		Logger.debug("AudioQueue", "playNext:start", {
			queued: this.queue.length,
		});

		const item = this.queue.shift();
		if (!item) {
			this.playing = false;
			this.callbacks.onPlaybackEnd?.();
			return;
		}
		const generation = this.generation;
		const wasPlaying = this.playing;
		this.playing = true;
		if (item.stream) {
			this.playStream(item, item.stream, generation, wasPlaying);
			return;
		}
		const mp3Base64 = item.audioBase64 ?? "";

		// WAV base64 starts with "UklGR" (RIFF header); use audio/wav MIME for omni model output
		const isWav = mp3Base64.startsWith("UklGR");
		const audio = new Audio(
			`data:audio/${isWav ? "wav" : "mp3"};base64,${mp3Base64}`,
		);
		// Apply output device if specified (setSinkId is non-standard, guarded)
		const setSinkId = (
			audio as unknown as { setSinkId?: (id: string) => Promise<void> }
		).setSinkId;
		if (this.callbacks.outputDeviceId && setSinkId) {
			setSinkId.call(audio, this.callbacks.outputDeviceId).catch(() => {});
		}
		this.current = audio;

		let started = false;
		let unavailableSignaled = false;
		let advanced = false;
		const isCurrent = () =>
			generation === this.generation && this.current === audio;
		const signalUnavailable = () => {
			if (!isCurrent() || started || unavailableSignaled) return;
			unavailableSignaled = true;
			item.onPlaybackUnavailable?.();
		};
		const advance = () => {
			if (!isCurrent() || advanced) return;
			advanced = true;
			this.current = null;
			this.playNext();
		};

		// The level reader follows the media clock from the moment play() is
		// asked for, not from the `play`/`playing` event (engine-dependent).
		const envelope = isWav ? wavEnvelope(mp3Base64) : null;
		if (envelope)
			this.startLevel(this.mediaReader(audio, envelope, this.levelReader));
		else this.stopLevel();
		audio.onplay = () => {
			if (!isCurrent()) return;
			started = true;
			item.onPlaybackStart?.();
			// Only fire onPlaybackStart for the first chunk in a sequence
			if (!wasPlaying) {
				this.callbacks.onPlaybackStart?.();
			}
			// gap-review-7 구멍 5-1: HTMLAudioElement 경로(WAV 대체 합성 포함)
			// 도 스트림 경로와 같은 세밀한 신호를 낸다 — `onplay` 는 디코딩이
			// 끝나고 실제로 재생이 시작될 때 붙는다(WAV 합성 대기 시간에는
			// 붙지 않음).
			this.setAudible(true);
		};

		audio.onended = () => {
			if (isCurrent() && envelope) {
				const rate =
					Number.isFinite(audio.playbackRate) && audio.playbackRate > 0
						? audio.playbackRate
						: 1;
				this.startLevel(this.gapReader(envelope, rate, this.queue[0] ?? null));
			}
			this.setAudible(false);
			advance();
		};

		audio.onerror = (e) => {
			Logger.warn("AudioQueue", "Audio playback error", { error: String(e) });
			this.setAudible(false);
			signalUnavailable();
			advance();
		};

		audio.play().catch((err) => {
			Logger.warn("AudioQueue", "Audio play rejected", { error: String(err) });
			signalUnavailable();
			advance();
		});
	}
}

/** Shared Web Audio context for streamed PCM playback (lazily created, one per page). */
let sharedAudioContext: AudioContext | null = null;
function ensureAudioContext(outputDeviceId?: string): AudioContext {
	if (!sharedAudioContext) sharedAudioContext = new AudioContext();
	const ctx = sharedAudioContext;
	if (ctx.state === "suspended") ctx.resume().catch(() => {});
	const setSinkId = (
		ctx as unknown as { setSinkId?: (id: string) => Promise<void> }
	).setSinkId;
	if (outputDeviceId && setSinkId)
		setSinkId.call(ctx, outputDeviceId).catch(() => {});
	return ctx;
}

/** Return the PCM duration encoded by a RIFF/WAVE base64 payload. */
export function wavDurationSeconds(audioBase64: string): number | null {
	try {
		const binary = atob(audioBase64);
		if (
			binary.length < 44 ||
			binary.slice(0, 4) !== "RIFF" ||
			binary.slice(8, 12) !== "WAVE"
		) {
			return null;
		}
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		const view = new DataView(bytes.buffer);
		let offset = 12;
		let byteRate = 0;
		let dataSize = 0;
		while (offset + 8 <= bytes.length) {
			const id = binary.slice(offset, offset + 4);
			const size = view.getUint32(offset + 4, true);
			const body = offset + 8;
			if (id === "fmt " && size >= 12 && body + 12 <= bytes.length) {
				byteRate = view.getUint32(body + 8, true);
			} else if (id === "data") {
				dataSize = Math.min(size, Math.max(0, bytes.length - body));
				break;
			}
			offset = body + size + (size % 2);
		}
		return byteRate > 0 && dataSize > 0 ? dataSize / byteRate : null;
	} catch {
		return null;
	}
}

/** A decoded RIFF/WAVE payload as mono PCM16 samples ready for `PcmStreamSource.push`. */
export interface DecodedWavPcm16 {
	samples: Int16Array;
	sampleRate: number;
}

/**
 * Decode a RIFF/WAVE base64 payload into mono PCM16 samples.
 *
 * FR-VOICE.22 gap-review-2 (2026-09-25) — when a "streaming" local-voice slot
 * is already reserved (`enqueueOrderedStream`) but the host turns out not to
 * support streaming and answers with one whole WAV, that audio must be fed
 * into the SAME `PcmStreamSource` (`push` + `end`), not re-enqueued through
 * `AudioQueue.enqueueOrdered` at the same seq — by the time the WAV arrives,
 * the ordered flush cursor has already moved past that seq (the stream slot
 * was flushed into the play queue the moment its turn came, independent of
 * whether any chunk had arrived yet), so a second `enqueueOrdered` call for
 * the same seq sits in `pendingOrdered` forever and is silently dropped.
 * Only 16-bit PCM (`audioFormat === 1`, the universal case for local TTS
 * output) is supported; multi-channel input is downmixed to mono to match
 * what `PcmStreamSource`/`AudioQueue.playStream` already assume.
 */
export function decodeWavPcm16(audioBase64: string): DecodedWavPcm16 | null {
	try {
		const binary = atob(audioBase64);
		if (
			binary.length < 44 ||
			binary.slice(0, 4) !== "RIFF" ||
			binary.slice(8, 12) !== "WAVE"
		) {
			return null;
		}
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		const view = new DataView(bytes.buffer);
		let offset = 12;
		let audioFormat = 0;
		let numChannels = 0;
		let sampleRate = 0;
		let bitsPerSample = 0;
		let dataOffset = -1;
		let dataSize = 0;
		while (offset + 8 <= bytes.length) {
			const id = binary.slice(offset, offset + 4);
			const size = view.getUint32(offset + 4, true);
			const body = offset + 8;
			if (id === "fmt " && size >= 16 && body + 16 <= bytes.length) {
				audioFormat = view.getUint16(body, true);
				numChannels = view.getUint16(body + 2, true);
				sampleRate = view.getUint32(body + 4, true);
				bitsPerSample = view.getUint16(body + 14, true);
			} else if (id === "data") {
				dataOffset = body;
				dataSize = Math.min(size, Math.max(0, bytes.length - body));
				break;
			}
			offset = body + size + (size % 2);
		}
		if (
			dataOffset < 0 ||
			dataSize <= 0 ||
			sampleRate <= 0 ||
			numChannels <= 0 ||
			// audioFormat 0xFFFE (WAVE_FORMAT_EXTENSIBLE) also carries 16-bit PCM
			// in practice for this engine family; anything else is unsupported.
			(audioFormat !== 1 && audioFormat !== 0xfffe) ||
			bitsPerSample !== 16
		) {
			return null;
		}
		const frameBytes = numChannels * 2;
		const frameCount = Math.floor(dataSize / frameBytes);
		if (frameCount <= 0) return null;
		const samples = new Int16Array(frameCount);
		for (let i = 0; i < frameCount; i++) {
			let sum = 0;
			for (let ch = 0; ch < numChannels; ch++) {
				sum += view.getInt16(dataOffset + i * frameBytes + ch * 2, true);
			}
			samples[i] = Math.max(
				-0x8000,
				Math.min(0x7fff, Math.round(sum / numChannels)),
			);
		}
		return { samples, sampleRate };
	} catch {
		return null;
	}
}
