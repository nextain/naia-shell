/**
 * Azure Voice Live via any-llm `/v1/voice-live`.
 * First client message is gateway setup; later messages are Azure Realtime events.
 */
import { Logger } from "../logger";
import type {
	AzureVoiceLiveConfig,
	LiveProviderConfig,
	VoiceSession,
} from "./types";

export function createAzureVoiceLiveSession(): VoiceSession {
	let ws: WebSocket | null = null;
	let connected = false;

	const session: VoiceSession = {
		audioInput: {
			sampleRate: 24000,
			autoGainControl: true,
			gateWhilePlaying: true,
		},
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
			const azure = config as AzureVoiceLiveConfig;
			const base = (azure.gatewayUrl ?? "").replace(/\/$/, "");
			const wsUrl = `${base.replace(/^http/, "ws")}/v1/voice-live`;
			Logger.info("AzureVoiceLive", "connecting", { gateway: base });
			ws = new WebSocket(wsUrl);

			return new Promise<void>((resolve, reject) => {
				if (!ws) return reject(new Error("WebSocket not created"));
				const timeout = setTimeout(() => {
					reject(new Error("Connection timeout"));
					ws?.close();
				}, 15000);

				ws.onopen = () => {
					ws?.send(
						JSON.stringify({
							setup: {
								apiKey: azure.naiaKey,
								model: azure.model ?? "azure-realtime",
								voice: azure.voice ?? "sunhi",
								systemInstruction: azure.systemInstruction ?? "",
							},
						}),
					);
				};

				ws.onmessage = (event) => {
					try {
						const msg = JSON.parse(String(event.data));
						if (msg.setupComplete) {
							clearTimeout(timeout);
							connected = true;
							resolve();
							return;
						}
						if (msg.error) {
							clearTimeout(timeout);
							const err = new Error(
								String(msg.error.message ?? "Azure Voice Live error"),
							);
							if (!connected) reject(err);
							session.onError?.(err);
							return;
						}
						handleMessage(msg);
					} catch {
						// ignore malformed
					}
				};

				ws.onerror = () => {
					clearTimeout(timeout);
					const err = new Error("WebSocket error");
					if (!connected) reject(err);
					session.onError?.(err);
				};

				ws.onclose = () => {
					clearTimeout(timeout);
					const wasConnected = connected;
					connected = false;
					if (!wasConnected) {
						reject(new Error("Connection closed before session created"));
					}
					session.onDisconnect?.();
				};
			});
		},

		sendAudio(pcmBase64: string) {
			if (!ws || !connected) return;
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

		sendToolResponse(callId: string, result: unknown) {
			if (!ws || !connected) return;
			ws.send(
				JSON.stringify({
					type: "conversation.item.create",
					item: {
						type: "function_call_output",
						call_id: callId,
						output:
							typeof result === "string" ? result : JSON.stringify(result),
					},
				}),
			);
			ws.send(JSON.stringify({ type: "response.create" }));
		},

		disconnect() {
			connected = false;
			if (ws) {
				ws.close();
				ws = null;
			}
		},
	};

	function handleMessage(msg: Record<string, unknown>) {
		const type = msg.type as string;
		switch (type) {
			case "response.audio.delta":
			case "response.output_audio.delta": {
				const delta = msg.delta as string | undefined;
				if (delta) session.onAudio?.(delta);
				break;
			}
			case "response.audio_transcript.delta": {
				const delta = msg.delta as string | undefined;
				if (delta) session.onOutputTranscript?.(delta);
				break;
			}
			case "conversation.item.input_audio_transcription.completed": {
				const transcript = msg.transcript as string | undefined;
				if (transcript) session.onInputTranscript?.(transcript);
				break;
			}
			case "response.done":
				session.onTurnEnd?.();
				break;
			case "input_audio_buffer.speech_started":
				session.onInterrupted?.();
				break;
			default:
				break;
		}
	}

	return session;
}
