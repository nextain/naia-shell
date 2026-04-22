/**
 * MiniCPM-o vllm-omni /v1/realtime full-duplex WebSocket session.
 *
 * OpenAI Realtime API compatible. Server: local vllm-omni with MiniCPM-o 4.5.
 *
 * This implementation uses server-side Voice Activity Detection (VAD) and
 * streams audio chunks directly to the server, mirroring the behavior of
 * the `openai-realtime.ts` provider for maximum performance and low latency.
 *
 * Protocol (/v1/realtime):
 *   Server → Client (on open): {"type": "session.created"}
 *   Client → Server:
 *     {"type": "session.update", "model": ..., "session": {..., turn_detection}}
 *     {"type": "input_audio_buffer.append", "audio": "<base64 PCM16 16kHz>"}
 *     {"type": "response.cancel"}  (interrupt)
 *
 *   Server → Client:
 *     {"type": "response.created"}
 *     {"type": "response.audio_transcript.delta", "delta": "..."}
 *     {"type": "response.audio.delta", "delta": "<base64 PCM16 24kHz>"}
 *     {"type": "response.done"}
 *     {"type": "response.cancelled"}
 *     {"type": "error", "error": "..."}
 */
import { Logger } from "../logger";
import type { LiveProviderConfig, MiniCpmOConfig, VoiceSession } from "./types";

const DEFAULT_SERVER_URL = "http://localhost:8000";
const DEFAULT_MODEL = "openbmb/MiniCPM-o-4_5";

export function createMiniCpmOSession(): VoiceSession {
	let ws: WebSocket | null = null;
	let connected = false;
	let cfg: MiniCpmOConfig | null = null;
	let isAiSpeaking = false; // Used for local cancellation logic

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
									modalities: ["text", "audio"],
									input_audio_format: "pcm16",
									output_audio_format: "pcm16",
									instructions: cfg?.systemInstruction ?? "",
									turn_detection: { type: "server_vad" },
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

				ws.onclose = (event) => {
					clearTimeout(timeout);
					const wasConnected = connected;
					connected = false;
					Logger.info("minicpm-o", "disconnected from /v1/realtime", {
						code: event.code,
						reason: event.reason,
						wasClean: event.wasClean,
					});
					if (!wasConnected && !connectErrored) {
						reject(new Error("Connection closed before session ready"));
					}
					session.onDisconnect?.();
				};
			});
		},

		sendAudio(pcmBase64: string) {
			if (!ws || !connected) return;
			// Gating is handled by the caller (ChatPanel) based on player state.
			// This function just streams the audio chunks.
			ws.send(
				JSON.stringify({
					type: "input_audio_buffer.append",
					audio: pcmBase64,
				}),
			);
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
			isAiSpeaking = false;
			if (ws) {
				ws.close();
				ws = null;
			}
		},
	};

	function handleMessage(msg: Record<string, unknown>) {
		const type = msg.type as string;

		switch (type) {
			case "response.created":
				isAiSpeaking = true;
				Logger.debug("minicpm-o", "response started");
				break;

			case "response.audio_transcript.delta": {
				const delta = msg.delta as string | undefined;
				if (delta) session.onOutputTranscript?.(delta);
				break;
			}

			case "response.audio.delta": {
				// Pass base64 PCM16 24kHz delta straight through to audio player.
				const delta = msg.delta as string | undefined;
				if (delta) session.onAudio?.(delta);
				break;
			}

			case "response.done":
				isAiSpeaking = false;
				Logger.debug("minicpm-o", "response done");
				session.onTurnEnd?.();
				break;

			case "response.cancelled":
				isAiSpeaking = false;
				Logger.debug("minicpm-o", "response cancelled");
				session.onInterrupted?.();
				break;

			case "input_audio_buffer.speech_started":
				// Server VAD detected user speech while AI was responding.
				// Defensively send response.cancel — vllm-omni auto-cancel behavior
				// on speech_started is unverified; idempotent if already cancelled.
				if (isAiSpeaking && ws) {
					try {
						ws.send(JSON.stringify({ type: "response.cancel" }));
					} catch {
						// ignore
					}
				}
				session.onInterrupted?.();
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
