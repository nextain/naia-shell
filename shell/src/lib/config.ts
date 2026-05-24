import type { Locale } from "./i18n";
import {
	SECRET_KEYS,
	deleteSecretKey,
	getSecretKey,
	saveSecretKey,
} from "./secure-store";
import type { ProviderId } from "./types";
// LiveProviderId kept for migration only — will be removed after migration period
import type { LiveProviderId } from "./voice/types";

const STORAGE_KEY = "naia-config";
export const DEFAULT_GATEWAY_URL = "ws://localhost:18789";

export type ThemeId =
	| "system"
	| "espresso"
	| "midnight"
	| "ocean"
	| "forest"
	| "rose"
	| "latte"
	| "sakura"
	| "cloud";

export type SttProviderId =
	| ""
	| "vosk"
	| "whisper"
	| "web-speech"
	| "google"
	| "elevenlabs"
	| "nextain"
	| "vllm";

/** Map app locale to Vosk STT language code. */
const LOCALE_TO_STT: Record<string, string> = {
	ko: "ko-KR",
	en: "en-US",
	ja: "ja-JP",
	zh: "zh-CN",
	fr: "fr-FR",
	de: "de-DE",
	ru: "ru-RU",
	es: "es-ES",
	pt: "pt-BR",
	hi: "hi-IN",
	ar: "ar-SA",
	vi: "vi-VN",
	id: "id-ID",
	bn: "bn-IN",
};

/** Convert app locale to STT language code. Falls back to en-US. */
export function localeToSttLanguage(locale: string): string {
	return LOCALE_TO_STT[locale] ?? LOCALE_TO_STT[locale.slice(0, 2)] ?? "en-US";
}

export type TtsProviderId =
	| "google"
	| "edge"
	| "openai"
	| "elevenlabs"
	| "nextain"
	| "vllm";

export type PanelPosition = "left" | "right" | "bottom";

export interface AppConfig {
	provider: ProviderId;
	model: string;
	apiKey: string;
	locale?: Locale;
	theme?: ThemeId;
	backgroundImage?: string;
	vrmModel?: string;
	customVrms?: string[];
	customBgs?: string[];
	sttProvider?: SttProviderId;
	sttModel?: string;
	/** Naia Cloud STT backend engine (e.g. "google-cloud-stt"). */
	naiaCloudSttBackend?: string;
	ttsEnabled?: boolean;
	ttsVoice?: string;
	googleApiKey?: string;
	ttsProvider?: TtsProviderId;
	/** Naia Cloud TTS backend engine (e.g. "google-chirp3-hd"). */
	naiaCloudTtsBackend?: string;
	ttsEngine?: "auto" | "gateway" | "google";
	persona?: string;
	enableTools?: boolean;
	gatewayUrl?: string;
	gatewayToken?: string;
	chatRouting?: "gateway" | "direct" | "auto";
	discordDefaultUserId?: string;
	discordDefaultTarget?: string;
	discordDmChannelId?: string;
	allowedTools?: string[];
	userName?: string;
	agentName?: string;
	honorific?: string;
	speechStyle?: string;
	onboardingComplete?: boolean;
	naiaKey?: string;
	naiaUserId?: string;
	disabledSkills?: string[];
	slackWebhookUrl?: string;
	discordWebhookUrl?: string;
	googleChatWebhookUrl?: string;
	openaiTtsApiKey?: string;
	elevenlabsApiKey?: string;
	gatewayTtsAuto?: string;
	gatewayTtsMode?: string;
	panelPosition?: PanelPosition;
	panelVisible?: boolean;
	panelSize?: number;
	discordSessionMigrated?: boolean;
	discordRelayUrl?: string;
	lastProcessedDiscordMessageId?: string;
	ollamaHost?: string;
	vllmHost?: string;
	/** vLLM endpoint for STT/ASR (e.g. Qwen3-ASR). */
	vllmSttHost?: string;
	/** vLLM endpoint for TTS (e.g. Kokoro). */
	vllmTtsHost?: string;
	/** Selected ASR model ID on the vLLM STT server. */
	vllmSttModel?: string;
	/** Selected microphone device ID for STT input (from enumerateDevices). */
	sttInputDeviceId?: string;
	/** Selected speaker/output device ID for TTS output (from enumerateDevices). */
	ttsOutputDeviceId?: string;
	voiceConversation?: boolean;
	liveProvider?: LiveProviderId;
	liveVoice?: string;
	liveModel?: string;
	openaiRealtimeApiKey?: string;
	openaiRealtimeVoice?: string;
	/** Unified voice selection (replaces liveVoice/openaiRealtimeVoice after migration) */
	voice?: string;
	/** Panel IDs that the user has explicitly deleted (build-time panels only). */
	deletedPanels?: string[];
	/** Workspace root directory override. Defaults to the compile-time WORKSPACE_ROOT constant if not set. */
	workspaceRoot?: string;
	/** Filename of the selected background video inside naia-settings/background/ */
	backgroundVideo?: string;
	/** Filename of the selected BGM track inside naia-settings/bgm-musics/ */
	bgmTrack?: string;
	/** Last active BGM source ("youtube" or "local"). */
	bgmSource?: "local" | "youtube";
	/** Last playing YouTube video ID (for session restore). */
	bgmYoutubeVideoId?: string;
	/** Last playing YouTube video title. */
	bgmYoutubeTitle?: string;
	/** Last playing YouTube channel name. */
	bgmYoutubeChannel?: string;
	/** Last playing YouTube thumbnail URL. */
	bgmYoutubeThumbnail?: string;
	/** Last BGM volume (0–1). */
	bgmVolume?: number;
	/** Whether BGM was playing when the app was closed. */
	bgmPlaying?: boolean;

