/**
 * Microphone recorder for voice-reference capture (WebKitGTK-safe).
 *
 * Mirrors the api-stt capture pattern — default `AudioContext` (no sampleRate
 * constraint, which freezes WebKitGTK) + `ScriptProcessor`, with
 * echoCancellation / noiseSuppression / autoGainControl all OFF (WebKitGTK DSP
 * clips or freezes the stream otherwise). Unlike api-stt it does NOT stream to
 * an STT endpoint; it accumulates the whole take and returns a single
 * native-rate mono WAV `Blob`. That blob is handed to `encodeRefAudio()`, which
 * downmixes + resamples to the 16 kHz mono wire form the gateway expects.
 *
 * The gateway enforces the 5–30 s duration window server-side (before charge),
 * but callers should gate on `durationSeconds` first to avoid a pointless
 * round-trip.
 */
import { Logger } from "../logger";
import { encodeWav } from "./ref-audio";

const TAG = "ref-recorder";
const BUFFER_SIZE = 4096;

export interface RefRecording {
	/** Stop capture and return the take as a native-rate mono WAV blob. */
	stop: () => { blob: Blob; durationSeconds: number };
	/** Abort without producing a blob (releases mic + AudioContext). */
	cancel: () => void;
}

export interface RefRecorderOptions {
	/** Auto-stop ceiling in seconds — the recorder stops capturing at this length. */
	maxSeconds: number;
	/** RMS level (0..~1) per audio frame, for a live input meter. */
	onLevel?: (level: number) => void;
	/** Elapsed seconds (~per frame), for a timer / countdown. */
	onElapsed?: (seconds: number) => void;
	/** Fired once when the maxSeconds auto-stop ceiling is reached. */
	onAutoStop?: () => void;
}

/**
 * Begin recording. Resolves once the mic is live and capturing. Call
 * `stop()` to finalize into a WAV blob, or `cancel()` to discard.
 */
export async function startRefRecording(
	opts: RefRecorderOptions,
): Promise<RefRecording> {
	const stream = await navigator.mediaDevices.getUserMedia({
		// All DSP off — WebKitGTK autoGainControl/echoCancellation clip or freeze
		// the capture (same rationale as api-stt.ts). Ref voice wants the raw timbre.
		audio: {
			echoCancellation: false,
			noiseSuppression: false,
			autoGainControl: false,
		},
	});
	// No sampleRate constraint — WebKitGTK returns zeros at non-native rates.
	// encodeRefAudio() resamples the resulting blob to 16 kHz later.
	const ctx = new AudioContext();
	const sampleRate = ctx.sampleRate;
	const source = ctx.createMediaStreamSource(stream);
	const processor = ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);

	const chunks: Float32Array[] = [];
	let total = 0;
	let stopped = false;
	let autoStopFired = false;
	const maxSamples = Math.floor(opts.maxSeconds * sampleRate);

	let cleanedUp = false;
	const cleanup = () => {
		if (cleanedUp) return; // idempotent — auto-stop and stop()/cancel() share this
		cleanedUp = true;
		stopped = true;
		try {
			processor.disconnect();
		} catch {
			/* already disconnected */
		}
		try {
			source.disconnect();
		} catch {
			/* already disconnected */
		}
		ctx.close().catch(() => {});
		for (const t of stream.getTracks()) t.stop();
	};

	processor.onaudioprocess = (e) => {
		if (stopped) return;
		const raw = e.inputBuffer.getChannelData(0);
		// Copy — the inputBuffer is reused across callbacks.
		chunks.push(new Float32Array(raw));
		total += raw.length;

		if (opts.onLevel) {
			let sumSq = 0;
			for (let i = 0; i < raw.length; i++) sumSq += raw[i] * raw[i];
			opts.onLevel(Math.sqrt(sumSq / raw.length));
		}
		opts.onElapsed?.(total / sampleRate);

		if (total >= maxSamples && !autoStopFired) {
			autoStopFired = true;
			// Self-release the mic/context immediately; the buffered chunks survive
			// in the closure so a later stop() can still finalize them. Keeps the
			// recorder self-contained — no split-brain with the caller (#code-review).
			cleanup();
			opts.onAutoStop?.();
		}
	};

	source.connect(processor);
	processor.connect(ctx.destination);
	Logger.info(TAG, "started", { sampleRate, maxSeconds: opts.maxSeconds });

	const finalize = (): { blob: Blob; durationSeconds: number } => {
		const merged = new Float32Array(total);
		let offset = 0;
		for (const c of chunks) {
			merged.set(c, offset);
			offset += c.length;
		}
		const wav = encodeWav(merged, sampleRate);
		// wav owns its whole ArrayBuffer (encodeWav returns new Uint8Array(buffer)),
		// so passing .buffer is safe; the cast drops the SharedArrayBuffer union.
		return {
			blob: new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }),
			durationSeconds: total / sampleRate,
		};
	};

	return {
		stop() {
			// cleanup is idempotent — a no-op when auto-stop already released the
			// mic. finalize reads the buffered chunks, which survive cleanup.
			cleanup();
			const result = finalize();
			Logger.info(TAG, "stopped", {
				durationSeconds: result.durationSeconds.toFixed(2),
			});
			return result;
		},
		cancel() {
			cleanup();
			Logger.info(TAG, "cancelled");
		},
	};
}
