/**
 * Barge-in energy gate — shared SoT from omni development (#216).
 *
 * Extracted from naia-omni.ts so the gate survives that provider's passthrough
 * refactor (no client-side VAD/buffering remains there). ChatPanel applies this
 * gate while the AI is speaking — on weak-AEC platforms (WebKitGTK) it stops
 * AEC-residual echo from self-triggering the server VAD into an interrupt loop.
 * Gemini Live and naia-omni share this one threshold.
 */

/**
 * RMS threshold for client-side speech detection (Int16 scale 0–32767,
 * ~3% of full scale). Validated during omni development (#216 minicpm-o).
 */
export const SPEECH_RMS_THRESHOLD = 200;

/** Root-mean-square amplitude of Int16 PCM samples. */
function rms(samples: Int16Array): number {
	if (samples.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
	return Math.sqrt(sum / samples.length);
}

/**
 * RMS (Int16 scale 0–32767) of a base64-encoded Int16-LE PCM chunk. Shared
 * SoT helper for the barge-in energy gate (see {@link SPEECH_RMS_THRESHOLD}).
 */
export function rmsFromBase64Pcm(b64: string): number {
	const bytes = base64ToUint8Array(b64);
	if (bytes.byteLength < 2) return 0;
	const samples = new Int16Array(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength >> 1,
	);
	return rms(samples);
}

function base64ToUint8Array(b64: string): Uint8Array {
	let bin: string;
	try {
		bin = atob(b64);
	} catch {
		// Malformed base64 from the mic encoder is treated as a silent chunk
		// rather than a thrown exception that would kill the caller.
		return new Uint8Array(0);
	}
	const arr = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
	return arr;
}
