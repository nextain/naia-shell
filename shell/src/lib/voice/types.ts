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
	| "naia-omni"
	| "vllm-omni"
	| "edge-tts";

export const LIVE_PROVIDER_LABELS: Record<LiveProviderId, string> = {
	naia: "Naia OS",
	"gemini-live": "Gemini",
	"openai-realtime": "OpenAI",
	"naia-omni": "Naia Omni",
	"vllm-omni": "vLLM Omni (Local)",
	"edge-tts": "Edge (TTS Only)",
};

// ── Provider Cost Hints (approximate per-minute voice conversation cost) ──

export const LIVE_PROVIDER_COST_HINTS: Record<
	LiveProviderId,
	{ cost: string; note: string }
> = {
	naia: { cost: "~$0.03/min", note: "Naia credits" },
	"gemini-live": { cost: "~$0.03/min", note: "Google API Key" },
	"openai-realtime": { cost: "~$0.10/min", note: "OpenAI API Key" },
	"naia-omni": {
		cost: "~$0.33/hr",
		note: "Naia credits — hourly session (local: free)",
	},
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

// ── Panel Context Update (#313 L3 — mid-session panel context bridge) ──

// `PanelContextUpdate` is a structurally narrow subset of `PanelContext` from
// `panel-registry.ts` — duplicated here to keep `voice/*` free of UI imports.
export interface PanelContextUpdate {
	/** Panel type identifier (e.g. "browser", "workspace"). */
	type: string;
	/** Arbitrary JSON payload describing the new panel state. */
	data: Record<string, unknown>;
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

export interface NaiaOmniConfig extends LiveProviderConfigBase {
	provider: "naia-omni";
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
	/** Naia OS instance ID (user_id:install_uuid). Used for Pod routing (CONTRACT §1.2). */
	instanceId?: string;
	/**
	 * Naia Local mode: connect direct to a user-run container (serverUrl, no
	 * gatewayUrl) AND send the subscriber key in the first `setup` frame so the
	 * container validates entitlement (backend "user"). ONLY set true for the
	 * `naia-local` model — gates the key-bearing `setup` so `naiaKey` never leaks
	 * to an arbitrary direct server (e.g. a third-party vLLM). (cross-review BLOCKING)
	 */
	localContainer?: boolean;
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
	/**
	 * Optional voice-clone reference as an https URL (#15). Sent on the
	 * initial `session.update` as `ref_audio_url`; the backend downloads it
	 * once (allowlist: storage.googleapis.com / naia.nextain.io) and clones
	 * the timbre. Takes priority over `refAudio` (base64) server-side, so
	 * presets (sample_url) and uploads (storage URL) avoid shipping a heavy
	 * blob each session.
	 */
	refAudioUrl?: string;
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
	| NaiaOmniConfig
	| VllmOmniConfig;

// ── Audio input requirements (per-provider, read by the shared mic layer) ──

/**
 * Per-provider microphone capture requirements. The shared UI (ChatPanel)
 * reads these off the session instead of branching on provider id, so the
 * mic-stream config and the AI-speaking echo gate stay declarative and each
 * provider owns its own wire contract.
 */
export interface AudioInputConfig {
	/**
	 * PCM capture rate sent on the wire. naia-omni: 24000 (server INPUT_SR).
	 * All others (openai-realtime / gemini-live / gemini-live-proxy /
	 * vllm-omni): 16000 (wire format `audio/pcm;rate=16000` / WAV header /
	 * prior hardcoded default). Mismatching this rate makes the server
	 * reinterpret the audio at the wrong speed/pitch.
	 */
	sampleRate: number;
	/**
	 * getUserMedia `autoGainControl`. false for the streaming omni/openai paths
	 * (preserve vocal dynamics so server VAD sees true energy); true elsewhere
	 * (legacy default, matches prior behavior).
	 */
	autoGainControl: boolean;
	/**
	 * Apply the RMS echo gate while the AI is speaking. true on weak-AEC paths
	 * (WebKitGTK) so AEC-residual echo doesn't self-trigger the server VAD into
	 * an interrupt loop. The gate only drops sub-threshold chunks while audio is
	 * playing, so real user speech still passes.
	 */
	gateWhilePlaying: boolean;
}

// ── Voice connection status (cold-start aware) ──

/**
 * Why a voice connection ended, mapped 1:1 from the gateway WS application close
 * code. Single source of truth = `closeCodeReason` in naia-omni.ts, which mirrors
 * naia.nextain.io's `naia-omni-client.closeReason` so desktop and web agree on
 * the wire semantics.
 *  - `auth`        — 4001, credential rejected / session expired
 *  - `credits`     — 4003, insufficient credits
 *  - `superseded`  — 4002, same account took over on another device (last-wins)
 *  - `consent`     — 4409, same account already has a live session and the
 *                    backend wants a replace/add decision (SoT §4)
 *  - `normal`      — clean close (1000) or user-initiated stop
 *  - `unknown`     — any other / abnormal code
 */
export type VoiceCloseReason =
	| "auth"
	| "credits"
	| "superseded"
	| "consent"
	| "normal"
	| "unknown";

/** Terminal close detail handed to `onDisconnect` when a LIVE session drops. */
export interface VoiceCloseInfo {
	code?: number;
	reason: VoiceCloseReason;
}

/**
 * Connection lifecycle status. The single source of truth for voice UI state —
 * ChatPanel derives the voice button mode from the current phase (no parallel
 * `voiceMode`). Phases mirror naia.nextain.io's `ConnectionState` so desktop and
 * web stay semantically aligned.
 *
 *  - `idle`        — no session (initial / fully torn down)
 *  - `connecting`  — WebSocket opening, no cold-start signal yet
 *  - `cold-start`  — server returned pod-starting; retrying with backoff
 *  - `active`      — session live. Set by ChatPanel once mic setup succeeds, NOT
 *                    by the provider — active is UI-readiness, not just connected.
 *  - `sold-out`    — capacity exhausted, no Pod available (terminal, pre-active)
 *  - `error`       — terminal pre-active failure, classified for a message
 *  - `closed`      — a previously-active session dropped mid-call (carries the
 *                    close reason so superseded/credits/auth can be surfaced)
 *
 * Providers emit only the pre-active phases via `onStatusChange`
 * (connecting / cold-start / sold-out / error). `active` is owned by ChatPanel;
 * `closed` is derived by ChatPanel from `onDisconnect(info)` so teardown and the
 * terminal transition stay atomic (no re-enable-against-stale-refs race).
 */
export type VoiceConnectionStatus =
	| { phase: "idle" }
	| { phase: "connecting" }
	| {
			phase: "cold-start";
			elapsedSeconds: number;
			attempt: number;
			// SoT §4 session.preparing/queued hints (optional — gateway may omit).
			etaSeconds?: number;
			queuePosition?: number;
	  }
	| { phase: "active" }
	| { phase: "sold-out"; tierAHint?: string }
	| {
			phase: "error";
			reason:
				| "auth"
				| "credits"
				| "timeout"
				| "superseded"
				| "consent"
				| "unknown";
			message: string;
	  }
	| { phase: "closed"; code?: number; reason: VoiceCloseReason };

// ── Voice Session (provider-agnostic interface) ──

export interface VoiceSession {
	/**
	 * Microphone capture + echo-gate requirements for this provider. Read by
	 * ChatPanel when it creates the shared mic stream (provider-agnostic UI).
	 */
	readonly audioInput: AudioInputConfig;
	connect: (config: LiveProviderConfig) => Promise<void>;
	sendAudio: (pcmBase64: string) => void;
	sendText: (text: string) => void;
	sendToolResponse: (callId: string, result: unknown) => void;
	/**
	 * Inject a mid-session panel-context delta (#313 L3). Optional — providers
	 * without a mid-session inject surface (vllm-omni, naia-omni) simply omit
	 * it, and the panel-context bridge degrades to the next-turn system prompt.
	 */
	sendContextUpdate?: (ctx: PanelContextUpdate) => void;
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
	/**
	 * A LIVE session dropped. `info` carries the close code + classified reason
	 * (superseded / credits / auth / normal) so ChatPanel can surface the right
	 * message and do teardown atomically. Absent `info` (or pre-`info` callers) =
	 * an unspecified disconnect. Pre-session failures reject `connect()` instead.
	 */
	onDisconnect: ((info?: VoiceCloseInfo) => void) | null;
	/**
	 * Pre-active connection lifecycle updates (cold-start aware). Optional — only
	 * providers with a non-instant connect (naia-omni RunPod on-demand) emit
	 * "connecting" / "cold-start" / "sold-out" / "error". Never carries "active"
	 * (ChatPanel owns that, mic-gated) or "closed" (flows via onDisconnect).
	 */
	onStatusChange?: ((status: VoiceConnectionStatus) => void) | null;
}

// ── Factory signature ──

export type VoiceSessionFactory = (config: LiveProviderConfig) => VoiceSession;
