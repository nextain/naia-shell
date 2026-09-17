import type { ModelCapability } from "../types.js";

export type LlmRoleId = "expert" | "main" | "sub" | "memory";

/** Settings-only ordering for the Naia model catalog. */
export type ModelSortMode = "price" | "performance";

/** Voice option for omni/tts models. */
export interface LlmVoiceMeta {
	id: string;
	label: string;
}

/** LLM model metadata. */
export interface LlmModelMeta {
	id: string;
	label: string;
	/** Capability tags (e.g. ["llm"], ["llm","omni"], ["llm","omni","stt","tts"]). */
	capabilities: ModelCapability[];
	/** Per-1M-token pricing: [input, output]. */
	pricing?: [number, number];
	/** Optional per-1M-token prompt-cache pricing reported by the gateway. */
	cachePricing?: { read: number | null; write: number | null };
	/** Whether this exact Naia route accepts tool definitions. */
	supportsTools?: boolean;
	/** Auditable upstream route advertised by the Naia gateway. */
	upstreamProvider?: string;
	/** Provider lifecycle signal such as ga or preview. */
	lifecycle?: string;
	/** Upstream wire contract; keeps OpenAI-compatible and Anthropic Messages routes distinct. */
	protocol?: string;
	/** Runtime availability advertised by the gateway (for example live or quota_blocked). */
	operationalStatus?: string;
	/** Omni: user can select voice in settings. */
	voiceSelectable?: boolean;
	/** Omni: available voices. */
	voices?: LlmVoiceMeta[];
	/** Omni: model provides input transcription. */
	transcriptProvided?: boolean;
	/** Not yet generally available — shown with a "(준비중)" tag and blocks Apply. */
	comingSoon?: boolean;
}

/** LLM provider metadata for settings UI auto-discovery. */
export interface LlmProviderMeta {
	/** Unique identifier (e.g. "nextain", "codex"). */
	id: string;
	/** Human-readable name (e.g. "Naia"). */
	name: string;
	/** Brief description for settings UI. */
	description: string;
	/** Whether this provider requires an API key. */
	requiresApiKey: boolean;
	/** Config field name for the API key (e.g. "apiKey", "ollamaHost"). */
	apiKeyConfigField?: string;
	/** Whether this provider requires a Naia Lab key instead. */
	requiresNaiaKey?: boolean;
	/** Whether this provider is local (e.g. Ollama). */
	isLocal?: boolean;
	/** Default model ID. */
	defaultModel: string;
	/** Available models. */
	models: LlmModelMeta[];
	/** Fetch models dynamically (e.g. Ollama). */
	fetchModels?: (host: string) => Promise<LlmModelMeta[] | null>;
	/** Whether this provider is disabled in UI. */
	disabled?: boolean;
	/** 지원 역할. 생략하면 main/sub/memory 모두 지원하는 일반 LLM provider로 본다. */
	supportedRoles?: readonly LlmRoleId[];
	/** i18n description key for onboarding UI (e.g. "provider.localRequired"). */
	descKey?: string;
}
