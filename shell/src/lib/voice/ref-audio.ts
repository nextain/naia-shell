/**
 * Voice-clone reference encoder for the vllm-omni `/v1/realtime` server.
 *
 * The wire contract (see `nextain/vllm-omni#11`): a base64-encoded
 * RIFF/WAVE blob carrying mono PCM16 at 16 kHz, sent on
 * `session.update.session.ref_audio`. The server validates the payload
 * client-side first (4 MiB raw cap, RIFF/WAVE magic check) and surfaces
 * failures as a Realtime `error` event.
 *
 * This module accepts the three input shapes a UI layer is most likely
 * to produce — a raw base64 string already in wire form, a `Blob`/`File`
 * from a file input, or an `ArrayBuffer` from `fetch(url).arrayBuffer()`
 * — decodes them via `AudioContext.decodeAudioData`, downmixes to mono,
 * resamples to 16 kHz with `OfflineAudioContext`, then writes a minimal
 * RIFF/WAVE header before base64-encoding for the wire.
 *
 * Decode failures and oversize payloads throw before any WebSocket send
 * so the caller can surface a single, structured error to the user.
 */

const TARGET_SAMPLE_RATE = 16000;
const RAW_BYTE_CAP = 4 * 1024 * 1024;
const ALREADY_BASE64_RE = /^[A-Za-z0-9+/=]+$/;

export class RefAudioEncodeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RefAudioEncodeError";
	}
}

/**
 * Encode a user-provided voice reference into the base64 wire form.
 *
 * Accepts:
 *  - `string` — already base64-encoded (passed through, only validated
 *    against the size cap).
 *  - `Blob` / `File` — typically from `<input type="file" accept="audio/*">`.
 *  - `ArrayBuffer` — from `fetch(url).arrayBuffer()` etc.
 *
 * Returns the base64 string the server expects on `session.update.ref_audio`.
 */
export async function encodeRefAudio(
	input: ArrayBuffer | Blob | string,
): Promise<string> {
	if (typeof input === "string") {
		return validateBase64Wav(input);
	}

	const ab = input instanceof Blob ? await input.arrayBuffer() : input;
	if (ab.byteLength === 0) {
		throw new RefAudioEncodeError("ref audio is empty");
	}

	const audioBuffer = await decodeAudioData(ab);
	const monoSamples = downmixToMono(audioBuffer);
	const resampled = await resampleTo(
		monoSamples,
		audioBuffer.sampleRate,
		TARGET_SAMPLE_RATE,
	);
	const wavBytes = encodeWav(resampled, TARGET_SAMPLE_RATE);

	if (wavBytes.byteLength > RAW_BYTE_CAP) {
		throw new RefAudioEncodeError(
			`encoded ref audio (${Math.round(wavBytes.byteLength / 1024)} KiB) ` +
				`exceeds the ${RAW_BYTE_CAP / 1024 / 1024} MiB cap; trim the clip`,
		);
	}

	return uint8ToBase64(wavBytes);
}

function validateBase64Wav(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new RefAudioEncodeError("ref audio string is empty");
	}
	if (!ALREADY_BASE64_RE.test(trimmed)) {
		throw new RefAudioEncodeError(
			"ref audio string is not pure base64 — pass a Blob/ArrayBuffer " +
				"for raw audio, or a base64 WAV string already on the wire",
		);
	}
	// Approximate the decoded size from the base64 length to cap before
	// the server has to.
	const approxBytes = Math.floor((trimmed.length * 3) / 4);
	if (approxBytes > RAW_BYTE_CAP) {
		throw new RefAudioEncodeError(
			`ref audio (${Math.round(approxBytes / 1024)} KiB) exceeds the ` +
				`${RAW_BYTE_CAP / 1024 / 1024} MiB cap`,
		);
	}
	return trimmed;
}

