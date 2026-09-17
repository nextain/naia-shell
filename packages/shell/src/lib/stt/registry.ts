import type { SttProviderMeta } from "./types";

const providers = new Map<string, SttProviderMeta>();

/** Register an STT provider's metadata. */
export function registerSttProvider(meta: SttProviderMeta): void {
	providers.set(meta.id, meta);
}

/** Get a registered STT provider by id. */
export function getSttProvider(id: string): SttProviderMeta | undefined {
	return providers.get(id);
}

/** List all registered STT providers. */
export function listSttProviders(): SttProviderMeta[] {
	return Array.from(providers.values());
}

// ── Browser built-in (free, no download) ──

registerSttProvider({
	id: "web-speech",
	name: "Web Speech API",
	description:
		"Browser built-in speech recognition. No model download, no API key. Availability depends on browser/WebKit version.",
	engineType: "web",
	isOffline: false,
	pricing: "Free",
	supportedLanguages: [
		"ko-KR",
		"en-US",
		"zh-CN",
		"ja-JP",
		"es-ES",
		"fr-FR",
		"de-DE",
		"ru-RU",
		"pt-BR",
		"it-IT",
	],
});

// ── Offline providers (free, Tauri plugin) ──

registerSttProvider({
	id: "vosk",
	name: "Vosk",
	description:
		"Offline speech recognition. Small models (~40-80MB), real-time streaming.",
	engineType: "tauri",
	engine: "vosk",
	isOffline: true,
	pricing: "Free",
	supportedLanguages: [
		"ko-KR",
		"en-US",
		"zh-CN",
		"ja-JP",
		"es-ES",
		"fr-FR",
		"de-DE",
		"ru-RU",
		"pt-BR",
		"it-IT",
		"vi-VN",
		"hi-IN",
	],
});

registerSttProvider({
	id: "whisper",
	name: "Whisper",
	description:
		"Local high-accuracy speech recognition (faster-whisper), batch inference every 2s.",
	engineType: "tauri",
	engine: "whisper",
	isOffline: true,
	gpuAccelerated: true,
	pricing: "Free",
	supportedLanguages: [
		"ko-KR",
		"en-US",
		"zh-CN",
		"ja-JP",
		"es-ES",
		"fr-FR",
		"de-DE",
		"ru-RU",
		"pt-BR",
		"it-IT",
		"vi-VN",
		"hi-IN",
		"ar-SA",
		"bn-IN",
		"id-ID",
	],
});

// ── Local vLLM providers (no API key, user-managed server) ──

registerSttProvider({
	id: "vllm",
	name: "vLLM ASR",
	description:
		"Local vLLM server — supports any ASR model (Qwen3-ASR, Whisper, etc.)",
	engineType: "vllm",
	isOffline: true,
	isLocal: true,
	requiresEndpointUrl: true,
	endpointUrlConfigField: "vllmSttHost",
	gpuAccelerated: true,
	pricing: "Free (local)",
	supportedLanguages: [
		"ko-KR",
		"en-US",
		"zh-CN",
		"ja-JP",
		"es-ES",
		"fr-FR",
		"de-DE",
		"ru-RU",
		"pt-BR",
		"it-IT",
		"vi-VN",
		"hi-IN",
		"ar-SA",
		"tr-TR",
		"pl-PL",
		"nl-NL",
		"sv-SE",
		"da-DK",
		"fi-FI",
		"no-NO",
		"cs-CZ",
		"sk-SK",
		"hu-HU",
		"ro-RO",
		"bg-BG",
		"uk-UA",
		"ms-MY",
		"th-TH",
		"bn-IN",
		"id-ID",
	],
});

