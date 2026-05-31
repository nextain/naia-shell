/**
 * Continuous microphone PCM streaming for Gemini Live API.
 * Captures 16kHz mono Int16 PCM and delivers base64 chunks via callback.
 */
import { Logger } from "./logger";

export interface MicStream {
	start: () => void;
	stop: () => void;
}

export interface MicStreamOptions {
	onChunk: (base64Pcm: string) => void;
	sampleRate?: number;
	bufferSize?: number;
	/**
	 * getUserMedia `autoGainControl`. Default true (legacy behavior). Streaming
	 * omni paths pass false to preserve vocal dynamics for the server VAD.
	 * `echoCancellation` stays on regardless — the weak-AEC echo protection.
	 */
	autoGainControl?: boolean;
}

export async function createMicStream(
	opts: MicStreamOptions,
): Promise<MicStream> {
	const sampleRate = opts.sampleRate ?? 16000;
	const bufferSize = opts.bufferSize ?? 4096;
	const autoGainControl = opts.autoGainControl ?? true;

	const stream = await navigator.mediaDevices.getUserMedia({
		audio: {
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl,
		},
	});
	// AudioContext({ sampleRate }) causes GStreamer CRITICAL in WebKitGTK.
	// Use default sampleRate and downsample in SW instead.
	const ctx = new AudioContext();
	const source = ctx.createMediaStreamSource(stream);
	const processor = ctx.createScriptProcessor(bufferSize, 1, 1);

	let active = false;

	processor.onaudioprocess = (e) => {
		if (!active) return;
		const float32 = e.inputBuffer.getChannelData(0);
		const downsampled = downsample(float32, ctx.sampleRate, sampleRate);
		const int16 = float32ToInt16(downsampled);
		const b64 = uint8ArrayToBase64(new Uint8Array(int16.buffer));
		opts.onChunk(b64);
	};

	return {
		start() {
			active = true;
			source.connect(processor);
			processor.connect(ctx.destination);
			Logger.info("MicStream", "started", { sampleRate, bufferSize });
		},
		stop() {
			active = false;
			processor.disconnect();
			source.disconnect();
			stream.getTracks().forEach((t) => t.stop());
			ctx.close().catch(() => {});
			Logger.info("MicStream", "stopped");
		},
	};
}

/** Average-based downsampling from one sample rate to another. */
function downsample(
	input: Float32Array,
	fromRate: number,
	toRate: number,
): Float32Array {
	if (fromRate === toRate) return input;
	const ratio = fromRate / toRate;
	const outLen = Math.round(input.length / ratio);
	const output = new Float32Array(outLen);
	for (let i = 0; i < outLen; i++) {
		const start = Math.round(i * ratio);
		const end = Math.min(Math.round((i + 1) * ratio), input.length);
		let sum = 0;
		for (let j = start; j < end; j++) sum += input[j];
		output[i] = sum / (end - start);
	}
	return output;
}

function float32ToInt16(float32: Float32Array): Int16Array {
	const int16 = new Int16Array(float32.length);
	for (let i = 0; i < float32.length; i++) {
		const s = Math.max(-1, Math.min(1, float32[i]));
		int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
	}
	return int16;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}
