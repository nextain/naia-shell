import type { ModelCapability } from "../types.js";

export type LlmRoleId = "main" | "sub" | "memory";

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
	/** Unique identifier (e.g. "gemini", "openai"). */
	id: string;
	/** Human-readable name (e.g. "Google Gemini"). */
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
	/** i18n description key for onboarding UI (e.g. "provider.apiKeyRequired"). */
	descKey?: string;
}