	// ── Memory settings ──
	/** Memory adapter backend. Defaults to 'local' (JSON file). */
	memoryAdapter?: "local" | "qdrant";
	/** Embedding provider for semantic search. Defaults to 'none' (keyword search). */
	memoryEmbeddingProvider?: "none" | "offline" | "vllm" | "ollama" | "naia";
	/** Offline embedding model (used when memoryEmbeddingProvider = 'offline'). */
	memoryOfflineModel?: "all-MiniLM-L6-v2" | "all-mpnet-base-v2";
	/** Base URL for vLLM/Ollama embedding endpoint. */
	memoryEmbeddingBaseUrl?: string;
	/** API key for embedding endpoint (vLLM/Ollama). */
	memoryEmbeddingApiKey?: string;
	/** Embedding model name (vLLM/Ollama). */
	memoryEmbeddingModel?: string;
	/** LLM provider used for memory fact extraction. Defaults to 'none' (heuristic). */
	memoryLlmProvider?: "none" | "naia" | "vllm" | "ollama";
	/** Base URL for vLLM/Ollama LLM endpoint (memory fact extraction). */
	memoryLlmBaseUrl?: string;
	/** API key for LLM endpoint (memory fact extraction). */
	memoryLlmApiKey?: string;
	/** Model name for LLM fact extraction. */
	memoryLlmModel?: string;
	/** Qdrant vector DB URL (adapter = 'qdrant'). */
	qdrantUrl?: string;
	/** Qdrant API key. */
	qdrantApiKey?: string;
}

// ── Sync API (localStorage only, backwards compatible) ──

export function loadConfig(): AppConfig | null {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const config = JSON.parse(raw) as AppConfig;
		// Default STT provider: web-speech on Windows/macOS (Chromium WebView),
		// vosk on Linux (WebKitGTK doesn't support Web Speech API)
		if (!config.sttProvider) {
			const isLinux = navigator.userAgent.includes("Linux");
			config.sttProvider = isLinux ? "vosk" : "web-speech";
		}
		if (config.enableTools == null) {
			config.enableTools = true;
		}
		return config;
	} catch {
		return null;
	}
}

export function saveConfig(config: AppConfig): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
	if (typeof window !== "undefined") {
		window.dispatchEvent(new CustomEvent("naia-config-changed"));
	}
}

export function hasApiKey(): boolean {
	const config = loadConfig();
	return !!config?.apiKey || !!config?.naiaKey;
}

export function isReadyToChat(): boolean {
	const config = loadConfig();
	if (!config) return false;
	// Import-free check: provider needs no key if it's claude-code-cli, ollama, or vllm
	const noKeyNeeded =
		config.provider === "claude-code-cli" ||
		config.provider === "ollama" ||
		config.provider === "vllm";
	return noKeyNeeded || !!config.apiKey || !!config.naiaKey;
}

export function hasNaiaKey(): boolean {
	const config = loadConfig();
	return !!config?.naiaKey;
}

export function getNaiaKey(): string | undefined {
	return loadConfig()?.naiaKey;
}

export function resolveGatewayUrl(
	config: AppConfig | null | undefined,
): string | undefined {
	if (!config?.enableTools) return undefined;
	const raw = config.gatewayUrl?.trim();
	return raw && raw.length > 0 ? raw : DEFAULT_GATEWAY_URL;
}

