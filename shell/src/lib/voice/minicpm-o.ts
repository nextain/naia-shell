/**
 * MiniCPM-o vllm-omni /v1/omni full-duplex WebSocket session.
 *
 * Full-duplex: PCM16 audio input → omni LLM → WAV audio output.
 * Distinct from /v1/realtime (ASR-only) and /v1/audio/speech/stream (TTS-only).
 *
 * Protocol (/v1/omni):
 *   Client → Server:
 *     {"type": "session.config", model, system}  (once, on open)
 *     <binary: PCM16 16kHz mono>  (zero or more binary frames per turn)
 *     {"type": "input.done"}  (end of audio input, triggers inference)
 *
 *   Server → Client:
 *     {"type": "turn.start"}
 *     {"type": "transcript.delta", "text": "..."}  (LLM text tokens)
 *     {"type": "audio.start", "format": "wav_chunk", "sample_rate": 24000}
 *     <binary: WAV chunk>  (each binary frame = self-contained WAV)
 *     {"type": "audio.done", "total_bytes": N}
 *     {"type": "turn.done"}
 *     {"type": "error", "message": "..."}
 *
 * Server: vllm-omni with MiniCPM-o 4.5 on port 8000
 *   distrobox enter vllm-dev -- bash scripts/serve_async_chunk.sh
 */
import { Logger } from "../logger";
import type { LiveProviderConfig, MiniCpmOConfig, VoiceSession } from "./types";

const DEFAULT_SERVER_URL = "http://localhost:8000";

/** ms of silence after last speech chunk before flushing to server */
const SILENCE_TIMEOUT_MS = 1500;
/** force flush after this many ms even if speech is continuous */
const MAX_BUFFER_MS = 6000;
/** minimum samples to bother sending (0.5s @ 16kHz) */
const MIN_AUDIO_SAMPLES = 8000;
/** output chunk size for onAudio callbacks */
const AUDIO_CHUNK_FRAMES = 4096;
/** RMS threshold for speech detection (Int16 scale 0–32767, ~3% of full scale) */
const SPEECH_RMS_THRESHOLD = 200;
const OUTPUT_SAMPLE_RATE = 24000;

