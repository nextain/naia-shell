/**
 * Gemini Live API provider for live voice conversation.
 *
 * Supports two connection modes:
 * - Gateway mode: relay via any-llm gateway (naiaKey auth)
 * - Direct mode: connect to Gemini API directly (user's googleApiKey)
 */
import { Logger } from "../logger";
import type {
	GeminiLiveConfig,
	LiveProviderConfig,
	PanelContextUpdate,
	VoiceSession,
} from "./types";

const GEMINI_LIVE_WS_BASE = "wss://generativelanguage.googleapis.com/ws";
/** Direct mode: Google AI Studio model name */
const DEFAULT_MODEL_DIRECT = "gemini-2.5-flash-native-audio-preview-12-2025";
/** Gateway mode: any-llm gateway model name */
const DEFAULT_MODEL_GATEWAY = "gemini-live-2.5-flash-native-audio";

export function createGeminiLiveSession(): VoiceSession {
	let ws: WebSocket | null = null;
	let connected = false;

	const session: VoiceSession = {
		// Gemini Live hardcodes audio/pcm;rate=16000 on the wire (see sendAudio).
		// AGC on + echo gate on — unchanged from prior behavior.
		audioInput: {
			sampleRate: 16000,
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
			const gemini = config as GeminiLiveConfig;
			const isDirect = !!gemini.googleApiKey && !gemini.naiaKey;

			const defaultModel = isDirect
				? DEFAULT_MODEL_DIRECT
				: DEFAULT_MODEL_GATEWAY;
			let wsUrl: string;
			if (isDirect) {
				// Direct mode: connect to Gemini API with user's own API key
				wsUrl = `${GEMINI_LIVE_WS_BASE}/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${gemini.googleApiKey}`;
				Logger.info("GeminiLive", "connecting direct", {
					model: gemini.model ?? defaultModel,
					wsUrl: wsUrl.replace(/key=.*/, "key=***"),
				});
			} else {
				// Gateway mode: relay via any-llm gateway
				const base = gemini.gatewayUrl ?? "";
				wsUrl = `${base.replace(/^http/, "ws")}/v1/live`;
				Logger.info("GeminiLive", "connecting via gateway", {
					gateway: base,
					model: gemini.model ?? defaultModel,
				});
			}

			ws = new WebSocket(wsUrl);

			return new Promise<void>((resolve, reject) => {
				if (!ws) return reject(new Error("WebSocket not created"));

				const timeout = setTimeout(() => {
					reject(new Error("Connection timeout"));
					ws?.close();
				}, 15000);

				ws.onopen = () => {
					Logger.info("GeminiLive", "WebSocket connected, sending setup");
					const model = gemini.model ?? defaultModel;

					if (isDirect) {
						// Direct mode: Gemini API native setup format
						const langCode = gemini.locale ?? "ko-KR";
						ws?.send(
							JSON.stringify({
								setup: {
									model: `models/${model}`,
									generationConfig: {
										responseModalities: ["AUDIO"],
										speechConfig: {
											voiceConfig: {
												prebuiltVoiceConfig: {
													voiceName: gemini.voice ?? "Kore",
												},
											},
											languageCode: langCode,
										},
									},
									inputAudioTranscription: {},
									outputAudioTranscription: {},
									systemInstruction: gemini.systemInstruction
										? {
												parts: [{ text: gemini.systemInstruction }],
											}
										: undefined,
									tools: gemini.tools?.length
										? [
												{
													functionDeclarations: gemini.tools,
												},
											]
										: undefined,
								},
							}),
						);
					} else {
						// Gateway mode: any-llm gateway format
						ws?.send(
							JSON.stringify({
								setup: {
									apiKey: `Bearer ${gemini.naiaKey}`,
									voice: gemini.voice ?? "Kore",
									languageCode: gemini.locale ?? "ko-KR",
									systemInstruction: gemini.systemInstruction,
									tools: gemini.tools,
									model,
								},
							}),
						);
					}
				};

				ws.onmessage = (event) => {
					try {
						const msg = JSON.parse(event.data);
						if (!connected) {
							Logger.info("GeminiLive", "pre-setup message", {
								keys: Object.keys(msg),
							});
						}
						if (msg.setupComplete) {
							clearTimeout(timeout);
							connected = true;
							Logger.info("GeminiLive", "setup complete");
							resolve();
							return;
						}
						if (msg.error) {
							clearTimeout(timeout);
							const err = new Error(msg.error.message || "Setup failed");
							reject(err);
							session.onError?.(err);
							return;
						}
						handleMessage(msg);
					} catch {
						// ignore malformed
					}
				};

				ws.onerror = (ev) => {
					clearTimeout(timeout);
					Logger.warn("GeminiLive", "WebSocket error", { event: String(ev) });
					const err = new Error("WebSocket error");
					reject(err);
					session.onError?.(err);
				};

				ws.onclose = (ev) => {
					clearTimeout(timeout);
					const wasConnected = connected;
					connected = false;
					Logger.info("GeminiLive", "disconnected", {
						code: ev.code,
						reason: ev.reason,
					});
					if (!wasConnected) {
						reject(
							new Error(
								`Connection closed before setup completed (code=${ev.code} reason=${ev.reason || "none"})`,
							),
						);
					}
					session.onDisconnect?.();
				};
			});
		},

		sendAudio(pcmBase64: string) {
			if (!ws || !connected) return;
			ws.send(
				JSON.stringify({
					realtimeInput: {
						mediaChunks: [
							{
								mimeType: "audio/pcm;rate=16000",
								data: pcmBase64,
							},
						],
					},
				}),
			);
		},

		sendText(text: string) {
			if (!ws || !connected) return;
			ws.send(
				JSON.stringify({
					clientContent: {
						turns: [{ role: "user", parts: [{ text }] }],
						turnComplete: true,
					},
				}),
			);
		},

		sendToolResponse(callId: string, result: unknown) {
			if (!ws || !connected) return;
			ws.send(
				JSON.stringify({
					toolResponse: {
						functionResponses: [{ id: callId, response: { result } }],
					},
				}),
			);
		},

		// #313 L3 — mid-session panel context bridge.
		//
		// Gemini Live's `clientContent` event with `turnComplete: false` appends
		// the parts to the running session context WITHOUT triggering a model
		// response (per Live API docs: turn boundaries are user-controlled; an
		// incomplete turn is treated as additional grounding for the next model
		// turn). We use this surface to inject panel-state deltas (e.g. browser
		// URL change) so the model's NEXT spoken turn is grounded in current
		// world state instead of the snapshot frozen at session open.
		//
		// Payload is a compact text serialization of the panel context — kept
		// minimal so rapid URL hops (debounced upstream at 500ms) do not fill
		// the WS with bloated JSON. Drops silently when WS is not connected so
		// the bridge can fire-and-forget without paused/closed checks.
		sendContextUpdate(ctx: PanelContextUpdate) {
			if (!ws || !connected) return;
			if (!ctx || typeof ctx !== "object" || !ctx.type) return;
			let serialized: string;
			try {
				serialized = JSON.stringify(ctx.data ?? {});
			} catch {
				// Circular refs / BigInt etc. — drop rather than crash the WS.
				Logger.warn("GeminiLive", "sendContextUpdate: non-serializable data", {
					type: ctx.type,
				});
				return;
			}
			const text = `[panel-context:${ctx.type}] ${serialized}`;
			ws.send(
				JSON.stringify({
					clientContent: {
						turns: [{ role: "user", parts: [{ text }] }],
						// turnComplete:false — append to running context, do NOT
						// solicit a new model response. Critical: setting true here
						// would make every URL change generate a spoken reply.
						turnComplete: false,
					},
				}),
			);
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
		const sc = msg.serverContent as Record<string, unknown> | undefined;
		if (sc) {
			const mt = sc.modelTurn as
				| {
						parts?: {
							inlineData?: { data: string };
							text?: string;
						}[];
				  }
				| undefined;
			if (mt?.parts) {
				for (const part of mt.parts) {
					if (part.inlineData?.data) {
						session.onAudio?.(part.inlineData.data);
					}
				}
			}

			const itx = sc.inputTranscription as { text?: string } | undefined;
			if (itx?.text) {
				session.onInputTranscript?.(itx.text);
			}

			const otx = sc.outputTranscription as { text?: string } | undefined;
			if (otx?.text) {
				session.onOutputTranscript?.(otx.text);
			}

			if (sc.turnComplete) {
				session.onTurnEnd?.();
			}

			if (sc.interrupted) {
				session.onInterrupted?.();
			}
		}

		const tc = msg.toolCall as
			| {
					functionCalls?: {
						id: string;
						name: string;
						args: Record<string, unknown>;
					}[];
			  }
			| undefined;
		if (tc?.functionCalls) {
			for (const fc of tc.functionCalls) {
				session.onToolCall?.(fc.id, fc.name, fc.args ?? {});
			}
		}
	}

	return session;
}
