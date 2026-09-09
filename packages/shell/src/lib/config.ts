import type { EnvironmentAwareness } from "@nextain/naia-os-core/composition";
import type { VramTierId } from "./capabilities/vram-tiers";
import type { Locale } from "./i18n";
import { Logger } from "./logger";
import {
	SECRET_KEYS,
	deleteSecretKeyAtPath,
	getLegacySecretEntries,
	getSecretKey,
	getSecretKeyAtPath,
	getSecureStorePath,
	hasFirstAdkBindingReceipt,
	isSecretKey,
	markFirstAdkBinding,
	saveSecretKeyAtPath,
} from "./secure-store";
import { NAIA_SLOT_DEFAULTS } from "./slots/model";
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
// Azure public blob is the canonical host (GCP is being retired). Preview plays
// this through `new Audio(url)` which the webview CSP `media-src` gates — the
// Azure host must therefore stay on that allow-list (tauri.conf.json), or every
// preview dies as a silent "playback failed".
export const DEFAULT_VOICE_REF_URL =
	"https://stnaiapub83b29893.blob.core.windows.net/ref-audio/cc0/cc0-ko-female-01.wav";

/**
 * Rewrite a legacy GCS preset URL to the canonical Azure host. The gateway
 * catalog still serves storage.googleapis.com sample URLs, but GCP is being
 * retired — previews against it fail (MEDIA_ERR_SRC_NOT_SUPPORTED) and any
 * stored GCS URL would break outright once the bucket is gone. Same blob
 * layout on both hosts, so only the prefix changes.
 */
export function canonicalRefAudioUrl(url: string): string {
	return url.replace(
		/^https:\/\/storage\.googleapis\.com\/naia-ref-audio-presets\//,
		"https://stnaiapub83b29893.blob.core.windows.net/ref-audio/",
	);
}

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

export type AppPosition = "left" | "right" | "bottom";

/** Development tiers are expert/main/sub; memory remains orthogonal. */
export type LlmRoleId = "expert" | "main" | "sub" | "memory";
export interface LlmRoleConfig {
	provider?: ProviderId;
	model?: string;
	baseUrl?: string;
	/** OS keychain의 opaque 참조만 허용하며 실제 key/token은 넣지 않는다. */
	credentialRef?: string;
	inherit?: LlmRoleId;
}

