/**
 * Sequential audio playback queue for pipeline voice.
 *
 * Queues MP3 base64 chunks and plays them in order.
 * Supports interrupt (clear all), avatar speaking state,
 * and ordered enqueue for out-of-order TTS responses.
 */

import { Logger } from "../logger";
import {
	VOICE_LEVEL_WINDOW_SEC,
	type VoiceLevelSource,
	VoiceLevelTimeline,
	releaseVoiceLevelSource,
	rmsEnvelope,
	setActiveVoiceLevelSource,
	wavEnvelope,
} from "./voice-level";

export interface AudioQueueCallbacks {
	onPlaybackStart?: () => void;
	onPlaybackEnd?: () => void;
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
	wholeAudioBase64: string | null = null;
	ended = false;
	failed = false;
	private onChunk: ((chunk: Int16Array) => void) | null = null;
	private onEnd: (() => void) | null = null;
	constructor(public sampleRate = 24000) {}
	/** Host answered one whole WAV/MP3 instead of PCM chunks: close the stream and let the queue play this audio in the SAME ordered slot. */
	endWithAudio(audioBase64: string): void {
		if (this.ended) return;
		this.wholeAudioBase64 = audioBase64;
		this.end();
	}
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
	/** Reads the level of the item playing now (null = cannot measure, e.g. MP3). */
	private levelReader: (() => number | null) | null = null;
	/** Reads the level offsetSec ahead of playback (null = cannot measure or unbuffered). */
	private levelAheadReader: ((offsetSec: number) => number | null) | null =
		null;
	/** Envelope of streamed PCM chunks on the shared AudioContext clock. */
	private streamLevels = new VoiceLevelTimeline();
	private current: HTMLAudioElement | null = null;
	private currentStream: PcmStreamSource | null = null;
	private streamSources = new Set<AudioBufferSourceNode>();
	private playing = false;
	private playbackPaused = false;
	private generation = 0;
	private callbacks: AudioQueueCallbacks;
	private streamEnvelopeCache = new WeakMap<
		PcmStreamSource,
		{ chunkCount: number; envelope: Float32Array; durationSec: number }
	>();
	private wavItemCache = new WeakMap<
		AudioQueueItem,
		{ envelope: Float32Array; durationSec: number } | null
	>();
	private streamWholeAudioCache = new WeakMap<
		PcmStreamSource,
		{ envelope: Float32Array; durationSec: number } | null
	>();

	// Ordered enqueue: buffer out-of-order items until their turn.
	// A `null` value marks a reserved slot whose synthesis failed / fell back —
	// it advances the cursor without playing, so later seqs don't stall.
	private nextExpectedSeq = 0;
	private pendingOrdered: Map<number, AudioQueueItem | null> = new Map();

	// FR-SLIDES-PAGE-GAP.1: earliest time (performance.now) the next idle start
	// may begin playing. 0 = no hold. Cleared by clear() (pause, page move, stop).
	private holdUntil = 0;
	private holdTimer: ReturnType<typeof setTimeout> | null = null;

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

	/**
	 * Do not START playback before `atMs` (performance.now clock). Audio that
	 * is ready earlier waits until then; audio that is ready later plays at
	 * once, so the start time is max(atMs, audio ready). Only an idle queue is
	 * held — an item already playing is never delayed. clear() cancels it.
	 */
	holdPlaybackUntil(atMs: number): void {
		this.clearHold();
		this.holdUntil = atMs;
	}

	private clearHold(): void {
		if (this.holdTimer !== null) {
			clearTimeout(this.holdTimer);
			this.holdTimer = null;
		}
		this.holdUntil = 0;
	}

