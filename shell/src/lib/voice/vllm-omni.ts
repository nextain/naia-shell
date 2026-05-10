/**
 * vllm-omni REST voice session.
 *
 * Half-duplex: buffer PCM audio → silence timeout → REST call → WAV response.
 * No streaming (async_chunk=false — full audio returned after generation).
 *
 * Audio flow:
 *   Mic PCM16 16kHz → buffer → WAV → POST /v1/chat/completions {modalities:["audio"]}
 *   Response WAV → decodeAudioData (resample to 24kHz) → PCM16 chunks → onAudio
 *
 * Requires: vllm-omni feat/minicpm-o branch (audio_url input support).
 */
import { Logger } from "../logger";
import type { LiveProviderConfig, VllmOmniConfig, VoiceSession } from "./types";

const SILENCE_TIMEOUT_MS = 1500;
const MIN_AUDIO_SAMPLES = 8000; // 0.5s @ 16kHz — ignore very short utterances
const AUDIO_CHUNK_FRAMES = 4096; // onAudio chunk size in samples
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const MAX_TOKENS = 1024;
/** RMS amplitude threshold for speech detection (Int16 scale, 0–32767).
 *  Chunks below this are treated as silence and do not reset the flush timer.
 *  ~3% of full scale — filters ambient noise, passes normal speech. */
const SPEECH_RMS_THRESHOLD = 200;
/** Force flush after this many ms even if speech is still ongoing. */
const MAX_BUFFER_MS = 6000;

export function createVllmOmniSession(): VoiceSession {
	let connected = false;
	let cfg: VllmOmniConfig | null = null;
	let silenceTimer: ReturnType<typeof setTimeout> | null = null;
	let maxBufferTimer: ReturnType<typeof setTimeout> | null = null;
	let pcmBuffer: Int16Array[] = [];
	let messages: Array<{ role: string; content: unknown }> = [];
	let rmsLogThrottle = 0; // log RMS every N chunks

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
			cfg = config as VllmOmniConfig;
			messages = [];
			if (cfg.systemInstruction) {
				messages.push({ role: "system", content: cfg.systemInstruction });
			}
			connected = true;
			Logger.info("vllm-omni", "connected", {
				host: cfg.host,
				model: cfg.model,
			});
		},

		sendAudio(pcmBase64: string) {
			if (!connected) return;

			const bytes = base64ToUint8Array(pcmBase64);
			const samples = new Int16Array(
				bytes.buffer,
				bytes.byteOffset,
				bytes.byteLength / 2,
			);
			pcmBuffer.push(samples.slice());

			const chunkRms = rms(samples);

			// Log RMS every 20 chunks (~1.7s) to help calibrate threshold
			if (++rmsLogThrottle % 20 === 0) {
				Logger.debug("vllm-omni", "RMS sample", {
					rms: Math.round(chunkRms),
					threshold: SPEECH_RMS_THRESHOLD,
					isSpeech: chunkRms >= SPEECH_RMS_THRESHOLD,
					bufferChunks: pcmBuffer.length,
				});
			}

			// Amplitude-based silence detection: only reset the flush timer when
			// the chunk contains actual speech (RMS above threshold).
			const isSpeech = chunkRms >= SPEECH_RMS_THRESHOLD;
			if (isSpeech) {
				if (silenceTimer) clearTimeout(silenceTimer);
				silenceTimer = setTimeout(() => {
					silenceTimer = null;
					flushAudio().catch((err) => {
						Logger.warn("vllm-omni", "flush failed", { error: String(err) });
						session.onError?.(
							err instanceof Error ? err : new Error(String(err)),
						);
					});
				}, SILENCE_TIMEOUT_MS);

				// Start max-buffer timer on first speech chunk
				if (!maxBufferTimer) {
					maxBufferTimer = setTimeout(() => {
						maxBufferTimer = null;
						if (silenceTimer) clearTimeout(silenceTimer);
						silenceTimer = null;
						flushAudio().catch((err) => {
							Logger.warn("vllm-omni", "max-buffer flush failed", {
								error: String(err),
							});
							session.onError?.(
								err instanceof Error ? err : new Error(String(err)),
							);
						});
					}, MAX_BUFFER_MS);
				}
			} else if (!silenceTimer) {
				// No speech yet — start a timer so we eventually flush stale buffer
				silenceTimer = setTimeout(() => {
					silenceTimer = null;
					flushAudio().catch((err) => {
						Logger.warn("vllm-omni", "flush failed", { error: String(err) });
						session.onError?.(
							err instanceof Error ? err : new Error(String(err)),
						);
					});
				}, SILENCE_TIMEOUT_MS);
			}
		},

		sendText(text: string) {
			if (!connected || !cfg) return;
			const localCfg = cfg;
			messages.push({ role: "user", content: text });
			callRest(localCfg, messages)
				.then(({ audioData, transcript }) => {
					messages.push({ role: "assistant", content: transcript || "" });
					handleAudioResponse(audioData, transcript);
				})
				.catch((err) => {
					messages.pop();
					Logger.warn("vllm-omni", "sendText failed", { error: String(err) });
					session.onError?.(
						err instanceof Error ? err : new Error(String(err)),
					);
				});
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
			messages = [];
			rmsLogThrottle = 0;
			session.onDisconnect?.();
		},
	};

	async function flushAudio() {
		if (maxBufferTimer) {
			clearTimeout(maxBufferTimer);
			maxBufferTimer = null;
		}
		if (!cfg || pcmBuffer.length === 0) return;

		const totalSamples = pcmBuffer.reduce((n, c) => n + c.length, 0);
		if (totalSamples < MIN_AUDIO_SAMPLES) {
			pcmBuffer = [];
			return;
		}

		const pcm = new Int16Array(totalSamples);
		let offset = 0;
		for (const chunk of pcmBuffer) {
			pcm.set(chunk, offset);
			offset += chunk.length;
		}
		pcmBuffer = [];

		const wav = pcmToWav(pcm, INPUT_SAMPLE_RATE);
		const wavBase64 = uint8ArrayToBase64(wav);

		const userMessage = {
			role: "user" as const,
			content: [
				{
					type: "audio_url",
					audio_url: { url: `data:audio/wav;base64,${wavBase64}` },
				},
			],
		};
		messages.push(userMessage);

		try {
			const localCfg = cfg;
			const { audioData, transcript } = await callRest(localCfg, messages);
			messages.push({ role: "assistant", content: transcript || "" });
			handleAudioResponse(audioData, transcript);
		} catch (err) {
			messages.pop();
			throw err;
		}
	}

	function handleAudioResponse(audioData: string, transcript: string) {
		if (transcript) {
			session.onOutputTranscript?.(transcript);
		}
		try {
			const pcm = decodeWavToPcm(audioData);
			for (let i = 0; i < pcm.length; i += AUDIO_CHUNK_FRAMES) {
				const chunk = pcm.slice(i, i + AUDIO_CHUNK_FRAMES);
				const b64 = uint8ArrayToBase64(
					new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
				);
				session.onAudio?.(b64);
			}
			session.onTurnEnd?.();
		} catch (err) {
			Logger.warn("vllm-omni", "audio decode failed", { error: String(err) });
			session.onError?.(err instanceof Error ? err : new Error(String(err)));
		}
	}

	return session;
}