export interface AppConfig {
	provider: ProviderId;
	model: string;
	/** Settings-only model catalog ordering. Persisted in ui-config.json. */
	modelSortMode?: "price" | "performance";
	/** UI preferences are persisted with the selected ADK's ui-config.json. */
	uiPreferences?: Record<string, unknown>;
	apiKey: string;
	/** main/sub/memory 신규 정본. 전환 기간에는 legacy flat 필드와 dual-read/write한다. */
	llmRoles?: Partial<Record<LlmRoleId, LlmRoleConfig>>;
	subLlmProvider?: ProviderId;
	subLlmModel?: string;
	subLlmBaseUrl?: string;
	/** API key for an explicit sub-brain provider. Stored only in the secure store. */
	subLlmApiKey?: string;
	subLlmCredentialRef?: string;
	memoryLlmCredentialRef?: string;
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
	/**
	 * #502 (FR-ENV-LIVE.4) — 나이아가 사용자의 터미널에 직접 입력하는 것을 허용하는가.
	 * 사용자가 직접 타이핑하는 것과 같은 일이라 구조화 전달과 같은 권한으로 나가지 않는다.
	 * 기본값은 꺼짐이며, 꺼져 있으면 거절 사유가 그대로 나이아에게 올라간다.
	 */
	environmentTerminalInput?: boolean;
	/**
	 * #502 (FR-ENV-ATTENTION.4) — 작업 표면을 나이아가 얼마나 인지하게 둘 것인가.
	 *   "off"    작업 표면을 아예 알리지 않는다. 도구도 등록하지 않는다.
	 *   "auto"   (기본값) 평소에는 표면 개수만 알리고, 목록이 필요하면 나이아가 스스로 지켜본다.
	 *   "always" 요청마다 표면 목록을 싣는다. 나이아가 끌 수 없다.
	 * 기본이 "auto" 인 이유: 목록을 늘 실으면 요청마다 토큰이 붙고 터미널 이름이 늘 뇌로 간다.
	 */
	environmentAwareness?: EnvironmentAwareness;
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
	/**
	 * 페르소나를 시스템 프롬프트로 주입하지 않는다.
	 *
	 * 파인튜닝으로 성격을 가중치에 넣은 모델은 프롬프트가 없어도 자기 이름과
	 * 말투를 유지한다. 거기에 셸이 또 페르소나를 얹으면 두 정의가 부딪힌다.
	 * 실제로 페르소나 입력을 비우면 DEFAULT_PERSONA("You are Naia")가 대신
	 * 들어가서, 자기를 알파로 아는 모델에게 너는 나이아라고 말하는 상태가 됐다.
	 *
	 * 이 값이 true 면 페르소나 본문·사용자 이름·호칭·말투를 모두 보내지 않는다.
	 * 응답 언어 지시와 도구/앱 문맥은 성격이 아니므로 그대로 둔다.
	 */
	personaDisabled?: boolean;
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
	appPosition?: AppPosition;
	appVisible?: boolean;
	appSize?: number;
	discordSessionMigrated?: boolean;
	discordRelayUrl?: string;
	lastProcessedDiscordMessageId?: string;
	ollamaHost?: string;
	/** Per-request Ollama GPU layers. `0` keeps the model on CPU/NPU so the
	 * laptop 4060 profile reserves VRAM for Ditto and VoxCPM2. */
	ollamaNumGpu?: number;
	vllmHost?: string;
	/** Optional OpenAI-compatible API root. Empty uses api.openai.com/v1. */
	openaiBaseUrl?: string;
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
	/** Explicit user authority for the packaged voxCPM2 local voice runtime. */
	localVoiceEnabled?: boolean;
	/**
	 * 로컬 음성을 올릴 카드 번호 (#537).
	 *
	 * 비워 두면 여유가 가장 많은 카드에 올라간다. 카드가 한 장뿐인 기계에서는
	 * 고를 것이 없으므로 설정 자체가 보이지 않는다. 없는 번호가 남아 있어도
	 * 런타임은 기본으로 돌아간다 — 카드를 뽑았다고 음성이 아예 안 뜨면 안 된다.
	 */
	localVoiceGpuIndex?: number;
	/**
	 * FR-VOICE.13 (#419): recorded when a safety migration disabled the local
	 * voice authority (retired localGpuTier treated as stale authority). The
	 * Voice settings card must surface this reason with a recovery action;
	 * cleared as soon as the user re-enables local voice.
	 */
	localVoiceMigrationNotice?: "legacy-local-profile";
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
	/** App IDs that the user has explicitly deleted (build-time apps only). */
	deletedApps?: string[];
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
	/** Whether the YouTube BGM iframe is visible as the app background. */
	bgmYoutubeBackgroundVideo?: boolean;
	/**
	 * YouTube BGM favorites — user data, so it lives in the workspace SoT
	 * (naia-settings config) and survives reinstall/update/profile switches.
	 * `undefined` = not yet migrated from the legacy webview localStorage key
	 * "yt-bgm-favorites"; an array (even empty) = workspace copy is authoritative.
	 */
	bgmYoutubeFavorites?: {
		id: string;
		title: string;
		thumbnail?: string;
		duration?: string;
		channel?: string;
	}[];
	/** Persistent mixed-source music library. Stored in naia-settings. */
	bgmLibrary?: import("./bgm-library").BgmLibraryState;
	/** Last BGM volume (0–1). */
	bgmVolume?: number;
	/** Whether BGM was playing when the app was closed. */
	bgmPlaying?: boolean;
	/** Opt-in proactive speech mode. Disabled unless explicitly persisted. */
	proactiveSpeechProfile?:
		| "disabled"
		| "personal_radio_dj"
		| "exhibition_intro";
	/** Runtime permission for proactive LLM/TTS use. Profile policy alone never implies permission. */
	proactiveSpeechPermitted?: boolean;
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
	/** Legacy compatibility mirror for memory role. `llmRoles.memory` is authoritative. */
	memoryLlmProvider?: ProviderId | "none";
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

/** Derived config.json env aliases. These are write-only outputs, not AppConfig input. */
export const DERIVED_AGENT_ENV_KEYS = new Set<string>([
	"NAIA_MAIN_PROVIDER",
	"NAIA_MAIN_MODEL",
	"NAIA_ANYLLM_BASE_URL",
	"OPENAI_BASE_URL",
	"NAIA_EMBED_PROVIDER",
	"NAIA_EMBED_MODEL",
	"NAIA_EMBED_BASE_URL",
	"NAIA_AGENT_NAME",
	"NAIA_USER_NAME",
	"NAIA_SPEECH_STYLE",
	"NAIA_LOCALE",
	"NAIA_LLM_PROVIDER",
	"NAIA_LLM_MODEL",
	"NAIA_LLM_BASE_URL",
]);

function withoutDerivedAgentEnv(
	config: Record<string, unknown> | null,
): Record<string, unknown> | null {
	if (!config) return null;
	return Object.fromEntries(
		Object.entries(config).filter(([key]) => !DERIVED_AGENT_ENV_KEYS.has(key)),
	);
}

// ── Sync API (localStorage only, backwards compatible) ──

/** FR-VOICE.13: log the disabling migration once per session, not per load. */
let legacyLocalVoiceMigrationLogged = false;

function normalizeLocalRuntimeConfig(config: AppConfig): AppConfig {
	const {
		cascadeRuntimeUrl: _retiredCascadeRuntimeUrl,
		local8gFocus: _retiredLocal8gFocus,
		localAvatarVoiceFocus: _retiredLocalAvatarVoiceFocus,
		localGpuTier: retiredLocalGpuTier,
		...current
	} = config;
	const migratedLegacyProfile =
		retiredLocalGpuTier !== undefined && retiredLocalGpuTier !== "off";
	if (migratedLegacyProfile && !legacyLocalVoiceMigrationLogged) {
		// FR-VOICE.13: a migration that disables a feature must say so once,
		// both in the log and in the persisted config the UI reads. The guard
		// keeps it to one line per session — loadConfig runs on every render.
		legacyLocalVoiceMigrationLogged = true;
		Logger.info("config", "safety migration disabled local voice", {
			reason: "legacy-local-profile",
			retiredLocalGpuTier,
		});
	}
	const normalized: AppConfig = {
		...current,
		// A detected/recommended legacy profile was never explicit authority for
		// the new voice-only control. Migrate it safely to OFF.
		localVoiceEnabled: migratedLegacyProfile
			? false
			: config.localVoiceEnabled === true,
		...(migratedLegacyProfile && config.ttsProvider === "naia-local-voice"
			? { ttsEnabled: false }
			: {}),
		...(migratedLegacyProfile
			? { localVoiceMigrationNotice: "legacy-local-profile" as const }
			: {}),
	};
	// The notice only coexists with disabled local voice: re-enabling is the
	// recovery action, so it retires the reason everywhere at once.
	if (normalized.localVoiceEnabled === true) {
		delete normalized.localVoiceMigrationNotice;
	}
	return normalized;
}

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
		const config = reconcileExplicitLocalProfile(
			normalizeLocalRuntimeConfig(JSON.parse(raw) as AppConfig),
		);
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
	localStorage.setItem(
		STORAGE_KEY,
		JSON.stringify(normalizeLocalRuntimeConfig(config)),
	);
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
	if (local?.workspaceRoot !== undefined)
		bootstrap.workspaceRoot = local.workspaceRoot;
	bootstrap.onboardingComplete = local?.onboardingComplete === true;