export function createMiniCpmOSession(): VoiceSession {
	let ws: WebSocket | null = null;
	let connected = false;
	let cfg: MiniCpmOConfig | null = null;
	let silenceTimer: ReturnType<typeof setTimeout> | null = null;
	let maxBufferTimer: ReturnType<typeof setTimeout> | null = null;
	let pcmBuffer: Int16Array[] = [];
	let rmsLogThrottle = 0;

	const session: VoiceSession = {
		onAudio: null,
		onInputTranscript: null,
		onOutputTranscript: null,
		onToolCall: null,
		onTurnEnd: null,
		onInterrupted: null,
		onError: null,
		onDisconnect: null,

		get isConnected() {
			return connected;
		},

		async connect(config: LiveProviderConfig) {
			cfg = config as MiniCpmOConfig;

			// Derive WebSocket URL from http:// or ws:// serverUrl
			const base = (cfg.serverUrl ?? DEFAULT_SERVER_URL)
				.replace(/\/+$/, "")
				.replace(/^http/, "ws");
			const wsUrl = `${base}/v1/omni`;

			Logger.info("minicpm-o", "connecting", { url: wsUrl });

			ws = new WebSocket(wsUrl);
			ws.binaryType = "arraybuffer"; // receive binary as ArrayBuffer

			return new Promise<void>((resolve, reject) => {
				if (!ws) return reject(new Error("WebSocket not created"));

				const timeout = setTimeout(() => {
					reject(new Error("Connection timeout"));
					ws?.close();
				}, 15000);

				ws.onopen = () => {
					clearTimeout(timeout);
					// Send session.config immediately on open
					ws?.send(
						JSON.stringify({
							type: "session.config",
							model: cfg?.model ?? "openbmb/MiniCPM-o-4_5",
							system: cfg?.systemInstruction ?? undefined,
						}),
					);
					// /v1/omni has no session.created ack — resolve immediately
					connected = true;
					Logger.info("minicpm-o", "connected to /v1/omni");
					resolve();
				};

				ws.onmessage = (event: MessageEvent) => {
					if (event.data instanceof ArrayBuffer) {
						// Binary frame = WAV audio chunk from server
						handleAudioChunk(event.data);
					} else if (typeof event.data === "string") {
						try {
							const msg = JSON.parse(event.data) as Record<string, unknown>;
							handleMessage(msg);
						} catch {
							// ignore malformed JSON
						}
					}
				};

				ws.onerror = () => {
					clearTimeout(timeout);
					const err = new Error("WebSocket error");
					reject(err);
					session.onError?.(err);
				};

				ws.onclose = () => {
					clearTimeout(timeout);
					const wasConnected = connected;
					connected = false;
					Logger.info("minicpm-o", "disconnected from /v1/omni");
					if (!wasConnected) {
						reject(new Error("Connection closed before session ready"));
					}
					session.onDisconnect?.();
				};
			});
		},

		sendAudio(pcmBase64: string) {
			if (!ws || !connected) return;

			// Decode base64 PCM16 and buffer locally
			const bytes = base64ToUint8Array(pcmBase64);
			const samples = new Int16Array(
				bytes.buffer,
				bytes.byteOffset,
				bytes.byteLength / 2,
			);
			pcmBuffer.push(samples.slice());

			const chunkRms = rms(samples);
			if (++rmsLogThrottle % 20 === 0) {
				Logger.debug("minicpm-o", "RMS sample", {
					rms: Math.round(chunkRms),
					threshold: SPEECH_RMS_THRESHOLD,
					isSpeech: chunkRms >= SPEECH_RMS_THRESHOLD,
				});
			}

			const isSpeech = chunkRms >= SPEECH_RMS_THRESHOLD;
			if (isSpeech) {
				if (silenceTimer) clearTimeout(silenceTimer);
				silenceTimer = setTimeout(() => {
					silenceTimer = null;
					flushAudio();
				}, SILENCE_TIMEOUT_MS);

				if (!maxBufferTimer) {
					maxBufferTimer = setTimeout(() => {
						maxBufferTimer = null;
						if (silenceTimer) {
							clearTimeout(silenceTimer);
							silenceTimer = null;
						}
						flushAudio();
					}, MAX_BUFFER_MS);
				}
			} else if (!silenceTimer) {
				silenceTimer = setTimeout(() => {
					silenceTimer = null;
					flushAudio();
				}, SILENCE_TIMEOUT_MS);
			}
		},

		sendText(text: string) {
			if (!ws || !connected) return;
			// Send text turn directly
			ws.send(JSON.stringify({ type: "input.text", text }));
		},

		sendToolResponse(_callId: string, _result: unknown) {
			// Tool calls not supported by vllm-omni
		},

		disconnect() {
			connected = false;
			if (silenceTimer) {
				clearTimeout(silenceTimer);
				silenceTimer = null;
			}
			if (maxBufferTimer) {
				clearTimeout(maxBufferTimer);
				maxBufferTimer = null;
			}
			pcmBuffer = [];
			rmsLogThrottle = 0;
			if (ws) {
				ws.close();
				ws = null;
			}
		},
	};

	/** Send buffered PCM audio to server as binary frames + input.done. */
	function flushAudio() {
		if (maxBufferTimer) {
			clearTimeout(maxBufferTimer);
			maxBufferTimer = null;
		}
		if (!ws || !connected) return;

		const totalSamples = pcmBuffer.reduce((n, c) => n + c.length, 0);
		if (totalSamples < MIN_AUDIO_SAMPLES) {
			pcmBuffer = [];
			return;
		}

		// Concatenate all buffered PCM
		const pcm = new Int16Array(totalSamples);
		let offset = 0;
		for (const chunk of pcmBuffer) {
			pcm.set(chunk, offset);
			offset += chunk.length;
		}
		pcmBuffer = [];

		// Send raw PCM16 bytes as binary frame (server converts to WAV)
		ws.send(pcm.buffer);
		// Signal end of this turn's audio input
		ws.send(JSON.stringify({ type: "input.done" }));

		Logger.debug("minicpm-o", "flushed audio", { samples: totalSamples });
	}

	/** Decode a server binary frame (WAV chunk) and emit PCM via onAudio. */
	function handleAudioChunk(arrayBuffer: ArrayBuffer) {
		try {
			const bytes = new Uint8Array(arrayBuffer);
			const pcm = decodeWavToPcm(bytes);
			for (let i = 0; i < pcm.length; i += AUDIO_CHUNK_FRAMES) {
				const chunk = pcm.slice(i, i + AUDIO_CHUNK_FRAMES);
				const b64 = uint8ArrayToBase64(
					new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
				);
				session.onAudio?.(b64);
			}
		} catch (err) {
			Logger.warn("minicpm-o", "audio decode failed", { error: String(err) });
		}
	}

	function handleMessage(msg: Record<string, unknown>) {
		const type = msg.type as string;

		switch (type) {
			case "turn.start":
				Logger.debug("minicpm-o", "turn started");
				break;

			case "transcript.delta": {
				const text = msg.text as string | undefined;
				if (text) {
					session.onOutputTranscript?.(text);
				}
				break;
			}

			case "audio.start":
				Logger.debug("minicpm-o", "audio stream starting", {
					format: msg.format,
					sample_rate: msg.sample_rate,
				});
				break;

			case "audio.done":
				Logger.debug("minicpm-o", "audio stream done", {
					total_bytes: msg.total_bytes,
				});
				break;

			case "turn.done":
				Logger.debug("minicpm-o", "turn done");
				session.onTurnEnd?.();
				break;

			case "error": {
				const errMsg = (msg.message as string) || "Server error";
				Logger.warn("minicpm-o", "server error", { message: errMsg });
				session.onError?.(new Error(errMsg));
				break;
			}
		}
	}

	return session;
}

