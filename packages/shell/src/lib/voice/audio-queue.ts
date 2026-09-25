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

/**
 * gap-review-8 (2026-09-25) 구멍 5-2: AudioContext.resume() 대기 시간 제한(ms).
 * 브라우저나 OS 사운드 장치가 resume() 프로미스를 영영 완료하지 않는 경우
 * 대기열이 영구 정지(deadlock)되는 문제를 방지하기 위한 안전 타임아웃 fallback.
 */
export const AUDIO_CONTEXT_RESUME_TIMEOUT_MS = 2500;

/**
 * VL-3 구멍 1: 스트림이 ended 된 후 AudioContext 가 suspended 상태일 때
 * running 전환을 기다리는 최대 대기 시간(ms). 5초 안에 running 이 되지 않으면
 * 경고 로그를 남기고 해당 문장을 건너뛰어 다음 항목으로 진행한다.
 */
export const SUSPENDED_ENDED_STREAM_MAX_WAIT_MS = 5000;

/** Earliest a stream item can start after the one before it (first-chunk lead). */
const STREAM_MIN_START_LEAD_SEC = 0.04;

/** Reads the level of what the queue is playing, on that item's own clock. */
interface LevelReader {
	level(): number | null;
	around(query: LevelsAroundQuery): LevelsAround | null;
	rebindNext?(next: AudioQueueItem | null): void;
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
	/**
	 * Whether the response stream is still active (conversation is ongoing).
	 * While true, an empty queue is NOT treated as final silence (the 400ms
	 * audible hold is preserved between sentences).
	 */
	isResponseActive?: () => boolean;
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
	/** VL-3 구멍 1: suspended 대기 관련 리스너 및 타이머 정리 콜백 */
	private cancelStreamResumeListeners: (() => void) | null = null;
	/** VL-3 구멍 2: HTMLAudioElement 폴링/리스너 정리 콜백 */
	private cancelMediaAudiblePoll: (() => void) | null = null;
	/** VL-3 구멍 3: 직전 재생 항목 타입 추적 */
	private lastPlaybackType: "stream" | "media" | null = null;
	/** VL-4 구멍 2: 실제 재생 시작 시에만 1씩 증가하는 재생 일련번호 */
	private playbackSeq = 0;

	/**
	 * gap-review-8 hole 2: `true` is reported at once; `false` only after
	 * `AUDIBLE_OFF_HOLD_MS` of continued silence (plus the device latency, the
	 * sound already sent keeps playing that long). Anything audible again in
	 * that time cancels it, so an item boundary with the next item ready, a
	 * breath, or a slightly late chunk never flips the signal.
	 */
	private setAudible(value: boolean, includeLatency = true): void {
		if (value) {
			this.cancelAudibleOff();
			if (this.audible) return;
			this.audible = true;
			this.callbacks.onAudibleChange?.(true);
			return;
		}
		if (!this.audible || this.audibleOffTimer !== null) return;
		this.armAudibleOff(AUDIBLE_OFF_HOLD_MS, includeLatency);
	}

	/** Nothing more will play: report false once the last sound has left the speaker. */
	private endAudible(includeLatency = true): void {
		if (!this.audible) return;
		this.cancelAudibleOff();
		this.armAudibleOff(0, includeLatency);
	}

	/** Playback was cut: nothing is heard any more. */
	private silenceAudibleNow(): void {
		this.cancelAudibleOff();
		if (!this.audible) return;
		this.audible = false;
		this.callbacks.onAudibleChange?.(false);
	}