async function callRest(
	cfg: VllmOmniConfig,
	messages: Array<{ role: string; content: unknown }>,
): Promise<{ audioData: string; transcript: string }> {
	const host = cfg.host.replace(/\/+$/, "");
	const resp = await fetch(`${host}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: cfg.model,
			messages,
			modalities: ["audio"],
			max_tokens: MAX_TOKENS,
			// MiniCPM-o requires TTS template to generate <|tts_bos|>/<|tts_eos|>
			// boundary tokens for proper Thinker→Talker conditioning
			chat_template_kwargs: { use_tts_template: true },
		}),
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`vllm-omni HTTP ${resp.status}: ${text}`);
	}

	const data = await resp.json();
	// vllm-omni returns two choices: choices[0] = text, choices[1] = audio
	const choices = data.choices ?? [];
	const audioChoice = choices.find(
		(c: Record<string, unknown>) =>
			(c as { message?: { audio?: { data?: string } } }).message?.audio?.data,
	) as
		| {
				message: {
					audio: { data: string; transcript?: string };
					content?: string;
				};
		  }
		| undefined;
	const textChoice = choices.find(
		(c: Record<string, unknown>) =>
			(c as { message?: { content?: string } }).message?.content,
	) as { message: { content?: string } } | undefined;

	if (!audioChoice) {
		throw new Error("vllm-omni: no audio in response");
	}

	// Transcript: prefer audio.transcript, fall back to text choice content
	const transcript =
		audioChoice.message.audio.transcript ??
		textChoice?.message?.content?.replace(/<think>[\s\S]*?<\/think>\s*/g, "") ??
		"";

	return {
		audioData: audioChoice.message.audio.data,
		transcript,
	};
}

/**
 * Parse base64 WAV → Int16Array, resampling to OUTPUT_SAMPLE_RATE if needed.
 * Pure JS — avoids AudioContext/GStreamer (WebKitGTK GStreamer range bug).
 */
function decodeWavToPcm(wavBase64: string): Int16Array {
	const bytes = base64ToUint8Array(wavBase64);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	// Parse fmt chunk (standard 44-byte WAV header layout)
	const srcSampleRate = view.getUint32(24, true);
	// const channels = view.getUint16(22, true);  // assume mono

	// Find 'data' chunk
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
			).slice(); // copy to detach from original buffer
			return srcSampleRate === OUTPUT_SAMPLE_RATE
				? pcm
				: resampleLinear(pcm, srcSampleRate, OUTPUT_SAMPLE_RATE);
		}
		offset += 8 + size;
	}
	throw new Error("vllm-omni: WAV has no data chunk");
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

/** PCM16 mono samples → WAV bytes. */
function pcmToWav(samples: Int16Array, sampleRate: number): Uint8Array {
	const dataLen = samples.byteLength;
	const buf = new ArrayBuffer(44 + dataLen);
	const view = new DataView(buf);
	const writeStr = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++)
			view.setUint8(offset + i, s.charCodeAt(i));
	};
	writeStr(0, "RIFF");
	view.setUint32(4, 36 + dataLen, true);
	writeStr(8, "WAVE");
	writeStr(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	writeStr(36, "data");
	view.setUint32(40, dataLen, true);
	new Int16Array(buf, 44).set(samples);
	return new Uint8Array(buf);
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
