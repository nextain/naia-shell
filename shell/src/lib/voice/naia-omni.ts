/**
 * Naia Omni /v1/realtime full-duplex WebSocket session.
 *
 * OpenAI Realtime API compatible. Connects to naia-anyllm gateway or local vllm-omni.
 *
 * This implementation uses server-side Voice Activity Detection (VAD) and
 * streams audio chunks directly to the server, mirroring the behavior of
 * the `openai-realtime.ts` provider for maximum performance and low latency.
 * `sendAudio` is a pure passthrough — no client-side buffering, silence
 * timer, or manual commit. The server's silero VAD auto-commits and responds
 * on end-of-speech. The AI-speaking echo gate lives in ChatPanel
 * (`audioInput.gateWhilePlaying`), not here.
 *
 * Protocol (/v1/realtime):
 *   Server → Client (on open): {"type": "session.created"}
 *   Client → Server:
 *     {"type": "session.update", "model": ..., "session": {..., turn_detection}}
 *     {"type": "input_audio_buffer.append", "audio": "<base64 PCM16 24kHz>"}
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
import { emotionTagsToChatText } from "./emotion-tags";
import {
	ColdStartTimeoutError,
	SoldOutError,
	abandonPod,
} from "./ondemand-retry";
import { RefAudioEncodeError, encodeRefAudio } from "./ref-audio";
import type {
	LiveProviderConfig,
	NaiaOmniConfig,
	VoiceCloseReason,
	VoiceConnectionStatus,
	VoiceSession,
} from "./types";

const COLD_START_CAP_MS = 10 * 60 * 1000; // server v15: 10 min cap (CLIENT-ONDEMAND-CONTRACT)
const INITIAL_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

const DEFAULT_SERVER_URL = "http://localhost:8000";
const DEFAULT_MODEL = "naia-0.9-omni-24g";
const GATEWAY_REALTIME_PATH = "/v1/realtime";

/** PCM capture rate (Hz) sent on the wire. Server INPUT_SR default = 24000. */
const INPUT_SAMPLE_RATE = 24000;

/** Schemes accepted for `serverUrl` before conversion to `ws(s)://`. */
const ALLOWED_SERVER_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