export function resolveConfiguredGatewayUrl(
	config: AppConfig | null | undefined,
): string | undefined {
	if (!config?.enableTools) return undefined;
	const raw = config.gatewayUrl?.trim();
	if (!raw || raw === DEFAULT_GATEWAY_URL) return undefined;
	return raw;
}

// ── Async API (secure store + localStorage fallback) ──

/**
 * Load full config: localStorage fields + secrets from secure store.
 */
export async function loadConfigWithSecrets(): Promise<AppConfig | null> {
	const config = loadConfig();
	if (!config) return null;

	for (const key of SECRET_KEYS) {
		const localVal = (config as any)[key];
		const secureVal = await getSecretKey(key);
		if (localVal) {
			// localStorage has a fresh value (e.g. just saved by login handler)
			// Sync to secure store if different
			if (localVal !== secureVal) {
				await saveSecretKey(key, localVal);
			}
		} else if (secureVal) {
			// Only use secure store when localStorage doesn't have the value
			(config as any)[key] = secureVal;
		}
	}
	return config;
}

/**
 * Save config: sensitive fields → secure store, rest → localStorage.
 */
export async function saveConfigSecure(config: AppConfig): Promise<void> {
	const publicConfig = { ...config };

	for (const key of SECRET_KEYS) {
		const val = (config as any)[key];
		if (typeof val === "string" && val.length > 0) {
			await saveSecretKey(key, val);
		}
		(publicConfig as any)[key] = undefined;
	}

	localStorage.setItem(STORAGE_KEY, JSON.stringify(publicConfig));
}

/**
 * Migrate secrets from localStorage to secure store.
 * Call once on app startup. Idempotent.
 */
export async function migrateSecretsToSecureStore(): Promise<void> {
	const config = loadConfig();
	if (!config) return;

	let migrated = false;
	for (const key of SECRET_KEYS) {
		const val = (config as any)[key];
		if (typeof val === "string" && val.length > 0) {
			const existing = await getSecretKey(key);
			if (!existing) {
				await saveSecretKey(key, val);
			}
			(config as any)[key] = undefined;
			migrated = true;
		}
	}

	if (migrated) {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
	}
}

/**
 * Async version: check secure store first, then localStorage.
 */
export async function hasApiKeySecure(): Promise<boolean> {
	const apiKey = await getSecretKey("apiKey");
	const naiaKey = await getSecretKey("naiaKey");
	if (apiKey || naiaKey) return true;
	return hasApiKey();
}

export async function getNaiaKeySecure(): Promise<string | undefined> {
	const secureVal = await getSecretKey("naiaKey");
	if (secureVal) return secureVal;
	return getNaiaKey();
}

export async function hasNaiaKeySecure(): Promise<boolean> {
	const key = await getNaiaKeySecure();
	return !!key;
}

/**
 * Migrate labKey/labUserId → naiaKey/naiaUserId.
 * Call once on app startup after migrateSecretsToSecureStore(). Idempotent.
 */
export async function migrateLabKeyToNaiaKey(): Promise<void> {
	// 1. Secure store: labKey → naiaKey (skip if Tauri not available)
	try {
		const oldKey = await getSecretKey("labKey" as any);
		if (oldKey) {
			await saveSecretKey("naiaKey", oldKey);
			await deleteSecretKey("labKey" as any);
		}
	} catch {
		// Tauri store not available (e.g. tests) — skip secure store migration
	}

	// 2. localStorage: labKey → naiaKey, labUserId → naiaUserId
	const config = loadConfig();
	if (!config) return;
	const raw = config as any;
	let changed = false;
	if (raw.labKey && !raw.naiaKey) {
		raw.naiaKey = raw.labKey;
		raw.labKey = undefined;
		changed = true;
	}
	if (raw.labUserId && !raw.naiaUserId) {
		raw.naiaUserId = raw.labUserId;
		raw.labUserId = undefined;
		changed = true;
	}
	if (changed) {
		localStorage.setItem("naia-config", JSON.stringify(raw));
	}
}

// ── Speech style migration ──

/** Normalize legacy Korean speech style values to locale-neutral keys */
export function normalizeSpeechStyle(
	val: string | undefined,
): string | undefined {
	if (!val) return val;
	if (val === "반말") return "casual";
	if (val === "존댓말") return "formal";
	return val;
}

/**
 * Migrate speechStyle from Korean values ("반말"/"존댓말") to locale-neutral ("casual"/"formal").
 * Call once on app startup. Idempotent.
 */
