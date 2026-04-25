/**
 * Unified Live Voice Conversation types.
 *
 * All native Live API providers (Gemini Live, OpenAI Realtime, etc.)
 * share the same VoiceSession interface. The only difference is the WebSocket
 * message format, which each provider implementation handles internally.
 *
 * mic-stream.ts and audio-player.ts are provider-agnostic and reused as-is.
 */

// ── Provider ID ──

export type LiveProviderId =
	| "naia"
	| "gemini-live"
	| "openai-realtime"
	| "minicpm-o"
	| "vllm-omni"
	| "edge-tts";

export const LIVE_PROVIDER_LABELS: Record<LiveProviderId, string> = {
	naia: "Naia OS",
	"gemini-live": "Gemini",
	"openai-realtime": "OpenAI",
	"minicpm-o": "MiniCPM-o (Omni Voice)",
	"vllm-omni": "MiniCPM-o (vllm-omni)",
	"edge-tts": "Edge (TTS 전용)",
};

// ── Provider Cost Hints (approximate per-minute voice conversation cost) ──

export const LIVE_PROVIDER_COST_HINTS: Record<
	LiveProviderId,
	{ cost: string; note: string }
> = {
	naia: { cost: "~$0.03/min", note: "Naia credits" },
	"gemini-live": { cost: "~$0.03/min", note: "Google API Key" },
	"openai-realtime": { cost: "~$0.10/min", note: "OpenAI API Key" },
	"minicpm-o": { cost: "Free*", note: "Local GPU / RunPod ~$0.22/hr" },
	"vllm-omni": { cost: "Free*", note: "Local GPU / RunPod ~$0.22/hr" },
	"edge-tts": { cost: "Free", note: "TTS only" },
};

// ── Provider Voice Options ──
// Voice options are now defined in config.ts (OPENAI_REALTIME_VOICES, GEMINI_LIVE_VOICES)
// and re-exported from voice/index.ts for backward compatibility.

// ── Tool Declaration (shared across providers) ──

export interface ToolDeclaration {
	name: string;
	description: string;
	parameters?: Record<string, unknown>;
}

// ── Provider Config ──

interface LiveProviderConfigBase {
	voice?: string;
	model?: string;
	systemInstruction?: string;
	tools?: ToolDeclaration[];
	/** BCP-47 locale for speech recognition language hint (e.g. "ko-KR"). */
	locale?: string;
}

export interface GeminiLiveConfig extends LiveProviderConfigBase {
	provider: "gemini-live";
	/** Gateway mode: relay via any-llm gateway */
	gatewayUrl?: string;
	naiaKey?: string;
	/** Direct mode: connect to Gemini API directly with user's own key */
	googleApiKey?: string;
}

export interface OpenAIRealtimeConfig extends LiveProviderConfigBase {
	provider: "openai-realtime";
	apiKey: string;
}

export interface MiniCpmOConfig extends LiveProviderConfigBase {
	provider: "minicpm-o";
	/** vllm-omni server URL (e.g. http://localhost:8000 or ws://localhost:8000).
	 *  Provider connects to /v1/realtime (OpenAI Realtime API extended for omni models). */
	serverUrl: string;
}

export interface VllmOmniConfig extends LiveProviderConfigBase {
	provider: "vllm-omni";
	/** vllm-omni REST server URL (e.g. http://localhost:8000). */
	host: string;
	/** Model ID served by the server. */
	model: string;
}

export type LiveProviderConfig =
	| GeminiLiveConfig
	| OpenAIRealtimeConfig
	| MiniCpmOConfig
	| VllmOmniConfig;

// ── Voice Session (provider-agnostic interface) ──

export interface VoiceSession {
	connect: (config: LiveProviderConfig) => Promise<void>;
	sendAudio: (pcmBase64: string) => void;
	sendText: (text: string) => void;
	sendToolResponse: (callId: string, result: unknown) => void;
	disconnect: () => void;
	readonly isConnected: boolean;

	// Events
	onAudio: ((pcmBase64: string) => void) | null;
	onInputTranscript: ((text: string) => void) | null;
	onOutputTranscript: ((text: string) => void) | null;
	onToolCall:
		| ((id: string, name: string, args: Record<string, unknown>) => void)
		| null;
	onTurnEnd: (() => void) | null;
	onInterrupted: (() => void) | null;
	onError: ((error: Error) => void) | null;
	onDisconnect: (() => void) | null;
}

// ── Factory signature ──

export type VoiceSessionFactory = (config: LiveProviderConfig) => VoiceSession;
