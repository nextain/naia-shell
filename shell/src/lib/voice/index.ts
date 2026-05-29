/**
 * Voice session factory.
 *
 * Creates a VoiceSession for the given provider. Each provider implements
 * the same interface but uses a different WebSocket protocol internally.
 *
 * Gemini Direct mode uses a Rust WebSocket proxy because WebKitGTK cannot
 * connect to wss://generativelanguage.googleapis.com (silent connection hang).
 *
 * Usage:
 *   const session = createVoiceSession("gemini-live", { useProxy: true });
 *   await session.connect({ provider: "gemini-live", googleApiKey, ... });
 */
import { createGeminiLiveSession } from "./gemini-live";
import { createGeminiLiveProxySession } from "./gemini-live-proxy";
import { createNaiaOmniSession } from "./naia-omni";

// Barge-in energy gate — shared SoT from omni development (#216).
export { SPEECH_RMS_THRESHOLD, rmsFromBase64Pcm } from "./naia-omni";

import { createOpenAIRealtimeSession } from "./openai-realtime";
import type { LiveProviderId, VoiceSession } from "./types";
import { createVllmOmniSession } from "./vllm-omni";

// #313 L3 — mid-session panel context bridge.
export {
	attachPanelContextBridge,
	DEFAULT_DEBOUNCE_MS as PANEL_CONTEXT_BRIDGE_DEBOUNCE_MS,
	type PanelContextBridge,
	type PanelContextBridgeOptions,
	type PanelContextSource,
} from "./panel-context-bridge";

export {
	type LiveProviderId,
	type LiveProviderConfig,
	type VoiceSession,
	LIVE_PROVIDER_LABELS,
	LIVE_PROVIDER_COST_HINTS,
} from "./types";
export type {
	GeminiLiveConfig,
	NaiaOmniConfig,
	OpenAIRealtimeConfig,
	VllmOmniConfig,
	ToolDeclaration,
	PanelContextUpdate,
} from "./types";
// Re-export voice options from LLM registry
export { OPENAI_REALTIME_VOICES, GEMINI_LIVE_VOICES } from "../llm/registry";

interface CreateOptions {
	/** Use Rust WebSocket proxy for Gemini Direct (bypasses WebKitGTK limitation). */
	useProxy?: boolean;
}

export function createVoiceSession(
	provider: LiveProviderId,
	options?: CreateOptions,
): VoiceSession {
	switch (provider) {
		case "naia":
			return createGeminiLiveSession();
		case "gemini-live":
			// Direct mode: use Rust proxy to bypass WebKitGTK WebSocket limitation
			return options?.useProxy
				? createGeminiLiveProxySession()
				: createGeminiLiveSession();
		case "openai-realtime":
			return createOpenAIRealtimeSession();
		case "naia-omni":
			return createNaiaOmniSession();
		case "vllm-omni":
			return createVllmOmniSession();
		default:
			throw new Error(`Unknown live provider: ${provider}`);
	}
}
