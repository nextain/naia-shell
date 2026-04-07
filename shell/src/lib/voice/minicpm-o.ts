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
/** RMS below this = silence in AI output (Int16 scale) */
const OUTPUT_SILENCE_THRESHOLD = 300;
/** Consecutive silent output chunks before cutting playback (~2s at 170ms/chunk) */
const OUTPUT_SILENCE_CHUNKS = 12;
/** Hard cap on AI audio output — never play more than this many seconds */
const MAX_OUTPUT_SECONDS = 20;

export function createMiniCpmOSession(): VoiceSession {
	let ws: WebSocket | null = null;
	let connected = false;
	let cfg: MiniCpmOConfig | null = null;
	let silenceTimer: ReturnType<typeof setTimeout> | null = null;
	let maxBufferTimer: ReturnType<typeof setTimeout> | null = null;
	let pcmBuffer: Int16Array[] = [];
	let rmsLogThrottle = 0;
	let audioChunkCount = 0;
	let isAiSpeaking = false; // suppress mic input while AI audio plays (prevents echo loop)
	let silentOutputChunks = 0; // consecutive silent output chunks for early cutoff
	let outputSamplesTotal = 0; // total PCM samples emitted this turn (for hard cap)
	let audioOutputCapped = false; // true after hard cap or silence cut — discard remaining server frames

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

				let connectErrored = false;
				ws.onerror = () => {
					clearTimeout(timeout);
					connectErrored = true;
					const err = new Error("WebSocket error");
					if (connected) {
						// Post-connect error: notify caller via callback
						session.onError?.(err);
					} else {
						// Pre-connect error: surface via rejected promise only
						reject(err);
					}
				};

				ws.onclose = () => {
					clearTimeout(timeout);
					const wasConnected = connected;
					connected = false;
					Logger.info("minicpm-o", "disconnected from /v1/omni");
					if (!wasConnected && !connectErrored) {
						// onerror already rejected — avoid double-reject
						reject(new Error("Connection closed before session ready"));
					}
					session.onDisconnect?.();
				};
			});
		},

		sendAudio(pcmBase64: string) {
			if (!ws || !connected) return;
			// Discard mic input while AI is speaking to prevent echo loop
			if (isAiSpeaking) return;

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
			audioChunkCount = 0;
			isAiSpeaking = false;
			silentOutputChunks = 0;
			outputSamplesTotal = 0;
			audioOutputCapped = false;
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

		// Notify UI that user speech was captured (no ASR u2014 placeholder only)
		session.onInputTranscript?.("🎤 음성 입력");

		// Send raw PCM16 bytes as binary frame (server converts to WAV)
		try {
			ws.send(pcm.buffer);
			// Signal end of this turn's audio input
			ws.send(JSON.stringify({ type: "input.done" }));
		} catch (err) {
			Logger.warn("minicpm-o", "send failed", { error: String(err) });
			session.onError?.(err instanceof Error ? err : new Error(String(err)));
			return;
		}

		Logger.debug("minicpm-o", "flushed audio", { samples: totalSamples });
	}

	/** Decode a server binary frame (WAV chunk) and emit PCM via onAudio. */
	function handleAudioChunk(arrayBuffer: ArrayBuffer) {
		// Discard remaining server frames after cap/silence cut (prevents repeated onInterrupted spam)
		if (audioOutputCapped) return;

		try {
			const bytes = new Uint8Array(arrayBuffer);
			if (audioChunkCount === 0) {
				// Log first chunk WAV header info to verify format
				const dv = new DataView(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 44));
				Logger.debug("minicpm-o", "first WAV chunk header", {
					totalBytes: arrayBuffer.byteLength,
					audioFormat: dv.getUint16(20, true), // 1=PCM, 3=IEEE_FLOAT
					channels: dv.getUint16(22, true),
					sampleRate: dv.getUint32(24, true),
					bitsPerSample: dv.getUint16(34, true),
				});
			}
			audioChunkCount++;
			const pcm = decodeWavToPcm(bytes);

			// Hard cap: never play more than MAX_OUTPUT_SECONDS regardless of content
			const maxSamples = MAX_OUTPUT_SECONDS * OUTPUT_SAMPLE_RATE;
			if (outputSamplesTotal >= maxSamples) {
				Logger.info("minicpm-o", "output hard cap reached u2014 cutting playback", {
					seconds: MAX_OUTPUT_SECONDS,
				});
				audioOutputCapped = true;
				isAiSpeaking = false;
				session.onInterrupted?.();
				return;
			}

			// Silence detection: stop early when speech ends
			const chunkRmsOutput = rms(pcm);
			if (chunkRmsOutput < OUTPUT_SILENCE_THRESHOLD) {
				silentOutputChunks++;
				if (silentOutputChunks >= OUTPUT_SILENCE_CHUNKS) {
					Logger.info("minicpm-o", "output silence u2014 cutting playback early", {
						playedSeconds: outputSamplesTotal / OUTPUT_SAMPLE_RATE,
						chunk: audioChunkCount,
					});
					silentOutputChunks = 0;
					outputSamplesTotal = 0;
					audioOutputCapped = true;
					isAiSpeaking = false;
					session.onInterrupted?.();
					return;
				}
			} else {
				silentOutputChunks = 0;
			}

			outputSamplesTotal += pcm.length;

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
				isAiSpeaking = true;
				silentOutputChunks = 0;
				outputSamplesTotal = 0;
				audioOutputCapped = false;
				// Discard any buffered mic input captured before AI started speaking
				pcmBuffer = [];
				if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
				if (maxBufferTimer) { clearTimeout(maxBufferTimer); maxBufferTimer = null; }
				Logger.debug("minicpm-o", "audio stream starting (mic muted)", {
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
				isAiSpeaking = false;
				Logger.debug("minicpm-o", "turn done (mic unmuted)");
				session.onTurnEnd?.();
				break;

			case "error": {
				// Non-fatal per protocol — session continues. Do NOT call onError.
				// (onError → ChatPanel.disconnect() would kill the session on recoverable errors)
				const errMsg = (msg.message as string) || "Server error";
				Logger.warn("minicpm-o", "non-fatal server error (session continues)", { message: errMsg });
				break;
			}
		}
	}

	return session;
}

