/**
 * Sequential audio playback queue for pipeline voice.
 *
 * Queues MP3 base64 chunks and plays them in order.
 * Supports interrupt (clear all), avatar speaking state,
 * and ordered enqueue for out-of-order TTS responses.
 */

import { Logger } from "../logger";
import { effectivePreRollSeconds } from "../tts/voice-playback-mode";

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

export class AudioQueue {
	private queue: AudioQueueItem[] = [];
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
		if (this.playing) {
			this.playing = false;
			this.callbacks.onPlaybackEnd?.();
		}
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
		let nextStart = 0;
		let started = false;
		let advanced = false;
		let pending = 0;
		let ended = false;
		// FR-VOICE.22 gap-review-2 (2026-09-25) — snapshot BEFORE subscribe():
		// subscribe() synchronously replays every chunk already sitting in
		// `stream.chunks` (and fires the end callback immediately if the
		// stream already ended), so by the time the first chunk handler below
		// runs, `stream.chunks`/`stream.ended` may already reflect the FULL
		// sentence. We need the pre-turn snapshot, not the post-replay state,
		// to know how much of the requested pre-roll is already satisfied.
		const initialBufferedSeconds =
			stream.chunks.reduce((sum, c) => sum + c.length, 0) /
			(stream.sampleRate || 1);
		const initialEnded = stream.ended;
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
				// 40 ms lead on the very first chunk absorbs scheduling jitter;
				// startDelaySeconds (FR-VOICE.22 pre-roll) can push that lead out
				// further when "auto" judged the engine only slightly slower than
				// realtime. gap-review-2: that extra lead is only what's still
				// missing after subtracting what had already buffered by this
				// stream's turn (synthesis kept running while the previous
				// sentence played) — zero once the sentence is fully synthesized.
				const effectiveDelay = effectivePreRollSeconds(
					stream.startDelaySeconds,
					initialBufferedSeconds,
					stream.expectedDurationSeconds,
					initialEnded,
				);
				const firstChunkLead = Math.max(0.04, effectiveDelay);
				const at = Math.max(now + (started ? 0 : firstChunkLead), nextStart);
				src.start(at);
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
					const leadMs = Math.max(0, (at - now) * 1000);
					const fireStart = () => {
						this.pendingStartTimers.delete(timer);
						if (!isCurrent()) return;
						item.onPlaybackStart?.();
						if (!wasPlaying) this.callbacks.onPlaybackStart?.();
					};
					const timer =
						leadMs > 0
							? setTimeout(fireStart, leadMs)
							: setTimeout(fireStart, 0);
					this.pendingStartTimers.add(timer);
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
	}

	private playNext(): void {
		if (this.queue.length === 0) {
			Logger.debug("AudioQueue", "playNext:empty → end", {});
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

		audio.onplay = () => {
			if (!isCurrent()) return;
			started = true;
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
