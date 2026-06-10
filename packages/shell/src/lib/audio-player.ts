/**
 * Continuous PCM audio player for Gemini Live API responses.
 * Queues base64 PCM chunks (24kHz Int16 mono) and plays them seamlessly.
 */
import { Logger } from "./logger";

export interface AudioPlayer {
	enqueue: (base64Pcm: string) => void;
	clear: () => void;
	destroy: () => void;
	readonly isPlaying: boolean;
}

export interface AudioPlayerOptions {
	sampleRate?: number;
	onPlaybackStart?: () => void;
	onPlaybackEnd?: () => void;
}

/** Safety margin for physical speaker + DAC buffer drain after last scheduled sample. */
const SPEAKER_DRAIN_MARGIN_MS = 200;

export function createAudioPlayer(opts: AudioPlayerOptions = {}): AudioPlayer {
	const inputSampleRate = opts.sampleRate ?? 24000;
	// AudioContext({ sampleRate }) causes GStreamer CRITICAL in WebKitGTK.
	// Use default sampleRate and upsample in SW instead.
	const ctx = new AudioContext();
	Logger.debug("AudioPlayer", "created", {
		inputSampleRate,
		ctxSampleRate: ctx.sampleRate,
		state: ctx.state,
	});
	let nextStartTime = 0;
	let activeSourceCount = 0;
	let destroyed = false;
	const activeSources: Set<AudioBufferSourceNode> = new Set();

	function enqueue(base64Pcm: string) {
		if (destroyed) return;

		if (ctx.state === "suspended") {
			ctx.resume();
		}

		const bytes = base64ToUint8Array(base64Pcm);
		const int16 = new Int16Array(
			bytes.buffer,
			bytes.byteOffset,
			bytes.byteLength / 2,
		);
		const float32Raw = int16ToFloat32(int16);
		const float32 = upsample(float32Raw, inputSampleRate, ctx.sampleRate);

		const buffer = ctx.createBuffer(1, float32.length, ctx.sampleRate);
		buffer.getChannelData(0).set(float32);

		const source = ctx.createBufferSource();
		source.buffer = buffer;
		source.connect(ctx.destination);
		activeSources.add(source);

		const now = ctx.currentTime;
		const startAt = Math.max(now, nextStartTime);
		nextStartTime = startAt + buffer.duration;

		const wasIdle = activeSourceCount === 0;
		activeSourceCount++;
		if (wasIdle) {
			opts.onPlaybackStart?.();
		}

		source.onended = () => {
			activeSources.delete(source);
			activeSourceCount--;
			if (activeSourceCount <= 0) {
				activeSourceCount = 0;
				opts.onPlaybackEnd?.();
			}
		};

		source.start(startAt);
	}

	function clear() {
		const wasPlaying = activeSourceCount > 0;
		for (const src of activeSources) {
			try {
				src.stop();
			} catch {
				/* already stopped */
			}
		}
		activeSources.clear();
		nextStartTime = 0;
		activeSourceCount = 0;
		Logger.info("AudioPlayer", "cleared");
		if (wasPlaying) {
			opts.onPlaybackEnd?.();
		}
	}

	function destroy() {
		destroyed = true;
		clear();
		ctx.close().catch(() => {});
		Logger.info("AudioPlayer", "destroyed");
	}

	return {
		enqueue,
		clear,
		destroy,
		// Mic gate uses this; avatar visual uses onPlaybackEnd callback.
		// Staying true through the scheduled tail + drain margin keeps the mic
		// muted while the physical speaker is still emitting audio, preventing
		// the last ~200ms of playback from being captured as user input (echo loop).
		get isPlaying() {
			return (
				activeSourceCount > 0 ||
				(nextStartTime > 0 &&
					ctx.currentTime < nextStartTime + SPEAKER_DRAIN_MARGIN_MS / 1000)
			);
		},
	};
}

/** Linear interpolation resampling (Float32 mono). */
function upsample(
	input: Float32Array,
	fromRate: number,
	toRate: number,
): Float32Array {
	if (fromRate === toRate) return input;
	const ratio = fromRate / toRate;
	const outLen = Math.round(input.length / ratio);
	const output = new Float32Array(outLen);
	for (let i = 0; i < outLen; i++) {
		const src = i * ratio;
		const lo = Math.floor(src);
		const hi = Math.min(lo + 1, input.length - 1);
		const frac = src - lo;
		output[i] = input[lo] * (1 - frac) + input[hi] * frac;
	}
	return output;
}

function base64ToUint8Array(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function int16ToFloat32(int16: Int16Array): Float32Array {
	const float32 = new Float32Array(int16.length);
	for (let i = 0; i < int16.length; i++) {
		float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
	}
	return float32;
}