export function migrateSpeechStyleValues(): void {
	const config = loadConfig();
	if (!config?.speechStyle) return;
	const normalized = normalizeSpeechStyle(config.speechStyle);
	if (normalized !== config.speechStyle) {
		saveConfig({ ...config, speechStyle: normalized });
	}
}

// ── Live provider → unified model migration ──

/**
 * Migrate legacy liveProvider settings to unified model selection.
 * Call once on app startup after other migrations. Idempotent.
 *
 * liveProvider: "naia" → provider: "nextain", model: "gemini-2.5-flash-live"
 * liveProvider: "gemini-live" → provider: "gemini", model: "gemini-2.5-flash-live"
 * liveProvider: "openai-realtime" → provider: "openai", model: "gpt-4o-realtime"
 * liveProvider: "edge-tts" → ttsProvider: "edge" (pipeline TTS)
 * liveProvider: "minicpm-o" → preserved in config (backlog #33), UI hidden
 */
export function migrateLiveProviderToUnifiedModel(): void {
	const config = loadConfig();
	if (!config) return;
	const raw = config as any;

	// Skip if already migrated (no liveProvider field)
	if (!raw.liveProvider) return;

	let changed = false;

	switch (raw.liveProvider) {
		case "naia":
			raw.voice = raw.liveVoice;
			raw.provider = "nextain";
			raw.model = "gemini-2.5-flash-live";
			changed = true;
			break;
		case "gemini-live":
			raw.voice = raw.liveVoice;
			raw.provider = "gemini";
			raw.model = "gemini-2.5-flash-live";
			changed = true;
			break;
		case "openai-realtime":
			raw.voice = raw.openaiRealtimeVoice;
			raw.provider = "openai";
			raw.model = "gpt-4o-realtime";
			changed = true;
			break;
		case "edge-tts":
			// Edge TTS moves to pipeline TTS provider
			if (!raw.ttsProvider) raw.ttsProvider = "edge";
			changed = true;
			break;
		case "minicpm-o":
			// minicpm-o uses vllmHost/ws — clear legacy liveProvider
			changed = true;
			break;
	}

	if (changed) {
		raw.liveProvider = undefined;
		raw.liveVoice = undefined;
		raw.liveModel = undefined;
		localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
	}
}

// ── Utility functions (sync, unchanged) ──

export function getDisabledSkills(): string[] {
	const config = loadConfig();
	return config?.disabledSkills ?? [];
}

export function isSkillDisabled(skillName: string): boolean {
	return getDisabledSkills().includes(skillName);
}

export function toggleSkill(skillName: string): void {
	const config = loadConfig();
	if (!config) return;
	const disabled = config.disabledSkills ?? [];
	const idx = disabled.indexOf(skillName);
	const next =
		idx >= 0
			? [...disabled.slice(0, idx), ...disabled.slice(idx + 1)]
			: [...disabled, skillName];
	saveConfig({ ...config, disabledSkills: next });
}

export function isToolAllowed(toolName: string): boolean {
	const config = loadConfig();
	return config?.allowedTools?.includes(toolName) ?? false;
}

export function addAllowedTool(toolName: string): void {
	const config = loadConfig();
	if (!config) return;
	const tools = config.allowedTools ?? [];
	if (!tools.includes(toolName)) {
		tools.push(toolName);
	}
	saveConfig({ ...config, allowedTools: tools });
}

export function clearAllowedTools(): void {
	const config = loadConfig();
	if (!config) return;
	saveConfig({ ...config, allowedTools: undefined });
}

export function isOnboardingComplete(): boolean {
	const config = loadConfig();
	return config?.onboardingComplete === true;
}

export function getUserName(): string | undefined {
	return loadConfig()?.userName;
}

const _PROD_GATEWAY =
	(import.meta.env.VITE_NAIA_GATEWAY_URL as string) ||
	"https://naia-gateway-181404717065.asia-northeast3.run.app";

const _DEV_GATEWAY =
	(import.meta.env.VITE_NAIA_DEV_GATEWAY_URL as string) ||
	"https://naia-gateway-dev-181404717065.asia-northeast3.run.app";

/** any-llm Gateway URL — dev mode uses dev gateway, production uses prod gateway. */
export const LAB_GATEWAY_URL = import.meta.env.DEV ? _DEV_GATEWAY : _PROD_GATEWAY;

/** Dev-only gateway URL (always available regardless of mode). */
export const DEV_GATEWAY_URL = _DEV_GATEWAY;

export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
export const DEFAULT_VLLM_HOST = "http://localhost:8000";
