/**
 * API-based STT session — captures audio via AudioContext + ScriptProcessor
 * (same as mic-stream.ts), accumulates PCM, sends to cloud API every 3s.
 *
 * Uses AudioContext (not MediaRecorder) for WebKitGTK compatibility.
 */
import { LAB_GATEWAY_URL } from "../config";
import { Logger } from "../logger";
import type { SttResult, SttSession } from "./types";

interface ApiSttOptions {
	provider: "google" | "elevenlabs" | "nextain" | "vllm";
	apiKey: string;
	language: string;
	/** Endpoint URL for local vLLM providers (e.g. "http://localhost:8000"). */
	endpointUrl?: string;
	/** Model ID for vLLM ASR (e.g. "qwen/qwen3-asr-1.7b"). If omitted, vLLM uses its default. */
	model?: string;
	/** Microphone device ID from enumerateDevices. If omitted, browser default is used. */
	inputDeviceId?: string;
}

const TARGET_SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096;
const SEND_INTERVAL_MS = 3000;

/**
 * Create an API-based STT session.
 * Captures mic via AudioContext (WebKitGTK compatible), sends PCM chunks to API.
 */
export function createApiSttSession(options: ApiSttOptions): SttSession {
	const { provider, apiKey, language, endpointUrl, model, inputDeviceId } =
		options;
	let resultCallbacks: ((result: SttResult) => void)[] = [];
	let errorCallbacks: ((error: { code: string; message: string }) => void)[] =
		[];
	let costCallbacks: ((cost: { durationSeconds: number }) => void)[] = [];
	let stopped = false;
	let mediaStream: MediaStream | null = null;
	let audioCtx: AudioContext | null = null;
	let sendInterval: ReturnType<typeof setInterval> | null = null;
	let pcmChunks: Int16Array[] = [];

	function float32ToInt16(float32: Float32Array): Int16Array {
		const int16 = new Int16Array(float32.length);
		for (let i = 0; i < float32.length; i++) {
			const s = Math.max(-1, Math.min(1, float32[i]));
			int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
		}
		return int16;
	}

	function int16ToBase64(samples: Int16Array): string {
		const bytes = new Uint8Array(
			samples.buffer,
			samples.byteOffset,
			samples.byteLength,
		);
		let binary = "";
		for (let i = 0; i < bytes.length; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return btoa(binary);
	}

	function mergePcmChunks(): Int16Array {
		let totalLength = 0;
		for (const chunk of pcmChunks) totalLength += chunk.length;
		const merged = new Int16Array(totalLength);
		let offset = 0;
		for (const chunk of pcmChunks) {
			merged.set(chunk, offset);
			offset += chunk.length;
		}
		return merged;
	}

	async function sendAndTranscribe() {
		if (pcmChunks.length === 0 || stopped) return;

		const pcm = mergePcmChunks();
		pcmChunks = [];

		// Skip silence — SW_GAIN=0.3 reduces signal ~3x, so threshold 150 not 500
		let sumSq = 0;
		for (let i = 0; i < pcm.length; i++) sumSq += pcm[i] * pcm[i];
		const rms = Math.sqrt(sumSq / pcm.length);
		if (rms < 150) {
			Logger.info("api-stt", "Skipping silence", {
				rms: Math.round(rms),
				samples: pcm.length,
			});
			return;
		}

		const durationSeconds = pcm.length / TARGET_SAMPLE_RATE;
		const base64 = int16ToBase64(pcm);
		const peak = Math.max(...Array.from(pcm).map(Math.abs));
		Logger.info("api-stt", "transcribeChunk called", {
			provider,
			samples: pcm.length,
			durationSeconds: Math.round(durationSeconds),
			rms: Math.round(rms),
			peak,
		});

		// Notify cost BEFORE API call (API call = billing)
		for (const cb of costCallbacks) cb({ durationSeconds });

		try {
			let result: string | null = null;
			if (provider === "google") {
				result = await transcribeGoogle(base64, apiKey, language);
			} else if (provider === "nextain") {
				result = await transcribeNextain(base64, apiKey, language);
			} else if (provider === "elevenlabs") {
				result = await transcribeElevenLabs(base64, apiKey, language);
			} else if (provider === "vllm") {
				result = await transcribeLocalVllm(
					base64,
					endpointUrl ?? "http://localhost:8000",
					language,
					model,
				);
			}
			Logger.info("api-stt", "transcribeChunk result", {
				provider,
				result: result?.slice(0, 50) ?? "(null)",
			});
			if (result?.trim()) {
				for (const cb of resultCallbacks) {
					cb({ transcript: result.trim(), isFinal: true });
				}
			}
		} catch (err) {
			Logger.warn("api-stt", `${provider} transcription error`, {
				error: String(err),
			});
			for (const cb of errorCallbacks)
				cb({ code: "API_ERROR", message: String(err) });
		}
	}

	return {
		async start() {
			stopped = false;
			pcmChunks = [];

			try {
				mediaStream = await navigator.mediaDevices.getUserMedia({
					// autoGainControl causes clipping in WebKitGTK (rms saturates to ~32767)
					// All processing disabled — WebKitGTK DSP can cause clipping
					audio: {
						echoCancellation: false,
						noiseSuppression: false,
						autoGainControl: false,
						...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}),
					},
				});
			} catch (err) {
				for (const cb of errorCallbacks)
					cb({ code: "MIC_ERROR", message: String(err) });
				throw err;
			}

			// No sampleRate constraint — WebKitGTK freezes (returns zeros) when requesting
			// non-native rate (e.g. 16000 Hz vs device native 48000 Hz). Downsample in SW.
			audioCtx = new AudioContext();
			const nativeSampleRate = audioCtx.sampleRate;
			const downsampleRatio = Math.max(
				1,
				Math.round(nativeSampleRate / TARGET_SAMPLE_RATE),
			);
			const source = audioCtx.createMediaStreamSource(mediaStream);
			const processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
			// NOTE: GainNode must NOT be inserted between source and processor in WebKitGTK.
			// It causes frozen (constant DC) audio. Apply gain in SW instead.
			const SW_GAIN = 0.3;

			let firstChunkLogged = false;
			processor.onaudioprocess = (e) => {
				if (stopped) return;
				const raw = e.inputBuffer.getChannelData(0);
				if (!firstChunkLogged) {
					firstChunkLogged = true;
					const f32min = Math.min(...raw).toFixed(4);
					const f32max = Math.max(...raw).toFixed(4);
					const f32rms = Math.sqrt(
						raw.reduce((s, v) => s + v * v, 0) / raw.length,
					).toFixed(4);
					Logger.info("api-stt", "First audio chunk (float32 raw)", {
						f32min,
						f32max,
						f32rms,
						swGain: SW_GAIN,
						nativeSampleRate,
						downsampleRatio,
					});
				}
				// Downsample: decimate by ratio to reach TARGET_SAMPLE_RATE
				const outLen = Math.floor(raw.length / downsampleRatio);
				const float32 = new Float32Array(outLen);
				for (let i = 0; i < outLen; i++) {
					float32[i] = raw[i * downsampleRatio] * SW_GAIN;
				}
				pcmChunks.push(float32ToInt16(float32));
			};

			// Direct connection: source → processor (no graph nodes between them)
			source.connect(processor);
			processor.connect(audioCtx.destination);

			// Send accumulated PCM every 3s
			sendInterval = setInterval(() => {
				if (!stopped) sendAndTranscribe();
			}, SEND_INTERVAL_MS);

			Logger.info("api-stt", `${provider} STT started`, {
				language,
				nativeSampleRate,
				targetSampleRate: TARGET_SAMPLE_RATE,
				downsampleRatio,
			});
		},

		async stop() {
			stopped = true;
			if (sendInterval) {
				clearInterval(sendInterval);
				sendInterval = null;
			}
			// Send remaining audio
			await sendAndTranscribe();
			if (audioCtx) {
				audioCtx.close().catch(() => {});
				audioCtx = null;
			}
			if (mediaStream) {
				for (const track of mediaStream.getTracks()) track.stop();
				mediaStream = null;
			}
			pcmChunks = [];
			Logger.info("api-stt", `${provider} STT stopped`);
		},

		onResult(callback) {
			resultCallbacks.push(callback);
			return () => {
				resultCallbacks = resultCallbacks.filter((cb) => cb !== callback);
			};
		},

		onError(callback) {
			errorCallbacks.push(callback);
			return () => {
				errorCallbacks = errorCallbacks.filter((cb) => cb !== callback);
			};
		},

		onCost(callback: (cost: { durationSeconds: number }) => void) {
			costCallbacks.push(callback);
			return () => {
				costCallbacks = costCallbacks.filter((cb) => cb !== callback);
			};
		},
	};
}