	private armAudibleOff(holdMs: number, includeLatency = true): void {
		const latencyMs = includeLatency
			? outputLatencySeconds(sharedAudioContext) * 1000
			: 0;
		const delayMs = holdMs + latencyMs;
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
		if (this.cancelStreamResumeListeners) {
			this.cancelStreamResumeListeners();
			this.cancelStreamResumeListeners = null;
		}
		if (this.cancelMediaAudiblePoll) {
			this.cancelMediaAudiblePoll();
			this.cancelMediaAudiblePoll = null;
		}
		this.lastPlaybackType = null;
		this.generation++;
		this.queue = [];
		this.playbackPaused = false;
		this.responseActive = false;
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

	private responseActive = false;

	/** Mark whether the response stream is currently ongoing. */
	setResponseActive(active: boolean): void {
		this.responseActive = active;
	}

	private isResponseActive(): boolean {
		if (this.callbacks.isResponseActive?.()) return true;
		return this.responseActive;
	}

	/**
	 * Nothing queued, nothing held for ordering, and every reserved slot
	 * already flushed: no sentence is waiting or being synthesized. The time
	 * after the audio still playing is then real silence (review hole 5).
	 *
	 * When the conversational response stream is still active (LLM is still
	 * generating text and the next sentence hasn't been reserved yet),
	 * we do NOT skip the 400ms hold — only when the response has fully ended
	 * is the time past the audio treated as real silence.
	 */
	private nothingQueued(): boolean {
		if (this.isResponseActive()) return false;
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
			rebindNext: (newNext: AudioQueueItem | null) => {
				before?.rebindNext?.(newNext);
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
		let currentNext = next;
		return {
			level: () => envelopeLevelAt(envelope, duration + audibleSinceEnd()),
			around: (query) => {
				const now = duration + audibleSinceEnd();
				const blocks: LevelBlock[] = [{ start: 0, envelope }];
				const after = this.withUpcoming(
					blocks,
					currentNext,
					Math.max(duration, now),
				);
				return levelsAround(
					blocks,
					now + query.leadSec * rate,
					query.backSec,
					query.aheadSec,
					after,
					rate,
				);
			},
			rebindNext: (newNext: AudioQueueItem | null) => {
				currentNext = newNext;
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
		let firstScheduledAt = 0;
		let lastScheduledEnd = 0;
		let started = false;
		let advanced = false;
		let pending = 0;
		let ended = false;
		// gap-review-3 (2026-09-25): the timer that will fire `onPlaybackStart`
		// once the first chunk's scheduled `at` arrives.
		let startTimer: ReturnType<typeof setTimeout> | null = null;
		let fireStart: (() => void) | null = null;
		// gap-review-7 (2026-09-25) 구멍 5-1: 실제 스피커에서 소리가 나는 시각 타이머.
		let audibleTimer: ReturnType<typeof setTimeout> | null = null;
		let fireAudible: (() => void) | null = null;
		let resumeTimer: ReturnType<typeof setTimeout> | null = null;
		let suspendedWaitTimer: ReturnType<typeof setTimeout> | null = null;
		let stateChangeListener: (() => void) | null = null;
		const eventTarget = ctx as unknown as EventTarget;

		const cleanupResumeListeners = () => {
			if (resumeTimer !== null) {
				clearTimeout(resumeTimer);
				resumeTimer = null;
			}
			if (suspendedWaitTimer !== null) {
				clearTimeout(suspendedWaitTimer);
				suspendedWaitTimer = null;
			}
			if (
				stateChangeListener !== null &&
				typeof eventTarget?.removeEventListener === "function"
			) {
				eventTarget.removeEventListener("statechange", stateChangeListener);
				stateChangeListener = null;
			}
			if (this.cancelStreamResumeListeners === cleanupResumeListeners) {
				this.cancelStreamResumeListeners = null;
			}
		};
		this.cancelStreamResumeListeners = cleanupResumeListeners;

		const isCurrent = () =>
			generation === this.generation && this.currentStream === stream;
		const advance = () => {
			cleanupResumeListeners();
			if (!isCurrent() || advanced) return;
			advanced = true;

			// VL-review1 시계 부류: 소리 버퍼가 출력 지연보다 짧아 들림 타이머가 아직
			// 대기 중일 때, 끝나는 순간 즉시 들림을 켜지 말고 실제로 들리는 시각
			// (스케줄 시각 + 출력 지연)에 켜고 그 뒤 소리가 끝나는 시각에 끄도록 한다.
			// 입이 소리보다 먼저 열리는 것을 원천 방지한다.
			const lat = outputLatencySeconds(ctx);
			const now = ctx.currentTime;
			const leadRemainMs = Math.round(
				Math.max(0, (firstScheduledAt - now + lat) * 1000),
			);
			const endRemainMs = Math.round(
				Math.max(0, (lastScheduledEnd - now + lat) * 1000),
			);
			const currentPlaybackSeq = this.playbackSeq;

			// gap-review-3: onPlaybackStart 알림은 소스가 렌더링을 마쳤을 때 즉시 통지한다.
			if (startTimer !== null) {
				clearTimeout(startTimer);
				this.pendingStartTimers.delete(startTimer);
				startTimer = null;
				fireStart?.();
			}

			// VL-review1 시계 부류: 소리 버퍼가 출력 지연보다 짧아 들림 타이머가 아직
			// 대기 중일 때, 끝나는 순간 즉시 들림을 켜지 말고 실제로 들리는 시각
			// (스케줄 시각 + 출력 지연)에 켜고 그 뒤 소리가 끝나는 시각에 끄도록 한다.
			// 입이 소리보다 먼저 열리는 것을 원천 방지한다.
			let shouldTurnAudibleOn = false;
			if (audibleTimer !== null) {
				clearTimeout(audibleTimer);
				this.pendingStartTimers.delete(audibleTimer);
				audibleTimer = null;
				if (leadRemainMs > 0) {
					const delayedOn = setTimeout(() => {
						this.pendingStartTimers.delete(delayedOn);
						if (generation !== this.generation) return;
						if (this.playbackSeq !== currentPlaybackSeq) return;
						this.setAudible(true);
					}, leadRemainMs);
					this.pendingStartTimers.add(delayedOn);

					const offDelay = Math.max(leadRemainMs, endRemainMs);
					const delayedOff = setTimeout(() => {
						this.pendingStartTimers.delete(delayedOff);
						if (generation !== this.generation) return;
						if (this.playbackSeq !== currentPlaybackSeq) return;
						if (this.nothingQueued() && !this.playing) {
							this.silenceAudibleNow();
						} else {
							// VL-3 구멍 3: 이미 lat를 더해 예약한 끄기는 출력 지연을 다시 더하지 않고 400ms 유지만 적용
							this.setAudible(false, false);
						}
					}, offDelay);
					this.pendingStartTimers.add(delayedOff);
				} else {
					if (endRemainMs > 0) {
						shouldTurnAudibleOn = true;
						const delayedOff = setTimeout(() => {
							this.pendingStartTimers.delete(delayedOff);
							if (generation !== this.generation) return;
							if (this.playbackSeq !== currentPlaybackSeq) return;
							if (this.nothingQueued() && !this.playing) {
								this.silenceAudibleNow();
							} else {
								// VL-3 구멍 3: 이미 lat를 더해 예약한 끄기는 출력 지연을 다시 더하지 않고 400ms 유지만 적용
								this.setAudible(false, false);
							}
						}, endRemainMs);
						this.pendingStartTimers.add(delayedOff);
					} else {
						this.setAudible(false, false);
					}
				}
			} else {
				if (this.audible && endRemainMs > 0) {
					const delayedOff = setTimeout(() => {
						this.pendingStartTimers.delete(delayedOff);
						if (generation !== this.generation) return;
						if (this.playbackSeq !== currentPlaybackSeq) return;
						if (this.nothingQueued() && !this.playing) {
							this.silenceAudibleNow();
						} else {
							// VL-3 구멍 3: 이미 lat를 더해 예약한 끄기는 출력 지연을 다시 더하지 않고 400ms 유지만 적용
							this.setAudible(false, false);
						}
					}, endRemainMs);
					this.pendingStartTimers.add(delayedOff);
				} else {
					this.setAudible(false, false);
				}
			}

			stream.unsubscribe();
			this.currentStream = null;
			this.currentStreamItem = null;
			this.playNext();
			if (shouldTurnAudibleOn && generation === this.generation) {
				this.setAudible(true);
			}
		};
		const maybeFinish = () => {
			if (ended && pending === 0 && pendingChunks.length === 0) advance();
		};

		// VL-review1 경합 부류: 컨텍스트가 suspended 상태일 때 들어온 청크를 보관.
		// 타임아웃이 지나도 컨텍스트가 아직 suspended 이면 멈춘 시계(currentTime)로
		// src.start 나 setTimeout(fireAudible)을 걸지 않고, 실제로 running 상태로
		// 재개된 뒤의 시계로 시작 시각과 입 타이머를 잡는다.
		const pendingChunks: Array<{
			chunk: Int16Array;
			buf: AudioBuffer;
			ch: Float32Array;
			src: AudioBufferSourceNode;
		}> = [];

		const skipSuspendedSentence = () => {
			cleanupResumeListeners();
			if (!isCurrent()) return;
			Logger.warn(
				"AudioQueue",
				"playStream: suspended context wait timeout, skipping sentence",
				{
					generation,
					pendingChunks: pendingChunks.length,
					streamSources: this.streamSources.size,
				},
			);
			for (const src of this.streamSources) {
				try {
					src.stop();
				} catch {
					/* already stopped */
				}
				try {
					if (typeof src.disconnect === "function") {
						src.disconnect();
					}
				} catch {
					/* ignore */
				}
			}
			this.streamSources.clear();
			pendingChunks.length = 0;
			if (audibleTimer !== null) {
				clearTimeout(audibleTimer);
				this.pendingStartTimers.delete(audibleTimer);
				audibleTimer = null;
			}
			if (startTimer !== null) {
				clearTimeout(startTimer);
				this.pendingStartTimers.delete(startTimer);
				startTimer = null;
			}
			this.silenceAudibleNow();
			item.onPlaybackUnavailable?.();
			advance();
		};

		const cancelSuspendedWaitTimer = () => {
			if (suspendedWaitTimer !== null) {
				clearTimeout(suspendedWaitTimer);
				suspendedWaitTimer = null;
			}
		};

		const armSuspendedWaitTimer = () => {
			if (
				suspendedWaitTimer !== null ||
				ctx.state === "running" ||
				!isCurrent()
			)
				return;
			suspendedWaitTimer = setTimeout(() => {
				suspendedWaitTimer = null;
				if (!isCurrent()) return;
				if (ctx.state !== "running") {
					skipSuspendedSentence();
				}
			}, SUSPENDED_ENDED_STREAM_MAX_WAIT_MS);
		};

		const scheduleChunk = (
			_chunk: Int16Array,
			buf: AudioBuffer,
			ch: Float32Array,
			src: AudioBufferSourceNode,
		) => {
			const now = ctx.currentTime;
			const isFirst = !started;
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
			if (isFirst) firstScheduledAt = at;
			nextStart = at + buf.duration;
			lastScheduledEnd = nextStart;

			// Level envelope on the same clock as `at` (after pre-roll and
			// after resume — beginSubscribe runs only once the context runs).
			this.streamLevels.add(at, rmsEnvelope(ch, stream.sampleRate));
			this.currentStreamScheduled = true;
			const wasSilent = pending === 0;
			pending++;
			this.streamSources.add(src);
			src.onended = () => {
				this.streamSources.delete(src);
				pending--;
				if (!isCurrent()) return;
				if (pending === 0 && !ended) this.setAudible(false);
				maybeFinish();
			};

			const audibleLeadMs = Math.round(
				Math.max(0, (at - now + outputLatencySeconds(ctx)) * 1000),
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
				this.playbackSeq++;
				this.lastPlaybackType = "stream";
				this.startLevel(this.streamReader(ctx));
				Logger.debug("AudioQueue", "playStream:first chunk scheduled", {
					at: Number(at.toFixed(3)),
					now: Number(now.toFixed(3)),
					ctxState: ctx.state,
					effectiveDelay: Number(effectiveDelay.toFixed(3)),
				});
				const leadMs = audibleLeadMs;
				fireStart = () => {
					if (startTimer !== null) this.pendingStartTimers.delete(startTimer);
					startTimer = null;
					if (!isCurrent()) return;
					item.onPlaybackStart?.();
					if (!wasPlaying) this.callbacks.onPlaybackStart?.();
				};
				startTimer =
					leadMs > 0 ? setTimeout(fireStart, leadMs) : setTimeout(fireStart, 0);
				this.pendingStartTimers.add(startTimer);
			}
		};

		const flushPendingChunksIfRunning = () => {
			if (!isCurrent() || ctx.state !== "running") return;
			cancelSuspendedWaitTimer();
			while (pendingChunks.length > 0) {
				const p = pendingChunks.shift();
				if (!p) break;
				scheduleChunk(p.chunk, p.buf, p.ch, p.src);
			}
			maybeFinish();
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

					if (ctx.state === "running") {
						scheduleChunk(chunk, buf, ch, src);
					} else {
						// Context is suspended: do not schedule with stopped clock.
						// Keep source ready so queue is not blocked, but hold start until real resume.
						pendingChunks.push({ chunk, buf, ch, src });
					}
				},
				() => {
					if (!isCurrent()) return;
					ended = true;
					Logger.debug("AudioQueue", "playStream:source ended", {
						pending,
						started,
						pendingChunks: pendingChunks.length,
					});
					if (!started && pendingChunks.length === 0 && pending === 0) {
						// Nothing arrived (failed/empty synthesis): release the slot.
						this.levelReader?.rebindNext?.(this.queue[0] ?? null);
						item.onPlaybackUnavailable?.();
						advance();
						return;
					}
					if (ctx.state !== "running" && pendingChunks.length > 0) {
						armSuspendedWaitTimer();
					}
					maybeFinish();
				},
			);
		};

		let subscribed = false;

		const handleStateChange = () => {
			if (!isCurrent()) return;
			if (ctx.state === "running") {
				if (resumeTimer !== null) {
					clearTimeout(resumeTimer);
					resumeTimer = null;
				}
				if (!subscribed) {
					subscribed = true;
					beginSubscribe();
				}
				cancelSuspendedWaitTimer();
				flushPendingChunksIfRunning();
			} else {
				if (subscribed) {
					armSuspendedWaitTimer();
				}
			}
		};

		if (typeof eventTarget?.addEventListener === "function") {
			stateChangeListener = handleStateChange;
			eventTarget.addEventListener("statechange", stateChangeListener);
		}

		if (ctx.state !== "running") {
			Logger.debug("AudioQueue", "playStream:awaiting resume", {
				ctxState: ctx.state,
			});
			const onReady = () => {
				if (resumeTimer !== null) {
					clearTimeout(resumeTimer);
					resumeTimer = null;
				}
				if (!isCurrent()) return;
				if (!subscribed) {
					subscribed = true;
					beginSubscribe();
				}
				if (ctx.state === "running") {
					cancelSuspendedWaitTimer();
					flushPendingChunksIfRunning();
				}
			};
			resumeTimer = setTimeout(onReady, AUDIO_CONTEXT_RESUME_TIMEOUT_MS);
			void ctx
				.resume()
				.catch(() => {})
				.then(onReady);
		} else {
			subscribed = true;
			beginSubscribe();
		}
	}

	private playNext(): void {
		if (this.queue.length === 0) {
			Logger.debug("AudioQueue", "playNext:empty → end", {});
			// Nothing waiting or being synthesized: the voice has ended, the
			// speaking signal goes off with the last sound (no hold).
			if (this.nothingQueued()) {
				const includeLatency = this.lastPlaybackType !== "media";
				this.endAudible(includeLatency);
			}
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
		let audibleStarted = false;
		let unavailableSignaled = false;
		let advanced = false;
		let mediaAudiblePollTimer: ReturnType<typeof setInterval> | null = null;
		let timeUpdateListener: (() => void) | null = null;

		const priorLevelReader = this.levelReader;
		const rebindPriorLevelOnSkip = () => {
			if (priorLevelReader) {
				this.levelReader = priorLevelReader;
				this.levelReader.rebindNext?.(this.queue[0] ?? null);
			} else {
				this.stopLevel();
			}
		};

		const markAudibleStarted = () => {
			if (audibleStarted) return;
			audibleStarted = true;
			this.playbackSeq++;
			this.lastPlaybackType = "media";
		};

		const cancelMediaPoll = () => {
			if (mediaAudiblePollTimer !== null) {
				clearInterval(mediaAudiblePollTimer);
				mediaAudiblePollTimer = null;
			}
			if (
				timeUpdateListener !== null &&
				typeof audio.removeEventListener === "function"
			) {
				audio.removeEventListener("timeupdate", timeUpdateListener);
				timeUpdateListener = null;
			}
			if (this.cancelMediaAudiblePoll === cancelMediaPoll) {
				this.cancelMediaAudiblePoll = null;
			}
		};
		this.cancelMediaAudiblePoll = cancelMediaPoll;

		const checkAudibleStarted = () => {
			if (!isCurrent()) {
				cancelMediaPoll();
				return;
			}
			if ((audio.currentTime || 0) > 0) {
				cancelMediaPoll();
				markAudibleStarted();
				this.setAudible(true);
			}
		};

		const isCurrent = () =>
			generation === this.generation && this.current === audio;
		const signalUnavailable = () => {
			if (!isCurrent() || started || unavailableSignaled) return;
			unavailableSignaled = true;
			item.onPlaybackUnavailable?.();
		};
		const advance = () => {
			cancelMediaPoll();
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
			// VL-3: 미디어 경로에서는 웹 오디오 출력 지연을 쓰지 않고,
			// audio.currentTime > 0 을 조회해 처음 0을 넘은 때에 입 신호를 켠다.
			if ((audio.currentTime || 0) > 0) {
				markAudibleStarted();
				this.setAudible(true);
			} else {
				cancelMediaPoll();
				this.cancelMediaAudiblePoll = cancelMediaPoll;
				timeUpdateListener = checkAudibleStarted;
				if (typeof audio.addEventListener === "function") {
					audio.addEventListener("timeupdate", timeUpdateListener);
				}
				mediaAudiblePollTimer = setInterval(checkAudibleStarted, 10);
			}
		};

		audio.onended = () => {
			cancelMediaPoll();
			if (!isCurrent()) return;
			if ((audio.currentTime || 0) > 0) {
				markAudibleStarted();
			}
			if (audibleStarted) {
				if (envelope) {
					const rate =
						Number.isFinite(audio.playbackRate) && audio.playbackRate > 0
							? audio.playbackRate
							: 1;
					this.startLevel(
						this.gapReader(envelope, rate, this.queue[0] ?? null),
					);
				}
				// VL-3: 미디어 경로 끄기는 출력 지연을 빼고 400ms 유지만 적용
				// VL-6: 소리가 실제로 시작된 경우에만 입 끄기를 실행
				this.setAudible(false, false);
			} else {
				rebindPriorLevelOnSkip();
			}
			advance();
		};

		audio.onerror = (e) => {
			cancelMediaPoll();
			if (!isCurrent()) return;
			Logger.warn("AudioQueue", "Audio playback error", { error: String(e) });
			// VL-6: 소리가 실제로 시작된 경우에만 입 끄기를 실행
			if (audibleStarted) {
				this.setAudible(false, false);
			} else {
				rebindPriorLevelOnSkip();
			}
			signalUnavailable();
			advance();
		};

		audio.play().catch((err) => {
			cancelMediaPoll();
			if (!isCurrent()) return;
			Logger.warn("AudioQueue", "Audio play rejected", { error: String(err) });
			if (!audibleStarted) {
				rebindPriorLevelOnSkip();
			}
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