export function createNaiaOmniSession(): VoiceSession {
	let ws: WebSocket | null = null;
	let connected = false;
	let cfg: NaiaOmniConfig | null = null;
	let isAiSpeaking = false;
	// Cold-start cancellation: disconnect() during a pod-starting retry sets
	// `aborted`, signals `connectAbort` to break the backoff sleep immediately,
	// and (if a Pod is warming) fires abandonPod so we stop paying for it.
	let aborted = false;
	let coldStartActive = false;
	let connectAbort: AbortController | null = null;

	const session: VoiceSession = {
		audioInput: {
			// Server INPUT_SR=24000; stream raw mic to server VAD with no AGC so
			// true energy reaches the VAD. Echo gate stays on (WebKitGTK weak AEC)
			// — it only drops sub-threshold chunks while the AI speaks.
			sampleRate: INPUT_SAMPLE_RATE,
			autoGainControl: false,
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
		onStatusChange: null,

		get isConnected() {
			return connected;
		},

		async connect(config: LiveProviderConfig) {
			cfg = config as NaiaOmniConfig;
			aborted = false;
			coldStartActive = false;
			connectAbort = new AbortController();
			const abortSignal = connectAbort.signal;

			const useGateway = !!(cfg.gatewayUrl && cfg.naiaKey);

			let wsUrl: string;
			if (useGateway) {
				const normalizedGw = normalizeServerUrl(cfg.gatewayUrl!);
				if (!normalizedGw) {
					throw new Error(
						`Invalid gatewayUrl: expected http(s):// or ws(s)://, got ${cfg.gatewayUrl}`,
					);
				}
				const modelParam = encodeURIComponent(cfg.model ?? DEFAULT_MODEL);
				wsUrl = `${normalizedGw}${GATEWAY_REALTIME_PATH}?model=${modelParam}`;
			} else {
				const normalizedBase = normalizeServerUrl(
					cfg.serverUrl ?? DEFAULT_SERVER_URL,
				);
				if (!normalizedBase) {
					throw new Error(
						`Invalid serverUrl: expected http(s):// or ws(s)://, got ${cfg.serverUrl}`,
					);
				}
				wsUrl = `${normalizedBase}/v1/realtime`;
			}

			let encodedRefAudio: string | null = null;
			if (cfg.refAudio !== undefined && cfg.refAudio !== null) {
				try {
					encodedRefAudio = await encodeRefAudio(cfg.refAudio);
				} catch (err) {
					if (err instanceof RefAudioEncodeError) {
						Logger.warn("naia-omni", "ref audio rejected", {
							error: err.message,
						});
						throw err;
					}
					throw err;
				}
			}

			Logger.info("naia-omni", "connecting", {
				url: sanitizeUrl(wsUrl),
				mode: useGateway ? "gateway" : "direct",
				hasRefAudio: encodedRefAudio !== null,
			});

			// On-demand retry loop (CONTRACT §3): 503 pod-starting → backoff, sold-out → throw
			emitStatus({ phase: "connecting" });
			const retryStart = Date.now();
			let retryDelay = INITIAL_RETRY_MS;
			let attempt = 0;

			const attemptConnect = (): Promise<void> => {
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

						if (!connected && useGateway && msg.error) {
							clearTimeout(timeout);
							connectErrored = true;
							const errMsg = extractServerErrorMessage(msg);
							reject(new Error(errMsg));
							return;
						}

						// SoT §4 admission status events (mirrors naia.nextain.io
						// naia-omni-client #34): the gateway sends a typed JSON status,
						// then closes 4503/4409. preparing/queued = cold-start WAIT →
						// reuse the retry loop (same instanceId re-enters arrival until
						// READY). sold_out / consent_required / session.error = terminal.
						// The msg.error branch above still handles the legacy error-string
						// wire, so both transports are supported.
						if (!connected) {
							const tp = msg.type as string;
							if (tp === "session.preparing" || tp === "session.queued") {
								clearTimeout(timeout);
								connectErrored = true;
								const eta =
									typeof msg.eta_s === "number" ? msg.eta_s : undefined;
								const pos =
									typeof msg.position === "number" ? msg.position : undefined;
								reject(
									new Error(
										`pod-starting${eta != null ? `:eta=${eta}` : ""}${pos != null ? `:pos=${pos}` : ""}`,
									),
								);
								return;
							}
							if (tp === "session.sold_out") {
								clearTimeout(timeout);
								connectErrored = true;
								reject(new Error("sold-out"));
								return;
							}
							if (tp === "session.consent_required") {
								// Same account already has a live session. The branch
								// (replace/add) selection protocol is not yet defined by the
								// gateway or the manual, so surface a terminal consent state
								// instead of guessing the send-back wire.
								clearTimeout(timeout);
								connectErrored = true;
								reject(new Error("consent-required"));
								return;
							}
							if (tp === "session.error") {
								clearTimeout(timeout);
								connectErrored = true;
								reject(new Error(extractServerErrorMessage(msg)));
								return;
							}
						}

						if (!connected && msg.type === "session.created") {
							clearTimeout(timeout);
							const sessionPayload: Record<string, unknown> = {
								modalities: ["text", "audio"],
								input_audio_format: "pcm16",
								output_audio_format: "pcm16",
								instructions: cfg?.systemInstruction ?? "",
								turn_detection: { type: "server_vad" },
								// Forward skills as OpenAI-style function tools so the cascade
								// registers them (tools_registry) and the LLM can actually emit
								// tool calls. Without this the server's registry stays empty and
								// no tool call is ever generated. Server expects flat
								// {type:"function", name, description, parameters}.
								...(cfg?.tools && cfg.tools.length > 0
									? {
											tools: cfg.tools.map((t) => ({
												type: "function",
												name: t.name,
												description: t.description,
												parameters: t.parameters ?? {
													type: "object",
													properties: {},
												},
											})),
										}
									: {}),
								// #15: prefer a URL (preset sample_url / upload URL) over a
								// heavy base64 blob — backend downloads it once. Server
								// priority: ref_audio_url > ref_audio > x-naia-voice-ref.
								...(cfg?.refAudioUrl ? { ref_audio_url: cfg.refAudioUrl } : {}),
							};
							if (encodedRefAudio !== null) {
								sessionPayload.ref_audio = encodedRefAudio;
								if (cfg?.refAudioLanguage) {
									sessionPayload.ref_audio_language = cfg.refAudioLanguage;
								}
							}
							ws?.send(
								JSON.stringify({
									type: "session.update",
									model: cfg?.model ?? DEFAULT_MODEL,
									session: sessionPayload,
								}),
							);
							connected = true;
							Logger.info("naia-omni", "connected to /v1/realtime", {
								mode: useGateway ? "gateway" : "direct",
								refAudio: encodedRefAudio !== null,
							});
							resolve();
							return;
						}

						if (!connected && msg.type === "error") {
							clearTimeout(timeout);
							connectErrored = true;
							const errMsg = extractServerErrorMessage(msg);
							reject(new Error(errMsg));
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

					ws.onopen = () => {
						if (useGateway) {
							ws?.send(
								JSON.stringify({
									setup: {
										apiKey: cfg?.naiaKey,
										backend: "runpod",
										locale: cfg?.locale ?? "en",
										instanceId: cfg?.instanceId,
									},
								}),
							);
						}
					};

					ws.onclose = (event) => {
						clearTimeout(timeout);
						const wasConnected = connected;
						connected = false;
						Logger.info("naia-omni", "disconnected from /v1/realtime", {
							code: event.code,
							reason: event.reason,
							wasClean: event.wasClean,
						});
						if (!wasConnected && !connectErrored) {
							// Map application close codes (4001 auth / 4002 superseded /
							// 4003 credits) so a pre-session reject classifies into the
							// right status banner.
							reject(new Error(closeCodeMessage(event.code)));
						}
						// Only surface a session-level disconnect when a LIVE session
						// dropped. Pre-connect closes (cold-start retries, auth/credit
						// rejects) are driven by connect()'s promise rejection →
						// ChatPanel's catch; firing onDisconnect here too would tear
						// down the UI mid-cold-start. Carry the close reason so a
						// mid-call superseded/credits drop isn't a silent disconnect.
						if (wasConnected) {
							session.onDisconnect?.({
								code: event.code,
								reason: closeCodeReason(event.code),
							});
						}
					};
				});
			}; // end attemptConnect

			// Retry loop for on-demand pods (CONTRACT §3.2)
			while (true) {
				try {
					await attemptConnect();
					return; // connected successfully
				} catch (err) {
					if (aborted) throw err; // user cancelled mid-cold-start — silent
					const msg = err instanceof Error ? err.message : String(err);
					// Check for pod-starting (503) in error message
					if (useGateway && msg.includes("pod-starting")) {
						if (Date.now() - retryStart > COLD_START_CAP_MS) {
							emitStatus({
								phase: "error",
								reason: "timeout",
								message: "cold-start-timeout",
							});
							throw new ColdStartTimeoutError();
						}
						coldStartActive = true;
						attempt += 1;
						// SoT §4 session.preparing/queued hints, encoded in the reject
						// message as ":eta=<s>" / ":pos=<n>" (see onmessage).
						const etaMatch = msg.match(/:eta=(\d+)/);
						const posMatch = msg.match(/:pos=(\d+)/);
						emitStatus({
							phase: "cold-start",
							elapsedSeconds: Math.floor((Date.now() - retryStart) / 1000),
							attempt,
							...(etaMatch ? { etaSeconds: Number(etaMatch[1]) } : {}),
							...(posMatch ? { queuePosition: Number(posMatch[1]) } : {}),
						});
						Logger.info("naia-omni", "pod starting, retrying", {
							delay: retryDelay,
							elapsed: Date.now() - retryStart,
						});
						await abortableSleep(retryDelay, abortSignal);
						retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
						continue;
					}
					if (msg.includes("sold-out")) {
						emitStatus({ phase: "sold-out" });
						throw new SoldOutError(msg);
					}
					emitStatus({
						phase: "error",
						reason: classifyErrorReason(msg),
						message: msg,
					});
					throw err; // other errors — don't retry
				}
			}
		},

		sendAudio(pcmBase64: string) {
			if (!ws || !connected) return;
			// Passthrough: stream each mic chunk straight to the server's
			// input_audio_buffer. The server runs silero VAD (turn_detection:
			// server_vad) and auto-commits + responds on end-of-speech — no
			// client-side buffering, silence timer, or manual commit. Mirrors
			// openai-realtime.ts and the web demo for low latency. Barge-in is
			// server-side via input_audio_buffer.speech_started (see
			// handleMessage); the AI-speaking echo gate lives in ChatPanel
			// (audioInput.gateWhilePlaying).
			try {
				ws.send(
					JSON.stringify({
						type: "input_audio_buffer.append",
						audio: pcmBase64,
					}),
				);
			} catch (err) {
				Logger.warn("naia-omni", "send failed", { error: String(err) });
				session.onError?.(err instanceof Error ? err : new Error(String(err)));
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

		sendToolResponse(callId: string, result: unknown) {
			if (!ws || !connected) return;
			// Server consumes function_call_output and auto-resumes the turn
			// (_resume_after_tools) once all pending tool calls are answered.
			// Do NOT send response.create — that would double-trigger a response.
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
		},

		disconnect() {
			// Cancel an in-progress cold-start: break the backoff loop and
			// release the half-started Pod so we stop paying for it (the retry
			// loop's abortableSleep rejects with AbortError → connect() rejects).
			if (
				!connected &&
				coldStartActive &&
				cfg?.gatewayUrl &&
				cfg.instanceId &&
				cfg.naiaKey
			) {
				void abandonPod(cfg.gatewayUrl, cfg.instanceId, cfg.naiaKey);
			}
			aborted = true;
			connectAbort?.abort();
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

	function emitStatus(status: VoiceConnectionStatus): void {
		try {
			session.onStatusChange?.(status);
		} catch {
			// A listener error must never break the connect/retry loop.
		}
	}

	function handleMessage(msg: Record<string, unknown>) {
		const type = msg.type as string;

		switch (type) {
			case "conversation.item.input_audio_transcription.completed": {
				// Server STT result for the user's spoken turn (emitted by the
				// server's _process_turn). registry marks naia-0.9-omni-24g
				// transcriptProvided:true — surface the real transcript for the
				// user's spoken turn (the mic button already shows listening state).
				const transcript = msg.transcript as string | undefined;
				if (transcript) session.onInputTranscript?.(transcript);
				break;
			}

			case "response.created":
				isAiSpeaking = true;
				Logger.debug("naia-omni", "response started");
				break;

			case "response.audio_transcript.delta":
			// Text-input turns stream the assistant's reply via response.text.delta
			// (server _process_text_turn); voice turns use audio_transcript.delta.
			// Both carry the assistant output text → same transcript surface.
			case "response.text.delta": {
				const delta = msg.delta as string | undefined;
				// Map VoxCPM2 prosody tags ([sigh] etc.) to chat emoji for display.
				// The TTS path keeps the raw tags server-side for prosody.
				if (delta) session.onOutputTranscript?.(emotionTagsToChatText(delta));
				break;
			}

			case "response.audio.delta": {
				// Pass base64 PCM16 24kHz delta straight through to audio player.
				const delta = msg.delta as string | undefined;
				if (delta) session.onAudio?.(delta);
				break;
			}

			case "response.done": {
				isAiSpeaking = false;
				// requires_action: the model emitted tool calls and is waiting for
				// function_call_output before its real reply. Don't end the turn —
				// the server auto-resumes (_resume_after_tools) once we answer.
				const resp = msg.response as { requires_action?: boolean } | undefined;
				if (resp?.requires_action) {
					Logger.debug("naia-omni", "response.done — awaiting tool output");
					break;
				}
				Logger.debug("naia-omni", "response done");
				session.onTurnEnd?.();
				break;
			}

			case "response.function_call_arguments.done": {
				// Server (naia_realtime_server) emits this per tool call, then a
				// response.done{requires_action}. Surface to onToolCall; ChatPanel
				// runs the skill and calls sendToolResponse with the result.
				const callId = msg.call_id as string | undefined;
				const name = msg.name as string | undefined;
				if (!callId || !name) break;
				let args: Record<string, unknown> = {};
				try {
					args = JSON.parse((msg.arguments as string) ?? "{}");
				} catch {
					// malformed arguments — invoke with empty args
				}
				session.onToolCall?.(callId, name, args);
				break;
			}

			case "response.cancelled":
				isAiSpeaking = false;
				Logger.debug("naia-omni", "response cancelled");
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
				const errMsg = extractServerErrorMessage(msg);
				if (errMsg.startsWith("Invalid ref_audio")) {
					// Server rejected the voice-clone reference. Surface to
					// the caller so the UI can prompt for a different file
					// or fall back to the default voice; the session
					// itself is still usable, just without the clone.
					Logger.warn("naia-omni", "ref audio rejected by server", {
						message: errMsg,
					});
					session.onError?.(new RefAudioEncodeError(errMsg));
					break;
				}
				Logger.warn("naia-omni", "non-fatal server error (session continues)", {
					message: errMsg,
				});
				break;
			}
		}
	}

	return session;
}

/**
 * Validate and normalize a user-supplied server URL to a trailing-slash-stripped
 * ws(s):// origin. Returns null for invalid input.
 *
 * Accepts http(s):// and ws(s):// with a simple scheme allowlist so that
 * mistyped settings (e.g. `HTTP://`, `ftp://…`) fail fast with a readable
 * `connect()` rejection instead of an opaque `new WebSocket()` throw inside
 * the Promise constructor. Embedded credentials are stripped — the field is
 * free-text, so a `http://user:pass@host:8000` paste must not survive into
 * either the WebSocket URL or the structured log line.
 */
function normalizeServerUrl(raw: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	const scheme = parsed.protocol.toLowerCase();
	if (!ALLOWED_SERVER_SCHEMES.has(scheme)) return null;
	parsed.protocol = scheme.startsWith("http")
		? scheme.replace("http", "ws")
		: scheme;
	parsed.username = "";
	parsed.password = "";
	const origin = `${parsed.protocol}//${parsed.host}`;
	return parsed.pathname && parsed.pathname !== "/"
		? `${origin}${parsed.pathname.replace(/\/+$/, "")}`
		: origin;
}

/** Strip userinfo from a URL string before logging so credentials don't leak. */
function sanitizeUrl(url: string): string {
	try {
		const u = new URL(url);
		if (u.username || u.password) {
			u.username = "";
			u.password = "";
			return u.toString();
		}
		return url;
	} catch {
		return url;
	}
}

/**
 * Extract a human-readable error string from a Realtime `error` event.
 * Server may send `{error: "string"}` or `{error: {message, ...}}`.
 */
/** Abortable backoff sleep — rejects with AbortError the moment connectAbort fires. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new DOMException("Aborted", "AbortError"));
			},
			{ once: true },
		);
	});
}

/**
 * Single source of truth: map a gateway WS application close code to a canonical
 * reason. Mirrors naia.nextain.io's `naia-omni-client.closeReason` so desktop and
 * web agree on the wire (probe-confirmed in the cascade demo plan §4):
 *   4001 = auth · 4002 = superseded (same account took over elsewhere, last-wins)
 *   4003 = credits · 1000/1005 = normal · else = unknown.
 */
function closeCodeReason(code: number): VoiceCloseReason {
	if (code === 4001) return "auth";
	if (code === 4002) return "superseded";
	if (code === 4003) return "credits";
	if (code === 4409) return "consent";
	if (code === 1000 || code === 1005) return "normal";
	return "unknown";
}

/**
 * Pre-session close → a classifiable reject message. Built from the close-code
 * SoT so `classifyErrorReason` recovers the same reason on the connect() catch.
 * SoT §4: a bare 4503 (transient unavailable — warming/queued, no preceding
 * status event) maps to pod-starting so the retry loop waits, never errors.
 */
function closeCodeMessage(code: number): string {
	switch (closeCodeReason(code)) {
		case "auth":
			return "auth-failed (4001)";
		case "superseded":
			return "superseded (4002)";
		case "credits":
			return "insufficient-credits (4003)";
		case "consent":
			return "consent-required";
		default:
			return code === 4503
				? "pod-starting"
				: "Connection closed before session ready";
	}
}

/** Classify a terminal connect error into a scenario for the status banner. */
function classifyErrorReason(
	message: string,
): "auth" | "credits" | "timeout" | "superseded" | "consent" | "unknown" {
	const m = message.toLowerCase();
	if (m.includes("superseded")) return "superseded";
	if (m.includes("consent")) return "consent";
	if (m.includes("credit") || m.includes("insufficient")) return "credits";
	if (
		m.includes("auth") ||
		m.includes("unauthorized") ||
		m.includes("invalid api") ||
		m.includes("api key") ||
		m.includes("4001")
	) {
		return "auth";
	}
	if (m.includes("cold start") || m.includes("timeout")) return "timeout";
	return "unknown";
}

function extractServerErrorMessage(msg: Record<string, unknown>): string {
	const err = msg.error;
	if (typeof err === "string") return err;
	if (err && typeof err === "object") {
		const m = (err as Record<string, unknown>).message;
		if (typeof m === "string") return m;
	}
	const top = msg.message;
	if (typeof top === "string") return top;
	return "Server error";
}
