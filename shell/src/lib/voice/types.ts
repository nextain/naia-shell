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
	| "naia-talk"
	| "gemini-live"
	| "openai-realtime"
	| "vllm-omni"
	| "edge-tts";

export const LIVE_PROVIDER_LABELS: Record<LiveProviderId, string> = {
	naia: "Naia OS",
	"naia-talk": "naia-talk",
	"gemini-live": "Gemini",
	"openai-realtime": "OpenAI",
	"vllm-omni": "naia-talk REST",
	"edge-tts": "Edge (TTS 전용)",
};

// ── Provider Cost Hints (approximate per-minute voice conversation cost) ──

export const LIVE_PROVIDER_COST_HINTS: Record<
	LiveProviderId,
	{ cost: string; note: string }
> = {
	naia: { cost: "~$0.03/min", note: "Naia credits" },
	"naia-talk": { cost: "Free", note: "Local / Naia credits (gateway)" },
	"gemini-live": { cost: "~$0.03/min", note: "Google API Key" },
	"openai-realtime": { cost: "~$0.10/min", note: "OpenAI API Key" },
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
	serverUrl?: string;
}

export interface NaiaTalkConfig extends LiveProviderConfigBase {
	provider: "naia-talk";
	/** vllm-omni server URL for direct mode (e.g. http://localhost:8000 or ws://localhost:8000).
	 *  Provider connects to /v1/realtime (OpenAI Realtime API extended for omni models).
	 *  Ignored when gatewayUrl is set. */
	serverUrl?: string;
	/** Gateway mode: relay via any-llm gateway /v1/realtime.
	 *  When set, the provider connects to the gateway instead of the vllm-omni server directly.
	 *  The gateway handles auth, credit billing, and backend routing. */
	gatewayUrl?: string;
	/** API key for gateway auth (gw-... format). Required when gatewayUrl is set. */
	naiaKey?: string;
	/**
	 * Optional voice-clone reference. The session sends this on the initial
	 * `session.update` so the server clones its timbre for every response in
	 * the session.
	 *
	 * Accepts:
	 *  - `Blob` / `File` from a file picker
	 *  - `ArrayBuffer` (e.g. `await fetch(url).then((r) => r.arrayBuffer())`)
	 *  - `string` already in base64 wire form (passed through)
	 *
	 * The provider downmixes to mono and resamples to 16 kHz before sending.
	 * If the server rejects the payload (malformed, oversize, decode error)
	 * the session surfaces a Realtime `error` event via `onError` and falls
	 * back to the server's default voice for the rest of the session.
	 */
	refAudio?: ArrayBuffer | Blob | string;
	/** BCP-47-ish hint to the speech tokenizer. Server defaults to "en". */
	refAudioLanguage?: "en" | "zh" | "ko";
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
	| NaiaTalkConfig
	| VllmOmniConfig;

// ── Voice Session (provider-agnostic interface) ──

export interface VoiceSession {
	connect: (config: LiveProviderConfig) => Promise<void>;
	sendAudio: (pcmBase64: string) => void;
	sendText: (text: string) => void;
	sendToolResponse: (callId: string, toolName: string, result: unknown) => void;
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
