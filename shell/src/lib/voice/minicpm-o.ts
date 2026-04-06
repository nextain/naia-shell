/**
 * MiniCPM-o vllm-omni /v1/realtime WebSocket session.
 *
 * Connects to vllm-omni's /v1/realtime endpoint (OpenAI Realtime-style ASR).
 * Audio input → text transcription output.
 *
 * Protocol (vllm /v1/realtime):
 *   Client → Server: session.update, input_audio_buffer.append, input_audio_buffer.commit
 *   Server → Client: session.created, transcription.delta, transcription.done, error
 *
 * Audio input: 16kHz PCM16 mono (base64)
 * Output: text transcription (no audio output — see vllm-omni.ts for audio output)
 *
 * Server: vllm-omni with MiniCPM-o 4.5 on port 8000
 *   distrobox enter vllm-dev -- bash scripts/serve_async_chunk.sh
 */
import { Logger } from "../logger";
import type { LiveProviderConfig, MiniCpmOConfig, VoiceSession } from "./types";

const DEFAULT_SERVER_URL = "http://localhost:8000";

const SILENCE_TIMEOUT_MS = 1500;
const MIN_AUDIO_SAMPLES = 8000; // 0.5s @ 16kHz
const SPEECH_RMS_THRESHOLD = 1000; // ~3% of Int16 full scale

export function createMiniCpmOSession(): VoiceSession {
	let ws: WebSocket | null = null;
	let connected = false;
	let cfg: MiniCpmOConfig | null = null;
	let silenceTimer: ReturnType<typeof setTimeout> | null = null;
	let pcmBuffer: Int16Array[] = [];

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

			// Accept http:// or ws:// serverUrl — derive WebSocket URL
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

				ws.onopen = () => {
					// Send session.update to configure model (triggers model validation)
					ws?.send(
						JSON.stringify({
							type: "session.update",
							model: cfg?.model ?? "openbmb/MiniCPM-o-4_5",
						}),
					);
				};

				ws.onmessage = (event) => {
					try {
						const msg = JSON.parse(event.data);
						if (msg.type === "session.created") {
							clearTimeout(timeout);
							connected = true;
							Logger.info("minicpm-o", "session created", { id: msg.id });
							resolve();
							return;
						}
						if (msg.type === "error") {
							clearTimeout(timeout);
							const err = new Error(msg.error || "Session error");
							reject(err);
							session.onError?.(err);
							return;
						}
						handleMessage(msg);
					} catch {
						// ignore malformed messages
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
					Logger.info("minicpm-o", "disconnected");
					if (!wasConnected) {
						reject(new Error("Connection closed before session created"));
					}
					session.onDisconnect?.();
				};
			});
		},

		sendAudio(pcmBase64: string) {
			if (!ws || !connected) return;

			// Buffer and send to server
			ws.send(
				JSON.stringify({
					type: "input_audio_buffer.append",
					audio: pcmBase64,
				}),
			);

			// Silence detection: commit when speech pauses
			const bytes = base64ToUint8Array(pcmBase64);
			const samples = new Int16Array(
				bytes.buffer,
				bytes.byteOffset,
				bytes.byteLength / 2,
			);
			pcmBuffer.push(samples.slice());

			const isSpeech = rms(samples) >= SPEECH_RMS_THRESHOLD;
			if (isSpeech) {
				if (silenceTimer) clearTimeout(silenceTimer);
				silenceTimer = setTimeout(() => {
					silenceTimer = null;
					commitAudio();
				}, SILENCE_TIMEOUT_MS);
			} else if (!silenceTimer) {
				silenceTimer = setTimeout(() => {
					silenceTimer = null;
					commitAudio();
				}, SILENCE_TIMEOUT_MS);
			}
		},

		sendText(_text: string) {
			// vllm /v1/realtime is ASR-only; text input not supported
		},

		sendToolResponse(_callId: string, _result: unknown) {
			// Tool calls not supported
		},

		disconnect() {
			connected = false;
			if (silenceTimer) {
				clearTimeout(silenceTimer);
				silenceTimer = null;
			}
			pcmBuffer = [];
			if (ws) {
				ws.close();
				ws = null;
			}
		},
	};

	function commitAudio() {
		if (!ws || !connected) return;

		const totalSamples = pcmBuffer.reduce((n, c) => n + c.length, 0);
		pcmBuffer = [];

		if (totalSamples < MIN_AUDIO_SAMPLES) {
			Logger.debug("minicpm-o", "audio too short, skipping commit", {
				samples: totalSamples,
			});
			return;
		}

		// Commit buffered audio to trigger inference
		ws.send(JSON.stringify({ type: "input_audio_buffer.commit", final: false }));
		Logger.debug("minicpm-o", "committed audio", { samples: totalSamples });
	}

	function handleMessage(msg: Record<string, unknown>) {
		const type = msg.type as string;

		switch (type) {
			case "transcription.delta": {
				// Incremental transcription text
				const delta = msg.delta as string | undefined;
				if (delta) {
					session.onOutputTranscript?.(delta);
				}
				break;
			}

			case "transcription.done": {
				// Final transcription
				const text = msg.text as string | undefined;
				if (text) {
					Logger.info("minicpm-o", "transcription done", { text });
				}
				session.onTurnEnd?.();
				break;
			}

			case "error": {
				const err = new Error(
					(msg.error as string) || "Server error",
				);
				Logger.warn("minicpm-o", "server error", { error: msg });
				session.onError?.(err);
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