	// 파일이 절대 우선. local 은 base 로 쓰지 않는다(스테일 persona/model/이름 leak 차단).
	// Old files may contain aliases generated by buildNaiaConfigEnv. Never feed
	// those outputs back into AppConfig; the write boundary regenerates them.
	const normalizedFile = withoutDerivedAgentEnv(file);
	const normalizedUi = withoutDerivedAgentEnv(ui);
	return normalizeLocalRuntimeConfig({
		...bootstrap,
		...(normalizedFile ?? {}),
		...(normalizedUi ?? {}),
	} as unknown as AppConfig) as unknown as Record<string, unknown>;
}

export function hasApiKey(): boolean {
	const config = loadConfig();
	return !!config?.apiKey || !!config?.naiaKey;
}

export function isReadyToChat(): boolean {
	const config = loadConfig();
	if (!config) return false;
	// Import-free check: local-login/local-engine providers need no API key.
	const noKeyNeeded =
		config.provider === "codex" ||
		config.provider === "claude-code-cli" ||
		config.provider === "grok" ||
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

// ── Async API (ADK-backed secure store) ──

/**
 * An ADK pointer is a bootstrap selector, not a stable global.  Async secure
 * store operations capture their expected path, but callers also need to avoid
 * publishing an old workspace's public cache after the user switches ADKs
 * while the operation is waiting on native I/O.
 */
function assertSelectedAdkPath(
	securePath: string | null,
	operation: string,
): void {
	if (securePath && getSecureStorePath() !== securePath) {
		throw new Error(
			`${operation} aborted: selected ADK changed during the operation`,
		);
	}
}

/**
 * Load the public config cache plus secrets from the selected ADK store.
 */
export async function loadConfigWithSecrets(): Promise<AppConfig | null> {
	const publicConfig = loadConfig();
	const securePath = getSecureStorePath();
	// A first-run ADK can have its Naia credential before the public config is
	// written (OAuth callback and onboarding completion are separate steps). Build
	// the same minimal Naia config used by onboarding in that case. The selected
	// ADK remains the authority; an empty ADK still returns null and cannot inherit
	// another ADK's credential.
	const config: AppConfig = publicConfig ?? {
		provider: NAIA_SLOT_DEFAULTS.main.provider,
		model: NAIA_SLOT_DEFAULTS.main.model,
		apiKey: "",
	};
	for (const key of SECRET_KEYS) {
		assertSelectedAdkPath(securePath, "Loading configuration");
		// The selected ADK is the only source of truth. Clear any legacy secret
		// left in localStorage so switching A → B cannot reuse A's credential.
		(config as any)[key] = securePath
			? (await getSecretKeyAtPath(key, securePath)) ?? undefined
			: undefined;
		assertSelectedAdkPath(securePath, "Loading configuration");
	}
	assertSelectedAdkPath(securePath, "Loading configuration");
	if (!publicConfig && !config.naiaKey) return null;
	return config;
}

/**
 * Save sensitive fields to the selected ADK store and the public config cache.
 *
 * #329 (B) hygiene: provider="nextain" relies solely on `naiaKey`. Any
 * stale `apiKey` from an earlier direct-provider session would collide
 * with `naiaKey` via the secret IPC race (see L059). Delete it actively
 * so the secure store stays clean and the agent only sees one source.
 */
export async function saveConfigSecure(config: AppConfig): Promise<void> {
	const publicConfig = { ...config };
	const securePath = getSecureStorePath();
	const configValues = config as unknown as Record<string, unknown>;
	const hasSecretInput = SECRET_KEYS.some((key) => {
		const value = configValues[key];
		return typeof value === "string" && value.length > 0;
	});
	if (!securePath && hasSecretInput) {
		throw new Error(
			"Cannot save credentials without a selected ADK workspace",
		);
	}

	for (const key of SECRET_KEYS) {
		assertSelectedAdkPath(securePath, "Saving configuration");
		const val = (config as any)[key];
		if (typeof val === "string" && val.length > 0) {
			if (securePath) {
				await saveSecretKeyAtPath(key, val, securePath);
			}
		}
		assertSelectedAdkPath(securePath, "Saving configuration");
		(publicConfig as any)[key] = undefined;
	}

	// #329 (B) — purge collision-causing stale fields per provider.
	if (config.provider === "nextain") {
		if (securePath) {
			await deleteSecretKeyAtPath("apiKey", securePath);
		}
	}

	// Keep the ordinary config-change contract: Settings/App listeners must see
	// the public snapshot immediately, while secret values remain keychain-only.
	assertSelectedAdkPath(securePath, "Saving configuration");
	saveConfig(publicConfig);
}

let secretMigrationPromise: Promise<void> | null = null;

function isMigratableLegacyKey(key: string): boolean {
	return isSecretKey(key) || key === "labKey" || key.startsWith("app:");
}

function clearLocalSecretFields(config: AppConfig): boolean {
	const raw = config as unknown as Record<string, unknown>;
	let changed = false;
	for (const key of [...SECRET_KEYS, "labKey"] as const) {
		if (raw[key] !== undefined) {
			raw[key] = undefined;
			changed = true;
		}
	}
	if (changed) saveConfig(config);
	return changed;
}

/**
 * Migrate pre-ADK credentials once into the first selected ADK.
 *
 * The selected path is captured before any await. This keeps one migration
 * from writing to a different ADK if the user changes the bootstrap pointer
 * while the old store is being read. The receipt is persisted by the secure
 * store module, rather than being treated as a localStorage cache.
 */
export async function migrateSecretsToSecureStore(): Promise<void> {
	if (secretMigrationPromise) return secretMigrationPromise;

	secretMigrationPromise = (async () => {
		const securePath = getSecureStorePath();
		// No selected ADK means there is nowhere safe to put a credential. More
		// importantly, do not write a receipt until one actually exists.
		if (!securePath || (await hasFirstAdkBindingReceipt())) return;

		const config = loadConfig();
		const legacyEntries = new Map<string, string>();
		for (const [key, value] of await getLegacySecretEntries()) {
			if (
				isMigratableLegacyKey(key) &&
				typeof value === "string" &&
				value.length > 0
			) {
				legacyEntries.set(key, value);
			}
		}

		for (const key of SECRET_KEYS) {
			const existing = await getSecretKeyAtPath(key, securePath);
			if (existing) continue;

			// The old device store wins over a still-present localStorage value.
			// Both remain intact until the ADK write has completed.
			const legacy =
				legacyEntries.get(key) ??
				(key === "naiaKey" ? legacyEntries.get("labKey") : undefined);
			const local = config
				? (config as unknown as Record<string, unknown>)[key]
				: undefined;
			const value = legacy ?? local;
			if (typeof value === "string" && value.length > 0) {
				await saveSecretKeyAtPath(key, value, securePath);
			}
		}

		// A pre-ADK labKey is renamed while the captured path is still in hand.
		// Keep the old device-store entry intact for recovery, but never leave the
		// credential in the selected ADK under its obsolete name.
		const localLabKey = config
			? (config as unknown as Record<string, unknown>).labKey
			: undefined;
		const oldLabKey =
			legacyEntries.get("labKey") ??
			(typeof localLabKey === "string" ? localLabKey : undefined) ??
			(await getSecretKeyAtPath("labKey", securePath));
		if (
			typeof oldLabKey === "string" &&
			oldLabKey.length > 0 &&
			!(await getSecretKeyAtPath("naiaKey", securePath))
		) {
			await saveSecretKeyAtPath("naiaKey", oldLabKey, securePath);
		}
		if (await getSecretKeyAtPath("labKey", securePath)) {
			await deleteSecretKeyAtPath("labKey", securePath);
		}

		// Preserve legacy app credentials even though they are outside
		// SECRET_KEYS. The `app:` namespace is intentionally copied verbatim.
		for (const [key, value] of legacyEntries) {
			if (isSecretKey(key) || key === "labKey") {
				continue;
			}
			if (!(await getSecretKeyAtPath(key, securePath))) {
				await saveSecretKeyAtPath(key, value, securePath);
			}
		}

		// Strip the old webview cache only after every canonical write succeeded.
		// The old Tauri store remains untouched, so an interrupted migration can
		// be retried without losing the original credential.
		if (config) clearLocalSecretFields(config);

		// A later ADK must start empty rather than inheriting localStorage or the
		// pre-ADK device credential. The receipt is durable across cache resets.
		await markFirstAdkBinding(securePath);
	})().finally(() => {
		secretMigrationPromise = null;
	});

	return secretMigrationPromise;
}

/**
 * Async version: check the selected ADK store only.
 */
export async function hasApiKeySecure(): Promise<boolean> {
	const apiKey = await getSecretKey("apiKey");
	const naiaKey = await getSecretKey("naiaKey");
	return !!(apiKey || naiaKey);
}

export async function getNaiaKeySecure(): Promise<string | undefined> {
	return (await getSecretKey("naiaKey")) ?? undefined;
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
	const securePath = getSecureStorePath();
	let secureMigrationCompleted = false;
	// This is the existing startup migration entry point. Keep the legacy
	// credential copy behind the first-ADK binding guard rather than relying on
	// every caller to remember to invoke it separately.
	try {
		await migrateSecretsToSecureStore();
		secureMigrationCompleted = Boolean(securePath);
	} catch {
		// Leave the marker unset so the migration remains retryable on startup.
	}

	// 1. Secure store: labKey → naiaKey (skip if Tauri not available). The
	// captured path prevents an ADK switch during the await chain from writing
	// the old credential into a different workspace.
	try {
		if (securePath) {
			const oldKey = await getSecretKeyAtPath("labKey", securePath);
			if (oldKey && !(await getSecretKeyAtPath("naiaKey", securePath))) {
				await saveSecretKeyAtPath("naiaKey", oldKey, securePath);
			}
			if (oldKey) await deleteSecretKeyAtPath("labKey", securePath);
		}
	} catch {
		// Tauri store not available (e.g. tests) — skip secure store migration
	}

	// 2. localStorage: only the non-secret user id is migrated. Secret fields
	// are removed after successful ADK binding and are never recreated locally.
	const config = loadConfig();
	if (!config) return;
	const raw = config as any;
	let changed = false;
	if (secureMigrationCompleted) {
		changed = clearLocalSecretFields(config) || changed;
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
// `tauri:dev` → https://dev.naia.land, `tauri:prod` → https://www.naia.land.
// (도메인 이전 2026-07: naia.nextain.io → www.naia.land. 둘 다 307/200 라이브이나
//  www.naia.land 가 정본. 컴포넌트는 이 상수를 쓸 것 — 직접 하드코딩 금지.)
export const NAIA_WEB_BASE_URL =
	(import.meta.env.VITE_NAIA_WEB_BASE_URL as string) ||
	(import.meta.env.DEV ? "https://dev.naia.land" : "https://www.naia.land");

export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
// 로컬 GPU 프로파일(llm capability) 선택 시 두뇌 자동 기본값 — wm `llm_main_compact` 와 동형
// (dnotitia DNA3.0-4B, mradermacher GGUF Q4 변환 — 출처 정직 표기. ~3.2G@16k 실측).
// compact 를 기본으로 두는 이유: 로컬 음성(fp16 ~6.1G)·아바타(2.6G)와 16GB 동거 안전선
// (9B 6.3G 는 포화 → 스래싱 실측 148s). 사용자가 이미 ollama 면 선택 모델을 보존한다.
// This must be an installed Ollama tag. The 8GB laptop profile provisions
// dna3:latest; a Hugging Face reference is not resolvable by /api/chat.
export const DEFAULT_LOCAL_LLM_MODEL = "dna3:latest";
const LEGACY_DNA3_OLLAMA_MODEL = "hf.co/mradermacher/DNA3.0-4B-GGUF:Q4_K_M";
export const DEFAULT_VLLM_HOST = "http://localhost:8000";
// 로컬 음성 기본 호스트 = 비공개 Naia Media Runtime(:8910).
// 음성 전용은 /v1/audio/speech, 비디오 아바타 결합 발화는 /stream_text를 사용한다.
// 원시 VoxCPM2·Ditto 어댑터의 주소와 조합은 Runtime이 소유하며 Shell에 노출하지 않는다.
// 반드시 127.0.0.1(IPv4 loopback): 엔진은 127.0.0.1 에만 바인딩하는데, Windows 에서
// "localhost" 는 ::1(IPv6) 로 먼저 해석돼 fetch 가 타임아웃/거부된다. 그러면 준비 판정이
// localFacadeUrl(127.0.0.1) 이 채워지기 전 폴백 경로에서 실패해 RefAudioSection 이 잘못
// "엔진 꺼짐"으로 뜬다. localVoiceFacadeUrlFromReady 도 127.0.0.1 을 돌려주므로 일관된다.
export const DEFAULT_LOCAL_VOICE_HOST = "http://127.0.0.1:8910";

/** Retire legacy GPU-profile authority without changing the LLM or avatar. */
export function reconcileExplicitLocalProfile(config: AppConfig): AppConfig {
	return normalizeLocalRuntimeConfig(config);
}

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
		config.provider === "ollama" && config.model === LEGACY_DNA3_OLLAMA_MODEL
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
