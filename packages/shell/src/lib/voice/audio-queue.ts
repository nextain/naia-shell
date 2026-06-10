/**
 * Sequential audio playback queue for pipeline voice.
 *
 * Queues MP3 base64 chunks and plays them in order.
 * Supports interrupt (clear all), avatar speaking state,
 * and ordered enqueue for out-of-order TTS responses.
 */

import { Logger } from "../logger";

export interface AudioQueueCallbacks {
	onPlaybackStart?: () => void;
	onPlaybackEnd?: () => void;
	/** Audio output device ID (from enumerateDevices). Applied via setSinkId. */
	outputDeviceId?: string;
}

export class AudioQueue {
	private queue: string[] = [];
	private current: HTMLAudioElement | null = null;
	private playing = false;
	private callbacks: AudioQueueCallbacks;

	// Ordered enqueue: buffer out-of-order items until their turn
	private nextExpectedSeq = 0;
	private pendingOrdered: Map<number, string> = new Map();

	constructor(callbacks: AudioQueueCallbacks = {}) {
		this.callbacks = callbacks;
	}

	/** Add MP3 base64 audio to the queue. Starts playback if idle. */
	enqueue(mp3Base64: string): void {
		this.queue.push(mp3Base64);
		if (!this.playing) {
			this.playNext();
		}
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
	enqueueOrdered(seq: number, mp3Base64: string): void {
		this.pendingOrdered.set(seq, mp3Base64);
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
			const mp3 = this.pendingOrdered.get(this.flushCursor)!;
			this.pendingOrdered.delete(this.flushCursor);
			this.flushCursor++;
			this.enqueue(mp3);
		}
	}

	/** Stop current playback and clear all queued audio. */
	clear(): void {
		this.queue = [];
		this.pendingOrdered.clear();
		this.flushCursor = 0;
		this.nextExpectedSeq = 0;
		if (this.current) {
			this.current.pause();
			this.current.src = "";
			this.current = null;
		}
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

	private playNext(): void {
		if (this.queue.length === 0) {
			this.playing = false;
			this.callbacks.onPlaybackEnd?.();
			return;
		}

		const mp3Base64 = this.queue.shift()!;
		const wasPlaying = this.playing;
		this.playing = true;

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

		audio.onplay = () => {
			// Only fire onPlaybackStart for the first chunk in a sequence
			if (!wasPlaying) {
				this.callbacks.onPlaybackStart?.();
			}
		};

		audio.onended = () => {
			this.current = null;
			this.playNext();
		};

		audio.onerror = (e) => {
			Logger.warn("AudioQueue", "Audio playback error", { error: String(e) });
			this.current = null;
			this.playNext();
		};

		audio.play().catch((err) => {
			Logger.warn("AudioQueue", "Audio play rejected", { error: String(err) });
			this.current = null;
			this.playNext();
		});
	}
}
