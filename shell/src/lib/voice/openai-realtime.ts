/**
 * OpenAI Realtime API provider for live voice conversation.
 *
 * WebSocket protocol: wss://api.openai.com/v1/realtime?model=...
 * Auth: via API key in URL or headers (browser WebSocket → URL param workaround)
 *
 * Client-side VAD pattern mirrors naia-talk.ts / vllm-omni.ts for
 * consistent benchmark measurements across all voice providers.
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

/** ms of silence after last speech chunk before committing turn */
const SILENCE_TIMEOUT_MS = 1500;
/** force commit after this many ms even if speech is continuous */
const MAX_BUFFER_MS = 6000;
/** minimum samples to bother sending (0.5s @ 16kHz) */
const MIN_AUDIO_SAMPLES = 8000;
/** RMS threshold for client-side speech detection (Int16 scale 0–32767) */
const SPEECH_RMS_THRESHOLD = 200;

export function createOpenAIRealtimeSession(): VoiceSession {
	let ws: WebSocket | null = null;
	let connected = false;
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
					clearTurnTimers();
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
				Logger.debug("OpenAIRealtime", "RMS sample", {
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

		sendToolResponse(callId: string, _toolName: string, result: unknown) {
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
			if (ws && connected && isAiSpeaking) {
				try {
					ws.send(JSON.stringify({ type: "response.cancel" }));
				} catch {
					// ignore
				}
			}
			connected = false;
			clearTurnTimers();
			pcmBuffer = [];
			rmsLogThrottle = 0;
			isAiSpeaking = false;
			if (ws) {
				ws.close();
				ws = null;
			}
		},
	};

	function clearTurnTimers() {
		if (silenceTimer) {
			clearTimeout(silenceTimer);
			silenceTimer = null;
		}
		if (maxBufferTimer) {
			clearTimeout(maxBufferTimer);
			maxBufferTimer = null;
		}
	}

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
			ws.send(
				JSON.stringify({
					type: "input_audio_buffer.append",
					audio: uint8ArrayToBase64(
						new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
					),
				}),
			);
			ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
			isAiSpeaking = true;
		} catch (err) {
			Logger.warn("OpenAIRealtime", "send failed", { error: String(err) });
			session.onError?.(err instanceof Error ? err : new Error(String(err)));
		}

		Logger.debug("OpenAIRealtime", "committed audio", { samples: totalSamples });
	}

	function handleMessage(msg: Record<string, unknown>) {
		const type = msg.type as string;

		switch (type) {
			case "response.created":
				isAiSpeaking = true;
				Logger.debug("OpenAIRealtime", "response started");
				break;

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
				isAiSpeaking = false;
				Logger.debug("OpenAIRealtime", "response done");
				session.onTurnEnd?.();
				break;
			}

			case "response.cancelled":
				isAiSpeaking = false;
				Logger.debug("OpenAIRealtime", "response cancelled");
				session.onInterrupted?.();
				break;

			case "input_audio_buffer.speech_started": {
				if (isAiSpeaking && ws) {
					try {
						ws.send(JSON.stringify({ type: "response.cancel" }));
					} catch {
						// ignore
					}
				}
				session.onInterrupted?.();
				break;
			}

			case "error": {
				const errMsg =
					(msg.error as Record<string, unknown>)?.message ||
					msg.message ||
					"Server error";
				Logger.warn("OpenAIRealtime", "server error", {
					message: String(errMsg),
				});
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

function rms(samples: Int16Array): number {
	if (samples.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
	return Math.sqrt(sum / samples.length);
}

function base64ToUint8Array(b64: string): Uint8Array {
	let bin: string;
	try {
		bin = atob(b64);
	} catch {
		return new Uint8Array(0);
	}
	const arr = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
	return arr;
}

function uint8ArrayToBase64(arr: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
	return btoa(bin);
}