	/** True while an idle start must still wait; arms one timer to retry. */
	private waitingForHold(): boolean {
		if (this.holdUntil === 0) return false;
		const waitMs = this.holdUntil - performance.now();
		if (waitMs <= 0) {
			this.clearHold();
			return false;
		}
		if (this.holdTimer === null) {
			const generation = this.generation;
			this.holdTimer = setTimeout(() => {
				this.holdTimer = null;
				if (generation !== this.generation) return;
				this.holdUntil = 0;
				if (!this.playing && !this.playbackPaused && this.queue.length > 0) {
					this.playNext();
				}
			}, waitMs);
		}
		return true;
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
		this.clearHold();
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
		for (const src of this.streamSources) {
			try {
				src.stop();
			} catch {
				/* already stopped */
			}
		}
		this.streamSources.clear();
		this.streamEnvelopeCache = new WeakMap();
		this.wavItemCache = new WeakMap();
		this.streamWholeAudioCache = new WeakMap();
		this.stopLevel();
		if (this.playing) {
			this.playing = false;
			this.callbacks.onPlaybackEnd?.();
		}
	}

	/** RMS of the audio this queue is playing now, or null when unknown. */
	voiceLevel(): number | null {
		return this.levelReader ? this.levelReader() : null;
	}

	/** RMS of the audio offsetSec ahead of playback, or null when unknown. */
	voiceLevelAhead(offsetSec: number): number | null {
		return this.levelAheadReader ? this.levelAheadReader(offsetSec) : null;
	}

	private startLevel(
		reader: () => number | null,
		aheadReader?: (offsetSec: number) => number | null,
	): void {
		this.levelReader = reader;
		this.levelAheadReader = aheadReader ?? null;
		setActiveVoiceLevelSource(this);
	}

	private stopLevel(): void {
		this.levelReader = null;
		this.levelAheadReader = null;
		this.streamLevels.clear();
		releaseVoiceLevelSource(this);
	}

	/** Whether audio is currently playing or queued. */
	get isActive(): boolean {
		return this.playing || this.queue.length > 0;
	}

	/** Destroy the queue and release resources. */
	destroy(): void {
		this.clear();
	}

	private getStreamEnvelope(stream: PcmStreamSource): {
		chunkCount: number;
		envelope: Float32Array;
		durationSec: number;
	} {
		const cached = this.streamEnvelopeCache.get(stream);
		if (cached && cached.chunkCount === stream.chunks.length) {
			return cached;
		}

		let totalSamples = 0;
		for (const chunk of stream.chunks) {
			totalSamples += chunk.length;
		}

		const samples = new Int16Array(totalSamples);
		let offset = 0;
		for (const chunk of stream.chunks) {
			samples.set(chunk, offset);
			offset += chunk.length;
		}

		const envelope = rmsEnvelope(
			samples,
			stream.sampleRate,
			VOICE_LEVEL_WINDOW_SEC,
			1 / 0x8000,
		);
		const durationSec =
			stream.sampleRate > 0 ? totalSamples / stream.sampleRate : 0;

		const result = {
			chunkCount: stream.chunks.length,
			envelope,
			durationSec,
		};
		this.streamEnvelopeCache.set(stream, result);
		return result;
	}

	private getItemWavEnvelope(
		item: AudioQueueItem,
		audioBase64: string,
	): { envelope: Float32Array; durationSec: number } | null {
		const cached = this.wavItemCache.get(item);
		if (cached !== undefined) {
			return cached;
		}
		const envelope = wavEnvelope(audioBase64);
		if (!envelope) {
			this.wavItemCache.set(item, null);
			return null;
		}
		const durationSec = envelope.length * VOICE_LEVEL_WINDOW_SEC;
		const result = { envelope, durationSec };
		this.wavItemCache.set(item, result);
		return result;
	}

