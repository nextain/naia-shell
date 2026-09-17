/**
 * Voice session factory.
 *
 * Kept live providers (#603): azure-voice-live, naia-omni, vllm-omni.
 */
import { createAzureVoiceLiveSession } from "./azure-voice-live";
import { createNaiaOmniSession } from "./naia-omni";
import type { LiveProviderId, VoiceSession } from "./types";
import { createVllmOmniSession } from "./vllm-omni";

export { SPEECH_RMS_THRESHOLD, rmsFromBase64Pcm } from "./echo-gate";
export { resolveLiveProvider } from "./resolve-live-provider";

export {
	attachAppContextBridge,
	DEFAULT_DEBOUNCE_MS as APP_CONTEXT_BRIDGE_DEBOUNCE_MS,
	type AppContextBridge,
	type AppContextBridgeOptions,
	type AppContextSource,
} from "./app-context-bridge";

export {
	type LiveProviderId,
	type LiveProviderConfig,
	type VoiceConnectionStatus,
	type VoiceSession,
	LIVE_PROVIDER_LABELS,
	LIVE_PROVIDER_COST_HINTS,
} from "./types";
export type {
	AzureVoiceLiveConfig,
	NaiaOmniConfig,
	VllmOmniConfig,
	ToolDeclaration,
	AppContextUpdate,
	VoiceCloseReason,
	VoiceCloseInfo,
} from "./types";

export function createVoiceSession(
	provider: LiveProviderId,
	_options?: { useProxy?: boolean },
): VoiceSession {
	switch (provider) {
		case "azure-voice-live":
		case "naia":
		case "gemini-live":
		case "openai-realtime":
			return createAzureVoiceLiveSession();
		case "naia-omni":
			return createNaiaOmniSession();
		case "vllm-omni":
			return createVllmOmniSession();
		default:
			throw new Error(`Unknown live provider: ${provider}`);
	}
}