/**
 * Parse WAV bytes -> Int16Array PCM, resampling to OUTPUT_SAMPLE_RATE if needed.
 * Each binary frame from /v1/omni is a self-contained WAV (RIFF header + PCM16 data).
 */
function decodeWavToPcm(bytes: Uint8Array): Int16Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	// Find 'data' chunk (standard RIFF layout)
	const srcSampleRate = view.getUint32(24, true);
	let offset = 12;
	while (offset + 8 <= bytes.byteLength) {
		const id =
			String.fromCharCode(bytes[offset]) +
			String.fromCharCode(bytes[offset + 1]) +
			String.fromCharCode(bytes[offset + 2]) +
			String.fromCharCode(bytes[offset + 3]);
		const size = view.getUint32(offset + 4, true);
		if (id === "data") {
			const pcm = new Int16Array(
				bytes.buffer,
				bytes.byteOffset + offset + 8,
				size / 2,
			).slice();
			return srcSampleRate === OUTPUT_SAMPLE_RATE
				? pcm
				: resampleLinear(pcm, srcSampleRate, OUTPUT_SAMPLE_RATE);
		}
		offset += 8 + size;
	}
	throw new Error("minicpm-o: WAV has no data chunk");
}

/** Linear interpolation resampling (Int16 mono). */
function resampleLinear(
	input: Int16Array,
	fromRate: number,
	toRate: number,
): Int16Array {
	const ratio = fromRate / toRate;
	const outputLen = Math.round(input.length / ratio);
	const output = new Int16Array(outputLen);
	for (let i = 0; i < outputLen; i++) {
		const src = i * ratio;
		const lo = Math.floor(src);
		const hi = Math.min(lo + 1, input.length - 1);
		const frac = src - lo;
		output[i] = Math.round(input[lo] * (1 - frac) + input[hi] * frac);
	}
	return output;
}

/** Root-mean-square amplitude of Int16 PCM samples. */
function rms(samples: Int16Array): number {
	if (samples.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
	return Math.sqrt(sum / samples.length);
}

function base64ToUint8Array(b64: string): Uint8Array {
	const bin = atob(b64);
	const arr = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
	return arr;
}

function uint8ArrayToBase64(arr: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
	return btoa(bin);
}