	private getStreamWholeAudioEnvelope(stream: PcmStreamSource): {
		envelope: Float32Array;
		durationSec: number;
	} | null {
		const cached = this.streamWholeAudioCache.get(stream);
		if (cached !== undefined) {
			return cached;
		}
		const audioBase64 = stream.wholeAudioBase64;
		if (!audioBase64 || !audioBase64.startsWith("UklGR")) {
			this.streamWholeAudioCache.set(stream, null);
			return null;
		}
		const envelope = wavEnvelope(audioBase64);
		if (!envelope) {
			this.streamWholeAudioCache.set(stream, null);
			return null;
		}
		const durationSec = envelope.length * VOICE_LEVEL_WINDOW_SEC;
		const result = { envelope, durationSec };
		this.streamWholeAudioCache.set(stream, result);
		return result;
	}

	/**
	 * 다음 대기열 항목으로 이어 봄, 이유(문장 사이 쉼에서 입 닫힘 증가).
	 * 현재 항목 끝을 넘는 앞보기는 대기열의 다음 항목들로 이어서 답한다.
	 */
	private lookaheadQueue(overSec: number): number | null {
		let over = overSec;
		for (const item of this.queue) {
			if (item.stream) {
				const stream = item.stream;
				if (stream.chunks.length > 0) {
					const cached = this.getStreamEnvelope(stream);
					if (over < cached.durationSec) {
						const index = Math.floor(over / VOICE_LEVEL_WINDOW_SEC);
						return index >= 0 && index < cached.envelope.length
							? cached.envelope[index]
							: 0;
					}
					if (!stream.ended) {
						return null;
					}
					// chunks 가 있고 ended 이면 wholeAudioBase64 는 무시하고 PCM 초 길이를 빼고 다음 항목으로
					over -= cached.durationSec;
					continue;
				}

				// chunks 가 비어 있는 경우
				if (!stream.ended) {
					return null;
				}

				// stream.ended === true
				if (stream.wholeAudioBase64) {
					// ended 이고 chunks 가 비어 있고 wholeAudioBase64 가 있으면 WAV 항목과 같은 봉투 판정
					// (wavEnvelope 가 null 이면 null 을 돌려주고 뒤 항목으로 넘어가지 않음)
					const cached = this.getStreamWholeAudioEnvelope(stream);
					if (!cached) {
						return null;
					}
					if (over < cached.durationSec) {
						const index = Math.floor(over / VOICE_LEVEL_WINDOW_SEC);
						return index >= 0 && index < cached.envelope.length
							? cached.envelope[index]
							: 0;
					}
					over -= cached.durationSec;
					continue;
				}

				// ended 이고 둘 다 없으면(재생 안 되는 빈 문장) 길이 0 으로 보고 다음 항목으로
				continue;
			}

			// WAV 또는 MP3 등 일반 오디오 항목
			const audioBase64 = item.audioBase64 ?? "";
			if (audioBase64.startsWith("UklGR")) {
				const cached = this.getItemWavEnvelope(item, audioBase64);
				if (!cached) {
					return null;
				}
				if (over < cached.durationSec) {
					const index = Math.floor(over / VOICE_LEVEL_WINDOW_SEC);
					return index >= 0 && index < cached.envelope.length
						? cached.envelope[index]
						: 0;
				}
				over -= cached.durationSec;
				continue;
			}

			// MP3 등 봉투를 모르는 항목: null
			return null;
		}

		// 대기열이 끝났을 때: 예약만 되고 아직 대기열에 안 들어온 문장이 있으면 null, 없으면 0
		if (this.nextExpectedSeq > this.flushCursor) {
			return null;
		}
		return 0;
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
		let nextStart = 0;
		let started = false;
		let advanced = false;
		let pending = 0;
		let ended = false;
		const isCurrent = () =>
			generation === this.generation && this.currentStream === stream;
		const advance = () => {
			if (!isCurrent() || advanced) return;
			advanced = true;
			stream.unsubscribe();
			this.currentStream = null;
			this.playNext();
		};
		const maybeFinish = () => {
			if (ended && pending === 0) advance();
		};
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
				// 40 ms lead on the very first chunk absorbs scheduling jitter.
				const at = Math.max(now + (started ? 0 : 0.04), nextStart);
				src.start(at);
				this.streamLevels.add(at, rmsEnvelope(ch, stream.sampleRate));
				nextStart = at + buf.duration;
				pending++;
				this.streamSources.add(src);
				src.onended = () => {
					this.streamSources.delete(src);
					pending--;
					maybeFinish();
				};
				if (!started) {
					started = true;
					this.startLevel(
						() => this.streamLevels.levelAt(ctx.currentTime),
						(offsetSec: number) => {
							const time = ctx.currentTime + offsetSec;
							if (time > nextStart) {
								if (!stream.ended) return null;
								// 다음 대기열 항목으로 이어 봄, 이유(문장 사이 쉼에서 입 닫힘 증가)
								return this.lookaheadQueue(time - nextStart);
							}
							return this.streamLevels.peekLevelAt(time) ?? 0;
						},
					);
					Logger.debug("AudioQueue", "playStream:first chunk scheduled", {
						at: Number(at.toFixed(3)),
						now: Number(now.toFixed(3)),
						ctxState: ctx.state,
					});
					item.onPlaybackStart?.();
					if (!wasPlaying) this.callbacks.onPlaybackStart?.();
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
					if (stream.wholeAudioBase64) {
						if (!isCurrent() || advanced) return;
						advanced = true;
						stream.unsubscribe();
						this.currentStream = null;
						this.queue.unshift({
							audioBase64: stream.wholeAudioBase64,
							onPlaybackStart: item.onPlaybackStart,
							onPlaybackUnavailable: item.onPlaybackUnavailable,
						});
						this.playing = wasPlaying;
						this.playNext();
						return;
					}
					// Nothing arrived (failed/empty synthesis): release the slot.
					item.onPlaybackUnavailable?.();
					advance();
					return;
				}
				maybeFinish();
			},
		);
	}

	private playNext(): void {
		if (this.queue.length === 0) {
			Logger.debug("AudioQueue", "playNext:empty → end", {});
			this.stopLevel();
			this.playing = false;
			this.callbacks.onPlaybackEnd?.();
			return;
		}
		if (!this.playing && this.waitingForHold()) {
			Logger.debug("AudioQueue", "playNext:held for minimum gap", {
				queued: this.queue.length,
			});
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
		// 꺼낸 항목이 시작하기 전에는 앞 항목 클로저가 대기열에서 빠진 이 항목을 못 보므로 모름
		this.levelAheadReader = () => null;
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

		audio.onplay = () => {
			if (!isCurrent()) return;
			started = true;
			const envelope = isWav ? wavEnvelope(mp3Base64) : null;
			this.startLevel(
				() => {
					if (!envelope) return null;
					const index = Math.floor(
						(audio.currentTime || 0) / VOICE_LEVEL_WINDOW_SEC,
					);
					return index >= 0 && index < envelope.length ? envelope[index] : 0;
				},
				(offsetSec: number) => {
					if (!envelope) return null;
					const durationSec = envelope.length * VOICE_LEVEL_WINDOW_SEC;
					const time = (audio.currentTime || 0) + offsetSec;
					if (time >= durationSec) {
						// 다음 대기열 항목으로 이어 봄, 이유(문장 사이 쉼에서 입 닫힘 증가)
						return this.lookaheadQueue(time - durationSec);
					}
					const index = Math.floor(time / VOICE_LEVEL_WINDOW_SEC);
					return index >= 0 && index < envelope.length ? envelope[index] : 0;
				},
			);
			item.onPlaybackStart?.();
			// Only fire onPlaybackStart for the first chunk in a sequence
			if (!wasPlaying) {
				this.callbacks.onPlaybackStart?.();
			}
		};

		audio.onended = () => {
			advance();
		};

		audio.onerror = (e) => {
			Logger.warn("AudioQueue", "Audio playback error", { error: String(e) });
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
