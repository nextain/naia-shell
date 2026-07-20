import type { VramTierId } from "./capabilities/vram-tiers";
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
/** Default address for the Naia Local container (omni-24g realtime WS).
 *  Use 127.0.0.1, not "localhost": localhost resolves to IPv6 ::1 first in many
 *  setups, but rootless-podman publishes the container on IPv4 only — so
 *  ws://localhost:8892 hits ::1 and fails ("WebSocket error"), while 127.0.0.1
 *  reaches the container. */
export const DEFAULT_NAIA_LOCAL_URL = "ws://127.0.0.1:8892";

/**
 * Default reference voice ("여성 음색 1" / cc0-ko-female-01) used when the user
 * has no custom ref and no preset selected. Public CC0 sample (Mozilla Common
 * Voice) on the gateway's public bucket — sent as `ref_audio_url` so the omni
 * voice is always a stable human voice, never the unconditioned/random default.
 */
export const DEFAULT_VOICE_REF_URL =
	"https://storage.googleapis.com/naia-ref-audio-presets/cc0/cc0-ko-female-01.wav";

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
	| "vllm"
	| "naia-local-voice";

export type PanelPosition = "left" | "right" | "bottom";

export interface AppConfig {
	provider: ProviderId;
	model: string;
	apiKey: string;
	locale?: Locale;
	theme?: ThemeId;
	backgroundImage?: string;
	vrmModel?: string;
	avatarProvider?: "vrm" | "naia-video-avatar";
	nvaModel?: string;
	/**
	 * NVA 토킹 아바타용 cascade 런타임(output_cascade façade) URL.
	 * 비면 정적 idle 루프만(입 안 움직임). 설정 시 발화를 이 런타임에 보내 립싱크 스트림을 받는다.
	 * 예: http://127.0.0.1:8910(로컬 임베드) 또는 http://100.91.187.24:8910(원격 GPU PC).
	 * SoT: .agents/progress/naia-os-cascade-talking-avatar-2026-07-01.md
	 */
	cascadeRuntimeUrl?: string;
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
	/**
	 * Active voice-reference preset sample URL for realtime voice (omni). Set
	 * when the user applies a preset in Settings; sent verbatim as
	 * `session.update.ref_audio_url` at connect (the deterministic source the
	 * web demo uses — no dependence on the GET /v1/ref-audio status round-trip).
	 * Empty for uploads/recordings (those are injected server-side from GCS).
	 */
	voiceRefUrl?: string;
	persona?: string;
	enableTools?: boolean;
	enableThinking?: boolean;
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
	/** Naia Local: ws:// address of the user's own omni-24g container.
	 *  Shown/edited when the `naia-local` model is selected; the logged-in naiaKey
	 *  is reused (no key input). Only loopback may be plaintext ws://; remote must
	 *  be wss:// (cross-review). Default DEFAULT_NAIA_LOCAL_URL. */
	naiaLocalUrl?: string;
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
	/** Per-request Ollama GPU layers. `0` keeps the model on CPU/NPU so the
	 * laptop 4060 profile reserves VRAM for Ditto and VoxCPM2. */
	ollamaNumGpu?: number;
	vllmHost?: string;
	/** vLLM endpoint for STT/ASR (e.g. Qwen3-ASR). */
	vllmSttHost?: string;
	/**
	 * Local GPU profile (#2 / FR-VRAM.2). "off" (default) = no effect; "auto" =
	 * use the tier detected from GPU VRAM; an explicit tier id forces it.
	 * Additive only — surfaces which local services a tier COULD serve as a
	 * budget candidate. Must NOT hide external STT/TTS slots until a runtime
	 * manager (windows-manager) reports actual readiness (F1, measurement-gated).
	 */
	localGpuTier?: VramTierId | "auto" | "off";
	/**
	 * 8G 배타 티어 로컬 집중 (정본, 2026-07-08): "llm" | "avatar" | "both".
	 * "llm" = 브레인만 로컬(추론·기억 프라이버시) / "avatar" = Ditto 립싱크 로컬 / "both" = 둘 다.
	 * 음성은 8G 에선 항상 클라우드. 12G+ 에서는 무시. 미지정 → 기본 "llm".
	 */
	local8gFocus?: import("./capabilities/vram-tiers").Local8gFocus;
	/**
	 * @deprecated local8gFocus 로 대체(2026-07-08). 읽기 전용 legacy alias — 구 축(avatar/voice/both)
	 * 저장값 마이그레이션용. 로드 시 normalizeLocal8gFocus 로 변환, 새 쓰기는 local8gFocus 에.
	 */
	localAvatarVoiceFocus?: import("./capabilities/vram-tiers").Local8gFocus;
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
	/** Opt-in proactive speech mode. Disabled unless explicitly persisted. */
	proactiveSpeechProfile?: "disabled" | "personal_radio_dj" | "exhibition_intro";
	proactiveSpeechIdleMs?: number;
	proactiveSpeechIntervalMs?: number;
	proactiveSpeechTimezone?: string;
	proactiveSpeechBgmAutoPlay?: boolean;
	proactiveSpeechWeatherConsented?: boolean;
	proactiveSpeechWeatherLatitude?: number;
	proactiveSpeechWeatherLongitude?: number;
	proactiveSpeechKnowledgeScope?: string;

