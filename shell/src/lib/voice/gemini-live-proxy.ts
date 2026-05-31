/**
 * Gemini Live via Tauri Rust proxy.
 *
 * WebKitGTK cannot connect to wss://generativelanguage.googleapis.com directly
 * (connection hangs silently). This module wraps Tauri commands that proxy the
 * WebSocket through Rust (tokio-tungstenite), forwarding events via Tauri emit.
 */
import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import { Logger } from "../logger";
import type {
	GeminiLiveConfig,
	LiveProviderConfig,
	VoiceSession,
} from "./types";

export function createGeminiLiveProxySession(): VoiceSession {
	let connected = false;
	const unlisteners: UnlistenFn[] = [];

	const session: VoiceSession = {
		// Mirrors gemini-live: 16kHz wire format, AGC on, echo gate on.
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

			Logger.info("GeminiLiveProxy", "connecting via Rust proxy", {
				model: gemini.model ?? "(default)",
				voice: gemini.voice ?? "(default)",
			});

			// Register event listeners BEFORE connecting
			unlisteners.push(
				await listen<string>("gemini-live:audio", (e) => {
					session.onAudio?.(e.payload);
				}),
			);
			unlisteners.push(
				await listen<string>("gemini-live:input-transcript", (e) => {
					session.onInputTranscript?.(e.payload);
				}),
			);
			unlisteners.push(
				await listen<string>("gemini-live:output-transcript", (e) => {
					session.onOutputTranscript?.(e.payload);
				}),
			);
			unlisteners.push(
				await listen<void>("gemini-live:turn-end", () => {
					session.onTurnEnd?.();
				}),
			);
			unlisteners.push(
				await listen<void>("gemini-live:interrupted", () => {
					session.onInterrupted?.();
				}),
			);
			unlisteners.push(
				await listen<{
					id: string;
					name: string;
					args: Record<string, unknown>;
				}>("gemini-live:tool-call", (e) => {
					session.onToolCall?.(
						e.payload.id,
						e.payload.name,
						e.payload.args ?? {},
					);
				}),
			);
			unlisteners.push(
				await listen<string>("gemini-live:error", (e) => {
					Logger.warn("GeminiLiveProxy", "error from Rust", {
						error: e.payload,
					});
					session.onError?.(new Error(e.payload));
				}),
			);
			unlisteners.push(
				await listen<void>("gemini-live:disconnected", () => {
					Logger.info("GeminiLiveProxy", "disconnected");
					connected = false;
					cleanup();
					session.onDisconnect?.();
				}),
			);

			// Call Rust command to connect
			await invoke("gemini_live_connect", {
				params: {
					api_key: gemini.googleApiKey,
					model: gemini.model ?? undefined,
					voice: gemini.voice ?? undefined,
					system_instruction: gemini.systemInstruction ?? undefined,
				},
			});

			connected = true;
			Logger.info("GeminiLiveProxy", "connected via Rust proxy");
		},

		sendAudio(pcmBase64: string) {
			if (!connected) return;
			invoke("gemini_live_send_audio", { pcmBase64 }).catch((err) => {
				Logger.warn("GeminiLiveProxy", "sendAudio error", {
					error: String(err),
				});
			});
		},

		sendText(text: string) {
			if (!connected) return;
			invoke("gemini_live_send_text", { text }).catch((err) => {
				Logger.warn("GeminiLiveProxy", "sendText error", {
					error: String(err),
				});
			});
		},

		sendToolResponse(callId: string, result: unknown) {
			if (!connected) return;
			invoke("gemini_live_send_tool_response", { callId, result }).catch(
				(err) => {
					Logger.warn("GeminiLiveProxy", "sendToolResponse error", {
						error: String(err),
					});
				},
			);
		},

		disconnect() {
			connected = false;
			cleanup();
			invoke("gemini_live_disconnect").catch(() => {});
		},
	};

	function cleanup() {
		for (const unlisten of unlisteners) {
			unlisten();
		}
		unlisteners.length = 0;
	}

	return session;
}
