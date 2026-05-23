/**
 * OpenAI Realtime API provider for live voice conversation.
 *
 * WebSocket protocol: wss://api.openai.com/v1/realtime?model=...
 * Auth: via API key in URL or headers (browser WebSocket → URL param workaround)
 *
 * Reference: https://platform.openai.com/docs/api-reference/realtime
 */
import { Logger } from "../logger";
import type {
	LiveProviderConfig,
	OpenAIRealtimeConfig,
	VoiceSession,
} from "./types";

const DEFAULT_MODEL = "gpt-4o-mini-realtime-preview";

export function createOpenAIRealtimeSession(): VoiceSession {
	let ws: WebSocket | null = null;
	let connected = false;

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
			const oai = config as OpenAIRealtimeConfig;
			const model = oai.model ?? DEFAULT_MODEL;

			const baseUrl = oai.serverUrl
				? oai.serverUrl.replace(/^http/, "ws")
				: "wss://api.openai.com";
			const params = new URLSearchParams({
				model: encodeURIComponent(model),
			});
			if (oai.serverUrl && oai.apiKey) {
				params.set("api_key", oai.apiKey);
			}
			const wsUrl = `${baseUrl.replace(/\/+$/, "")}/v1/realtime?${params.toString()}`;

			Logger.info("OpenAIRealtime", "connecting", { model, baseUrl });

			const subprotocols = oai.serverUrl
				? undefined
				: [
						"realtime",
						`openai-insecure-api-key.${oai.apiKey}`,
						"openai-beta.realtime-v1",
					];
			ws = subprotocols
				? new WebSocket(wsUrl, subprotocols)
				: new WebSocket(wsUrl);

			return new Promise<void>((resolve, reject) => {
				if (!ws) return reject(new Error("WebSocket not created"));

				const timeout = setTimeout(() => {
					reject(new Error("Connection timeout"));
					ws?.close();
				}, 15000);

				ws.onopen = () => {
					Logger.info(
						"OpenAIRealtime",
						"WebSocket connected, sending session.update",
					);
					// Send session configuration
					ws?.send(
						JSON.stringify({
							type: "session.update",
							session: {
								modalities: ["text", "audio"],
								voice: oai.voice ?? "alloy",
								input_audio_format: "pcm16",
								output_audio_format: "pcm16",
								input_audio_transcription: {
									model: "whisper-1",
								},
								turn_detection: {
									type: "server_vad",
								},
								instructions: oai.systemInstruction ?? "",
								tools: oai.tools?.map((t) => ({
									type: "function",
									name: t.name,
									description: t.description,
									parameters: t.parameters ?? {
										type: "object",
										properties: {},
									},
								})),
							},
						}),
					);
				};

				ws.onmessage = (event) => {
					try {
						const msg = JSON.parse(event.data);
						if (
							msg.type === "session.created" ||
							msg.type === "session.updated"
						) {
							clearTimeout(timeout);
							connected = true;
							Logger.info("OpenAIRealtime", "session ready");
							resolve();
							return;
						}
						if (msg.type === "error") {
							clearTimeout(timeout);
							const err = new Error(msg.error?.message || "Session error");
							reject(err);
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
					reject(err);
					session.onError?.(err);
				};

				ws.onclose = () => {
					clearTimeout(timeout);
					const wasConnected = connected;
					connected = false;
					Logger.info("OpenAIRealtime", "disconnected");
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
			// Create a text message item then trigger response
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
			case "response.audio.delta": {
				const delta = msg.delta as string | undefined;
				if (delta) {
					session.onAudio?.(delta);
				}
				break;
			}

			case "response.audio_transcript.delta": {
				const delta = msg.delta as string | undefined;
				if (delta) {
					session.onOutputTranscript?.(delta);
				}
				break;
			}

			case "conversation.item.input_audio_transcription.completed": {
				const transcript = msg.transcript as string | undefined;
				if (transcript) {
					session.onInputTranscript?.(transcript);
				}
				break;
			}

			case "response.done": {
				session.onTurnEnd?.();
				break;
			}

			case "input_audio_buffer.speech_started": {
				// User started speaking — interrupt current response
				session.onInterrupted?.();
				break;
			}

			case "response.function_call_arguments.done": {
				const callId = msg.call_id as string;
				const name = msg.name as string;
				let args: Record<string, unknown> = {};
				try {
					args = JSON.parse(msg.arguments as string);
				} catch {
					// empty args
				}
				session.onToolCall?.(callId, name, args);
				break;
			}
		}
	}

	return session;
}