/**
 * Parse WAV bytes -> Int16Array PCM, resampling to OUTPUT_SAMPLE_RATE if needed.
 * Each binary frame from /v1/omni is a self-contained WAV (RIFF header + PCM16 data).
 *
 * Handles both PCM_16 (audioFormat=1) and IEEE_FLOAT (audioFormat=3) subtypes.
 * soundfile writes FLOAT format when given float32 arrays unless subtype="PCM_16" is forced.
 */
function decodeWavToPcm(bytes: Uint8Array): Int16Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	// Standard WAV fmt chunk fields (all at fixed offsets for non-extensible PCM/FLOAT)
	const audioFormat = view.getUint16(20, true); // 1=PCM, 3=IEEE_FLOAT
	const srcSampleRate = view.getUint32(24, true);
	const bitsPerSample = view.getUint16(34, true);

	let offset = 12;
	while (offset + 8 <= bytes.byteLength) {
		const id =
			String.fromCharCode(bytes[offset]) +
			String.fromCharCode(bytes[offset + 1]) +
			String.fromCharCode(bytes[offset + 2]) +
			String.fromCharCode(bytes[offset + 3]);
		const size = view.getUint32(offset + 4, true);
		if (id === "data") {
			let pcm: Int16Array;
			if (audioFormat === 3 || bitsPerSample === 32) {
				// IEEE_FLOAT WAV: float32 samples in [-1.0, 1.0] → convert to Int16
				const float32 = new Float32Array(
					bytes.buffer,
					bytes.byteOffset + offset + 8,
					size / 4,
				).slice();
				pcm = new Int16Array(float32.length);
				for (let i = 0; i < float32.length; i++) {
					const s = float32[i];
					pcm[i] = Math.round(
						Math.max(-32768, Math.min(32767, s < 0 ? s * 32768 : s * 32767)),
					);
				}
			} else {
				// PCM_16: direct Int16 interpretation
				pcm = new Int16Array(
					bytes.buffer,
					bytes.byteOffset + offset + 8,
					size / 2,
				).slice();
			}
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
