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

// ─── Live tool schema normalization (#313 L2) ──────────────────────────────────
//
// Gemini Live sends `tools` once at session setup. If a tool's parameters are
// `{type:"object", properties:{}}` while a richer JSON schema exists in the
// panel/skill registry, the model never learns the real argument shape and
// downstream tool_call args come back malformed. `normalizeLiveTools` hydrates
// empty-schema tools from a canonical registry; unknown tools pass through
// with a warning so the live setup payload is never silently dropped.
//
// Out of scope (#313 L3): naia-agent lab-proxy-live tool_call round-trip wiring
// and the HTTP tool path (which goes through a different normalization stage).

/**
 * Minimal JSON-Schema-ish shape that Gemini Live setup expects per function.
 * Kept structurally compatible with `Record<string, unknown>` so callers can
 * pass either a typed schema or an arbitrary JSON object from a registry.
 */
export interface LiveToolParameters {
	type: "object";
	properties?: Record<string, unknown>;
	required?: string[];
	[k: string]: unknown;
}

/** The on-wire shape: function declaration for Gemini Live setup. */
export interface LiveToolDef {
	name: string;
	description: string;
	parameters?: Record<string, unknown>;
}

/**
 * Lookup of canonical tool schemas keyed by tool name. Sources:
 * - active panel descriptor `tools` (panel-registry.ts)
 * - agent skill list (chat-service.ts: fetchAgentSkills)
 *
 * Callers build this map once at session setup, then pass it to
 * `normalizeLiveTools` together with the tool list actually being sent.
 */
export type LiveToolRegistry = Map<string, Record<string, unknown>>;

/**
 * Returns true when `params` is missing, not an object schema, or is the
 * empty default `{type:"object", properties:{}}` (or `properties` absent).
 * Tools with zero declared args legitimately produce this shape, but they
 * are indistinguishable from the inline fallback at ChatPanel.tsx:1676.
 */
function isEmptySchema(params: LiveToolDef["parameters"] | undefined): boolean {
	if (!params || typeof params !== "object") return true;
	const obj = params as Record<string, unknown>;
	if (obj.type !== "object") return true;
	const props = obj.properties as Record<string, unknown> | undefined;
	if (!props || typeof props !== "object") return true;
	return Object.keys(props).length === 0;
}

function hasNonEmptySchema(
	params: LiveToolParameters | Record<string, unknown> | undefined,
): boolean {
	if (!params || typeof params !== "object") return false;
	const props = (params as Record<string, unknown>).properties as
		| Record<string, unknown>
		| undefined;
	return !!props && typeof props === "object" && Object.keys(props).length > 0;
}

/**
 * Normalize a list of tools destined for a Gemini Live `setup.tools` payload.
 *
 * Behavior:
 * 1. Tools that already carry a non-empty `properties` schema are passed
 *    through unchanged (the registry shouldn't second-guess what the tool
 *    author declared).
 * 2. Tools whose schema is empty/missing AND for which `registry` has a
 *    non-empty canonical schema are hydrated with that registry schema.
 * 3. Tools whose schema is empty/missing AND have no registry entry are
 *    passed through unmodified — a single warn is logged so the live
 *    payload is observable rather than silently truncated. Genuinely
 *    zero-arg tools (e.g. `skill_browser_back`) fall into this branch and
 *    that is correct.
 * 4. Malformed entries (non-object `parameters` value, e.g. an accidental
 *    `parameters: "object"` string) are warned and passed through with
 *    `parameters` untouched so the upstream API can reject loudly if needed.
 */
export function normalizeLiveTools(
	tools: LiveToolDef[],
	registry: LiveToolRegistry,
): LiveToolDef[] {
	if (!Array.isArray(tools) || tools.length === 0) return [];

	return tools.map((tool) => {
		if (!tool || typeof tool !== "object" || !tool.name) {
			Logger.warn(
				"GeminiLive",
				"normalizeLiveTools: dropped malformed tool entry",
				{ tool },
			);
			return tool;
		}

		// 4) Detect non-object parameters values — pass through + warn.
		if (
			tool.parameters !== undefined &&
			(typeof tool.parameters !== "object" || tool.parameters === null)
		) {
			Logger.warn(
				"GeminiLive",
				"normalizeLiveTools: tool has non-object parameters, passing through",
				{ name: tool.name },
			);
			return tool;
		}

		// 1) Already rich — leave untouched.
		if (hasNonEmptySchema(tool.parameters)) {
			return tool;
		}

		// 2) Empty/default schema — try registry hydration.
		const canonical = registry.get(tool.name);
		if (canonical && hasNonEmptySchema(canonical)) {
			return { ...tool, parameters: canonical };
		}

		// 3) Empty schema, no canonical replacement — passthrough + warn once.
		if (isEmptySchema(tool.parameters)) {
			Logger.warn(
				"GeminiLive",
				"normalizeLiveTools: no canonical schema for tool, passthrough",
				{ name: tool.name },
			);
		}
		return tool;
	});
}

const GEMINI_LIVE_WS_BASE = "wss://generativelanguage.googleapis.com/ws";
/** Direct mode: Google AI Studio model name */
const DEFAULT_MODEL_DIRECT = "gemini-2.5-flash-native-audio-preview-12-2025";
/** Gateway mode: any-llm gateway model name */
const DEFAULT_MODEL_GATEWAY = "gemini-live-2.5-flash-native-audio";

export function createGeminiLiveSession(): VoiceSession {
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

		sendToolResponse(callId: string, toolName: string, result: unknown) {
			if (!ws || !connected) return;
			ws.send(
				JSON.stringify({
					toolResponse: {
						functionResponses: [
							{ id: callId, name: toolName, response: { result } },
						],
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
