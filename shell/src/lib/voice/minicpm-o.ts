/**
 * MiniCPM-o vllm-omni /v1/realtime full-duplex WebSocket session.
 *
 * OpenAI Realtime API compatible. Server: local vllm-omni with MiniCPM-o 4.5.
 *
 * Protocol (/v1/realtime):
 *   Server → Client (on open): {"type": "session.created"}
 *   Client → Server:
 *     {"type": "session.update", "model": ..., "session": {instructions, temperature}}
 *     {"type": "input_audio_buffer.append", "audio": "<base64 PCM16 16kHz>"}
 *     {"type": "input_audio_buffer.commit"}  (end of turn audio)
 *     {"type": "response.cancel"}  (interrupt)
 *
 *   Server → Client:
 *     {"type": "response.created"}
 *     {"type": "response.audio_transcript.delta", "delta": "..."}
 *     {"type": "response.audio.delta", "delta": "<base64 PCM16 24kHz>"}
 *     {"type": "response.audio.done"}
 *     {"type": "response.audio_transcript.done", "transcript": "..."}
 *     {"type": "response.done"}
 *     {"type": "response.cancelled"}
 *     {"type": "input_audio_buffer.speech_started"}  (server VAD, optional)
 *     {"type": "input_audio_buffer.speech_stopped"}
 *     {"type": "error", "error": "..."}
 */
import { Logger } from "../logger";
import type { LiveProviderConfig, MiniCpmOConfig, VoiceSession } from "./types";

const DEFAULT_SERVER_URL = "http://localhost:8000";
const DEFAULT_MODEL = "openbmb/MiniCPM-o-4_5";

/** ms of silence after last speech chunk before committing turn */
const SILENCE_TIMEOUT_MS = 1500;
/** force commit after this many ms even if speech is continuous */
const MAX_BUFFER_MS = 6000;
/** minimum samples to bother sending (0.5s @ 16kHz) */
const MIN_AUDIO_SAMPLES = 8000;
/** RMS threshold for speech detection (Int16 scale 0–32767, ~3% of full scale) */
const SPEECH_RMS_THRESHOLD = 200;

