/** STT engine identifier — "tauri" for offline Rust engines, "api" for cloud API-based, "web" for Web Speech API, "vllm" for local vLLM server. */
export type SttEngineType = "tauri" | "api" | "web" | "vllm";

/** STT provider metadata for settings UI and runtime selection. */
export interface SttProviderMeta {
	/** Unique identifier (same as SttProviderId in config.ts). */
	id: string;
	/** Human-readable name. */
	name: string;
	/** Brief description for settings UI. */
	description: string;
	/** Engine type: "tauri" (offline Rust), "api" (cloud API), "web" (Web Speech), or "vllm" (local vLLM server). */
	engineType: SttEngineType;
	/** Rust engine name for tauri-based providers (vosk/whisper). */
	engine?: string;
	/** Whether this runs entirely offline (or on local network). */
	isOffline: boolean;
	/** Whether this provider is local (e.g. vLLM, Whisper). */
	isLocal?: boolean;
	/** Whether this provider requires an endpoint URL (e.g. vLLM host). */
	requiresEndpointUrl?: boolean;
	/** Config field name for the endpoint URL (e.g. "vllmHost"). */
	endpointUrlConfigField?: string;
	/** Whether GPU acceleration is available/beneficial. */
	gpuAccelerated?: boolean;
	/** Whether this provider requires an API key. */
	requiresApiKey?: boolean;
	/** Config field name for the API key. */
	apiKeyConfigField?: string;
	/** Whether this provider requires a Naia Lab key. */
	requiresNaiaKey?: boolean;
	/** Pricing hint (e.g. "Free", "$0.006/15s"). */
	pricing?: string;
	/** Supported language codes (BCP-47). */
	supportedLanguages: string[];
}

/** STT model metadata for download/selection UI. */
export interface SttModelMeta {
	/** Model identifier (e.g. "vosk-model-small-ko-0.22", "whisper-base"). */
	id: string;
	/** Which provider owns this model. */
	providerId: string;
	/** Human-readable name. */
	name: string;
	/** Download size (human-readable, e.g. "82MB"). */
	size: string;
	/** Word Error Rate (approximate). */
	wer?: string;
	/** Languages this model supports. */
	languages: string[];
	/** Whether GPU is recommended for real-time performance. */
	gpuRecommended?: boolean;
}

/** Recognition result from any STT engine. */
export interface SttResult {
	transcript: string;
	isFinal: boolean;
	confidence?: number;
}

/**
 * Unified STT session interface.
 * Both Tauri (offline) and API-based providers implement this.
 */
export interface SttSession {
	start(): Promise<void>;
	stop(): Promise<void>;
	/** Register callback for recognition results. Returns cleanup function. */
	onResult(callback: (result: SttResult) => void): () => void;
	/** Register callback for errors. Returns cleanup function. */
	onError?(
		callback: (error: { code: string; message: string }) => void,
	): () => void;
	/** Register callback for cost tracking (called per API call). Returns cleanup function. */
	onCost?(callback: (cost: { durationSeconds: number }) => void): () => void;
}