async function decodeAudioData(ab: ArrayBuffer): Promise<AudioBuffer> {
	const Ctx =
		(
			globalThis as unknown as {
				AudioContext?: typeof AudioContext;
				webkitAudioContext?: typeof AudioContext;
			}
		).AudioContext ??
		(
			globalThis as unknown as {
				webkitAudioContext?: typeof AudioContext;
			}
		).webkitAudioContext;
	if (!Ctx) {
		throw new RefAudioEncodeError(
			"AudioContext is unavailable in this environment; ref audio " +
				"encoding requires a Web Audio API host",
		);
	}
	const ctx = new Ctx();
	try {
		// Some browsers' decodeAudioData detaches the source ArrayBuffer; copy
		// to keep the original usable for diagnostics.
		const copy = ab.slice(0);
		return await ctx.decodeAudioData(copy);
	} catch (err) {
		throw new RefAudioEncodeError(
			`could not decode ref audio: ${err instanceof Error ? err.message : String(err)}`,
		);
	} finally {
		// Suspend rather than close to avoid InvalidStateError on second use.
		void ctx.close().catch(() => {});
	}
}

function downmixToMono(buffer: AudioBuffer): Float32Array {
	if (buffer.numberOfChannels === 1) {
		return buffer.getChannelData(0).slice();
	}
	const length = buffer.length;
	const out = new Float32Array(length);
	const channels = buffer.numberOfChannels;
	for (let ch = 0; ch < channels; ch++) {
		const data = buffer.getChannelData(ch);
		for (let i = 0; i < length; i++) {
			out[i] += data[i] / channels;
		}
	}
	return out;
}

async function resampleTo(
	samples: Float32Array,
	srcRate: number,
	dstRate: number,
): Promise<Float32Array> {
	if (srcRate === dstRate) return samples;

	const Offline =
		(
			globalThis as unknown as {
				OfflineAudioContext?: typeof OfflineAudioContext;
				webkitOfflineAudioContext?: typeof OfflineAudioContext;
			}
		).OfflineAudioContext ??
		(
			globalThis as unknown as {
				webkitOfflineAudioContext?: typeof OfflineAudioContext;
			}
		).webkitOfflineAudioContext;
	if (!Offline) {
		throw new RefAudioEncodeError(
			"OfflineAudioContext is unavailable; cannot resample ref audio",
		);
	}

	const length = Math.ceil((samples.length * dstRate) / srcRate);
	const ctx = new Offline(1, length, dstRate);
	const src = ctx.createBufferSource();
	const buf = ctx.createBuffer(1, samples.length, srcRate);
	buf.getChannelData(0).set(samples);
	src.buffer = buf;
	src.connect(ctx.destination);
	src.start();
	const rendered = await ctx.startRendering();
	return rendered.getChannelData(0).slice();
}

function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
	const numFrames = samples.length;
	const bytesPerSample = 2;
	const dataSize = numFrames * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);

	// RIFF header
	writeAscii(view, 0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	writeAscii(view, 8, "WAVE");
	// fmt chunk
	writeAscii(view, 12, "fmt ");
	view.setUint32(16, 16, true); // PCM chunk size
	view.setUint16(20, 1, true); // PCM format
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
	view.setUint16(32, bytesPerSample, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	// data chunk
	writeAscii(view, 36, "data");
	view.setUint32(40, dataSize, true);

	let offset = 44;
	for (let i = 0; i < numFrames; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
		offset += 2;
	}
	return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, ascii: string): void {
	for (let i = 0; i < ascii.length; i++) {
		view.setUint8(offset + i, ascii.charCodeAt(i));
	}
}

function uint8ToBase64(arr: Uint8Array): string {
	let bin = "";
	const chunk = 0x8000;
	for (let i = 0; i < arr.length; i += chunk) {
		bin += String.fromCharCode(
			...arr.subarray(i, Math.min(i + chunk, arr.length)),
		);
	}
	return btoa(bin);
}
