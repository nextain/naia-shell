/** TTS provider metadata for settings UI auto-discovery. */
export interface TtsProviderMeta {
	/** Unique identifier matching agent-side TtsProviderId. */
	id: string;
	/** Human-readable name. */
	name: string;
	/** Brief description for settings UI. */
	description: string;
	/** Whether this provider requires an API key. */
	requiresApiKey: boolean;
	/** Config key for the API key (e.g. "openaiTtsApiKey", "elevenlabsApiKey"). */
	apiKeyConfigField?: string;
	/** Whether this provider requires a Naia Lab key. */
	requiresNaiaKey?: boolean;
	/** Whether the provider is free to use. */
	isFree?: boolean;
	/** True if this provider runs locally (no cloud). */
	isLocal?: boolean;
	/** Whether TTS synthesis runs client-side in the browser (bypasses agent TTS pipeline). */
	isClientSide?: boolean;
	/** Pricing hint (e.g. "Free", "$15/1M chars"). */
	pricing?: string;
	/** Static voice list (fallback when API unavailable). */
	voices?: TtsVoiceMeta[];
	/** Fetch voices dynamically from API. Returns null if not supported or API key missing. */
	fetchVoices?: (apiKey: string) => Promise<TtsVoiceMeta[] | null>;
}

/** TTS voice metadata. */
export interface TtsVoiceMeta {
	id: string;
	label: string;
	language?: string;
	gender?: "male" | "female" | "neutral";
}
