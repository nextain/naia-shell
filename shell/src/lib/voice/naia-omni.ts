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
} from "./ondemand-retry";
import { RefAudioEncodeError, encodeRefAudio } from "./ref-audio";
import type { LiveProviderConfig, NaiaOmniConfig, VoiceSession } from "./types";

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

		get isConnected() {
			return connected;
		},

		async connect(config: LiveProviderConfig) {
			cfg = config as NaiaOmniConfig;

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
			const retryStart = Date.now();
			let retryDelay = INITIAL_RETRY_MS;

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

					if (!connected && msg.type === "session.created") {
						clearTimeout(timeout);
						const sessionPayload: Record<string, unknown> = {
							modalities: ["text", "audio"],
							input_audio_format: "pcm16",
							output_audio_format: "pcm16",
							instructions: cfg?.systemInstruction ?? "",
							turn_detection: { type: "server_vad" },
							// #15: prefer a URL (preset sample_url / upload URL) over a
							// heavy base64 blob — backend downloads it once. Server
							// priority: ref_audio_url > ref_audio > x-naia-voice-ref.
							...(cfg?.refAudioUrl
								? { ref_audio_url: cfg.refAudioUrl }
								: {}),
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
						reject(new Error("Connection closed before session ready"));
					}
					session.onDisconnect?.();
				};
			});
			}; // end attemptConnect

			// Retry loop for on-demand pods (CONTRACT §3.2)
			while (true) {
				try {
					await attemptConnect();
					return; // connected successfully
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					// Check for pod-starting (503) in error message
					if (useGateway && msg.includes("pod-starting")) {
						if (Date.now() - retryStart > COLD_START_CAP_MS) {
							throw new ColdStartTimeoutError();
						}
						Logger.info("naia-omni", "pod starting, retrying", {
							delay: retryDelay,
							elapsed: Date.now() - retryStart,
						});
						await new Promise((r) => setTimeout(r, retryDelay));
						retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
						continue;
					}
					if (msg.includes("sold-out")) {
						throw new SoldOutError(msg);
					}
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

			case "response.done":
				isAiSpeaking = false;
				Logger.debug("naia-omni", "response done");
				session.onTurnEnd?.();
				break;

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