export function createMiniCpmOSession(): VoiceSession {
	let ws: WebSocket | null = null;
	let connected = false;
	let cfg: MiniCpmOConfig | null = null;
	let silenceTimer: ReturnType<typeof setTimeout> | null = null;
	let maxBufferTimer: ReturnType<typeof setTimeout> | null = null;
	let pcmBuffer: Int16Array[] = [];
	let rmsLogThrottle = 0;
	let isAiSpeaking = false;

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

			const base = (cfg.serverUrl ?? DEFAULT_SERVER_URL)
				.replace(/\/+$/, "")
				.replace(/^http/, "ws");
			const wsUrl = `${base}/v1/realtime`;

			Logger.info("minicpm-o", "connecting", { url: wsUrl });

			ws = new WebSocket(wsUrl);

			return new Promise<void>((resolve, reject) => {
				if (!ws) return reject(new Error("WebSocket not created"));

				const timeout = setTimeout(() => {
					reject(new Error("Connection timeout"));
					ws?.close();
				}, 15000);

				let connectErrored = false;

				ws.onmessage = (event: MessageEvent) => {
					if (typeof event.data !== "string") return;
					let msg: Record<string, unknown>;
					try {
						msg = JSON.parse(event.data) as Record<string, unknown>;
					} catch {
						return;
					}

					// Handshake: wait for session.created, then send session.update
					if (!connected && msg.type === "session.created") {
						clearTimeout(timeout);
						ws?.send(
							JSON.stringify({
								type: "session.update",
								model: cfg?.model ?? DEFAULT_MODEL,
								session: {
									instructions: cfg?.systemInstruction ?? "",
								},
							}),
						);
						connected = true;
						Logger.info("minicpm-o", "connected to /v1/realtime");
						resolve();
						return;
					}

					handleMessage(msg);
				};

				ws.onerror = () => {
					clearTimeout(timeout);
					connectErrored = true;
					const err = new Error("WebSocket error");
					if (connected) {
						session.onError?.(err);
					} else {
						reject(err);
					}
				};

				ws.onclose = () => {
					clearTimeout(timeout);
					const wasConnected = connected;
					connected = false;
					Logger.info("minicpm-o", "disconnected from /v1/realtime");
					if (!wasConnected && !connectErrored) {
						reject(new Error("Connection closed before session ready"));
					}
					session.onDisconnect?.();
				};
			});
		},

		sendAudio(pcmBase64: string) {
			if (!ws || !connected) return;
			if (isAiSpeaking) return;

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
			ws.send(
				JSON.stringify({
					type: "conversation.item.create",
					item: {
						type: "message",
						role: "user",
						content: [{ type: "input_text", text }],
					},
				}),
			);
			ws.send(JSON.stringify({ type: "response.create" }));
		},

		sendToolResponse(_callId: string, _result: unknown) {
			// Tool calls not supported by vllm-omni
		},

		disconnect() {
			if (ws && connected && isAiSpeaking) {
				try {
					ws.send(JSON.stringify({ type: "response.cancel" }));
				} catch {
					// ignore
				}
			}
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
			isAiSpeaking = false;
			if (ws) {
				ws.close();
				ws = null;
			}
		},
	};

	/** Send buffered PCM as base64 append frames + commit. */
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

		const pcm = new Int16Array(totalSamples);
		let offset = 0;
		for (const chunk of pcmBuffer) {
			pcm.set(chunk, offset);
			offset += chunk.length;
		}
		pcmBuffer = [];

		session.onInputTranscript?.("🎤 음성 입력");

		try {
			const audioB64 = uint8ArrayToBase64(
				new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
			);
			ws.send(
				JSON.stringify({
					type: "input_audio_buffer.append",
					audio: audioB64,
				}),
			);
			ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
		} catch (err) {
			Logger.warn("minicpm-o", "send failed", { error: String(err) });
			session.onError?.(err instanceof Error ? err : new Error(String(err)));
			return;
		}

		Logger.debug("minicpm-o", "committed audio", { samples: totalSamples });
	}

	function handleMessage(msg: Record<string, unknown>) {
		const type = msg.type as string;

		switch (type) {
			case "response.created":
				isAiSpeaking = true;
				pcmBuffer = [];
				if (silenceTimer) {
					clearTimeout(silenceTimer);
					silenceTimer = null;
				}
				if (maxBufferTimer) {
					clearTimeout(maxBufferTimer);
					maxBufferTimer = null;
				}
				Logger.debug("minicpm-o", "response started (mic muted)");
				break;

			case "response.audio_transcript.delta": {
				const delta = msg.delta as string | undefined;
				if (delta) session.onOutputTranscript?.(delta);
				break;
			}

			case "response.audio.delta": {
				// Pass base64 PCM16 24kHz delta straight through to audio player.
				// Mirrors openai-realtime.ts — player.enqueue expects exactly this format.
				const delta = msg.delta as string | undefined;
				if (delta) session.onAudio?.(delta);
				break;
			}

			case "response.audio.done":
				Logger.debug("minicpm-o", "audio stream done");
				break;

			case "response.audio_transcript.done":
				Logger.debug("minicpm-o", "transcript done");
				break;

			case "response.done":
				isAiSpeaking = false;
				Logger.debug("minicpm-o", "response done (mic unmuted)");
				session.onTurnEnd?.();
				break;

			case "response.cancelled":
				isAiSpeaking = false;
				Logger.debug("minicpm-o", "response cancelled");
				session.onInterrupted?.();
				break;

			case "input_audio_buffer.speech_started":
				// Server-side VAD start — optional, we use client-side VAD
				break;

			case "input_audio_buffer.speech_stopped":
				// Server-side VAD end — optional
				break;

			case "error": {
				const errMsg =
					typeof msg.error === "string"
						? msg.error
						: (msg.error as Record<string, unknown>)?.message ?? "Server error";
				Logger.warn("minicpm-o", "non-fatal server error (session continues)", {
					message: errMsg,
				});
				break;
			}
		}
	}

	return session;
}

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