// ── Google Cloud Speech-to-Text (PCM LINEAR16) ──

async function transcribeGoogle(
	pcmBase64: string,
	apiKey: string,
	language: string,
): Promise<string | null> {
	const response = await fetch(
		`https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				config: {
					encoding: "LINEAR16",
					sampleRateHertz: TARGET_SAMPLE_RATE,
					languageCode: language,
					model: "latest_long",
					enableAutomaticPunctuation: true,
				},
				audio: { content: pcmBase64 },
			}),
		},
	);

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Google STT HTTP ${response.status}: ${text}`);
	}

	const data = await response.json();
	const results = data.results ?? [];
	return (
		results
			.map(
				(r: { alternatives?: { transcript?: string }[] }) =>
					r.alternatives?.[0]?.transcript ?? "",
			)
			.join(" ")
			.trim() || null
	);
}

// ── Naia Cloud STT (via any-llm gateway → Google Cloud STT) ──

async function transcribeNextain(
	pcmBase64: string,
	naiaKey: string,
	language: string,
): Promise<string | null> {
	// Convert PCM base64 to WAV blob for gateway upload
	const pcmBytes = Uint8Array.from(atob(pcmBase64), (c) => c.charCodeAt(0));
	const wavBlob = pcmToWavBlob(pcmBytes, TARGET_SAMPLE_RATE);

	const formData = new FormData();
	formData.append("file", wavBlob, "audio.wav");
	formData.append("language", language);

	const gatewayUrl = LAB_GATEWAY_URL;
	const response = await fetch(`${gatewayUrl}/v1/audio/transcriptions`, {
		method: "POST",
		headers: { "X-AnyLLM-Key": `Bearer ${naiaKey}` },
		body: formData,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Naia Cloud STT HTTP ${response.status}: ${text}`);
	}

	const data = await response.json();
	return data.text?.trim() || null;
}

// ── ElevenLabs Speech-to-Text ──

async function transcribeElevenLabs(
	pcmBase64: string,
	apiKey: string,
	language: string,
): Promise<string | null> {
	// Convert PCM base64 to WAV blob for ElevenLabs upload
	const pcmBytes = Uint8Array.from(atob(pcmBase64), (c) => c.charCodeAt(0));
	const wavBlob = pcmToWavBlob(pcmBytes, TARGET_SAMPLE_RATE);

	const formData = new FormData();
	formData.append("file", wavBlob, "audio.wav");
	formData.append("model_id", "scribe_v1");
	formData.append("language_code", language.split("-")[0]);

	const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
		method: "POST",
		headers: { "xi-api-key": apiKey },
		body: formData,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`ElevenLabs STT HTTP ${response.status}: ${text}`);
	}

	const data = await response.json();
	return data.text?.trim() || null;
}

// ── Local vLLM STT (OpenAI-compatible /v1/audio/transcriptions) ──

async function transcribeLocalVllm(
	pcmBase64: string,
	baseUrl: string,
	language: string,
	model?: string,
): Promise<string | null> {
	const pcmBytes = Uint8Array.from(atob(pcmBase64), (c) => c.charCodeAt(0));
	const wavBlob = pcmToWavBlob(pcmBytes, TARGET_SAMPLE_RATE);

	const formData = new FormData();
	formData.append("file", wavBlob, "audio.wav");
	formData.append("language", language.split("-")[0]);
	if (model) formData.append("model", model);

	const url = `${baseUrl.replace(/\/$/, "")}/v1/audio/transcriptions`;
	const response = await fetch(url, {
		method: "POST",
		body: formData,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Local vLLM STT HTTP ${response.status}: ${text}`);
	}

	const data = await response.json();
	return data.text?.trim() || null;
}

// ── Utility: PCM Int16 to WAV blob ──

function pcmToWavBlob(pcmBytes: Uint8Array, sampleRate: number): Blob {
	const buffer = new ArrayBuffer(44 + pcmBytes.length);
	const view = new DataView(buffer);

	// WAV header
	const writeString = (offset: number, str: string) => {
		for (let i = 0; i < str.length; i++)
			view.setUint8(offset + i, str.charCodeAt(i));
	};
	writeString(0, "RIFF");
	view.setUint32(4, 36 + pcmBytes.length, true);
	writeString(8, "WAVE");
	writeString(12, "fmt ");
	view.setUint32(16, 16, true); // chunk size
	view.setUint16(20, 1, true); // PCM format
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	writeString(36, "data");
	view.setUint32(40, pcmBytes.length, true);

	// PCM data
	new Uint8Array(buffer, 44).set(pcmBytes);

	return new Blob([buffer], { type: "audio/wav" });
}