	// ── Memory settings ──
	/** Memory adapter backend. Defaults to 'local' (JSON file). */
	memoryAdapter?: "local" | "qdrant";
	/** Embedding provider for semantic search. Defaults to 'none' (keyword search). */
	memoryEmbeddingProvider?: "none" | "offline" | "vllm" | "ollama" | "naia";
	/** Offline embedding model (used when memoryEmbeddingProvider = 'offline').
	 *  다국어(한국어): multilingual-e5-large(1024d, 고정확) · paraphrase-multilingual-MiniLM-L12-v2(384d, 경량·빠름).
	 *  영어 전용: all-MiniLM-L6-v2 · all-mpnet-base-v2 (한국어 회상 품질 낮음). */
	memoryOfflineModel?:
		| "all-MiniLM-L6-v2"
		| "all-mpnet-base-v2"
		| "multilingual-e5-large"
		| "paraphrase-multilingual-MiniLM-L12-v2";
	/** naia-embedded 컴퓨트 device (memoryEmbeddingProvider = 'offline'). cpu=강제CPU / gpu=가용시GPU(없으면 CPU 폴백) / auto=자동. */
	memoryEmbeddingDevice?: "cpu" | "gpu" | "auto";
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

/**
 * 원격 cascade URL 검증·정규화 (고급 T3 경로).
 * 빈 값 → {url: undefined}(로컬 auto). http/https 만 허용, 파싱 실패/스킴 위반 → error.
 * trailing slash 정규화. 도달성(health)까지는 검증 안 함(후속).
 */
export function normalizeCascadeUrl(raw: string): {
	url?: string;
	error?: "invalid" | "scheme";
} {
	const v = (raw ?? "").trim();
	if (!v) return { url: undefined };
	let u: URL;
	try {
		u = new URL(v);
	} catch {
		return { error: "invalid" };
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") {
		return { error: "scheme" };
	}
	return { url: v.replace(/\/+$/, "") };
}

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

/**
 * 부팅 병합 (UC-CONFIG-SOT / FR-CONFIG-SOT.1) — **파일이 SoT, localStorage 는 캐시**.
 *
 * localStorage 의 역할은 오직 `naia-adk-path`(부트스트랩 포인터) 뿐이다(루크 원칙 2026-07-15).
 * `naia-config` 는 파일에서 하이드레이트되는 렌더 캐시이므로, 부팅 시 **파일 값이 절대적으로 이긴다**.
 *
 * ⚠️ 이전 버그: `App.tsx` 부팅 병합만 유일하게 `{ ...local, ...file, ...ui }` 로 **local 을 base** 로 써서,
 *   config.json 이 persona 키를 안 담으면 스테일 localStorage persona(알파)가 살아남아 파일을 덮었다.
 *   워크스페이스 전환(`applyWorkspaceConfigToLocal`)은 이미 파일만 base 였다 — 이 함수로 부팅도 동형화한다.
 *
 * @param local  현재 localStorage(`naia-config`) — **base 로 쓰지 않는다**. 부트스트랩 키만 폴백 제공.
 * @param file   `naia-settings/config.json`(agent 소비: persona·이름·말투·locale·provider·model). SoT.
 * @param ui     `naia-settings/ui-config.json`(VRM·배경·BGM). SoT.
 * @returns 병합 결과, 또는 파일이 둘 다 없으면 `null`(캐시 wipe 방지 — 호출자가 기존 캐시 유지).
 */
export function mergeBootConfig(
	local: Record<string, unknown> | null,
	file: Record<string, unknown> | null,
	ui: Record<string, unknown> | null,
): Record<string, unknown> | null {
	// 파일이 둘 다 없으면 하이드레이트할 근거가 없다 → null (호출자가 기존 캐시 유지, wipe 금지).
	if (!file && !ui) return null;

	// 부트스트랩 키: 파일이 아니라 로컬(디바이스)에 정당하게 사는 값. 파일에 없으면 로컬에서 폴백.
	//   - workspaceRoot: 어느 ADK 를 볼지(adkPath 미러). 파일이 이걸 안 담을 수 있다.
	//   - onboardingComplete: 온보딩 재실행 방지 플래그. 파일에 있으면 파일 우선.
	const bootstrap: Record<string, unknown> = {};
	for (const k of ["workspaceRoot", "onboardingComplete"]) {
		if (local && local[k] !== undefined) bootstrap[k] = local[k];
	}

	// 파일이 절대 우선. local 은 base 로 쓰지 않는다(스테일 persona/model/이름 leak 차단).
	return { ...bootstrap, ...(file ?? {}), ...(ui ?? {}) };
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
async function getSecretKeySafe(key: string): Promise<string | null> {
	try {
		return await getSecretKey(key);
	} catch {
		return null;
	}
}

async function saveSecretKeySafe(key: string, value: string): Promise<void> {
	try {
		await saveSecretKey(key, value);
	} catch {
		// localStorage fallback remains usable; startup auth will retry secure store
		// on the next load instead of blocking the whole config restore path.
	}
}

export async function loadConfigWithSecrets(): Promise<AppConfig | null> {
	const config = loadConfig();
	if (!config) return null;

	for (const key of SECRET_KEYS) {
		const localVal = (config as any)[key];
		const secureVal = await getSecretKeySafe(key);
		if (localVal) {
			// localStorage has a fresh value (e.g. just saved by login handler)
			// Sync to secure store if different
			if (localVal !== secureVal) {
				await saveSecretKeySafe(key, localVal);
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
 *
 * #329 (B) hygiene: provider="nextain" relies solely on `naiaKey`. Any
 * stale `apiKey` from an earlier direct-provider session would collide
 * with `naiaKey` via the secret IPC race (see L059). Delete it actively
 * so the secure store stays clean and the agent only sees one source.
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

	// #329 (B) — purge collision-causing stale fields per provider.
	if (config.provider === "nextain") {
		await deleteSecretKey("apiKey");
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
	const apiKey = await getSecretKeySafe("apiKey");
	const naiaKey = await getSecretKeySafe("naiaKey");
	if (apiKey || naiaKey) return true;
	return hasApiKey();
}

export async function getNaiaKeySecure(): Promise<string | undefined> {
	const secureVal = await getSecretKeySafe("naiaKey");
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
 * liveProvider: "naia-omni" → preserved in config (backlog #33), UI hidden
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
		case "naia-omni":
			// naia-omni uses vllmHost/ws — clear legacy liveProvider
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

// Release runtime gateway (the gateway a DISTRIBUTED build talks to — distinct
// from the auto-updater endpoint, which is GitHub Releases). This is the public
// prod API gateway (api.nextain.io — TLS in front of the prod gateway VM); the
// raw VM IP stays out of this public repo. Override per-environment with
// VITE_NAIA_GATEWAY_URL. The earlier Cloud Run → VM migration is now complete —
// see memory: naia-anyllm-vm-migration.
const _PROD_GATEWAY =
	(import.meta.env.VITE_NAIA_GATEWAY_URL as string) || "https://api.nextain.io";

const _DEV_GATEWAY =
	(import.meta.env.VITE_NAIA_DEV_GATEWAY_URL as string) || "";

/**
 * any-llm Gateway URL.
 *
 * Mode resolution (#333 follow-up):
 *   - `pnpm run tauri:dev`  → wrapper sets VITE_NAIA_USE_DEV_GATEWAY=1
 *                             + VITE_NAIA_DEV_GATEWAY_URL → dev Cloud Run
 *   - `pnpm run tauri:prod` → wrapper unsets both → prod Cloud Run
 *   - `wdio` e2e            → loads .env.e2e which sets the same flag
 *
 * The previous rule "any Vite dev mode + dev URL present → dev gateway"
 * was too greedy — a stale .env.local with VITE_NAIA_DEV_GATEWAY_URL would
 * silently route a prod-login user to the dev gateway and 401. The explicit
 * VITE_NAIA_USE_DEV_GATEWAY flag forces an opt-in.
 */
const _USE_DEV_GATEWAY = import.meta.env.VITE_NAIA_USE_DEV_GATEWAY === "1";
export const LAB_GATEWAY_URL =
	_USE_DEV_GATEWAY && _DEV_GATEWAY ? _DEV_GATEWAY : _PROD_GATEWAY;

/** Dev-only gateway URL (always available regardless of mode). */
export const DEV_GATEWAY_URL = _DEV_GATEWAY || _PROD_GATEWAY;

// Naia web app base (login portal / dashboard / manual). Set per environment in
// .env.{dev,prod} via VITE_NAIA_WEB_BASE_URL (loaded by scripts/tauri-with-mode.mjs):
// `tauri:dev` → http://localhost:3001, `tauri:prod` → https://www.naia.land.
// (도메인 이전 2026-07: naia.nextain.io → www.naia.land. 둘 다 307/200 라이브이나
//  www.naia.land 가 정본. 컴포넌트는 이 상수를 쓸 것 — 직접 하드코딩 금지.)
export const NAIA_WEB_BASE_URL =
	(import.meta.env.VITE_NAIA_WEB_BASE_URL as string) ||
	"https://www.naia.land";

export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
// 로컬 GPU 프로파일(llm capability) 선택 시 두뇌 자동 기본값 — wm `llm_main_compact` 와 동형
// (dnotitia DNA3.0-4B, mradermacher GGUF Q4 변환 — 출처 정직 표기. ~3.2G@16k 실측).
// compact 를 기본으로 두는 이유: 로컬 음성(fp16 ~6.1G)·아바타(2.6G)와 16GB 동거 안전선
// (9B 6.3G 는 포화 → 스래싱 실측 148s). 사용자가 이미 ollama 면 선택 모델을 보존한다.
// This must be an installed Ollama tag. The 8GB laptop profile provisions
// dna3:latest; a Hugging Face reference is not resolvable by /api/chat.
export const DEFAULT_LOCAL_LLM_MODEL = "dna3:latest";
const LEGACY_DNA3_OLLAMA_MODEL =
	"hf.co/mradermacher/DNA3.0-4B-GGUF:Q4_K_M";
export const DEFAULT_VLLM_HOST = "http://localhost:8000";
// 로컬 음성(naia-local-voice = VoxCPM2) 기본 호스트 = **로컬 cascade façade(:8910)**.
// 셸 소비자는 OpenAI 정본 표면 /v1/audio/speech 만 쓰는데(3자 합의 2026-07-15), raw
// VoxCPM2 서비스(:22600)는 그 표면이 없다 — façade 가 voice→ref 해석까지 얹어 서빙한다.
// (구 값 :22600 은 raw /tts 시대 잔재 — UI 에서 로컬 음성만 고르면 아무것도 안 나오던 원인.)
// :8910 is the only desktop-facing endpoint. It owns `/tts` (WAV) and
// `/stream` (Ditto rendering); the bundled VoxCPM2 service on :8901 remains
// private behind this facade.
export const DEFAULT_LOCAL_VOICE_HOST = "http://localhost:8910";

/**
 * The previous 4060 profile wrote a Hugging Face reference into Ollama's
 * `model` field. Ollama cannot resolve that reference unless it was pulled
 * under the exact same tag, so existing profiles failed with a 404 even when
 * `dna3:latest` was installed. Keep explicit user-selected Ollama models.
 */
export function migrateLegacyDna3OllamaModel(): void {
	const config = loadConfig();
	if (!config) return;
	const model =
		config.provider === "ollama" &&
		config.model === LEGACY_DNA3_OLLAMA_MODEL
			? DEFAULT_LOCAL_LLM_MODEL
			: config.model;
	const vllmTtsHost =
		config.ttsProvider === "naia-local-voice" &&
		config.vllmTtsHost?.replace(/\/$/, "") === "http://localhost:8901"
			? DEFAULT_LOCAL_VOICE_HOST
			: config.vllmTtsHost;
	if (model !== config.model || vllmTtsHost !== config.vllmTtsHost) {
		saveConfig({ ...config, model, vllmTtsHost });
	}
}

const INSTANCE_ID_KEY = "naia-os-instance-id";

/** Get or create a persistent naia-os install UUID (CONTRACT §1.2). */
export function getNaiaInstanceId(userId?: string): string {
	let id = localStorage.getItem(INSTANCE_ID_KEY);
	if (!id) {
		id = crypto.randomUUID();
		localStorage.setItem(INSTANCE_ID_KEY, id);
	}
	return userId ? `${userId}:${id}` : id;
}
