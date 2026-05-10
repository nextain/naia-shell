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
import { RefAudioEncodeError, encodeRefAudio } from "./ref-audio";
import type { LiveProviderConfig, MiniCpmOConfig, VoiceSession } from "./types";

const DEFAULT_SERVER_URL = "http://localhost:8000";
const DEFAULT_MODEL = "openbmb/MiniCPM-o-4_5";

/** ms of silence after last speech chunk before committing turn to server */
const SILENCE_TIMEOUT_MS = 1500;
/** force commit after this many ms even if speech is continuous */
const MAX_BUFFER_MS = 6000;
/** minimum samples to bother sending (0.5s @ 16kHz) */
const MIN_AUDIO_SAMPLES = 8000;
/** RMS threshold for client-side speech detection (Int16 scale 0–32767) */
const SPEECH_RMS_THRESHOLD = 200;
/** Schemes accepted for `serverUrl` before conversion to `ws(s)://`. */
const ALLOWED_SERVER_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

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

			const normalizedBase = normalizeServerUrl(
				cfg.serverUrl ?? DEFAULT_SERVER_URL,
			);
			if (!normalizedBase) {
				throw new Error(
					`Invalid serverUrl: expected http(s):// or ws(s)://, got ${cfg.serverUrl}`,
				);
			}
			const wsUrl = `${normalizedBase}/v1/realtime`;

			// Encode the optional voice-clone reference up-front so a bad
			// payload (oversize, decode failure) fails the connect promise
			// instead of producing a half-open session that the server
			// later rejects mid-stream.
			let encodedRefAudio: string | null = null;
			if (cfg.refAudio !== undefined && cfg.refAudio !== null) {
				try {
					encodedRefAudio = await encodeRefAudio(cfg.refAudio);
				} catch (err) {
					if (err instanceof RefAudioEncodeError) {
						Logger.warn("minicpm-o", "ref audio rejected", {
							error: err.message,
						});
						throw err;
					}
					throw err;
				}
			}

			Logger.info("minicpm-o", "connecting", {
				url: sanitizeUrl(wsUrl),
				hasRefAudio: encodedRefAudio !== null,
			});

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
						const sessionPayload: Record<string, unknown> = {
							modalities: ["text", "audio"],
							input_audio_format: "pcm16",
							output_audio_format: "pcm16",
							instructions: cfg?.systemInstruction ?? "",
							turn_detection: { type: "server_vad" },
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
						Logger.info("minicpm-o", "connected to /v1/realtime", {
							refAudio: encodedRefAudio !== null,
						});
						resolve();
						return;
					}

					// Pre-handshake server error: surface the actual server message
					// instead of the generic "Connection closed" that ws.onclose
					// would otherwise emit after the server hangs up.
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

				ws.onclose = (event) => {
					clearTimeout(timeout);
					const wasConnected = connected;
					connected = false;
					clearTurnTimers();
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
				const errMsg = extractServerErrorMessage(msg);
				if (errMsg.startsWith("Invalid ref_audio")) {
					// Server rejected the voice-clone reference. Surface to
					// the caller so the UI can prompt for a different file
					// or fall back to the default voice; the session
					// itself is still usable, just without the clone.
					Logger.warn("minicpm-o", "ref audio rejected by server", {
						message: errMsg,
					});
					session.onError?.(new RefAudioEncodeError(errMsg));
					break;
				}
				Logger.warn("minicpm-o", "non-fatal server error (session continues)", {
					message: errMsg,
				});
				break;
			}
		}
	}

	/** Send buffered PCM to server as base64 append + commit. */
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
		} catch (err) {
			Logger.warn("minicpm-o", "send failed", { error: String(err) });
			session.onError?.(err instanceof Error ? err : new Error(String(err)));
		}

		Logger.debug("minicpm-o", "committed audio", { samples: totalSamples });
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
		// Malformed base64 from the mic encoder is treated as a silent chunk
		// rather than a thrown exception that would kill `sendAudio`.
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
