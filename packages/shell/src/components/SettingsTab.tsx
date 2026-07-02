import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import {
	agentKeyExists,
	clearAdkPath,
	getAdkPath,
	listNaiaAssets,
	setAdkPath,
	toLocalBlobUrl,
	writeAgentKey,
	writeAgentSecret,
	applyModelSelectionToConfig,
	applyWorkspaceConfigToLocal,
	writeNaiaConfig,
	writeSlotsManifest,
} from "../lib/adk-store";
import {
	DEFAULT_AVATAR_MODEL,
	DEFAULT_NVA_MODEL,
	getDefaultTtsVoiceForAvatar,
	getDefaultVoiceForAvatar,
} from "../lib/avatar-presets";
import { syncLinkedChannels } from "../lib/channel-sync";
import {
	sendAuthUpdate,
	sendCredsUpdate,
	sendNotifyConfig,
} from "../lib/chat-service";
import {
	type AppConfig,
	DEFAULT_GATEWAY_URL,
	DEFAULT_LOCAL_VOICE_HOST,
	DEFAULT_NAIA_LOCAL_URL,
	DEFAULT_OLLAMA_HOST,
	DEFAULT_VLLM_HOST,
	LAB_GATEWAY_URL,
	NAIA_WEB_BASE_URL,
	type SttProviderId,
	type ThemeId,
	type TtsProviderId,
	clearAllowedTools,
	loadConfig,
	loadConfigWithSecrets,
	saveConfig,
} from "../lib/config";
import {
	type AgentFact,
	deleteAgentFact,
	exportMemoryBackup,
	getAllAgentFacts,
	importMemoryBackup,
} from "../lib/db";
import { resetGatewaySession } from "../lib/gateway-sessions";
import {
	type Locale,
	getLocale,
	setLocale,
	t,
	type TranslationKey,
} from "../lib/i18n";
import { parseLabCredits } from "../lib/lab-balance";
import { diffConfigs, fetchLabConfig, pushConfigToLab } from "../lib/lab-sync";
import {
	type LlmModelMeta,
	applyCapabilityOverrides,
	fetchGatewayModelCatalog,
	fetchNaiaModelCapabilities,
	fetchNaiaPricing,
	fetchOllamaModels,
	fetchVllmModels,
	formatModelLabel,
	getDefaultLlmModel,
	getLlmProvider,
	getStaticModelsRecord,
	isApiKeyOptional,
	isOmniModel,
	listLlmProviders,
} from "../lib/llm";
import { deriveSettingsSlots } from "../lib/capabilities/slots";
import { detectGpuVramGb } from "../lib/capabilities/gpu";
import {
	type AvatarVoiceFocus,
	VRAM_TIERS,
	resolveActiveTier,
	resolveLocalCapabilities,
	tierFitsBoth,
	tierProvidedCapabilities,
	type VramTierId,
} from "../lib/capabilities/vram-tiers";
import {
	isRecommendedLocalValue,
	slotRecommendation,
	tierRecommendedSlots,
} from "../lib/capabilities/tier-slots";
import { localFacadeUrlFromReady } from "../lib/avatar/cascade-renderer";
import { useCascadeAvatarStore } from "../stores/cascade-avatar";
import {
	applyNaiaSlotDefaults,
	deriveGate,
	readSlots,
	SLOT_GROUPS,
	type GateMode,
	type SlotId,
} from "../lib/slots/model";
import { Logger } from "../lib/logger";
import { DEFAULT_PERSONA, FORMALITY_LOCALES } from "../lib/persona";
import { deleteSecretKey, saveSecretKey } from "../lib/secure-store";
import { listSttProviders } from "../lib/stt/registry";
import { listTtsProviderMetas } from "../lib/tts/registry";
import { synthesizeTts } from "../lib/tts/synthesize";
import type { ModelCapability, ProviderId } from "../lib/types";
import { type UpdateInfo, checkForUpdate } from "../lib/updater";
import { useAvatarStore } from "../stores/avatar";
import { useChatStore } from "../stores/chat";
import { useAppStore } from "../stores/app";
import { clearSavedCamera } from "./AvatarCanvas";
import { RefAudioSection } from "./RefAudioSection";
import { KnowledgeSettingsTab } from "./KnowledgeSettingsTab";
import { SkillsTab } from "./SkillsTab";

const LLM_PROVIDERS = listLlmProviders();

function vramTierLabelKey(id: VramTierId) {
	return `settings.vramTier.${id}` as const;
}

function buildNaiaLoginConfig(
	current: AppConfig | null,
	nextNaiaKey: string,
	nextNaiaUserId: string,
): AppConfig {
	const nextModel =
		current?.provider === "nextain" && current.model
			? current.model
			: getDefaultLlmModel("nextain");
	const base: AppConfig = current ?? {
		provider: "nextain",
		model: nextModel,
		apiKey: "",
		locale: getLocale(),
	};

	// FR-SLOT.3 / R2-1: naia 게이트 통과 → 미설정 슬롯에 Gemini 기본값 자동 적용.
	// applyNaiaSlotDefaults 는 비파괴(사용자가 이미 설정한 슬롯은 보존). §9 #5 모델 문자열 SoT.
	const withNaiaKey: AppConfig = {
		...base,
		provider: "nextain",
		model: nextModel,
		apiKey: "",
		naiaKey: nextNaiaKey,
		naiaUserId: nextNaiaUserId || undefined,
		voice: base.voice ?? getDefaultVoiceForAvatar(base.vrmModel),
	};
	return applyNaiaSlotDefaults(withNaiaKey);
}
const BG_VIDEO_EXTS = new Set(["mp4", "webm", "mov", "ogg", "avi"]);
const BG_IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);

function getBackgroundMediaType(path: string): "image" | "video" | "" {
	const ext = path.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
	if (BG_VIDEO_EXTS.has(ext)) return "video";
	if (BG_IMAGE_EXTS.has(ext)) return "image";
	return "";
}

// Fallback voice lists for Edge TTS
const ALL_EDGE_VOICES: string[] = [
	// 한국어
	"ko-KR-SunHiNeural",
	"ko-KR-InJoonNeural",
	"ko-KR-HyunsuMultilingualNeural",
	// English
	"en-US-AvaNeural",
	"en-US-AndrewNeural",
	"en-US-EmmaNeural",
	"en-US-BrianNeural",
	"en-US-AriaNeural",
	"en-US-AnaNeural",
	"en-US-ChristopherNeural",
	"en-US-EricNeural",
	"en-US-GuyNeural",
	"en-US-JennyNeural",
	"en-US-MichelleNeural",
	"en-US-RogerNeural",
	"en-US-SteffanNeural",
	"en-US-AndrewMultilingualNeural",
	"en-US-AvaMultilingualNeural",
	"en-US-BrianMultilingualNeural",
	"en-US-EmmaMultilingualNeural",
	"en-GB-LibbyNeural",
	"en-GB-SoniaNeural",
	"en-GB-RyanNeural",
	"en-GB-ThomasNeural",
	"en-GB-MaisieNeural",
	"en-AU-NatashaNeural",
	"en-AU-WilliamMultilingualNeural",
	// 日本語
	"ja-JP-NanamiNeural",
	"ja-JP-KeitaNeural",
	// 中文
	"zh-CN-XiaoxiaoNeural",
	"zh-CN-XiaoyiNeural",
	"zh-CN-YunjianNeural",
	"zh-CN-YunxiNeural",
	"zh-CN-YunxiaNeural",
	"zh-CN-YunyangNeural",
	"zh-TW-HsiaoChenNeural",
	"zh-TW-HsiaoYuNeural",
	"zh-TW-YunJheNeural",
	// Français
	"fr-FR-DeniseNeural",
	"fr-FR-HenriNeural",
	"fr-FR-EloiseNeural",
	"fr-FR-VivienneMultilingualNeural",
	"fr-FR-RemyMultilingualNeural",
	// Deutsch
	"de-DE-KatjaNeural",
	"de-DE-ConradNeural",
	"de-DE-AmalaNeural",
	"de-DE-KillianNeural",
	"de-DE-SeraphinaMultilingualNeural",
	"de-DE-FlorianMultilingualNeural",
	// Русский
	"ru-RU-SvetlanaNeural",
	"ru-RU-DmitryNeural",
	// Español
	"es-ES-ElviraNeural",
	"es-ES-AlvaroNeural",
	"es-ES-XimenaNeural",
	"es-MX-DaliaNeural",
	"es-MX-JorgeNeural",
	// العربية
	"ar-SA-ZariyahNeural",
	"ar-SA-HamedNeural",
	"ar-EG-SalmaNeural",
	"ar-EG-ShakirNeural",
	// हिन्दी
	"hi-IN-SwaraNeural",
	"hi-IN-MadhurNeural",
	// বাংলা
	"bn-BD-NabanitaNeural",
	"bn-BD-PradeepNeural",
	"bn-IN-TanishaaNeural",
	"bn-IN-BashkarNeural",
	// Português
	"pt-BR-FranciscaNeural",
	"pt-BR-AntonioNeural",
	"pt-BR-ThalitaMultilingualNeural",
	"pt-PT-RaquelNeural",
	"pt-PT-DuarteNeural",
	// Bahasa Indonesia
	"id-ID-GadisNeural",
	"id-ID-ArdiNeural",
	// Tiếng Việt
	"vi-VN-HoaiMyNeural",
	"vi-VN-NamMinhNeural",
];

/** Filter Edge voices by locale; multilingual voices always included */
function getEdgeVoicesForLocale(loc: string): string[] {
	const langPrefix = `${loc.slice(0, 2).toLowerCase()}-`;
	return ALL_EDGE_VOICES.filter(
		(v) => v.toLowerCase().startsWith(langPrefix) || v.includes("Multilingual"),
	);
}

const LOCALES: { id: Locale; label: string }[] = [
	{ id: "ko", label: "한국어" },
	{ id: "en", label: "English" },
	{ id: "ja", label: "日本語" },
	{ id: "zh", label: "中文" },
	{ id: "fr", label: "Français" },
	{ id: "de", label: "Deutsch" },
	{ id: "ru", label: "Русский" },
	{ id: "es", label: "Español" },
	{ id: "ar", label: "العربية" },
	{ id: "hi", label: "हिन्दी" },
	{ id: "bn", label: "বাংলা" },
	{ id: "pt", label: "Português" },
	{ id: "id", label: "Bahasa Indonesia" },
	{ id: "vi", label: "Tiếng Việt" },
];

function getNaiaWebBaseUrl() {
	// dev (tauri:dev) → localhost:3001, prod (tauri:prod) → naia.nextain.io.
	// Same VITE_NAIA_USE_DEV_GATEWAY flag as the gateway (see config.ts).
	return NAIA_WEB_BASE_URL;
}

function normalizeLocalPath(path: string): string {
	if (!path.startsWith("file://")) return path;
	try {
		return decodeURIComponent(new URL(path).pathname);
	} catch {
		return path.replace(/^file:\/\//, "");
	}
}

const THEMES: { id: ThemeId; label: string; preview: string }[] = [
	{
		id: "system",
		label: "System",
		preview: "linear-gradient(to right, #ffffff 50%, #1a1a2e 50%)",
	},
	{ id: "espresso", label: "Light", preview: "#ffffff" },
	{ id: "midnight", label: "Dark", preview: "#1a1a2e" },
	{ id: "ocean", label: "Ocean", preview: "#1b2838" },
	{ id: "forest", label: "Forest", preview: "#1a2e1a" },
	{ id: "rose", label: "Rose", preview: "#2e1a2a" },
	{ id: "latte", label: "Latte", preview: "#fffcf5" },
	{ id: "sakura", label: "Sakura", preview: "#fdf2f8" },
	{ id: "cloud", label: "Cloud", preview: "#f1f5f9" },
];

interface SttModelInfo {
	engine: string;
	modelId: string;
	modelName: string;
	language: string;
	sizeMb: number;
	wer: string;
	downloadUrl: string;
	description: string;
	downloaded: boolean;
	ready: boolean;
}

/**
 * Sanitize USB/audio device label strings.
 * USB device names stored in EUC-KR (common for Korean audio hardware) are misread as UTF-8
 * by Linux/PipeWire, producing mojibake:
 *   - Some byte pairs form valid 2-byte UTF-8 → Latin-1 Supplement chars (ï, ë, é, ñ…)
 *   - Invalid byte pairs → U+FFFD replacement chars (■ boxes)
 * Fix: strip U+007F–U+00FF (Latin-1 Supplement) and U+FFFD entirely, then remove
 * short leftover tokens (≤2 non-CJK chars) that are stray ASCII bytes from Korean sequences.
 * The ASCII prefix ("USB Audio", "Realtek HD"…) survives intact.
 */
function sanitizeDeviceLabel(label: string): string {
	// 1. Strip C0/C1 controls, Latin-1 Supplement (0x7F–0xFF), U+FFFD
	const stripped = [...label]
		.filter((c) => {
			const cp = c.codePointAt(0) ?? 0;
			return !(cp <= 0x1f || (cp >= 0x7f && cp <= 0x00ff) || cp === 0xfffd);
		})
		.join("")
		// 2. Punctuation isolated by stripping → collapse to space
		.replace(/[,.\-_·•]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	// 3. Remove short tokens (≤2 chars) that aren't Korean/CJK — EUC-KR byte remnants
	const result = stripped
		.split(" ")
		.filter(
			(tok) =>
				tok.length >= 3 ||
				/[\uAC00-\uD7A3\u4E00-\u9FFF\uFF00-\uFFEF]/.test(tok),
		)
		.join(" ")
		.trim();
	return result || label.trim();
}

/** Custom dropdown for audio device selection.
 * Replaces native <select> to avoid WebKitGTK native popup ignoring CSS font-family (Korean garbling). */
function DeviceSelect({
	value,
	options,
	onChange,
	placeholder = "기본 장치",
}: {
	value: string;
	options: { value: string; label: string }[];
	onChange: (value: string) => void;
	placeholder?: string;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (!ref.current?.contains(e.target as Node)) setOpen(false);
		};
		window.addEventListener("mousedown", handler);
		return () => window.removeEventListener("mousedown", handler);
	}, [open]);

	const selected = options.find((o) => o.value === value);
	const label = selected?.label ?? placeholder;

	return (
		<div ref={ref} className="device-select">
			<div className="device-select-trigger" onClick={() => setOpen((v) => !v)}>
				<span>{label}</span>
				<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
					<path fill="currentColor" d="M2 4l4 4 4-4" />
				</svg>
			</div>
			{open && (
				<div className="device-select-dropdown">
					<div
						className={`device-select-option${!value ? " selected" : ""}`}
						onClick={() => {
							onChange("");
							setOpen(false);
						}}
					>
						{placeholder}
					</div>
					{options.map((o) => (
						<div
							key={o.value}
							className={`device-select-option${o.value === value ? " selected" : ""}`}
							onClick={() => {
								onChange(o.value);
								setOpen(false);
							}}
						>
							{o.label}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export function SettingsTab() {
	const [activeSettingsTab, setActiveSettingsTab] = useState<
		| "profile"
		| "brain"
		| "voice"
		| "avatar"
		| "persona"
		| "memory"
		| "knowledge"
		| "skills"
		| "general"
	>("profile");
	// 통합 "AI 모델" 탭의 backend 축(main/small/embedding 공통): naia 계정 / 외부 API / 로컬(embedding=임베드).
	// 기존 provider·memoryLlm·memoryEmbedding state 에서 파생 표시 + 변경 시 해당 state 갱신(재사용, 중복 state 없음).
	const [agentHealthStatus, setAgentHealthStatus] = useState<
		"idle" | "checking" | "healthy" | "unhealthy"
	>("idle");
	const [agentHealthCheckedAt, setAgentHealthCheckedAt] = useState<Date | null>(
		null,
	);
	const existing = loadConfig();
	const setAvatarModelPath = useAvatarStore((s) => s.setModelPath);
	const setAvatarBackgroundImage = useAvatarStore((s) => s.setBackgroundImage);
	const setBackgroundVideoUrl = useAvatarStore((s) => s.setBackgroundVideoUrl);
	const setBackgroundMediaType = useAvatarStore(
		(s) => s.setBackgroundMediaType,
	);
	const pushModal = useAppStore((s) => s.pushModal);
	const popModal = useAppStore((s) => s.popModal);
	// 설정 패널이 실제로 열렸는지 — 오디오 장치 enumerate(navigator.mediaDevices)를 *기동 시*(SettingsTab 은
	// keepAlive 로 항상 마운트)가 아니라 사용자가 설정을 열 때만 실행하기 위함. getUserMedia/enumerateDevices 는
	// WebKitGTK + 일부 오디오 장치(USB Audio IEC958)에서 GstIntRange 버그로 web process 를 ~90초 동기 stall
	// 시켜 *전체 기동을 90초 막는다*(2026-06-13 실측·격리 확정). 설정 미개방 시 미디어 미접촉 = 기동 즉시.
	const isSettingsActive = useAppStore((s) => s.activeApp === "settings");
	const storeTtsEnabled = useAppStore((s) => s.ttsEnabled);
	const setStoreTtsEnabled = useAppStore((s) => s.setTtsEnabled);
	const [savedVrmModel, setSavedVrmModel] = useState(
		normalizeLocalPath(existing?.vrmModel ?? DEFAULT_AVATAR_MODEL),
	);
	const [provider, setProvider] = useState<ProviderId>(
		existing?.provider ?? "gemini",
	);
	const initProvider = existing?.provider ?? "gemini";
	const savedModel = existing?.model;
	const modelValid =
		savedModel &&
		(getLlmProvider(initProvider)?.models.some((m) => m.id === savedModel) ??
			false);
	const [model, setModel] = useState(
		modelValid ? savedModel : getDefaultLlmModel(initProvider),
	);
	const [apiKey, setApiKey] = useState(existing?.apiKey ?? "");
	// config.json 은 비밀을 strip(키는 키체인/credentials 매니페스트)하므로 existing.apiKey 는 항상 "".
	// provider 에 저장된 키가 있으면 입력란을 `*****`(저장됨)로 마스킹 표기(값은 안 읽음 — agentKeyExists 는
	// credentials 매니페스트의 존재여부만). 빈 입력으로 저장 시 기존 키 보존(아래 resolvedApiKey 로직).
	const [hasStoredApiKey, setHasStoredApiKey] = useState(false);
	const [locale, setLocaleState] = useState<Locale>(
		existing?.locale ?? getLocale(),
	);
	const [theme, setTheme] = useState<ThemeId>(existing?.theme ?? "midnight");
	const [vrmModel, setVrmModel] = useState(savedVrmModel);
	const [naiaVrms, setNaiaVrms] = useState<string[]>([]);
	const [naiaBgs, setNaiaBgs] = useState<string[]>([]);
	const [naiaNvas, setNaiaNvas] = useState<string[]>([]);
	const [avatarProvider, setAvatarProvider] = useState<
		"vrm" | "naia-video-avatar"
	>(existing?.avatarProvider ?? "vrm");
	const [nvaModel, setNvaModel] = useState(existing?.nvaModel ?? "");
	const [cascadeRuntimeUrl, setCascadeRuntimeUrl] = useState(
		existing?.cascadeRuntimeUrl ?? "",
	);
	const [activeBgPath, setActiveBgPath] = useState<string>("");
	const [backgroundVideoFilename, setBackgroundVideoFilename] = useState<
		string | undefined
	>(existing?.backgroundVideo);
	const [customVrms] = useState<string[]>(
		(existing?.customVrms ?? []).map(normalizeLocalPath),
	);
	const [customBgs] = useState<string[]>(
		(existing?.customBgs ?? []).map(normalizeLocalPath),
	);
	const [backgroundImage] = useState(
		normalizeLocalPath(existing?.backgroundImage ?? ""),
	);
	const defaultVoiceForProvider = getDefaultTtsVoiceForAvatar(
		existing?.ttsProvider ?? "edge",
		existing?.vrmModel,
	);
	const [ttsVoice, setTtsVoice] = useState(
		existing?.ttsVoice ?? defaultVoiceForProvider,
	);
	const [googleApiKey, setGoogleApiKey] = useState(
		existing?.googleApiKey ?? "",
	);
	const [ttsProvider, setTtsProvider] = useState<TtsProviderId>(
		existing?.ttsProvider ??
			(existing?.ttsEngine === "gateway"
				? "edge"
				: existing?.ttsEngine === "google"
					? "google"
					: "edge"),
	);
	const [sttProvider, setSttProvider] = useState<SttProviderId>(
		existing?.sttProvider ?? "",
	);
	const [sttModel, setSttModel] = useState(existing?.sttModel ?? "");
	const [sttModels, setSttModels] = useState<SttModelInfo[]>([]);
	const [sttDownloading, setSttDownloading] = useState<string | null>(null);
	// #2 / FR-VRAM: local GPU profile. "off" default = no slot change (safe).
	const [localGpuTier, setLocalGpuTier] = useState<VramTierId | "auto" | "off">(
		existing?.localGpuTier ?? "off",
	);
	// 배타 티어(8G: 아바타 XOR 음성)에서 로컬 집중 선택. 기본 "voice"(wm 8g 기본과 동형).
	const [localAvatarVoiceFocus, setLocalAvatarVoiceFocus] =
		useState<AvatarVoiceFocus>(existing?.localAvatarVoiceFocus ?? "voice");
	const [detectedVramGb, setDetectedVramGb] = useState<number | null>(null);
	// Detect GPU VRAM once on mount (#2 / FR-VRAM.1); null when unavailable.
	useEffect(() => {
		detectGpuVramGb().then(setDetectedVramGb);
	}, []);
	const [sttDownloadProgress, setSttDownloadProgress] = useState(0);

	const [ttsEnabled, setTtsEnabled] = useState(existing?.ttsEnabled ?? false);
	// Keep panel store in sync so QuickToggles button reflects settings changes
	useEffect(() => {
		setStoreTtsEnabled(ttsEnabled);
	}, [ttsEnabled, setStoreTtsEnabled]);
	// Sync back from store so QuickToggles TTS button changes are reflected here
	useEffect(() => {
		setTtsEnabled(storeTtsEnabled);
	}, [storeTtsEnabled]);
	// provider 별 저장된 apiKey 존재여부 조회 → 입력란 마스킹(루크 #3: 키가 연결돼 있으면 ***** 표기).
	useEffect(() => {
		let cancelled = false;
		agentKeyExists(provider, "apiKey").then((exists) => {
			if (!cancelled) setHasStoredApiKey(exists);
		});
		return () => {
			cancelled = true;
		};
	}, [provider]);
	const [persona, setPersona] = useState(existing?.persona ?? DEFAULT_PERSONA);
	const [userName, setUserName] = useState(existing?.userName ?? "");
	const [agentName, setAgentName] = useState(existing?.agentName ?? "");
	const [honorific, setHonorific] = useState(existing?.honorific ?? "");
	const [speechStyle, setSpeechStyle] = useState(
		existing?.speechStyle ?? "casual",
	);
	const [enableTools, setEnableTools] = useState(existing?.enableTools ?? true);
	const [enableThinking, setEnableThinking] = useState(
		existing?.enableThinking ?? false,
	);
	const [workspaceRoot, setWorkspaceRoot] = useState(() => {
		return existing?.workspaceRoot || getAdkPath() || "";
	});
	const [voice, setVoice] = useState(
		existing?.voice ?? getDefaultVoiceForAvatar(existing?.vrmModel),
	);
	const [openaiRealtimeApiKey, setOpenaiRealtimeApiKey] = useState(
		existing?.openaiRealtimeApiKey ?? "",
	);
	const [dynamicModels, setDynamicModels] = useState<
		Record<string, LlmModelMeta[]>
	>(getStaticModelsRecord);
	const [ollamaHost, setOllamaHost] = useState(
		existing?.ollamaHost ?? DEFAULT_OLLAMA_HOST,
	);
	const [ollamaConnected, setOllamaConnected] = useState(false);
	const [vllmHost, setVllmHost] = useState(
		existing?.vllmHost ?? DEFAULT_VLLM_HOST,
	);
	// Naia Local: ws:// address of the user's own omni-24g container (shown when
	// the `naia-local` model is selected). Reuses the logged-in key — no key input.
	const [naiaLocalUrl, setNaiaLocalUrl] = useState(
		existing?.naiaLocalUrl ?? DEFAULT_NAIA_LOCAL_URL,
	);
	const [vllmConnected, setVllmConnected] = useState(false);
	const [vllmSttHost, setVllmSttHost] = useState(existing?.vllmSttHost ?? "");
	const [vllmTtsHost, setVllmTtsHost] = useState(existing?.vllmTtsHost ?? "");
	// R2.2b: 로컬 cascade(naia-local-voice) lifecycle 토글 상태.
	const [cascadeRunning, setCascadeRunning] = useState(false);
	const [cascadeBusy, setCascadeBusy] = useState(false);
	const [cascadeMsg, setCascadeMsg] = useState("");
	useEffect(() => {
		invoke<boolean>("cascade_status")
			.then(setCascadeRunning)
			.catch(() => {});
	}, []);
	// naia-local-voice 선택 상태에서 Local Voice Host 가 비어있으면 기본값(localhost:22600)
	// 으로 채운다 — 임베딩 cascade(VoxCPM2)가 그 포트에 뜨므로 합성이 자동으로 로컬을 가리킴.
	// biome-ignore lint/correctness/useExhaustiveDependencies: ttsProvider 전환 시에만 보정
	useEffect(() => {
		if (ttsProvider === "naia-local-voice" && !vllmTtsHost) {
			setVllmTtsHost(DEFAULT_LOCAL_VOICE_HOST);
			persistConfig({ vllmTtsHost: DEFAULT_LOCAL_VOICE_HOST });
		}
	}, [ttsProvider]);
	const handleToggleCascade = async () => {
		setCascadeBusy(true);
		setCascadeMsg("");
		try {
			if (cascadeRunning) {
				await invoke("stop_cascade");
				setCascadeRunning(false);
				// 로컬 facade URL 해제 → VideoAvatarCanvas 가 원격/폴백으로 되돌아감.
				useCascadeAvatarStore.getState().setLocalFacadeUrl(null);
				setCascadeMsg(t("settings.cascadeStopped"));
			} else {
				// 기동 직전 manifest 동기화(설정 변경이 반영된 최신 상태로 launch).
				const cfg = loadConfig();
				if (cfg) await writeSlotsManifest(cfg);
				// start_cascade 는 CASCADE_READY 페이로드({facade_port,services}) 를 반환 —
				// facade_port 로 로컬 cascade URL 을 유도해 VideoAvatarCanvas(아바타 립싱크)가
				// 로컬 facade 에 붙게 한다(focus=avatar 로 avatar 서비스가 떴을 때 입 움직임).
				const ready = await invoke<string>("start_cascade");
				const localUrl = localFacadeUrlFromReady(ready);
				useCascadeAvatarStore.getState().setLocalFacadeUrl(localUrl);
				setCascadeRunning(true);
				setCascadeMsg(t("settings.cascadeStarted"));
			}
		} catch (e) {
			setCascadeMsg(`${t("settings.cascadeError")}: ${String(e)}`);
		} finally {
			setCascadeBusy(false);
		}
	};

	// R4/R5: 로컬 프로파일(GPU 티어/포커스) 선택 → 관련 슬롯을 로컬로 스테이징 + 백엔드 warm(대기).
	// 스테이징이라 config 는 "적용"(handleSave) 전까지 안 바뀐다(앱 그대로). warm 은 스테이징
	// config 로 slots-manifest 를 써서 백엔드를 미리 띄운다 → 적용 시 즉시 아바타 연결.
	const warmedProfileRef = useRef<string>("");

	// R5: 티어 capability 로 로컬 슬롯을 스테이징(setState). 반환 = warm manifest 에 쓸 값.
	const stageLocalSlots = (
		tier: typeof localGpuTier,
		focus: AvatarVoiceFocus,
	): {
		avatar: "vrm" | "naia-video-avatar";
		nva: string;
		tts: TtsProviderId;
	} => {
		const caps = resolveLocalCapabilities(
			resolveActiveTier(tier, detectedVramGb),
			focus,
		);
		let nextAvatar = avatarProvider;
		let nextNva = nvaModel;
		let nextTts = ttsProvider;
		if (caps.includes("avatar")) {
			nextAvatar = "naia-video-avatar";
			setAvatarProvider("naia-video-avatar");
			if (!nvaModel) {
				nextNva = DEFAULT_NVA_MODEL;
				setNvaModel(DEFAULT_NVA_MODEL);
			}
		}
		if (caps.includes("tts")) {
			nextTts = "naia-local-voice";
			setTtsProvider("naia-local-voice");
			if (!vllmTtsHost) setVllmTtsHost(DEFAULT_LOCAL_VOICE_HOST);
		}
		return { avatar: nextAvatar, nva: nextNva, tts: nextTts };
	};

	// R4: 스테이징 config 로 백엔드 warm(기동·대기). 티어/포커스 변경 시 재기동(manifest 반영).
	const warmLocalProfile = async (
		tier: typeof localGpuTier,
		focus: AvatarVoiceFocus,
		staged: {
			avatar: "vrm" | "naia-video-avatar";
			nva: string;
			tts: TtsProviderId;
		},
	) => {
		if (!naiaKey || tier === "off") {
			// 로컬 해제 → 백엔드 정지
			if (cascadeRunning) {
				try {
					await invoke("stop_cascade");
				} catch {
					/* 정지 실패 비치명 */
				}
				setCascadeRunning(false);
				useCascadeAvatarStore.getState().setLocalFacadeUrl(null);
			}
			warmedProfileRef.current = "";
			setCascadeMsg("");
			return;
		}
		const key = `${tier}|${focus}`;
		if (warmedProfileRef.current === key && cascadeRunning) return; // 이미 이 프로파일로 warm됨
		setCascadeBusy(true);
		setCascadeMsg(t("settings.cascadeBusy"));
		try {
			if (cascadeRunning) {
				// 프로파일 바뀜 → manifest 반영 위해 재기동
				try {
					await invoke("stop_cascade");
				} catch {
					/* 무시 */
				}
			}
			const cfg = {
				...(loadConfig() ?? {}),
				localGpuTier: tier,
				localAvatarVoiceFocus: focus,
				avatarProvider: staged.avatar,
				nvaModel: staged.nva || undefined,
				ttsProvider: staged.tts,
			} as AppConfig;
			await writeSlotsManifest(cfg);
			const ready = await invoke<string>("start_cascade");
			useCascadeAvatarStore
				.getState()
				.setLocalFacadeUrl(localFacadeUrlFromReady(ready));
			setCascadeRunning(true);
			warmedProfileRef.current = key;
			setCascadeMsg(t("settings.cascadeStarted"));
		} catch (e) {
			setCascadeMsg(`${t("settings.cascadeError")}: ${String(e)}`);
		} finally {
			setCascadeBusy(false);
		}
	};

	const handleSelectLocalTier = (tier: typeof localGpuTier) => {
		setLocalGpuTier(tier); // 스테이징(persist 안 함 — 적용에서 커밋)
		const staged =
			tier === "off"
				? { avatar: avatarProvider, nva: nvaModel, tts: ttsProvider }
				: stageLocalSlots(tier, localAvatarVoiceFocus);
		void warmLocalProfile(tier, localAvatarVoiceFocus, staged);
	};

	const handleSelectFocus = (focus: AvatarVoiceFocus) => {
		setLocalAvatarVoiceFocus(focus); // 스테이징
		const staged = stageLocalSlots(localGpuTier, focus);
		void warmLocalProfile(localGpuTier, focus, staged);
	};

	const [vllmSttModels, setVllmSttModels] = useState<
		import("../lib/llm/types").LlmModelMeta[]
	>([]);
	const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>(
		[],
	);
	const [audioOutputDevices, setAudioOutputDevices] = useState<
		MediaDeviceInfo[]
	>([]);
	const [sttInputDeviceId, setSttInputDeviceId] = useState(
		existing?.sttInputDeviceId ?? "",
	);
	const [ttsOutputDeviceId, setTtsOutputDeviceId] = useState(
		existing?.ttsOutputDeviceId ?? "",
	);
	const [micTestActive, setMicTestActive] = useState(false);
	const [micTestLevel, setMicTestLevel] = useState(0);
	const micTestCleanupRef = useRef<(() => void) | null>(null);
	const [gatewayUrl] = useState(existing?.gatewayUrl ?? "");
	const [gatewayToken] = useState(existing?.gatewayToken ?? "");
	const [discordDefaultUserId, setDiscordDefaultUserId] = useState(
		existing?.discordDefaultUserId ?? "",
	);
	const [discordDefaultTarget, setDiscordDefaultTarget] = useState(
		existing?.discordDefaultTarget ?? "",
	);
	const [discordDmChannelId, setDiscordDmChannelId] = useState(
		existing?.discordDmChannelId ?? "",
	);
	const [error, setError] = useState("");
	const [saved, setSaved] = useState(false);
	const [isPreviewing, setIsPreviewing] = useState(false);
	const [dynamicTtsVoices, setDynamicTtsVoices] = useState<
		{ id: string; label: string; gender?: string }[]
	>([]);
	const [facts, setFacts] = useState<AgentFact[]>([]);

	// Memory adapter settings
	const [memoryAdapter, setMemoryAdapter] = useState<"local" | "qdrant">(
		existing?.memoryAdapter ?? "local",
	);
	const [qdrantUrl, setQdrantUrl] = useState(existing?.qdrantUrl ?? "");
	const [qdrantApiKey, setQdrantApiKey] = useState(
		existing?.qdrantApiKey ?? "",
	);
	const [memoryEmbeddingProvider, setMemoryEmbeddingProvider] = useState<
		"none" | "offline" | "vllm" | "ollama" | "naia"
	>(existing?.memoryEmbeddingProvider ?? "none");
	const [memoryOfflineModel, setMemoryOfflineModel] = useState<
		"all-MiniLM-L6-v2" | "all-mpnet-base-v2"
	>(existing?.memoryOfflineModel ?? "all-MiniLM-L6-v2");
	const [memoryEmbeddingDevice, setMemoryEmbeddingDevice] = useState<
		"cpu" | "gpu" | "auto"
	>(existing?.memoryEmbeddingDevice ?? "cpu");
	const [memoryEmbeddingBaseUrl, setMemoryEmbeddingBaseUrl] = useState(
		existing?.memoryEmbeddingBaseUrl ?? "",
	);
	const [memoryEmbeddingApiKey, setMemoryEmbeddingApiKey] = useState(
		existing?.memoryEmbeddingApiKey ?? "",
	);
	const [memoryEmbeddingModel, setMemoryEmbeddingModel] = useState(
		existing?.memoryEmbeddingModel ?? "",
	);
	const [memoryLlmProvider, setMemoryLlmProvider] = useState<
		"none" | "naia" | "vllm" | "ollama"
	>(existing?.memoryLlmProvider ?? "none");
	const [memoryLlmBaseUrl, setMemoryLlmBaseUrl] = useState(
		existing?.memoryLlmBaseUrl ?? "",
	);
	const [memoryLlmApiKey, setMemoryLlmApiKey] = useState(
		existing?.memoryLlmApiKey ?? "",
	);
	const [memoryLlmModel, setMemoryLlmModel] = useState(
		existing?.memoryLlmModel ?? "",
	);
	const [backupPassword, setBackupPassword] = useState("");
	const [backupStatus, setBackupStatus] = useState<
		"idle" | "exporting" | "importing" | "done" | "error"
	>("idle");
	const [backupError, setBackupError] = useState("");

	const [allowedToolsCount, setAllowedToolsCount] = useState(
		existing?.allowedTools?.length ?? 0,
	);
	const [naiaKey, setNaiaKeyState] = useState(existing?.naiaKey ?? "");
	const [naiaUserId, setNaiaUserIdState] = useState(existing?.naiaUserId ?? "");
	const [sttModelModalOpen, setSttModelModalOpen] = useState(false);
	const [syncDialogOpen, setSyncDialogOpen] = useState(false);
	const [syncDialogOnlineConfig, setSyncDialogOnlineConfig] = useState<Record<
		string,
		unknown
	> | null>(null);
	const labSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const labBrowserVisibleRef = useRef(false);

	// Hide Chrome X11 embed while STT model modal is open
	useEffect(() => {
		if (sttModelModalOpen) {
			pushModal();
			return () => popModal();
		}
	}, [sttModelModalOpen, pushModal, popModal]);

	// Hide Chrome X11 embed while sync dialog is open
	useEffect(() => {
		if (syncDialogOpen) {
			pushModal();
			return () => popModal();
		}
	}, [syncDialogOpen, pushModal, popModal]);

	// Load STT model catalog on mount
	useEffect(() => {
		invoke<SttModelInfo[]>("list_stt_models")
			.then(setSttModels)
			.catch((e) =>
				Logger.warn("Settings", "Failed to load STT models", {
					error: String(e),
				}),
			);
	}, []);

	// Listen for download progress events
	useEffect(() => {
		let unlisten: (() => void) | null = null;
		listen<{ status: string; model: string; progress: number }>(
			"stt://download-progress",
			(event) => {
				const { status, progress } = event.payload;
				setSttDownloadProgress(Math.min(progress, 100));
				if (status === "complete") {
					setSttDownloading(null);
					setSttDownloadProgress(0);
					// Refresh catalog
					invoke<SttModelInfo[]>("list_stt_models")
						.then(setSttModels)
						.catch(() => {});
				}
			},
		).then((fn) => {
			unlisten = fn;
		});
		return () => {
			unlisten?.();
		};
	}, []);

	useEffect(() => {
		const modelPrefixPattern =
			/^(nextain|claude-code-cli|claude-code|gemini|google|openai|anthropic|claude|xai|grok|zai|glm|ollama)[:/](.+)$/i;
		const providerAlias: Record<string, ProviderId> = {
			nextain: "nextain",
			"claude-code-cli": "claude-code-cli",
			"claude-code": "claude-code-cli",
			gemini: "gemini",
			google: "gemini",
			openai: "openai",
			anthropic: "anthropic",
			claude: "anthropic",
			xai: "xai",
			grok: "xai",
			zai: "zai",
			glm: "zai",
			ollama: "ollama",
		};

		const normalizeModelId = (raw: string): string => {
			const matched = modelPrefixPattern.exec(raw);
			if (matched?.[2]) return matched[2];
			return raw;
		};

		const resolveProvider = (raw: unknown): ProviderId | null => {
			if (typeof raw !== "string") return null;
			return providerAlias[raw.toLowerCase()] ?? null;
		};

		const resolveProviderFromId = (id: string): ProviderId | null => {
			const matched = modelPrefixPattern.exec(id);
			if (!matched?.[1]) return null;
			return resolveProvider(matched[1]);
		};

		async function fetchModels() {
			try {
				// E1 셸-직결: 게이트웨이 `/v1/pricing` 전체 카탈로그(구 skill_config directToolCall 대체 — 신코어
				// tool_request 미지원. nextain(vertexai) 가격은 별도 fetchNaiaPricing 가 다룸 → 아래 dedup 로 중복 회피).
				const models = await fetchGatewayModelCatalog(LAB_GATEWAY_URL);
				if (models && models.length > 0) {
					const grouped = Object.fromEntries(
						Object.entries(getStaticModelsRecord()).map(([k, v]) => [
							k,
							[...v],
						]),
					) as Record<string, LlmModelMeta[]>;

					for (const m of models) {
						if (!m || typeof m.id !== "string") continue;
						const modelId = normalizeModelId(m.id);
						const priceStr = m.price
							? ` ($${m.price.input ?? "?"} / $${m.price.output ?? "?"})`
							: "";
						const label = `${m.name || modelId}${priceStr}`;

						const pushModel = (key: string) => {
							if (!grouped[key]?.some((x) => x.id === modelId)) {
								grouped[key].push({
									id: modelId,
									label,
									capabilities: ["llm"] as const,
								});
							}
						};

						const mappedProvider =
							resolveProvider(m.provider) || resolveProviderFromId(m.id);
						if (mappedProvider) pushModel(mappedProvider);
						// Claude Code CLI uses subscription — add models without pricing
						if (mappedProvider === "anthropic") {
							const nameOnly = m.name || modelId;
							if (!grouped["claude-code-cli"]?.some((x) => x.id === modelId)) {
								grouped["claude-code-cli"].push({
									id: modelId,
									label: nameOnly,
									capabilities: ["llm"] as const,
								});
							}
						}
						// Naia only supports curated Gemini models (from registry)
						if (mappedProvider === "gemini") {
							const nextainModelIds =
								getLlmProvider("nextain")
									?.models.filter((nm) => !nm.capabilities.includes("omni"))
									.map((nm) => nm.id) ?? [];
							if (nextainModelIds.includes(modelId)) {
								pushModel("nextain");
							}
						}
					}

					setDynamicModels(grouped);
				}
			} catch {
				// Fallback to static registry models
			}
		}
		fetchModels();
	}, []);

	useEffect(() => {
		if (provider !== "ollama") return;
		fetchOllamaModels(ollamaHost).then(({ models, connected }) => {
			setOllamaConnected(connected);
			if (models.length > 0) {
				setDynamicModels((prev) => ({ ...prev, ollama: models }));
				if (!model || !models.some((m) => m.id === model)) {
					setModel(models[0].id);
				}
			}
		});
	}, [provider, ollamaHost]);

	useEffect(() => {
		if (provider !== "vllm") return;
		fetchVllmModels(vllmHost).then(({ models, connected }) => {
			setVllmConnected(connected);
			if (models.length > 0) {
				setDynamicModels((prev) => ({ ...prev, vllm: models }));
				// Auto-select: skip ASR-only models (they belong in STT, not LLM)
				const nonAsrModels = models.filter(
					(m) => !m.capabilities.includes("asr"),
				);
				const currentValid = nonAsrModels.some((m) => m.id === model);
				if (!currentValid) {
					setModel(nonAsrModels[0]?.id ?? "");
				}
			}
		});
	}, [provider, vllmHost]);

	// Fetch live Naia pricing from gateway (DB = SoT).
	// Runs when provider switches to "nextain" so the displayed price always
	// matches what the gateway actually charges.
	useEffect(() => {
		if (provider !== "nextain") return;
		// Pricing (DB SoT) + capability catalog (#365: gateway SoT for caps).
		// If the catalog fetch fails, models keep their static capabilities.
		Promise.all([
			fetchNaiaPricing(LAB_GATEWAY_URL),
			fetchNaiaModelCapabilities(LAB_GATEWAY_URL),
		]).then(([liveModels, capMap]) => {
			// Apply gateway capabilities even if pricing failed (the two are
			// independent): override the priced live models, or fall back to the
			// existing static nextain models when pricing is unavailable.
			if (!liveModels && !capMap) return;
			setDynamicModels((prev) => ({
				...prev,
				nextain: applyCapabilityOverrides(
					liveModels ?? prev.nextain ?? [],
					capMap,
				),
			}));
		});
	}, [provider]);

	// Fetch ASR models from vLLM STT host (separate from LLM vllmHost)
	useEffect(() => {
		if (sttProvider !== "vllm") return;
		const host = vllmSttHost || DEFAULT_VLLM_HOST;
		fetchVllmModels(host).then(({ models }) => {
			const asrModels = models.filter((m) => m.capabilities.includes("asr"));
			setVllmSttModels(asrModels);
		});
	}, [sttProvider, vllmSttHost]);

	// Enumerate audio input/output devices — ⚠️ 설정 패널이 열렸을 때만(기동 90초 stall 회피, 위 isSettingsActive 주석).
	useEffect(() => {
		if (!isSettingsActive) return;
		if (!navigator.mediaDevices?.enumerateDevices) return;

		// Output devices: WebKitGTK does not expose audiooutput via enumerateDevices().
		// Use pw-dump (Tauri) to list PipeWire sinks directly.
		const refreshOutputDevices = () => {
			invoke<{ id: string; label: string }[]>("list_audio_output_devices")
				.then((sinks) => {
					Logger.debug("SettingsTab", "pw-dump sinks", { count: sinks.length });
					setAudioOutputDevices(
						sinks.map(
							(s) =>
								({
									deviceId: s.id,
									label: s.label,
									kind: "audiooutput",
									groupId: "",
								}) as MediaDeviceInfo,
						),
					);
				})
				.catch((e) =>
					Logger.warn("SettingsTab", "list_audio_output_devices failed", { e }),
				);
		};
		refreshOutputDevices();

		const enumerate = () => {
			refreshOutputDevices();
			navigator.mediaDevices
				.enumerateDevices()
				.then((devices) => {
					const inputs = devices.filter((d) => d.kind === "audioinput");
					// Debug: check raw label encoding — if Korean appears garbled, chars will show wrong codepoints
					Logger.debug("SettingsTab", "Audio input devices enumerated", {
						inputs: inputs.map((d) => ({
							label: d.label,
							codes: [...d.label].map((c) => c.codePointAt(0)),
						})),
					});
					setAudioInputDevices(inputs);
				})
				.catch(() => {});
		};
		// Request mic permission briefly — WebKitGTK requires this before enumerating input labels.
		navigator.mediaDevices
			.getUserMedia({ audio: true })
			.then((stream) => {
				stream.getTracks().forEach((t) => t.stop());
				enumerate();
			})
			.catch(() => enumerate());

		navigator.mediaDevices.addEventListener("devicechange", enumerate);
		return () =>
			navigator.mediaDevices.removeEventListener("devicechange", enumerate);
	}, [isSettingsActive]);

	async function startMicTest() {
		if (micTestActive) return;
		setMicTestActive(true);
		setMicTestLevel(0);
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: false,
					noiseSuppression: false,
					autoGainControl: false,
					...(sttInputDeviceId
						? { deviceId: { exact: sttInputDeviceId } }
						: {}),
				},
			});
			const ctx = new AudioContext();
			const source = ctx.createMediaStreamSource(stream);
			const processor = ctx.createScriptProcessor(4096, 1, 1);
			processor.onaudioprocess = (e) => {
				const raw = e.inputBuffer.getChannelData(0);
				let sumSq = 0;
				for (let i = 0; i < raw.length; i++) sumSq += raw[i] * raw[i];
				const rms = Math.sqrt(sumSq / raw.length);
				setMicTestLevel(Math.min(100, rms * 1000));
			};
			source.connect(processor);
			processor.connect(ctx.destination);
			const stopTimeout = setTimeout(() => stopMicTest(), 8000);
			micTestCleanupRef.current = () => {
				clearTimeout(stopTimeout);
				processor.disconnect();
				source.disconnect();
				ctx.close().catch(() => {});
				for (const track of stream.getTracks()) track.stop();
				setMicTestActive(false);
				setMicTestLevel(0);
			};
		} catch {
			setMicTestActive(false);
		}
	}

	function stopMicTest() {
		micTestCleanupRef.current?.();
		micTestCleanupRef.current = null;
	}

	function playTestBeep() {
		const sampleRate = 44100;
		// C major arpeggio: C4 → E4 → G4 → C5
		const notes = [
			{ freq: 261.63, dur: 0.15 },
			{ freq: 329.63, dur: 0.15 },
			{ freq: 392.0, dur: 0.15 },
			{ freq: 523.25, dur: 0.3 },
		];
		const allSamples: number[] = [];
		for (const { freq, dur } of notes) {
			const n = Math.floor(sampleRate * dur);
			for (let i = 0; i < n; i++) {
				const t = i / sampleRate;
				const attack = Math.min(1, t / 0.01);
				const release = Math.min(1, (dur - t) / 0.04);
				allSamples.push(
					Math.round(
						0.35 * 32767 * attack * release * Math.sin(2 * Math.PI * freq * t),
					),
				);
			}
		}
		const pcm = new Int16Array(allSamples);
		const wavBuffer = new ArrayBuffer(44 + pcm.byteLength);
		const view = new DataView(wavBuffer);
		const ws = (o: number, s: string) => {
			for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
		};
		ws(0, "RIFF");
		view.setUint32(4, 36 + pcm.byteLength, true);
		ws(8, "WAVE");
		ws(12, "fmt ");
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, 1, true);
		view.setUint32(24, sampleRate, true);
		view.setUint32(28, sampleRate * 2, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		ws(36, "data");
		view.setUint32(40, pcm.byteLength, true);
		new Uint8Array(wavBuffer, 44).set(new Uint8Array(pcm.buffer));
		const url = URL.createObjectURL(
			new Blob([wavBuffer], { type: "audio/wav" }),
		);
		const audio = new Audio(url);
		const setSinkId = (
			audio as unknown as { setSinkId?: (id: string) => Promise<void> }
		).setSinkId;
		if (ttsOutputDeviceId && setSinkId) {
			setSinkId.call(audio, ttsOutputDeviceId).catch(() => {});
		}
		audio.play().catch(() => {});
		audio.onended = () => URL.revokeObjectURL(url);
	}

	useEffect(() => {
		let cancelled = false;
		loadConfigWithSecrets()
			.then((cfg) => {
				if (cancelled || !cfg?.naiaKey) return;
				setNaiaKeyState(cfg.naiaKey);
				setNaiaUserIdState(cfg.naiaUserId ?? "");
				if (cfg.provider === "nextain") {
					setProvider("nextain");
					setModel(cfg.model || getDefaultLlmModel("nextain"));
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);
	const [, setLabWaiting] = useState(false);
	const [labBalance, setLabBalance] = useState<number | null>(null);
	const [labBalanceLoading, setLabBalanceLoading] = useState(false);
	const [labBalanceError, setLabBalanceError] = useState(false);

	const startLabLogin = async () => {
		setLabWaiting(true);
		const timeout = window.setTimeout(() => setLabWaiting(false), 180_000);
		try {
			const state = await invoke<string>("generate_oauth_state").catch(
				() => "",
			);
			const params = new URLSearchParams({
				redirect: "desktop",
				// naia.nextain.io buildLoginRedirect requires BOTH redirect=desktop
				// AND app=naia-os (2026-05-28 security gate) — without `app` it
				// redirects to /dashboard and the desktop callback never fires.
				app: "naia-os",
				source: "desktop",
				// #341 옵션 B — Linux dev:tauri 의 naia:// 미등록 우회.
				// 운영 웹 측이 redirect_uri 받으면 그 URL 로 redirect;
				// 받지 못해도 기존 deep-link path 가 fallback.
				redirect_uri: "http://127.0.0.1:18792/auth/callback",
			});
			if (state) params.set("state", state);
			Logger.info("SettingsTab", "[lab-login] opening system browser");
			await openUrl(
				`${getNaiaWebBaseUrl()}/${locale}/login?${params.toString()}`,
			).catch((e: unknown) => {
				Logger.error("SettingsTab", "[lab-login] openUrl failed", {
					error: String(e),
				});
				window.clearTimeout(timeout);
				setLabWaiting(false);
			});
		} catch (e: unknown) {
			Logger.error("SettingsTab", "[lab-login] unexpected error", {
				error: String(e),
			});
			window.clearTimeout(timeout);
			setLabWaiting(false);
		}
	};

	// Gateway TTS state
	// gatewayTtsApiKey: shared state for TTS API key input (used by multiple providers)
	const [gatewayTtsApiKey, setGatewayTtsApiKey] = useState(() => {
		const p = existing?.ttsProvider ?? "edge";
		if (p === "openai") return existing?.openaiTtsApiKey ?? "";
		if (p === "elevenlabs") return existing?.elevenlabsApiKey ?? "";
		if (p === "google") return existing?.googleApiKey ?? "";
		return "";
	});

	// Voice wake state removed (UI + handlers deleted)
	// Discord integration — unverified, hidden until stabilized
	// const [discordBotConnected, setDiscordBotConnected] = useState(false);
	// const [discordBotLoading, setDiscordBotLoading] = useState(false);

	// In-app confirmation state (replaces window.confirm to avoid WebKitGTK double-dialog)
	const [showResetConfirm, setShowResetConfirm] = useState(false);
	const [resetClearHistory, setResetClearHistory] = useState(false);
	const [showLabDisconnect, setShowLabDisconnect] = useState(false);
	const [_showReOnboarding, _setShowReOnboarding] = useState(false);

	// Discord integration — unverified, hidden until stabilized
	// const fetchDiscordBotStatus = useCallback(async () => { ... }, [gatewayUrl, gatewayToken]);

	useEffect(() => {
		getAllAgentFacts()
			.then((result: AgentFact[]) => setFacts(result ?? []))
			.catch((err: unknown) => {
				Logger.warn("SettingsTab", "Failed to load agent memory facts", {
					error: String(err),
				});
			});
	}, []);

	// Fetch Lab balance for a given key
	function fetchLabBalance(key: string) {
		Logger.debug("SettingsTab", "fetchLabBalance called", {
			keyPrefix: key.slice(0, 8),
			keyLength: key.length,
		});
		setLabBalanceLoading(true);
		setLabBalanceError(false);
		fetch(`${LAB_GATEWAY_URL}/v1/profile/balance`, {
			headers: { "X-AnyLLM-Key": `Bearer ${key}` },
		})
			.then((res) => {
				if (res.status === 401) {
					Logger.warn(
						"SettingsTab",
						"Lab balance unauthorized; preserving Naia login state",
					);
					setLabBalanceError(true);
					throw new Error("BALANCE_UNAUTHORIZED");
				}
				if (!res.ok) {
					return res.text().then((text) => {
						throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
					});
				}
				return res.json();
			})
			.then((data: unknown) => {
				const credits = parseLabCredits(data);
				setLabBalance(credits ?? 0);
				setLabBalanceError(false);
			})
			.catch((err) => {
				if (String(err).includes("BALANCE_UNAUTHORIZED")) return;
				Logger.warn("SettingsTab", "Lab balance fetch failed", {
					error: String(err),
				});
				setLabBalanceError(true);
			})
			.finally(() => setLabBalanceLoading(false));
	}

	// Fetch Lab balance when naiaKey is available
	useEffect(() => {
		if (!naiaKey) return;
		fetchLabBalance(naiaKey);
	}, [naiaKey]);

	// Listen for Lab auth deep-link callback
	useEffect(() => {
		const unlisten = listen<{ naiaKey: string; naiaUserId?: string }>(
			"naia_auth_complete",
			async (event) => {
				const nextNaiaKey = event.payload.naiaKey;
				const nextNaiaUserId = event.payload.naiaUserId ?? "";
				sendAuthUpdate(nextNaiaKey).catch(() => {});

				// Close Chrome and return to default view if we opened it for login
				if (labBrowserVisibleRef.current) {
					labBrowserVisibleRef.current = false;
					useAppStore.getState().setActiveApp(null);
				}

				setNaiaKeyState(nextNaiaKey);
				setNaiaUserIdState(nextNaiaUserId);
				setProvider("nextain");
				setModel((prev) => prev || getDefaultLlmModel("nextain"));
				setError("");
				// In Lab mode, clear direct API key input to avoid confusion.
				setApiKey("");
				setLabWaiting(false);

				// Fetch balance immediately with the new key
				fetchLabBalance(nextNaiaKey);

				// Persist to both secure store and localStorage
				await saveSecretKey("naiaKey", nextNaiaKey);
				const current = loadConfig();
				const nextConfig = buildNaiaLoginConfig(
					current,
					nextNaiaKey,
					nextNaiaUserId,
				);
				const nextModel = nextConfig.model;
				setModel(nextModel);
				saveConfig(nextConfig);
				void writeNaiaConfig(nextConfig as unknown as Record<string, unknown>);

				// (gateway sync 제거됨 2026-06-12 — gateway.json 은 아무도 안 읽는 죽은 경로. config 영속=naia-settings, naiaKey=키체인.)

				// Sync linked channels (e.g. Discord) after login
				// Re-check Discord bot status after sync + gateway restart
				syncLinkedChannels().then(() => {
					// setTimeout(() => fetchDiscordBotStatus(), 3000); // Discord unverified
				});

				// Try Lab pull — show diff dialog if settings differ
				if (nextNaiaUserId) {
					const onlineConfig = await fetchLabConfig(
						nextNaiaKey,
						nextNaiaUserId,
					);
					if (onlineConfig) {
						const diffs = diffConfigs(nextConfig, onlineConfig);
						if (diffs.length > 0) {
							setSyncDialogOnlineConfig(
								onlineConfig as Record<string, unknown>,
							);
							setSyncDialogOpen(true);
						}
					}
				}
			},
		);
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	// Listen for Discord auth deep-link callback — UI state only (App.tsx handles persist)
	useEffect(() => {
		const unlisten = listen<{
			discordUserId?: string | null;
			discordChannelId?: string | null;
			discordTarget?: string | null;
		}>("discord_auth_complete", (event) => {
			const { discordUserId, discordChannelId, discordTarget } = event.payload;
			if (discordUserId) setDiscordDefaultUserId(discordUserId);
			if (discordTarget) setDiscordDefaultTarget(discordTarget);
			else if (discordUserId) setDiscordDefaultTarget(`user:${discordUserId}`);
			if (discordChannelId) setDiscordDmChannelId(discordChannelId);
			// setDiscordBotConnected(true); // Discord unverified
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	// Live-preview: apply VRM instantly on selection
	function handleVrmSelect(path: string) {
		const normalized = normalizeLocalPath(path);
		setVrmModel(normalized);
		setAvatarModelPath(normalized);
		setSavedVrmModel(normalized);
		const cfg = loadConfig();
		if (cfg) saveConfig({ ...cfg, vrmModel: normalized || undefined });
	}

	function handleNaiaBgSelect(path: string) {
		const filename = path.split(/[/\\]/).pop() ?? "";
		setActiveBgPath(path);
		setBackgroundVideoFilename(filename || undefined);
		setBackgroundMediaType(getBackgroundMediaType(path));
		void toLocalBlobUrl(path).then(setBackgroundVideoUrl);
		const cfg = loadConfig();
		if (cfg) saveConfig({ ...cfg, backgroundVideo: filename || undefined });
	}

	function handleClearNaiaBg() {
		setActiveBgPath("");
		setBackgroundVideoFilename(undefined);
		setBackgroundMediaType("");
		setBackgroundVideoUrl("");
		const cfg = loadConfig();
		if (cfg) saveConfig({ ...cfg, backgroundVideo: undefined });
	}

	// #12: Import file (Downloads → naia-settings/{subdir}/)
	async function handleImportAsset(
		subdir: "vrm-files" | "background" | "nva-files",
	) {
		const adkPath = getAdkPath();
		if (!adkPath) return;
		const selected = await open({
			multiple: false,
			filters:
				subdir === "vrm-files"
					? [{ name: "VRM", extensions: ["vrm"] }]
					: subdir === "nva-files"
						? [{ name: "NVA", extensions: ["nva"] }]
						: [
								{
									name: "Image",
									extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
								},
							],
		});
		if (!selected || typeof selected !== "string") return;
		try {
			await invoke("import_naia_asset", {
				adkPath,
				subdir,
				sourcePath: selected,
			});
			const paths = await listNaiaAssets(subdir);
			if (subdir === "vrm-files") {
				setNaiaVrms(paths.filter((p) => p.toLowerCase().endsWith(".vrm")));
			} else if (subdir === "nva-files") {
				setNaiaNvas(paths);
			} else {
				setNaiaBgs(paths);
			}
		} catch (e) {
			Logger.warn("SettingsTab", "[import-asset] failed", {
				error: String(e),
			});
		}
	}

	// #13: Delete file from naia-settings/{subdir}/
	async function handleDeleteAsset(
		subdir: "vrm-files" | "background" | "nva-files",
		filename: string,
	) {
		const adkPath = getAdkPath();
		if (!adkPath) return;
		// 레거시로 nvaModel 등이 절대경로면 delete_naia_asset 이 경로(\\,/) 를 거부해 삭제 실패 →
		// basename 만 취해 견고화. 신규 선택은 bare 이름이라 무영향.
		const bare = filename.split(/[/\\]/).filter(Boolean).pop() ?? filename;
		try {
			await invoke("delete_naia_asset", { adkPath, subdir, filename: bare });
			const paths = await listNaiaAssets(subdir);
			if (subdir === "vrm-files") {
				setNaiaVrms(paths.filter((p) => p.toLowerCase().endsWith(".vrm")));
				if (vrmModel && vrmModel.endsWith(filename)) handleVrmSelect("");
			} else if (subdir === "nva-files") {
				setNaiaNvas(paths);
				if (nvaModel && nvaModel.endsWith(filename)) {
					setNvaModel("");
					persistConfig({ nvaModel: "" });
				}
			} else {
				setNaiaBgs(paths);
				if (activeBgPath && activeBgPath.endsWith(filename))
					handleClearNaiaBg();
			}
		} catch (e) {
			Logger.warn("SettingsTab", "[delete-asset] failed", {
				error: String(e),
			});
		}
	}

	// Revert-on-unmount 제거 (2026-06-29): handleVrmSelect / handleNaiaBgSelect 가
	// saveConfig 로 즉시 영속하므로 "미리보기 되돌림" 계약이 폐기됨. stale closure 로 인해
	// 아바타 전환 시 두 번 클릭해야 하는 버그의 원인이었음.

	/** #auto-apply: 즉시 config 영속 (localStorage + naia-settings/config.json).
	 *  Save 버튼 없이 onChange/onBlur 로 바로 적용 — 비밀키 필드는 제외. */
	function persistConfig(updates: Record<string, unknown>) {
		const cfg = loadConfig();
		if (!cfg) return;
		const next = { ...cfg, ...updates };
		saveConfig(next);
		void writeNaiaConfig(next as unknown as Record<string, unknown>);
	}

	function handleProviderChange(id: ProviderId) {
		setProvider(id);
		if (id !== "ollama") {
			setModel(getDefaultLlmModel(id));
		}
		setError("");
		if (id === "nextain" && !naiaKey) {
			setError(t("settings.naiaLoginRequiredFirst"));
			startLabLogin();
			return; // login first; naia_auth_complete persists once the key arrives
		}
		// UC-MODEL-SELECT contract: persist the provider/model switch so the gRPC
		// agent reloads with it (prev. only Save persisted → stale provider/model).
		const provSel = applyModelSelectionToConfig(
			loadConfig() as Record<string, unknown> | null,
			id,
			id !== "ollama"
				? getDefaultLlmModel(id)
				: ((loadConfig()?.model as string | undefined) ?? ""),
		);
		saveConfig(provSel as unknown as Parameters<typeof saveConfig>[0]);
		void writeNaiaConfig(provSel);
	}

	function handleLocaleChange(id: Locale) {
		setLocaleState(id);
		setLocale(id);
		// 활성 음성 세션(naia-omni)에 새 인식 언어를 즉시 핀(재연결 없음). ChatArea 이 수신.
		window.dispatchEvent(new CustomEvent("naia:locale-change", { detail: id }));
	}

	function handleThemeChange(id: ThemeId) {
		setTheme(id);
		const resolved =
			id === "system"
				? window.matchMedia("(prefers-color-scheme: dark)").matches
					? "midnight"
					: "espresso"
				: id;
		document.documentElement.setAttribute("data-theme", resolved);
		// Auto-save theme immediately — no need to hit the save button
		const current = loadConfig();
		if (current) saveConfig({ ...current, theme: id });
	}

	// Load VRM list from naia-settings
	useEffect(() => {
		listNaiaAssets("vrm-files").then((paths) => {
			const vrms = paths.filter((p) => p.toLowerCase().endsWith(".vrm"));
			setNaiaVrms(vrms);
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Load background list from naia-settings
	useEffect(() => {
		const savedFilename = existing?.backgroundVideo as string | undefined;
		listNaiaAssets("background").then((paths) => {
			setNaiaBgs(paths);
			if (savedFilename) {
				const match = paths.find((p) => p.endsWith(savedFilename));
				if (match) setActiveBgPath(match);
			}
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Load .nva directory list from naia-settings
	useEffect(() => {
		listNaiaAssets("nva-files").then((paths) => {
			setNaiaNvas(paths);
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	function debouncedLabSync() {
		if (labSyncTimerRef.current) clearTimeout(labSyncTimerRef.current);
		labSyncTimerRef.current = setTimeout(() => {
			const cfg = loadConfig();
			if (!cfg) return;
			if (naiaKey && naiaUserId) pushConfigToLab(naiaKey, naiaUserId, cfg);
			// (gateway TTS sync 제거됨 2026-06-12 — 죽은 gateway.json 경로)
		}, 2000);
	}

	// Persist TTS voice/provider changes immediately (without full handleSave)
	function persistTtsVoice(voice: string) {
		setTtsVoice(voice);
		if (existing) {
			saveConfig({ ...existing, ttsVoice: voice });
		}
		debouncedLabSync();
	}
	function getPreviewText(_voice?: string): string {
		const lang = locale.slice(0, 2).toLowerCase();
		switch (lang) {
			case "ko":
				return "안녕하세요, 반갑습니다. 오늘도 좋은 하루 되세요.";
			case "en":
				return "Hello, nice to meet you. Have a great day!";
			case "ja":
				return "こんにちは、はじめまして。良い一日をお過ごしください。";
			case "zh":
				return "你好，很高兴认识你。祝你有美好的一天！";
			case "fr":
				return "Bonjour, enchanté. Passez une bonne journée !";
			case "de":
				return "Hallo, freut mich. Einen schönen Tag noch!";
			case "es":
				return "Hola, mucho gusto. ¡Que tengas un buen día!";
			case "ru":
				return "Здравствуйте, приятно познакомиться. Хорошего дня!";
			case "ar":
				return "مرحباً، سعيد بلقائك. أتمنى لك يوماً سعيداً!";
			case "hi":
				return "नमस्ते, आपसे मिलकर खुशी हुई। आपका दिन शुभ हो!";
			case "bn":
				return "নমস্কার, আপনার সাথে দেখা হয়ে ভালো লাগলো। শুভ দিন!";
			case "pt":
				return "Olá, prazer em conhecê-lo. Tenha um ótimo dia!";
			case "id":
				return "Halo, senang bertemu Anda. Semoga hari Anda menyenangkan!";
			case "vi":
				return "Xin chào, rất vui được gặp bạn. Chúc bạn một ngày tốt lành!";
			default:
				return "Hello, nice to meet you. Have a great day!";
		}
	}

	async function handleVoicePreview() {
		if (isPreviewing) return;
		setError("");
		setIsPreviewing(true);
		try {
			const modelMeta = (dynamicModels[provider] ?? []).find(
				(m) => m.id === model,
			);
			const isOmni = modelMeta?.capabilities.includes("omni") ?? false;

			// Resolve the effective TTS provider / voice / credentials, then
			// synthesize shell-side (#363). The agent's skill_tts was never a real
			// synthesizer, so preview routes through the same path as live voice.
			let synthProvider: TtsProviderId;
			let synthVoice: string | undefined;
			let synthApiKey: string | undefined;

			if (isOmni && (provider === "nextain" || provider === "gemini")) {
				// Omni avatar voice → Naia Cloud (gateway Chirp 3 HD).
				const voiceName = voice || getDefaultVoiceForAvatar(existing?.vrmModel);
				synthProvider = "nextain";
				synthVoice = `ko-KR-Chirp3-HD-${voiceName}`;
			} else if (isOmni && provider === "openai") {
				synthProvider = "openai";
				synthVoice = voice || "alloy";
				synthApiKey =
					openaiRealtimeApiKey.trim() || existing?.openaiTtsApiKey || undefined;
			} else {
				synthProvider = (ttsProvider || "edge") as TtsProviderId;
				synthVoice = ttsVoice;
				if (
					synthProvider === "google" ||
					synthProvider === "openai" ||
					synthProvider === "elevenlabs"
				) {
					synthApiKey = gatewayTtsApiKey || undefined;
				}
			}

			if (synthProvider === "nextain" && !naiaKey) {
				setError(t("settings.ttsPreviewLoginRequired"));
				return;
			}

			const { audioBase64 } = await synthesizeTts({
				text: getPreviewText(synthVoice),
				voice: synthVoice,
				provider: synthProvider,
				apiKey: synthApiKey,
				naiaKey: naiaKey || undefined,
				gatewayUrl: LAB_GATEWAY_URL,
				vllmHost: existing?.vllmHost,
			});
			const audio = new Audio(`data:audio/mp3;base64,${audioBase64}`);
			await audio.play();
		} catch (err) {
			setError(
				`${t("settings.ttsPreviewFailed")}: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			setIsPreviewing(false);
		}
	}

	function handleReset() {
		setShowResetConfirm(true);
	}

	async function executeReset() {
		localStorage.removeItem("naia-config");
		clearSavedCamera();
		clearAdkPath(); // re-triggers ADK setup screen on next launch
		invoke("reset_window_state").catch(() => {});
		if (resetClearHistory) {
			useChatStore.getState().newConversation();
			resetGatewaySession().catch(() => {}); // agent skill_sessions(실 도구) — gateway 아님, 유지
			// (reset_gateway_data 제거됨 2026-06-12 — 죽은 gateway 데이터)
		}
		setLocale("ko");
		document.documentElement.setAttribute("data-theme", "midnight");
		window.location.reload();
	}

	async function handleSttModelDownload(modelId: string) {
		setSttDownloading(modelId);
		setSttDownloadProgress(0);
		try {
			await invoke("download_stt_model", { modelId });
		} catch (e) {
			Logger.warn("Settings", "STT model download failed", {
				error: String(e),
			});
			setSttDownloading(null);
			setSttDownloadProgress(0);
		}
	}

	async function handleSttModelDelete(modelId: string) {
		try {
			await invoke("delete_stt_model", { modelId });
			// Refresh catalog
			const models = await invoke<SttModelInfo[]>("list_stt_models");
			setSttModels(models);
			// Clear selection if deleted model was selected
			if (sttModel === modelId) {
				setSttModel("");
			}
		} catch (e) {
			Logger.warn("Settings", "STT model delete failed", { error: String(e) });
		}
	}

	function handleSyncDialogApply() {
		if (!syncDialogOnlineConfig) return;
		const current = loadConfig();
		if (!current) return;
		const merged = { ...current, ...syncDialogOnlineConfig };
		saveConfig(merged);
		// Update local state from merged config
		if (merged.userName) setUserName(merged.userName);
		if (merged.agentName) setAgentName(merged.agentName);
		if (merged.honorific !== undefined) setHonorific(merged.honorific ?? "");
		if (merged.speechStyle) setSpeechStyle(merged.speechStyle);
		if (merged.persona) setPersona(merged.persona ?? DEFAULT_PERSONA);
		if (merged.locale) setLocaleState(merged.locale);
		if (merged.theme) setTheme(merged.theme);
		if (merged.sttProvider) setSttProvider(merged.sttProvider);
		if (merged.sttModel) setSttModel(merged.sttModel);
		if (merged.ttsEnabled !== undefined) setTtsEnabled(merged.ttsEnabled);
		if (merged.ttsVoice) setTtsVoice(merged.ttsVoice);
		if (merged.ttsProvider) setTtsProvider(merged.ttsProvider);
		setSyncDialogOpen(false);
		setSyncDialogOnlineConfig(null);
	}

	function savePersonaFields(overrides?: {
		agentName?: string;
		userName?: string;
		honorific?: string;
		speechStyle?: string;
		persona?: string;
	}) {
		const cfg = loadConfig();
		if (!cfg) return;
		const updated = {
			...cfg,
			agentName: (overrides?.agentName ?? agentName).trim() || undefined,
			userName: (overrides?.userName ?? userName).trim() || undefined,
			honorific: (overrides?.honorific ?? honorific).trim() || undefined,
			speechStyle: overrides?.speechStyle ?? speechStyle,
			persona: (overrides?.persona ?? persona).trim() || undefined,
		};
		saveConfig(updated);
		void writeNaiaConfig(updated as unknown as Record<string, unknown>);
	}

	function handleSave() {
		// Keep previous key when input is empty (password field UX).
		const resolvedApiKey = apiKey.trim() || existing?.apiKey || "";
		const isNextainProvider = provider === "nextain";
		if (isNextainProvider && !naiaKey) {
			setError(t("settings.naiaLoginRequiredBeforeSave"));
			return;
		}
		if (
			!isNextainProvider &&
			!isApiKeyOptional(provider) &&
			!resolvedApiKey &&
			!naiaKey
		) {
			setError(t("settings.apiKeyRequired"));
			return;
		}
		const defaultVrm = DEFAULT_AVATAR_MODEL;
		// Derive ttsEngine from ttsProvider for agent compatibility
		// Only "google" uses direct Google TTS; all others (including nextain) use Gateway
		const derivedTtsEngine = ttsProvider === "google" ? "google" : "gateway";
		const newConfig = {
			...existing,
			provider,
			model,
			apiKey:
				isNextainProvider || isApiKeyOptional(provider) ? "" : resolvedApiKey,
			naiaKey: naiaKey || undefined,
			naiaUserId: naiaUserId || undefined,
			locale,
			theme,
			vrmModel: vrmModel !== defaultVrm ? vrmModel : undefined,
			avatarProvider,
			nvaModel:
				avatarProvider === "naia-video-avatar"
					? nvaModel || DEFAULT_NVA_MODEL // R6: 미지정이면 기본 번들
					: undefined,
			cascadeRuntimeUrl:
				avatarProvider === "naia-video-avatar"
					? cascadeRuntimeUrl.trim() || undefined
					: undefined,
			customVrms: customVrms.length > 0 ? customVrms : undefined,
			customBgs: customBgs.length > 0 ? customBgs : undefined,
			backgroundImage: backgroundImage || undefined,
			backgroundVideo: backgroundVideoFilename || undefined,
			sttProvider: sttProvider || undefined,
			sttModel: sttModel || undefined,
			localGpuTier: localGpuTier !== "off" ? localGpuTier : undefined,
			// 배타 티어 focus 는 기본값("voice")이 아닐 때만 저장(설정 최소화).
			localAvatarVoiceFocus:
				localAvatarVoiceFocus !== "voice" ? localAvatarVoiceFocus : undefined,
			ttsEnabled,
			ttsVoice,
			ttsProvider,
			ttsEngine: derivedTtsEngine as "google" | "gateway",
			googleApiKey:
				ttsProvider === "google" && gatewayTtsApiKey.trim()
					? gatewayTtsApiKey.trim()
					: googleApiKey.trim() || existing?.googleApiKey || undefined,
			openaiTtsApiKey:
				ttsProvider === "openai" && gatewayTtsApiKey.trim()
					? gatewayTtsApiKey.trim()
					: existing?.openaiTtsApiKey || undefined,
			elevenlabsApiKey:
				ttsProvider === "elevenlabs" && gatewayTtsApiKey.trim()
					? gatewayTtsApiKey.trim()
					: existing?.elevenlabsApiKey || undefined,
			persona:
				persona.trim() !== DEFAULT_PERSONA.trim() ? persona.trim() : undefined,
			userName: userName.trim() || undefined,
			agentName: agentName.trim() || undefined,
			honorific: honorific.trim() || undefined,
			speechStyle,
			enableTools,
			enableThinking,
			gatewayUrl:
				enableTools &&
				gatewayUrl.trim() &&
				gatewayUrl.trim() !== DEFAULT_GATEWAY_URL
					? gatewayUrl.trim()
					: undefined,
			gatewayToken: gatewayToken.trim() || undefined,
			discordDefaultUserId: discordDefaultUserId.trim() || undefined,
			discordDefaultTarget: discordDefaultTarget.trim() || undefined,
			discordDmChannelId: discordDmChannelId.trim() || undefined,
			ollamaHost:
				provider === "ollama"
					? ollamaHost.trim() || undefined
					: existing?.ollamaHost,
			vllmHost:
				provider === "vllm" ? vllmHost.trim() || undefined : existing?.vllmHost,
			naiaLocalUrl: naiaLocalUrl.trim() || undefined,
			voice: isOmniModel(provider, model) ? voice : existing?.voice,
			openaiRealtimeApiKey: openaiRealtimeApiKey.trim() || undefined,
			sttInputDeviceId: sttInputDeviceId || undefined,
			ttsOutputDeviceId: ttsOutputDeviceId || undefined,
			// Memory settings
			memoryAdapter,
			memoryEmbeddingProvider,
			memoryOfflineModel:
				memoryEmbeddingProvider === "offline" ? memoryOfflineModel : undefined,
			memoryEmbeddingDevice:
				memoryEmbeddingProvider === "offline"
					? memoryEmbeddingDevice
					: undefined,
			memoryEmbeddingBaseUrl:
				memoryEmbeddingProvider === "vllm" ||
				memoryEmbeddingProvider === "ollama"
					? memoryEmbeddingBaseUrl || undefined
					: undefined,
			memoryEmbeddingApiKey:
				memoryEmbeddingProvider === "vllm" ||
				memoryEmbeddingProvider === "ollama"
					? memoryEmbeddingApiKey || undefined
					: undefined,
			memoryEmbeddingModel:
				memoryEmbeddingProvider === "vllm" ||
				memoryEmbeddingProvider === "ollama"
					? memoryEmbeddingModel || undefined
					: undefined,
			qdrantUrl:
				memoryAdapter === "qdrant" ? qdrantUrl || undefined : undefined,
			qdrantApiKey:
				memoryAdapter === "qdrant" ? qdrantApiKey || undefined : undefined,
			memoryLlmProvider:
				memoryLlmProvider !== "none" ? memoryLlmProvider : undefined,
			memoryLlmBaseUrl:
				memoryLlmProvider === "vllm" || memoryLlmProvider === "ollama"
					? memoryLlmBaseUrl || undefined
					: undefined,
			memoryLlmApiKey:
				memoryLlmProvider === "vllm" || memoryLlmProvider === "ollama"
					? memoryLlmApiKey || undefined
					: undefined,
			memoryLlmModel:
				memoryLlmProvider !== "none" ? memoryLlmModel || undefined : undefined,
		};
		saveConfig(newConfig);
		// Also persist to naia-settings/config.json so ADK reload restores the same settings
		void writeNaiaConfig(newConfig as unknown as Record<string, unknown>);
		if (naiaKey) void saveSecretKey("naiaKey", naiaKey);
		// 새 core: agent 가 읽는 OS 키체인에 키 기록(write_agent_key). 설정 저장 시 누락돼 있던 배선
		// — OnboardingWizard 만 했고 SettingsTab 은 안 해서, 설정에서 넣은 키가 agent 에 안 닿아 401 났음(라이브 e2e 가 잡음).
		if (resolvedApiKey)
			void writeAgentKey(newConfig.provider, "apiKey", resolvedApiKey);
		if (naiaKey) void writeAgentKey(newConfig.provider, "naiaKey", naiaKey);
		// #18: 메모리 비밀(embed/qdrant/llm apiKey)도 OS 키체인에 기록 — config.json 에선 strip 되므로
		// agent loadMemoryConfig 가 키체인 account(NAIA_MEMORY_*_API_KEY)로 읽는다(provider 무관 → writeAgentSecret).
		if (newConfig.memoryEmbeddingApiKey)
			void writeAgentSecret(
				"NAIA_MEMORY_EMBED_API_KEY",
				newConfig.memoryEmbeddingApiKey,
			);
		if (newConfig.qdrantApiKey)
			void writeAgentSecret(
				"NAIA_MEMORY_QDRANT_API_KEY",
				newConfig.qdrantApiKey,
			);
		if (newConfig.memoryLlmApiKey)
			void writeAgentSecret(
				"NAIA_MEMORY_LLM_API_KEY",
				newConfig.memoryLlmApiKey,
			);
		// Push webhook URLs + Discord defaults to the agent (#260). Replaces
		// per-chat_request webhook field transmission with a one-shot config
		// update so credentials don't appear in every stdio frame.
		void sendNotifyConfig({
			slackWebhookUrl: newConfig.slackWebhookUrl,
			discordWebhookUrl: newConfig.discordWebhookUrl,
			googleChatWebhookUrl: newConfig.googleChatWebhookUrl,
			discordDefaultUserId: newConfig.discordDefaultUserId,
			discordDefaultTarget: newConfig.discordDefaultTarget,
			discordDmChannelId: newConfig.discordDmChannelId,
		});
		// Push all per-session credentials (#260 follow-up). Empty strings
		// clear the corresponding cached entry on the agent — keeps the cache
		// in sync with what the user just saved.
		const ttsKeys: Record<string, string> = {};
		ttsKeys.google = newConfig.googleApiKey ?? "";
		ttsKeys.openai = newConfig.openaiTtsApiKey ?? "";
		ttsKeys.elevenlabs = newConfig.elevenlabsApiKey ?? "";
		void sendCredsUpdate({
			keys: newConfig.provider
				? { [newConfig.provider]: newConfig.apiKey ?? "" }
				: {},
			ttsKeys,
			gatewayToken: newConfig.gatewayToken ?? "",
		});
		setLocale(locale);
		setAvatarModelPath(vrmModel);
		setAvatarBackgroundImage(backgroundImage);
		setSavedVrmModel(vrmModel);
		setSaved(true);
		setTimeout(() => setSaved(false), 2000);

		// (gateway sync 제거됨 2026-06-12 — gateway.json 미사용 죽은 경로. config 영속=naia-settings, memory 설정=다른 세션 재설계.)

		// Auto-sync to Lab if connected
		if (naiaKey && naiaUserId) {
			pushConfigToLab(naiaKey, naiaUserId, newConfig);
		}
	}

	const providerModels = dynamicModels[provider] ?? [];
	const selectedModelMeta = providerModels.find((m) => m.id === model);
	const hasSelectedModel = Boolean(selectedModelMeta);
	const isSelectedOmni =
		selectedModelMeta?.capabilities.includes("omni") ?? false;
	const modelIdLower = model?.toLowerCase() ?? "";
	const isSelectedAsr =
		(selectedModelMeta?.capabilities.includes("asr") ?? false) ||
		(provider === "vllm" &&
			(modelIdLower.includes("asr") || modelIdLower.includes("whisper")));
	// #365 capability-driven slots: derive which external voice slots to show
	// from the model's declared capabilities (gateway SoT) instead of scattered
	// omni/asr booleans. Fold the vllm ASR runtime pattern into the capability
	// set so the manifest is the single source for slot gating (omni → voice
	// in+out covered, section hidden; ASR → STT covered, TTS external; text-only
	// → both external). Extensible to image/video/avatar supplements.
	const baseCapabilities: ModelCapability[] =
		isSelectedAsr && !(selectedModelMeta?.capabilities.includes("asr") ?? false)
			? [...(selectedModelMeta?.capabilities ?? []), "asr"]
			: (selectedModelMeta?.capabilities ?? []);
	// #2 / FR-VRAM.2: local GPU tier is a budget/candidate signal only. It must
	// not hide external STT/TTS slots until a runtime manager reports actual
	// readiness; otherwise the UI would imply local services are already running.
	// FR-3(2026-07-02): 로그인 안 되어 있으면 로컬 프로파일은 비활성으로 취급한다.
	// 위젯 disabled 만으로는 부족 — 로그아웃 후에도 config 의 localGpuTier 가 남아
	// activeLocalTier 가 truthy 가 되면 요약/추천 배지가 로컬을 반영해 게이트가 샌다.
	// 설정값(config)은 남겨 재로그인 시 복원되지만, 파생 활성상태는 로그인에 종속시킨다.
	const activeLocalTier = naiaKey
		? resolveActiveTier(localGpuTier, detectedVramGb)
		: null;
	// 배타 티어면 focus 로 실제 로컬 capability 를 해소(아바타 XOR 음성). 비배타면 전부.
	const tierExclusive =
		!!activeLocalTier?.exclusiveLocal && !tierFitsBoth(activeLocalTier);
	const localTierCapabilities = resolveLocalCapabilities(
		activeLocalTier,
		localAvatarVoiceFocus,
	);
	// 비디오 아바타(cascade Ditto)를 띄울 수 있는가 = 로컬 GPU 프로파일이 "avatar" capability 를
	// **실제로** 제공할 때만(capability 기반 — exclusive/focus 휴리스틱 아님). resolveLocalCapabilities
	// 가 모든 케이스를 해소: 로그아웃(activeLocalTier=null)→[]→false(FR-3), 6G(tts만)→false,
	// 8G 배타는 focus=avatar 일 때만 true, 12G+ 는 true. 이 값으로 아바타 유형 피커의
	// "비디오 아바타" 선택을 게이트한다(가능할 때만 선택). VideoAvatarCanvas 자동기동과 동일 로직.
	const cascadeAvatarPossible = localTierCapabilities.includes("avatar");
	// FR-VRAM.4: tier 가 VRAM 예산 내에서 로컬 추천할 슬롯(숨김 아님 — 추천만).
	// 설정 슬롯 셀렉터 배지·슬롯 개요·GPU 프로파일 요약이 동일 소스를 소비.
	// 배타 티어는 focus 로 고른 슬롯만 추천.
	const tierRecs = tierRecommendedSlots(activeLocalTier, localAvatarVoiceFocus);
	const effectiveCapabilities: ModelCapability[] = baseCapabilities;
	const capabilitySlots = deriveSettingsSlots(effectiveCapabilities);
	const omniVoices = selectedModelMeta?.voices;
	const activeTierCapabilities = activeLocalTier
		? localTierCapabilities.join(", ")
		: t("settings.engineLocalOff");
	// S-SLOT 게이트(FR-SLOT.1) — naiaKey 존재 = naia(크레딧 접근), 부재 = byo.
	// GPU·localGpuTier 무관(R1-3). "Naia"는 provider 아닌 접근 유형.
	const gateMode: GateMode = deriveGate(!!naiaKey);
	// 슬롯 오버뷰 = **적용(applied) 상태**(라이브). 피커/셀렉터는 스테이징(React state)이고
	// "적용"(handleSave)이 스테이징→적용으로 커밋한다. 그래서 요약은 loadConfig() 을 읽는다.
	const appliedCfg = loadConfig();
	const slotSnapshot = readSlots(appliedCfg ?? ({} as AppConfig));

	const SLOT_LABEL_KEYS: Record<SlotId, string> = {
		main: "settings.slot.slotMain",
		sub: "settings.slot.slotSub",
		embedding: "settings.slot.slotEmbedding",
		stt: "settings.slot.slotStt",
		tts: "settings.slot.slotTts",
		avatar: "settings.slot.slotAvatar",
	};
	function slotValueDisplay(id: SlotId): string {
		switch (id) {
			case "main":
				return `${slotSnapshot.main.provider || "—"} / ${slotSnapshot.main.model || model || "—"}`;
			case "sub":
				return slotSnapshot.sub.provider && slotSnapshot.sub.provider !== "none"
					? `${slotSnapshot.sub.provider}${slotSnapshot.sub.model ? ` / ${slotSnapshot.sub.model}` : ""}`
					: t("settings.slot.notSet");
			case "embedding":
				return slotSnapshot.embedding.provider &&
					slotSnapshot.embedding.provider !== "none"
					? `${slotSnapshot.embedding.provider}${slotSnapshot.embedding.model ? ` / ${slotSnapshot.embedding.model}` : ""}`
					: t("settings.slot.notSet");
			case "stt":
				return slotSnapshot.stt.provider
					? String(slotSnapshot.stt.provider)
					: t("settings.slot.notSet");
			case "tts":
				return slotSnapshot.tts.provider
					? String(slotSnapshot.tts.provider)
					: t("settings.slot.notSet");
			case "avatar": {
				// 슬롯 = 적용된(라이브) 시각 아바타. readSlots 의 avatar 는 레거시 liveProvider
				// (마이그레이션이 비움)를 읽어 항상 "미설정"으로 뜨므로, 여기선 적용된 config
				// (appliedCfg.avatarProvider + nvaModel/vrmModel)를 직접 표시한다. 경로면 basename 만.
				const bare = (v: string) => v.split(/[/\\]/).filter(Boolean).pop() ?? v;
				const ap = appliedCfg?.avatarProvider;
				if (ap === "naia-video-avatar") {
					return `${t("settings.avatarProviderVideo")}${appliedCfg?.nvaModel ? ` / ${bare(appliedCfg.nvaModel)}` : ""}`;
				}
				if (ap === "vrm") {
					return `${t("settings.avatarProviderVrm")}${appliedCfg?.vrmModel ? ` / ${bare(appliedCfg.vrmModel)}` : ""}`;
				}
				return t("settings.slot.notSet");
			}
		}
	}

	// FR-SLOT.3 / R2-1: naia 게이트에서 "Gemini 기본값 적용" — 미설정 슬롯에 비파괴 적용.
	function handleApplyNaiaDefaults() {
		if (!naiaKey) {
			setError(t("settings.naiaLoginRequiredFirst"));
			startLabLogin();
			return;
		}
		const current = loadConfig();
		if (!current) return;
		const next = applyNaiaSlotDefaults(current);
		saveConfig(next);
		void writeNaiaConfig(next as unknown as Record<string, unknown>);
		setProvider(next.provider);
		setModel(next.model);
		if (next.memoryLlmProvider) setMemoryLlmProvider(next.memoryLlmProvider);
		if (next.memoryEmbeddingProvider)
			setMemoryEmbeddingProvider(next.memoryEmbeddingProvider);
	}
	const detectedVramLabel =
		detectedVramGb != null
			? t("settings.engineDetectedVram").replace(
					"{vram}",
					String(detectedVramGb),
				)
			: t("settings.engineDetectedUnknown");
	const capabilityStatus = [
		capabilitySlots.coversVoiceInput
			? t("settings.engineVoiceInputCovered")
			: t("settings.engineVoiceInputExternal"),
		capabilitySlots.coversVoiceOutput
			? t("settings.engineVoiceOutputCovered")
			: t("settings.engineVoiceOutputExternal"),
		capabilitySlots.coversVision
			? t("settings.engineVisionCovered")
			: t("settings.engineVisionExternal"),
	];
	// Ref-audio (voice clone) applies to naia-omni sessions (naia-* omni
	// models or a local vllm-omni server) OR when naia-local-voice TTS is
	// selected (VoxCPM2 GPU voice cloning). Gemini Live is omni too but has no
	// voice-clone surface, so mounting RefAudioSection there just 404s on
	// GET /v1/ref-audio. Gate the section on this.
	const supportsRefAudio =
		(isSelectedOmni &&
			(modelIdLower.startsWith("naia-") || provider === "vllm")) ||
		ttsProvider === "naia-local-voice";
	const manualUrl = `${getNaiaWebBaseUrl()}/${locale}/manual`;

	// Discord integration — unverified, hidden until stabilized
	// async function handleDiscordBotConnect() { ... }

	return (
		<div className="settings-tab">
			<div className="settings-tab-bar">
				<button
					type="button"
					data-settings-tab="profile"
					className={`settings-tab-btn${activeSettingsTab === "profile" ? " settings-tab-btn--active" : ""}`}
					onClick={() => setActiveSettingsTab("profile")}
				>
					{t("settings.tabProfile")}
				</button>
				<button
					type="button"
					data-settings-tab="brain"
					className={`settings-tab-btn${activeSettingsTab === "brain" ? " settings-tab-btn--active" : ""}`}
					onClick={() => setActiveSettingsTab("brain")}
				>
					{t("settings.tabBrain")}
				</button>
				<button
					type="button"
					data-settings-tab="voice"
					className={`settings-tab-btn${activeSettingsTab === "voice" ? " settings-tab-btn--active" : ""}`}
					onClick={() => setActiveSettingsTab("voice")}
				>
					{t("settings.tabVoice")}
				</button>
				<button
					type="button"
					data-settings-tab="avatar"
					className={`settings-tab-btn${activeSettingsTab === "avatar" ? " settings-tab-btn--active" : ""}`}
					onClick={() => setActiveSettingsTab("avatar")}
				>
					{t("settings.tabAvatar")}
				</button>
				<button
					type="button"
					data-settings-tab="persona"
					className={`settings-tab-btn${activeSettingsTab === "persona" ? " settings-tab-btn--active" : ""}`}
					onClick={() => setActiveSettingsTab("persona")}
				>
					{t("settings.tabPersona")}
				</button>
				<button
					type="button"
					data-settings-tab="memory"
					className={`settings-tab-btn${activeSettingsTab === "memory" ? " settings-tab-btn--active" : ""}`}
					onClick={() => setActiveSettingsTab("memory")}
				>
					{t("settings.tabMemory")}
				</button>
				<button
					type="button"
					data-settings-tab="knowledge"
					className={`settings-tab-btn${activeSettingsTab === "knowledge" ? " settings-tab-btn--active" : ""}`}
					onClick={() => setActiveSettingsTab("knowledge")}
				>
					{t("settings.tabKnowledge")}
				</button>
				<button
					type="button"
					data-settings-tab="skills"
					className={`settings-tab-btn${activeSettingsTab === "skills" ? " settings-tab-btn--active" : ""}`}
					onClick={() => setActiveSettingsTab("skills")}
				>
					{t("settings.tabSkills")}
				</button>
				<button
					type="button"
					data-settings-tab="general"
					className={`settings-tab-btn${activeSettingsTab === "general" ? " settings-tab-btn--active" : ""}`}
					onClick={() => setActiveSettingsTab("general")}
				>
					{t("settings.tabGeneral")}
				</button>
			</div>
			{activeSettingsTab === "general" && (
				<>
					<div className="settings-field">
						<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
							<label htmlFor="locale-select" style={{ margin: 0 }}>
								{t("settings.language")}
							</label>
							<select
								id="locale-select"
								value={locale}
								onChange={(e) => handleLocaleChange(e.target.value as Locale)}
								style={{ width: "auto", minWidth: 120 }}
							>
								{LOCALES.map((l) => (
									<option key={l.id} value={l.id}>
										{l.label}
									</option>
								))}
							</select>
							<button
								type="button"
								className="voice-preview-btn"
								onClick={() => openUrl(manualUrl).catch(() => {})}
							>
								{t("settings.manual")}
							</button>
						</div>
					</div>

					<div className="settings-field">
						<label>{t("settings.theme")}</label>
						<div className="theme-picker">
							{THEMES.map((th) => (
								<button
									key={th.id}
									type="button"
									className={`theme-swatch ${theme === th.id ? "active" : ""}`}
									style={{ background: th.preview }}
									onClick={() => handleThemeChange(th.id)}
									title={th.label}
								/>
							))}
						</div>
					</div>

					{/* #10: 배경 이미지 — 테마 바로 아래, 드롭다운 방식 (avatar 탭에서 이동) */}
					<div className="settings-field">
						<label>{t("settings.background")}</label>
						<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
							<select
								value={activeBgPath ?? ""}
								onChange={(e) => {
									const v = e.target.value;
									if (!v) handleClearNaiaBg();
									else handleNaiaBgSelect(v);
								}}
								style={{ flex: 1 }}
							>
								<option value="">{t("settings.bgNone")}</option>
								{naiaBgs.map((path) => {
									const label = (path.split(/[/\\]/).pop() ?? path).replace(
										/\.[^.]+$/,
										"",
									);
									return (
										<option key={path} value={path}>
											{label}
										</option>
									);
								})}
							</select>
							<button
								type="button"
								className="voice-preview-btn"
								onClick={() => handleImportAsset("background")}
							>
								{t("settings.assetImport")}
							</button>
							{activeBgPath &&
								(() => {
									const fn = activeBgPath.split(/[/\\]/).pop();
									return fn ? (
										<button
											type="button"
											className="voice-preview-btn"
											style={{ color: "var(--error-color, #f44)" }}
											onClick={() => handleDeleteAsset("background", fn)}
										>
											{t("settings.assetDelete")}
										</button>
									) : null;
								})()}
						</div>
					</div>

					<div className="settings-field">
						<label>워크스페이스</label>
						<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
							<button
								type="button"
								className="voice-preview-btn"
								onClick={async () => {
									const selected = await open({
										directory: true,
										title: t("settings.workspaceDialogTitle"),
									});
									if (selected && typeof selected === "string") {
										setWorkspaceRoot(selected);
										const cfg = loadConfig();
										if (!cfg) return;
										saveConfig({ ...cfg, workspaceRoot: selected });
										setAdkPath(selected);
										invoke("workspace_set_root", { root: selected }).catch(
											() => {},
										);
										// 전환 = 새 워크스페이스의 config.json + ui-config.json 복원(FR-WS.1) — AdkSetupScreen 과 동형.
										await applyWorkspaceConfigToLocal();
										window.location.reload();
									}
								}}
							>
								{t("settings.workspaceBrowse")}
							</button>
							<button
								type="button"
								className="voice-preview-btn"
								style={{
									background: "var(--accent-color, #5b8cf5)",
									color: "#fff",
								}}
								onClick={async () => {
									const trimmed = workspaceRoot.trim();
									const cfg = loadConfig();
									if (!cfg) return;
									saveConfig({
										...cfg,
										workspaceRoot: trimmed || undefined,
									});
									if (trimmed) {
										setAdkPath(trimmed);
										invoke("workspace_set_root", {
											root: trimmed,
										}).catch(() => {});
										// 전환 = 새 워크스페이스 설정 복원(FR-WS.1).
										await applyWorkspaceConfigToLocal();
									} else {
										clearAdkPath();
									}
									window.location.reload();
								}}
							>
								{t("settings.workspaceApply")}
							</button>
							<input
								type="text"
								className="settings-input"
								value={workspaceRoot}
								onChange={(e) => setWorkspaceRoot(e.target.value)}
								placeholder={t("settings.workspacePlaceholder")}
								style={{ flex: 1 }}
							/>
						</div>
						<div className="settings-hint">{t("settings.workspaceHint")}</div>
					</div>

					<div className="settings-field">
						<label>naia-adk 경로 재설정</label>
						<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
							<button
								type="button"
								className="voice-preview-btn"
								onClick={() => {
									clearAdkPath();
									window.location.reload();
								}}
							>
								재설정 (앱 재시작)
							</button>
						</div>
						<div className="settings-hint">
							naia-adk 폴더를 변경하거나 초기 설정을 다시 진행할 때 사용하세요
						</div>
					</div>

					<div className="settings-field">
						<label>카메라 위치 초기화</label>
						<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
							<button
								type="button"
								className="voice-preview-btn"
								onClick={() => {
									clearSavedCamera();
									window.location.reload();
								}}
							>
								기본값으로 (앱 재시작)
							</button>
						</div>
						<div className="settings-hint">
							저장된 카메라 위치를 지우고 기본값으로 돌아갑니다
						</div>
					</div>
				</>
			)}
			{activeSettingsTab === "avatar" && (
				<>
					<div className="settings-section-divider">
						<span>{t("settings.avatarSection")}</span>
					</div>

					{/* #6: Avatar type selector — 비디오 아바타는 cascade(Ditto) 기동 가능 시에만 선택 가능. */}
					<div className="settings-field">
						<label>{t("settings.avatarProvider")}</label>
						<select
							value={avatarProvider}
							onChange={(e) => {
								const next = e.target.value as "vrm" | "naia-video-avatar";
								// cascade 기동 불가 시 비디오 아바타 선택 차단(정적 사진 폴백을 안 만들기 위함).
								if (next === "naia-video-avatar" && !cascadeAvatarPossible)
									return;
								// R3: 스테이징만(즉시 persist 안 함) — "적용"에서 커밋.
								setAvatarProvider(next);
								// R6: 비디오 아바타인데 NVA 미지정이면 기본 번들로 채운다(빈 상태 방지).
								if (next === "naia-video-avatar" && !nvaModel)
									setNvaModel(DEFAULT_NVA_MODEL);
							}}
						>
							<option value="vrm">{t("settings.avatarProviderVrm")}</option>
							<option
								value="naia-video-avatar"
								disabled={!cascadeAvatarPossible}
							>
								{t("settings.avatarProviderVideo")}
								{!cascadeAvatarPossible
									? ` (${t("settings.avatarVideoNeedsCascade")})`
									: isRecommendedLocalValue(
												activeLocalTier,
												"avatar",
												"naia-video-avatar",
												localAvatarVoiceFocus,
											)
										? ` · ${t("settings.tierRecommendBadge")}`
										: ""}
							</option>
						</select>
						{!cascadeAvatarPossible && (
							<div
								className="settings-hint"
								data-testid="avatar-cascade-required"
							>
								{t("settings.avatarVideoCascadeHint")}
							</div>
						)}
						{slotRecommendation(
							activeLocalTier,
							"avatar",
							localAvatarVoiceFocus,
						) && (
							<div className="settings-hint" data-testid="avatar-tier-hint">
								{t("settings.tierRecommendSummary")}: naia-video-avatar (
								{t("settings.tierRecommendLocalTag")})
							</div>
						)}
					</div>

					{/* VRM picker — shown when avatarProvider === "vrm" */}
					{avatarProvider === "vrm" && (
						<div className="settings-field">
							<label>{t("settings.vrmModel")}</label>
							<div className="vrm-list">
								{naiaVrms.length === 0 && (
									<span className="vrm-list-empty">
										naia-settings/vrm-files/ 에 VRM 파일을 추가하세요
									</span>
								)}
								{naiaVrms.map((path) => {
									const filename = path.split(/[/\\]/).pop() ?? path;
									const label = filename.replace(/\.vrm$/i, "");
									const thumb = `/avatars/${filename.replace(/\.vrm$/i, ".webp")}`;
									return (
										<button
											key={path}
											type="button"
											className={`vrm-list-item${vrmModel === path ? " vrm-list-item--active" : ""}`}
											onClick={() => handleVrmSelect(path)}
										>
											<img
												src={thumb}
												className="vrm-list-item__thumb"
												alt={label}
												onError={(e) => {
													(e.currentTarget as HTMLImageElement).style.display =
														"none";
												}}
											/>
											{label}
										</button>
									);
								})}
								{customVrms.map((path) => {
									const label = (path.split(/[/\\]/).pop() ?? path).replace(
										/\.vrm$/i,
										"",
									);
									return (
										<button
											key={path}
											type="button"
											className={`vrm-list-item${vrmModel === path ? " vrm-list-item--active" : ""}`}
											onClick={() => handleVrmSelect(path)}
										>
											{label}
										</button>
									);
								})}
							</div>
							{/* #12/#13: 파일 추가 + 삭제 */}
							<div style={{ display: "flex", gap: 8, marginTop: 8 }}>
								<button
									type="button"
									className="voice-preview-btn"
									onClick={() => handleImportAsset("vrm-files")}
								>
									{t("settings.assetImport")}
								</button>
								{vrmModel &&
									(() => {
										const fn = vrmModel.split(/[/\\]/).pop();
										return fn ? (
											<button
												type="button"
												className="voice-preview-btn"
												style={{ color: "var(--error-color, #f44)" }}
												onClick={() => handleDeleteAsset("vrm-files", fn)}
											>
												{t("settings.assetDelete")}
											</button>
										) : null;
									})()}
							</div>
						</div>
					)}

					{/* .nva picker — shown when avatarProvider === "naia-video-avatar" */}
					{avatarProvider === "naia-video-avatar" && (
						<div className="settings-field">
							<label>{t("settings.avatarProviderVideo")}</label>
							<div className="vrm-list">
								{naiaNvas.length === 0 && (
									<span className="vrm-list-empty">
										{t("settings.nvaEmpty")}
									</span>
								)}
								{naiaNvas.map((name) => (
									<button
										key={name}
										type="button"
										className={`vrm-list-item${nvaModel === name ? " vrm-list-item--active" : ""}`}
										onClick={() => {
											// R3: 스테이징만 — "적용"에서 커밋.
											setNvaModel(name);
										}}
									>
										{name}
									</button>
								))}
							</div>
							<div style={{ display: "flex", gap: 8, marginTop: 8 }}>
								<button
									type="button"
									className="voice-preview-btn"
									onClick={() => handleImportAsset("nva-files")}
								>
									{t("settings.folderImport")}
								</button>
								{nvaModel && (
									<button
										type="button"
										className="voice-preview-btn"
										style={{ color: "var(--error-color, #f44)" }}
										onClick={() => handleDeleteAsset("nva-files", nvaModel)}
									>
										{t("settings.assetDelete")}
									</button>
								)}
							</div>
							{/* FR-6(2026-07-01): 립싱크는 TTS 음성이 있을 때만. TTS 꺼짐 → 정적. */}
							<div
								className="settings-hint"
								data-testid="nva-lipsync-note"
								style={
									!ttsEnabled
										? { color: "var(--error-color, #f44)" }
										: undefined
								}
							>
								{!ttsEnabled
									? t("settings.nvaLipSyncWarnNoTts")
									: t("settings.nvaLipSyncNote")}
							</div>
							{/* FR-2(2026-07-01): "토킹 런타임 URL"(원격 cascade)은 아바타 탭에서 제거.
						    원격 cascade 연결은 프로파일 탭(서빙 프로파일)으로 이관 예정 — 아바타 탭은
						    아바타 종류/NVA 만. cascadeRuntimeUrl config/state 는 유지(프로파일서 재사용). */}
						</div>
					)}
				</>
			)}
			{activeSettingsTab === "persona" && (
				<>
					<div className="settings-section-divider">
						<span>{t("settings.personaSection")}</span>
					</div>

					<div className="settings-field">
						<label>{t("settings.agentName")}</label>
						<input
							type="text"
							className="settings-input"
							value={agentName}
							onChange={(e) => setAgentName(e.target.value)}
							onBlur={(e) => savePersonaFields({ agentName: e.target.value })}
							placeholder="Naia"
						/>
					</div>
					<div className="settings-field">
						<label>{t("settings.userName")}</label>
						<input
							type="text"
							className="settings-input"
							value={userName}
							onChange={(e) => setUserName(e.target.value)}
							onBlur={(e) => savePersonaFields({ userName: e.target.value })}
						/>
					</div>
					{FORMALITY_LOCALES.has(locale) && (
						<>
							<div className="settings-field">
								<label>{t("settings.honorific")}</label>
								<input
									type="text"
									className="settings-input"
									value={honorific}
									onChange={(e) => setHonorific(e.target.value)}
									onBlur={(e) =>
										savePersonaFields({ honorific: e.target.value })
									}
									placeholder={t("onboard.speechStyle.honorificPlaceholder")}
								/>
							</div>
							<div className="settings-field">
								<label>{t("settings.speechStyle")}</label>
								<select
									className="settings-select"
									data-testid="settings-speech-style"
									value={speechStyle}
									onChange={(e) => {
										setSpeechStyle(e.target.value);
										savePersonaFields({ speechStyle: e.target.value });
									}}
								>
									<option value="casual">
										{t("onboard.speechStyle.casual")} (Casual)
									</option>
									<option value="formal">
										{t("onboard.speechStyle.formal")} (Formal)
									</option>
								</select>
							</div>
						</>
					)}

					<div className="settings-field">
						<label htmlFor="persona-input">{t("settings.persona")}</label>
						<textarea
							id="persona-input"
							className="settings-persona-textarea"
							value={persona}
							onChange={(e) => setPersona(e.target.value)}
							onBlur={(e) => savePersonaFields({ persona: e.target.value })}
							rows={6}
						/>
						<div className="settings-hint">{t("settings.personaHint")}</div>
					</div>
				</>
			)}
			{activeSettingsTab === "profile" && (
				<>
					<div className="settings-section-divider">
						<span>{t("settings.engineSection")}</span>
					</div>

					<div className="settings-field" data-testid="slot-gate">
						<label>{t("settings.slot.gate")}</label>
						<div className="settings-hint">{t("settings.slot.gateHint")}</div>
						<div
							style={{
								display: "flex",
								gap: 8,
								marginTop: 8,
								flexWrap: "wrap",
								alignItems: "center",
							}}
						>
							<span data-testid="slot-gate-mode">
								{gateMode === "naia"
									? t("settings.slot.gateNaia")
									: t("settings.slot.gateByo")}
							</span>
							{gateMode === "naia" ? (
								<button
									type="button"
									data-testid="slot-apply-defaults"
									className="voice-preview-btn"
									onClick={handleApplyNaiaDefaults}
								>
									{t("settings.slot.applyDefaults")}
								</button>
							) : (
								<button
									type="button"
									data-testid="slot-login-naia"
									className="voice-preview-btn"
									onClick={startLabLogin}
								>
									{t("settings.slot.loginNaia")}
								</button>
							)}
						</div>
					</div>

					{/* #1 통합: NAIA 계정 관리(잔액/대시보드/연결끊기) = 게이트 바로 아래.
					    게이트가 로그인(byo 분기)을 담당; 여기는 connected 상태 UI. */}
					{naiaKey && (
						<div className="settings-field" data-testid="profile-naia-account">
							<label>{t("settings.labConnected")}</label>
							<div className="lab-info-block">
								{naiaUserId && (
									<span className="lab-user-id">{naiaUserId}</span>
								)}
								<div className="lab-balance-row">
									<span className="lab-balance-label">
										{t("settings.labBalance")}
									</span>
									<span className="lab-balance-value">
										{labBalanceLoading
											? t("settings.labBalanceLoading")
											: labBalanceError
												? t("cost.labError")
												: labBalance !== null
													? `${labBalance.toFixed(2)} ${t("cost.labCredits")}`
													: "-"}
									</span>
								</div>
								<div className="lab-actions-row">
									<button
										type="button"
										className="voice-preview-btn"
										onClick={() =>
											openUrl(
												`${getNaiaWebBaseUrl()}/${locale}/dashboard`,
											).catch(() => {})
										}
									>
										{t("settings.labDashboard")}
									</button>
									<button
										type="button"
										className="voice-preview-btn"
										onClick={() =>
											openUrl(`${getNaiaWebBaseUrl()}/${locale}/billing`).catch(
												() => {},
											)
										}
									>
										{t("cost.labCharge")}
									</button>
									{showLabDisconnect ? (
										<div
											className="reset-confirm-panel"
											style={{ marginTop: 8 }}
										>
											<p className="reset-confirm-msg">
												{t("settings.labDisconnectConfirm")}
											</p>
											<div className="reset-confirm-actions">
												<button
													type="button"
													className="settings-reset-btn"
													onClick={async () => {
														setNaiaKeyState("");
														setNaiaUserIdState("");
														setLabBalance(null);
														setProvider("gemini");
														setModel(getDefaultLlmModel("gemini"));
														setDiscordDefaultUserId("");
														setDiscordDmChannelId("");
														setDiscordDefaultTarget("");
														setShowLabDisconnect(false);
														await deleteSecretKey("naiaKey");
														const current = loadConfig();
														if (current) {
															saveConfig({
																...current,
																provider:
																	current.provider === "nextain"
																		? "gemini"
																		: current.provider,
																model:
																	current.provider === "nextain"
																		? getDefaultLlmModel("gemini")
																		: current.model,
																ttsProvider:
																	current.ttsProvider === "nextain"
																		? "edge"
																		: current.ttsProvider,
																sttProvider:
																	current.sttProvider === "nextain"
																		? ""
																		: current.sttProvider,
																naiaKey: undefined,
																naiaUserId: undefined,
																discordDefaultUserId: undefined,
																discordDmChannelId: undefined,
																discordDefaultTarget: undefined,
															});
														}
													}}
												>
													{t("settings.labDisconnect")}
												</button>
												<button
													type="button"
													className="settings-cancel-btn"
													onClick={() => setShowLabDisconnect(false)}
												>
													{t("settings.cancel")}
												</button>
											</div>
										</div>
									) : (
										<button
											type="button"
											className="voice-preview-btn lab-disconnect-btn"
											onClick={() => setShowLabDisconnect(true)}
										>
											{t("settings.labDisconnect")}
										</button>
									)}
								</div>
							</div>
						</div>
					)}

					<div className="settings-field" data-testid="slot-groups">
						<label>{t("settings.slot.groups")}</label>
						<div className="settings-hint">{t("settings.slot.groupsHint")}</div>
						<div
							style={{
								display: "grid",
								gap: 12,
								marginTop: 8,
							}}
						>
							{SLOT_GROUPS.map((group) => (
								<div
									key={group.id}
									data-testid={`slot-group-${group.id}`}
									className="settings-card"
								>
									<span className="settings-card-title">
										{t(group.labelKey as TranslationKey)}
									</span>
									<div className="settings-summary-grid">
										{group.slots.map((sid) => (
											<div
												key={sid}
												data-testid={`slot-${sid}`}
												className="settings-summary-row"
											>
												<span className="settings-summary-key">
													{t(SLOT_LABEL_KEYS[sid] as TranslationKey)}
												</span>
												{/* 슬롯 값 = 현재 상태만. 티어 추천은 아래 전용 '추천' 블록에서만
												    표시(사용자 요구: "슬롯은 현재 상태를 보여줘야해" — 상태/추천 분리). */}
												<span className="settings-summary-value">
													{slotValueDisplay(sid)}
												</span>
											</div>
										))}
									</div>
									<div
										style={{
											display: "flex",
											gap: 8,
											marginTop: 8,
											flexWrap: "wrap",
										}}
									>
										{group.id === "brain" && (
											<>
												<button
													type="button"
													className="voice-preview-btn"
													data-testid={`slot-edit-main`}
													onClick={() => setActiveSettingsTab("brain")}
												>
													{t("settings.slot.editMain")}
												</button>
												<button
													type="button"
													className="voice-preview-btn"
													data-testid={`slot-edit-models`}
													onClick={() => setActiveSettingsTab("memory")}
												>
													{t("settings.slot.editModels")}
												</button>
											</>
										)}
										{group.id === "voice" && (
											<button
												type="button"
												className="voice-preview-btn"
												data-testid={`slot-edit-voice`}
												onClick={() => setActiveSettingsTab("voice")}
											>
												{t("settings.slot.editVoice")}
											</button>
										)}
										{group.id === "avatar" && (
											<button
												type="button"
												className="voice-preview-btn"
												data-testid={`slot-edit-avatar`}
												onClick={() => setActiveSettingsTab("avatar")}
											>
												{t("settings.slot.editAvatar")}
											</button>
										)}
									</div>
								</div>
							))}
						</div>
					</div>

					{/* engine-core-summary 제거(2026-06-30): slot-groups 두뇌 그룹과 100% 중복
					    (동일 Main/Sub/Embedding + 동일 brain/memory 편집 네비). 중복 카드 정리. */}

					<div className="settings-field" data-testid="engine-gpu-summary">
						<label>{t("settings.engineGpuBudget")}</label>
						<div className="settings-hint">{t("settings.engineGpuHint")}</div>
						<div className="settings-summary-grid">
							<span>{detectedVramLabel}</span>
							<span>
								{t("settings.engineGpuProfile")}:{" "}
								{activeLocalTier
									? t(vramTierLabelKey(activeLocalTier.id))
									: t("settings.engineLocalOff")}
							</span>
							<span>
								{t("settings.engineLocalCapabilities")}:{" "}
								{activeTierCapabilities}
							</span>
							<span>{t("settings.engineRuntimeBoundary")}</span>
						</div>
					</div>

					{/* FR-1(2026-07-01): GPU 프로파일 편집을 두뇌 → 프로파일 탭으로 이관.
					    "이 기기가 어떻게 서빙하나(로컬 GPU / 원격 cascade)"는 프로파일 개념. */}
					<div className="settings-field">
						<label htmlFor="local-gpu-tier">
							{t("settings.localGpuProfile")}
						</label>
						<select
							id="local-gpu-tier"
							value={localGpuTier}
							disabled={!naiaKey}
							onChange={(e) => {
								// R3/R4/R5: 선택 = 스테이징(즉시 persist 안 함) + 로컬 슬롯 스테이징 +
								// 백엔드 warm(대기). "적용"(저장)에서 실제 앱에 커밋.
								handleSelectLocalTier(e.target.value as typeof localGpuTier);
							}}
						>
							<option value="off">{t("settings.engineLocalOff")}</option>
							<option value="auto">
								{detectedVramGb != null
									? t("settings.localGpuAutoDetected").replace(
											"{vram}",
											String(detectedVramGb),
										)
									: t("settings.localGpuAutoUnknown")}
							</option>
							{VRAM_TIERS.map((tier) => (
								<option key={tier.id} value={tier.id}>
									{t(vramTierLabelKey(tier.id))}
								</option>
							))}
						</select>
						<div className="settings-hint" data-testid="local-profile-hint">
							{!naiaKey
								? t("settings.localProfileLoginRequired")
								: activeLocalTier
									? t("settings.localGpuActiveHint").replace(
											"{capabilities}",
											tierProvidedCapabilities(activeLocalTier).join(", "),
										)
									: t("settings.localGpuHint")}
						</div>
						{/* R4: 로컬 프로파일 선택 시 백엔드 warm(대기) 상태. */}
						{naiaKey &&
							localGpuTier !== "off" &&
							(cascadeBusy || cascadeMsg) && (
								<div className="settings-hint" data-testid="local-warm-status">
									{cascadeBusy
										? `⏳ ${t("settings.cascadeBusy")}`
										: cascadeRunning
											? `✓ ${t("settings.cascadeStarted")}`
											: cascadeMsg}
								</div>
							)}
					</div>

					{/* 배타 티어(8G: 아바타 XOR 음성) 로컬 집중 택1. FR-3: 로그인 필요. */}
					{naiaKey && tierExclusive && (
						<div className="settings-field" data-testid="local-focus-select">
							<label htmlFor="local-av-focus">
								{t("settings.localFocusLabel")}
							</label>
							<select
								id="local-av-focus"
								value={localAvatarVoiceFocus}
								onChange={(e) => {
									// R3/R4/R5: 포커스 변경 = 스테이징 + 로컬 슬롯 재스테이징 + 재warm.
									handleSelectFocus(e.target.value as AvatarVoiceFocus);
								}}
							>
								<option value="avatar">{t("settings.localFocusAvatar")}</option>
								<option value="voice">{t("settings.localFocusVoice")}</option>
							</select>
							<div className="settings-hint">
								{localAvatarVoiceFocus === "avatar"
									? t("settings.localFocusAvatarHint")
									: t("settings.localFocusVoiceHint")}
							</div>
						</div>
					)}

					{/* GPU 프로파일 활성 시 VRAM 예산 내 슬롯별 로컬 추천. FR-3: 로그인 필요. */}
					{naiaKey && activeLocalTier && (
						<div className="settings-field" data-testid="tier-recommendations">
							<div className="settings-card">
								<span className="settings-card-title">
									{t("settings.tierRecommendSummary")}
								</span>
								{tierRecs.length > 0 ? (
									<div className="settings-summary-grid">
										{tierRecs.map((rec) => (
											<div
												key={rec.slot}
												className="settings-summary-row"
												data-testid={`tier-rec-${rec.slot}`}
											>
												<span className="settings-summary-key">
													{t(SLOT_LABEL_KEYS[rec.slot] as TranslationKey)}
												</span>
												<span className="settings-summary-value">
													{rec.localValue}{" "}
													<span className="slot-recommend-badge">
														{t("settings.tierRecommendLocalTag")}
													</span>
												</span>
											</div>
										))}
									</div>
								) : (
									<div className="settings-hint">
										{t("settings.tierRecommendNone")}
									</div>
								)}
							</div>
						</div>
					)}

					<div
						className="settings-field"
						data-testid="engine-capability-summary"
					>
						<label>{t("settings.engineCapabilities")}</label>
						<div className="settings-hint">
							{t("settings.engineCapabilitiesHint")}
						</div>
						<ul className="settings-summary-list">
							{capabilityStatus.map((item) => (
								<li key={item}>{item}</li>
							))}
							<li>
								{t("settings.engineSupplements")}:{" "}
								{capabilitySlots.supplements.length > 0
									? capabilitySlots.supplements.join(", ")
									: t("settings.engineNone")}
							</li>
						</ul>
					</div>
				</>
			)}
			{activeSettingsTab === "brain" && (
				<>
					<div className="settings-section-divider">
						<span>{t("settings.aiSection")}</span>
					</div>

					<div className="settings-field">
						<label htmlFor="provider-select">{t("settings.provider")}</label>
						<select
							id="provider-select"
							value={provider}
							onChange={(e) =>
								handleProviderChange(e.target.value as ProviderId)
							}
						>
							{LLM_PROVIDERS.map((p) => (
								<option key={p.id} value={p.id} disabled={p.disabled}>
									{p.name}
									{isRecommendedLocalValue(
										activeLocalTier,
										"main",
										p.id,
										localAvatarVoiceFocus,
									)
										? ` · ${t("settings.tierRecommendBadge")}`
										: ""}
								</option>
							))}
						</select>
						{slotRecommendation(
							activeLocalTier,
							"main",
							localAvatarVoiceFocus,
						) && (
							<div className="settings-hint" data-testid="main-tier-hint">
								{t("settings.tierRecommendSummary")}: ollama (
								{t("settings.tierRecommendLocalTag")})
							</div>
						)}
					</div>

					{/* API key — shown before model selector so user can enter key first */}
					{provider !== "nextain" &&
						provider !== "ollama" &&
						provider !== "vllm" &&
						provider !== "claude-code-cli" && (
							<div className="settings-field">
								<label htmlFor="apikey-input">{t("settings.apiKey")}</label>
								<input
									id="apikey-input"
									type="password"
									value={apiKey}
									onChange={(e) => {
										setApiKey(e.target.value);
										setError("");
									}}
									placeholder={
										hasStoredApiKey
											? "•••••••• (저장됨 — 변경하려면 입력)"
											: "sk-..."
									}
								/>
								{provider === "zai" && (
									<div className="settings-hint">
										Z.AI <strong>Coding Plan</strong> 구독 후 발급된 API Key를
										입력하세요.
									</div>
								)}
								{error && <div className="settings-error">{error}</div>}
							</div>
						)}

					{provider === "ollama" && (
						<div className="settings-field">
							<label>Ollama Host</label>
							<input
								type="text"
								value={ollamaHost}
								onChange={(e) => setOllamaHost(e.target.value)}
								onBlur={(e) => persistConfig({ ollamaHost: e.target.value })}
								placeholder={DEFAULT_OLLAMA_HOST}
							/>
							<div className="settings-hint">
								{ollamaConnected
									? `연결됨 — ${(dynamicModels.ollama ?? []).length}개 모델`
									: "연결 안 됨 — Ollama 서버가 실행 중인지 확인하세요"}
							</div>
							{error && <div className="settings-error">{error}</div>}
						</div>
					)}
					{provider === "vllm" && (
						<div className="settings-field">
							<label>vLLM Host</label>
							<input
								type="text"
								value={vllmHost}
								onChange={(e) => setVllmHost(e.target.value)}
								onBlur={(e) => persistConfig({ vllmHost: e.target.value })}
								placeholder={DEFAULT_VLLM_HOST}
							/>
							<div className="settings-hint">
								{vllmConnected
									? `연결됨 — ${(dynamicModels.vllm ?? []).length}개 모델`
									: "연결 안 됨 — vLLM 서버가 실행 중인지 확인하세요"}
							</div>
							{error && <div className="settings-error">{error}</div>}
						</div>
					)}

					<div className="settings-field">
						<label htmlFor="model-select">{t("settings.model")}</label>
						<select
							id="model-select"
							value={hasSelectedModel ? model : "__custom__"}
							onChange={(e) => {
								if (e.target.value === "__custom__") return;
								setModel(e.target.value);
								// UC-MODEL-SELECT contract: persist the selection immediately so the gRPC
								// agent loads THIS model. Previously only Save persisted → a stale model
								// (e.g. an omni gemini-2.5-flash-live from a prior voice session) survived.
								// Skip while a nextain login is pending (naia_auth_complete persists then).
								if (!(provider === "nextain" && !naiaKey)) {
									const nextSel = applyModelSelectionToConfig(
										loadConfig() as Record<string, unknown> | null,
										provider,
										e.target.value,
									);
									saveConfig(
										nextSel as unknown as Parameters<typeof saveConfig>[0],
									);
									void writeNaiaConfig(nextSel);
								}
								// When switching to an omni model, set default voice if not already set
								const newMeta = providerModels.find(
									(m) => m.id === e.target.value,
								);
								if (
									newMeta?.capabilities.includes("omni") &&
									newMeta.voices?.length
								) {
									const currentVoiceValid = newMeta.voices.some(
										(v) => v.id === voice,
									);
									if (!currentVoiceValid) {
										setVoice(newMeta.voices[0].id);
									}
								}
							}}
						>
							{!hasSelectedModel && model ? (
								<option value="__custom__">{`${model}${isSelectedAsr ? " 🎤" : ""} (현재값)`}</option>
							) : null}
							{providerModels
								.filter((m) => !m.capabilities.includes("asr"))
								.map((m) => (
									<option key={m.id} value={m.id}>
										{formatModelLabel(m)}
									</option>
								))}
						</select>
						<div className="settings-hint">
							{provider === "nextain" && selectedModelMeta?.pricing ? (
								<span style={{ color: "var(--accent-color, #64a0ff)" }}>
									Naia {t("settings.pricing")}:{" "}
									{selectedModelMeta.capabilities.includes("omni")
										? `$${selectedModelMeta.pricing[0].toFixed(2)}/hr`
										: `$${selectedModelMeta.pricing[0].toFixed(3)} / $${selectedModelMeta.pricing[1].toFixed(3)}`}
								</span>
							) : (
								(selectedModelMeta?.label ?? model)
							)}
						</div>
					</div>

					{/* Omni model voice selection */}
					{isSelectedOmni && omniVoices && omniVoices.length > 0 && (
						<div className="settings-field">
							<label htmlFor="omni-voice-select">
								{t("settings.naiaVoice")}
							</label>
							<div className="voice-picker">
								<select
									id="omni-voice-select"
									value={voice}
									onChange={(e) => {
										setVoice(e.target.value);
										if (existing)
											saveConfig({ ...existing, voice: e.target.value });
									}}
								>
									{omniVoices.map((v) => (
										<option key={v.id} value={v.id}>
											{v.label}
										</option>
									))}
								</select>
								<button
									type="button"
									className="voice-preview-btn"
									onClick={handleVoicePreview}
									disabled={isPreviewing}
								>
									{isPreviewing
										? t("settings.voicePreviewing")
										: t("settings.voicePreview")}
								</button>
							</div>
						</div>
					)}

					{/* Omni model: Gemini Direct mode needs Google API Key */}
					{isSelectedOmni && provider === "gemini" && (
						<div className="settings-field">
							<label htmlFor="google-apikey-input">Google API Key</label>
							<input
								id="google-apikey-input"
								type="password"
								value={googleApiKey}
								onChange={(e) => {
									setGoogleApiKey(e.target.value);
									if (existing)
										saveConfig({ ...existing, googleApiKey: e.target.value });
								}}
								placeholder="AIza..."
							/>
						</div>
					)}

					{/* Omni model: OpenAI Realtime needs API Key */}
					{isSelectedOmni && provider === "openai" && (
						<div className="settings-field">
							<label>OpenAI API Key</label>
							<input
								type="password"
								value={openaiRealtimeApiKey}
								onChange={(e) => {
									setOpenaiRealtimeApiKey(e.target.value);
									if (existing)
										saveConfig({
											...existing,
											openaiRealtimeApiKey: e.target.value,
										});
								}}
								placeholder="sk-..."
							/>
						</div>
					)}

					{/* Naia Local: address of the user's own omni-24g container.
			    Reuses the logged-in key (no key input); voice starts on the voice
			    button (lazy connect). Loopback may be ws://; remote must be wss://. */}
					{provider === "nextain" && model === "naia-local" && (
						<div className="settings-field">
							<label>{t("settings.naiaLocalUrl")}</label>
							<input
								type="text"
								value={naiaLocalUrl}
								placeholder={DEFAULT_NAIA_LOCAL_URL}
								onChange={(e) => {
									setNaiaLocalUrl(e.target.value);
									if (existing)
										saveConfig({
											...existing,
											naiaLocalUrl: e.target.value.trim() || undefined,
										});
								}}
							/>
							<span className="settings-hint">
								{t("settings.naiaLocalUrlHint")}
							</span>
						</div>
					)}

					{/* vLLM provider: voice mode uses /ws endpoint on the same host */}
					{provider === "vllm" && (
						<div className="settings-field">
							<span className="settings-hint">
								음성 버튼 → <code>ws://[vLLM Host]/ws</code> 자동 연결
								(MiniCPM-o audio output)
							</span>
						</div>
					)}

					{/* LLM options: tools + thinking (moved from general tab) */}
					<div className="settings-field settings-toggle-row">
						<label htmlFor="tools-toggle">{t("settings.enableTools")}</label>
						<input
							id="tools-toggle"
							type="checkbox"
							checked={enableTools}
							onChange={(e) => {
								setEnableTools(e.target.checked);
								persistConfig({ enableTools: e.target.checked });
							}}
						/>
					</div>
					<div className="settings-field settings-toggle-row">
						<label htmlFor="thinking-toggle">
							{t("settings.enableThinking")}
						</label>
						<input
							id="thinking-toggle"
							type="checkbox"
							checked={enableThinking}
							onChange={(e) => {
								setEnableThinking(e.target.checked);
								persistConfig({ enableThinking: e.target.checked });
							}}
						/>
					</div>

					{/* #11: 보조두뇌 (sub-LLM = memoryLlm) — 요약·사실추출용 */}
					<div className="settings-section-divider">
						<span>{t("settings.brainSubSection")}</span>
					</div>
					<div className="settings-field">
						<label>{t("settings.modelsSmallLlm")}</label>
						<div className="settings-hint">
							{t("settings.modelsSmallLlmHint")}
						</div>
						<div
							style={{
								display: "flex",
								flexDirection: "column",
								gap: "8px",
								marginTop: "4px",
							}}
						>
							{(
								[
									["none", t("settings.memoryLlmNone")],
									["naia", t("settings.memoryLlmNaia")],
									["vllm", t("settings.memoryLlmVllm")],
									["ollama", t("settings.memoryLlmOllama")],
								] as const
							).map(([val, label]) => (
								<label
									key={val}
									style={{ display: "flex", alignItems: "center", gap: "6px" }}
								>
									<input
										type="radio"
										name="memory-llm"
										value={val}
										checked={memoryLlmProvider === val}
										onChange={() => {
											setMemoryLlmProvider(val);
											persistConfig({ memoryLlmProvider: val });
										}}
									/>
									{label}
								</label>
							))}
						</div>
						{(memoryLlmProvider === "vllm" ||
							memoryLlmProvider === "ollama") && (
							<div
								style={{
									marginTop: "8px",
									display: "flex",
									flexDirection: "column",
									gap: "6px",
								}}
							>
								<input
									type="text"
									value={memoryLlmBaseUrl}
									onChange={(e) => setMemoryLlmBaseUrl(e.target.value)}
									onBlur={(e) =>
										persistConfig({ memoryLlmBaseUrl: e.target.value })
									}
									placeholder="http://localhost:8000"
								/>
								<input
									type="password"
									value={memoryLlmApiKey}
									onChange={(e) => setMemoryLlmApiKey(e.target.value)}
									placeholder={t("settings.apiKey")}
								/>
								<input
									type="text"
									value={memoryLlmModel}
									onChange={(e) => setMemoryLlmModel(e.target.value)}
									onBlur={(e) =>
										persistConfig({ memoryLlmModel: e.target.value })
									}
									placeholder={t("settings.model")}
								/>
							</div>
						)}
					</div>

					<div className="settings-actions">
						<button
							type="button"
							className="settings-save-btn"
							onClick={handleSave}
						>
							{saved ? t("settings.saved") : t("settings.save")}
						</button>
					</div>
				</>
			)}

			{activeSettingsTab === "voice" && (
				<>
					<div className="settings-section-divider">
						<span>{t("settings.voiceSection")}</span>
					</div>

					{/* TTS enable — top of voice section for visibility */}
					<div className="settings-field settings-toggle-row">
						<label htmlFor="tts-toggle">{t("settings.ttsEnabled")}</label>
						<input
							id="tts-toggle"
							type="checkbox"
							checked={ttsEnabled}
							onChange={(e) => {
								setTtsEnabled(e.target.checked);
								persistConfig({ ttsEnabled: e.target.checked });
							}}
						/>
					</div>

					{/* STT — 항상 노출(사용자 결정 2026-07-02): omni 내장 모델이어도 외부/로컬
							    STT를 옵션으로 열어둔다. 로컬 Whisper 등이 무료 STT 대비 정확도·프라이버시
							    이점(free 대비 우위). capability(needsExternalStt)는 이제 '숨김'이 아니라
							    omni일 때 '선택' 안내로만 반영. */}
					{
						<>
							{/* omni 등 음성 내장 모델일 때: STT는 '선택'임을 안내(숨기지 않음). */}
							{!capabilitySlots.needsExternalStt && (
								<div
									className="settings-field"
									data-testid="stt-omni-optional-hint"
								>
									<span className="settings-hint">
										{t("settings.sttOmniOptionalHint")}
									</span>
								</div>
							)}
							{/* Voice status summary — 외부 STT가 실제 필요한(텍스트 모델) 경우에만 설정
									    진행 사다리를 표시. omni는 STT가 '선택'이라(위 안내로 충분) sttProvider
									    기본값("nextain")과 무관하게 숨김 — "STT 설정 필요"가 '선택' 안내와 모순 방지. */}
							{capabilitySlots.needsExternalStt && (
								<div
									className="settings-field"
									data-testid="voice-status-summary"
									style={{
										fontSize: "0.85em",
										opacity: 0.8,
										lineHeight: 1.6,
									}}
								>
									{!sttProvider && (
										<div>{t("settings.voiceStatusSttNeeded")}</div>
									)}
									{sttProvider && !sttModel && (
										<div>{t("settings.voiceStatusModelNeeded")}</div>
									)}
									{sttProvider && sttModel && !ttsEnabled && (
										<div>{t("settings.voiceStatusTtsOff")}</div>
									)}
									{sttProvider && sttModel && ttsEnabled && (
										<div style={{ color: "var(--success-color, #4caf50)" }}>
											{t("settings.voiceStatusReady")}
										</div>
									)}
								</div>
							)}

							{/* STT Provider */}
							<div
								className="settings-field"
								data-testid="stt-provider-section"
							>
								<label>{t("settings.sttProvider")}</label>
								<select
									value={sttProvider}
									onChange={(e) => {
										const next = e.target.value as SttProviderId;
										setSttProvider(next);
										setSttModel("");
										persistConfig({ sttProvider: next, sttModel: "" });
									}}
								>
									<option value="">{t("settings.sttNone")}</option>
									{listSttProviders().map((p) => (
										<option
											key={p.id}
											value={p.id}
											disabled={p.requiresNaiaKey && !naiaKey}
										>
											{p.name}
											{p.pricing ? ` - ${p.pricing}` : ""}
											{p.requiresNaiaKey && !naiaKey
												? ` (${t("settings.ttsNaiaRequired")})`
												: ""}
										</option>
									))}
								</select>
							</div>
							{/* Naia Cloud STT — backend engine selector */}
							{sttProvider === "nextain" && naiaKey && (
								<div className="settings-field">
									<label>{t("settings.naiaCloudBackend")}</label>
									<select
										value={existing?.naiaCloudSttBackend ?? "google-cloud-stt"}
										onChange={(e) => {
											if (existing)
												saveConfig({
													...existing,
													naiaCloudSttBackend: e.target.value,
												});
										}}
									>
										<option value="google-cloud-stt">Google Cloud STT</option>
									</select>
								</div>
							)}
							{/* STT API key — shown for API-based providers */}
							{(() => {
								const sttMeta = listSttProviders().find(
									(p) => p.id === sttProvider,
								);
								if (sttMeta?.requiresNaiaKey && !naiaKey) {
									return (
										<div className="settings-field">
											<span className="settings-hint">
												{t("settings.ttsNaiaRequired")}
											</span>
										</div>
									);
								}
								if (sttMeta?.requiresApiKey) {
									const currentKey =
										sttMeta.apiKeyConfigField === "googleApiKey"
											? (existing?.googleApiKey ?? "")
											: sttMeta.apiKeyConfigField === "elevenlabsApiKey"
												? (existing?.elevenlabsApiKey ?? "")
												: "";
									return (
										<div className="settings-field">
											<label htmlFor="stt-api-key">
												{t("settings.sttApiKey")}
											</label>
											<input
												id="stt-api-key"
												type="password"
												defaultValue={currentKey}
												onChange={(e) => {
													if (sttMeta.apiKeyConfigField === "googleApiKey") {
														setGatewayTtsApiKey(e.target.value);
													}
												}}
												placeholder={`${sttMeta.name} API Key`}
											/>
										</div>
									);
								}
								return null;
							})()}

							{/* STT Model — current selection + manage button (offline engines only) */}
							{/* vLLM ASR: endpoint URL + ASR model picker */}
							{sttProvider === "vllm" && (
								<>
									<div className="settings-field">
										<label>vLLM STT Host</label>
										<input
											type="text"
											value={vllmSttHost}
											onChange={(e) => {
												setVllmSttHost(e.target.value);
												if (existing)
													saveConfig({
														...existing,
														vllmSttHost: e.target.value,
													});
											}}
											placeholder={DEFAULT_VLLM_HOST}
										/>
									</div>
									{(() => {
										const asrModels = vllmSttModels;
										if (asrModels.length === 0)
											return (
												<div className="settings-field">
													<span className="settings-hint">
														ASR 모델 불러오는 중... (Host URL 확인)
													</span>
												</div>
											);
										return (
											<div className="settings-field">
												<label>ASR 모델</label>
												<select
													value={existing?.vllmSttModel ?? ""}
													onChange={(e) => {
														if (existing)
															saveConfig({
																...existing,
																vllmSttModel: e.target.value,
															});
													}}
												>
													{asrModels.map((m) => (
														<option key={m.id} value={m.id}>
															{m.label} 🎤
														</option>
													))}
												</select>
											</div>
										);
									})()}
								</>
							)}

							{(sttProvider === "vosk" || sttProvider === "whisper") && (
								<div className="settings-field">
									<label>{t("settings.sttCurrentModel")}</label>
									<div
										style={{
											display: "flex",
											alignItems: "center",
											gap: "8px",
										}}
									>
										<span style={{ fontSize: "0.9em" }}>
											{sttModel
												? (sttModels.find((m) => m.modelId === sttModel)
														?.modelName ?? sttModel)
												: "—"}
										</span>
										<button
											type="button"
											className="onboarding-next-btn"
											style={{ fontSize: "0.8em", padding: "4px 12px" }}
											onClick={() => setSttModelModalOpen(true)}
										>
											{t("settings.sttManageModels")}
										</button>
									</div>
								</div>
							)}
						</>
					}

					{/* TTS Provider selector */}
					<div className="settings-field">
						<label htmlFor="tts-provider-select">
							{t("settings.ttsProvider")}
						</label>
						<select
							id="tts-provider-select"
							data-testid="gateway-tts-provider"
							value={ttsProvider}
							onChange={(e) => {
								const next = e.target.value as TtsProviderId;
								setTtsProvider(next);
								setDynamicTtsVoices([]);
								persistConfig({ ttsProvider: next });
								// Load API key for the selected provider
								if (next === "openai")
									setGatewayTtsApiKey(existing?.openaiTtsApiKey ?? "");
								else if (next === "elevenlabs")
									setGatewayTtsApiKey(existing?.elevenlabsApiKey ?? "");
								else if (next === "google")
									setGatewayTtsApiKey(existing?.googleApiKey ?? "");
								else setGatewayTtsApiKey("");
								// naia-local-voice: 임베딩 cascade(VoxCPM2)는 localhost:22600에
								// 뜸 → host 비어있으면 기본값 채움(합성이 자동으로 로컬 가리킴).
								if (next === "naia-local-voice" && !vllmTtsHost) {
									setVllmTtsHost(DEFAULT_LOCAL_VOICE_HOST);
									persistConfig({ vllmTtsHost: DEFAULT_LOCAL_VOICE_HOST });
								}
								// Reset voice to provider default
								const meta = listTtsProviderMetas().find((p) => p.id === next);
								if (meta?.voices?.[0]) {
									persistTtsVoice(meta.voices[0].id);
								} else if (next === "edge") {
									// Edge voice will be selected from gateway/hardcoded list
									persistTtsVoice("");
								} else if (next === "naia-local-voice" || next === "vllm") {
									// 로컬 음성: 고정 voice 목록 없음(클로닝). stale 클라우드 voice id 방지로
									// "default" 고정 — 음색은 RefAudioSection(ref audio)이 담당.
									persistTtsVoice("default");
								}
								// Fetch dynamic voices — use saved key or current input
								const savedKey =
									next === "openai"
										? (existing?.openaiTtsApiKey ?? "")
										: next === "elevenlabs"
											? (existing?.elevenlabsApiKey ?? "")
											: next === "google"
												? (existing?.googleApiKey ?? "")
												: "";
								const effectiveKey = savedKey || gatewayTtsApiKey;
								if (meta?.fetchVoices && effectiveKey) {
									meta.fetchVoices(effectiveKey).then((voices) => {
										if (voices && voices.length > 0) {
											setDynamicTtsVoices(voices);
											if (voices[0] && !meta.voices?.length)
												persistTtsVoice(voices[0].id);
										}
									});
								}
							}}
						>
							{listTtsProviderMetas().map((p) => (
								<option
									key={p.id}
									value={p.id}
									disabled={p.requiresNaiaKey && !naiaKey}
								>
									{p.name}
									{p.pricing ? ` - ${p.pricing}` : ""}
									{p.requiresNaiaKey && !naiaKey
										? ` (${t("settings.ttsNaiaRequired")})`
										: ""}
									{isRecommendedLocalValue(
										activeLocalTier,
										"tts",
										p.id,
										localAvatarVoiceFocus,
									)
										? ` · ${t("settings.tierRecommendBadge")}`
										: ""}
								</option>
							))}
						</select>
						{slotRecommendation(
							activeLocalTier,
							"tts",
							localAvatarVoiceFocus,
						) && (
							<div className="settings-hint" data-testid="tts-tier-hint">
								{t("settings.tierRecommendSummary")}: naia-local-voice (
								{t("settings.tierRecommendLocalTag")})
							</div>
						)}
					</div>
					{/* Naia Cloud TTS — backend engine selector */}
					{ttsProvider === "nextain" && naiaKey && (
						<div className="settings-field">
							<label>{t("settings.naiaCloudBackend")}</label>
							<select
								value={existing?.naiaCloudTtsBackend ?? "google-chirp3-hd"}
								onChange={(e) => {
									if (existing)
										saveConfig({
											...existing,
											naiaCloudTtsBackend: e.target.value,
										});
								}}
							>
								<option value="google-chirp3-hd">Google Chirp 3 HD</option>
							</select>
						</div>
					)}
					{/* TTS API key input — shown when provider requires it */}
					{(() => {
						const providerMeta = listTtsProviderMetas().find(
							(p) => p.id === ttsProvider,
						);
						if (providerMeta?.requiresApiKey) {
							return (
								<div className="settings-field">
									<label htmlFor="tts-api-key">{t("settings.ttsApiKey")}</label>
									<input
										id="tts-api-key"
										type="password"
										value={gatewayTtsApiKey}
										onChange={(e) => {
											const val = e.target.value;
											setGatewayTtsApiKey(val);
											const meta = listTtsProviderMetas().find(
												(p) => p.id === ttsProvider,
											);
											if (meta?.fetchVoices && val.length > 10) {
												meta.fetchVoices(val).then((voices) => {
													if (voices && voices.length > 0)
														setDynamicTtsVoices(voices);
												});
											}
										}}
										onPaste={(e) => {
											// Handle paste — onChange may not fire in WebKitGTK
											setTimeout(() => {
												const val = (e.target as HTMLInputElement).value;
												if (val.length > 10) {
													const meta = listTtsProviderMetas().find(
														(p) => p.id === ttsProvider,
													);
													meta?.fetchVoices?.(val).then((voices) => {
														if (voices && voices.length > 0)
															setDynamicTtsVoices(voices);
													});
												}
											}, 100);
										}}
										placeholder={`${providerMeta.name} API Key`}
									/>
								</div>
							);
						}
						if (providerMeta?.requiresNaiaKey && !naiaKey) {
							return (
								<div className="settings-field">
									<span className="settings-hint">
										{t("settings.ttsNaiaRequired")}
									</span>
								</div>
							);
						}
						return null;
					})()}
					{/* R2.2b: 로컬 cascade lifecycle 토글 — naia-os가 windows-manager
							    loader를 사이드카로 기동/중지(원격 아님). */}
					{ttsProvider === "naia-local-voice" && (
						<div className="settings-field" data-testid="cascade-toggle">
							<button
								type="button"
								className="voice-preview-btn"
								onClick={handleToggleCascade}
								disabled={cascadeBusy}
							>
								{cascadeBusy
									? t("settings.cascadeBusy")
									: cascadeRunning
										? t("settings.cascadeStop")
										: t("settings.cascadeStart")}
							</button>
							{cascadeMsg && (
								<div className="settings-hint" data-testid="cascade-msg">
									{cascadeMsg}
								</div>
							)}
						</div>
					)}

					{/* vLLM TTS: host URL input */}
					{(ttsProvider === "vllm" || ttsProvider === "naia-local-voice") && (
						<div className="settings-field">
							<label>
								{ttsProvider === "naia-local-voice"
									? "Local Voice Host"
									: "vLLM TTS Host"}
							</label>
							<input
								type="text"
								value={vllmTtsHost}
								onChange={(e) => {
									setVllmTtsHost(e.target.value);
									if (existing)
										saveConfig({
											...existing,
											vllmTtsHost: e.target.value,
										});
								}}
								placeholder={
									ttsProvider === "naia-local-voice"
										? "http://localhost:22600"
										: DEFAULT_VLLM_HOST
								}
							/>
							<div className="settings-hint">
								{ttsProvider === "naia-local-voice"
									? t("settings.localVoiceEngineHint")
									: "Free (local) — e.g. Kokoro"}
							</div>
						</div>
					)}

					{/* TTS Voice picker — dynamic based on provider */}
					{(() => {
						const providerMeta = listTtsProviderMetas().find(
							(p) => p.id === ttsProvider,
						);
						// Edge: use locale-based hardcoded voice list
						if (ttsProvider === "edge") {
							const voices = getEdgeVoicesForLocale(locale);
							return voices.length > 0 ? (
								<div className="settings-field">
									<label htmlFor="tts-voice-select">
										{t("settings.ttsVoice")}
									</label>
									<div className="voice-picker">
										<select
											id="tts-voice-select"
											data-testid="gateway-tts-voice"
											value={ttsVoice}
											onChange={(e) => persistTtsVoice(e.target.value)}
										>
											{voices.map((v) => (
												<option key={v} value={v}>
													{v}
												</option>
											))}
										</select>
										<button
											type="button"
											className="voice-preview-btn"
											onClick={handleVoicePreview}
											disabled={isPreviewing}
										>
											{isPreviewing
												? t("settings.voicePreviewing")
												: t("settings.voicePreview")}
										</button>
									</div>
								</div>
							) : null;
						}
						// Other providers: use dynamic voices (if fetched) or static registry voices
						const voiceList =
							dynamicTtsVoices.length > 0
								? dynamicTtsVoices
								: (providerMeta?.voices ?? []);
						if (voiceList.length > 0) {
							return (
								<div className="settings-field">
									<label htmlFor="tts-voice-select">
										{t("settings.ttsVoice")}
									</label>
									<div className="voice-picker">
										<select
											id="tts-voice-select"
											value={ttsVoice}
											onChange={(e) => persistTtsVoice(e.target.value)}
										>
											{voiceList.map((v) => (
												<option key={v.id} value={v.id}>
													{v.label}
												</option>
											))}
										</select>
										<button
											type="button"
											className="voice-preview-btn"
											onClick={handleVoicePreview}
											disabled={isPreviewing}
										>
											{isPreviewing
												? t("settings.voicePreviewing")
												: t("settings.voicePreview")}
										</button>
									</div>
								</div>
							);
						}
						return null;
					})()}

					{/* Voice Reference (naia-anyllm #31, plan §7) — naia-omni only */}
					{supportsRefAudio && <RefAudioSection />}

					{/* 오디오 장치 */}
					<div className="settings-section-divider">
						<span>오디오 장치</span>
					</div>

					{/* 마이크 + 스피커 2-column layout */}
					<div className="audio-device-col">
						<label>마이크 (입력 장치)</label>
						<DeviceSelect
							value={sttInputDeviceId}
							options={audioInputDevices.map((d) => ({
								value: d.deviceId,
								label:
									sanitizeDeviceLabel(d.label) ||
									`마이크 ${d.deviceId.slice(0, 8)}`,
							}))}
							onChange={(v) => {
								setSttInputDeviceId(v);
								if (existing)
									saveConfig({ ...existing, sttInputDeviceId: v || undefined });
							}}
						/>
						<div className="audio-device-test-row">
							<button
								type="button"
								className="onboarding-next-btn"
								style={{ fontSize: "0.8em", padding: "4px 12px" }}
								onClick={micTestActive ? stopMicTest : startMicTest}
							>
								{micTestActive ? "중지" : "마이크 테스트"}
							</button>
							{micTestActive && (
								<div className="mic-level-bar-outer">
									<div
										className="mic-level-bar-inner"
										style={{ width: `${Math.min(100, micTestLevel)}%` }}
									/>
								</div>
							)}
						</div>
					</div>

					<div className="audio-device-col">
						<label>스피커 (출력 장치)</label>
						<DeviceSelect
							value={ttsOutputDeviceId}
							options={audioOutputDevices.map((d) => ({
								value: d.deviceId,
								label:
									sanitizeDeviceLabel(d.label) ||
									`스피커 ${d.deviceId.slice(0, 8)}`,
							}))}
							onChange={(v) => {
								setTtsOutputDeviceId(v);
								if (existing)
									saveConfig({
										...existing,
										ttsOutputDeviceId: v || undefined,
									});
							}}
							placeholder="기본 장치"
						/>
						<button
							type="button"
							className="onboarding-next-btn"
							style={{
								fontSize: "0.8em",
								padding: "4px 12px",
								marginTop: "6px",
							}}
							onClick={playTestBeep}
						>
							스피커 테스트
						</button>
					</div>
					<div className="settings-actions">
						<button
							type="button"
							className="settings-save-btn"
							onClick={handleSave}
							disabled={selectedModelMeta?.comingSoon ?? false}
							title={
								selectedModelMeta?.comingSoon
									? t("settings.comingSoon")
									: undefined
							}
						>
							{saved ? t("settings.saved") : t("settings.save")}
						</button>
					</div>
				</>
			)}
			{activeSettingsTab === "memory" && (
				<>
					<div className="settings-section-divider">
						<span>{t("settings.modelsEmbedding")}</span>
					</div>

					{/* ── Embedding (의미검색) ── */}
					<div className="settings-field">
						<label>{t("settings.modelsEmbedding")}</label>
						<div className="settings-hint">
							{t("settings.modelsEmbeddingHint")}
						</div>
						<div
							style={{
								display: "flex",
								flexDirection: "column",
								gap: "8px",
								marginTop: "4px",
							}}
						>
							{(
								[
									["none", t("settings.memoryEmbeddingNone")],
									["offline", t("settings.memoryEmbeddingOffline")],
									["vllm", t("settings.memoryEmbeddingVllm")],
									["ollama", t("settings.memoryEmbeddingOllama")],
									["naia", t("settings.memoryEmbeddingNaia")],
								] as const
							).map(([val, label]) => (
								<label
									key={val}
									style={{ display: "flex", alignItems: "center", gap: "6px" }}
								>
									<input
										type="radio"
										name="memory-embedding"
										value={val}
										checked={memoryEmbeddingProvider === val}
										onChange={() => {
											setMemoryEmbeddingProvider(val);
											persistConfig({ memoryEmbeddingProvider: val });
										}}
									/>
									{label}
								</label>
							))}
						</div>
						{memoryEmbeddingProvider === "offline" && (
							<div style={{ marginTop: "8px" }}>
								<label>{t("settings.memoryOfflineModelSelect")}</label>
								<div
									style={{
										display: "flex",
										flexDirection: "column",
										gap: "8px",
										marginTop: "4px",
										marginBottom: "8px",
									}}
								>
									{(
										[
											[
												"all-MiniLM-L6-v2",
												t("settings.memoryOfflineModelLight"),
											],
											[
												"all-mpnet-base-v2",
												t("settings.memoryOfflineModelAccurate"),
											],
										] as const
									).map(([val, label]) => (
										<label
											key={val}
											style={{
												display: "flex",
												alignItems: "center",
												gap: "6px",
											}}
										>
											<input
												type="radio"
												name="memory-offline-model"
												value={val}
												checked={memoryOfflineModel === val}
												onChange={() => {
													setMemoryOfflineModel(val);
													persistConfig({ memoryOfflineModel: val });
												}}
											/>
											{label}
										</label>
									))}
								</div>
								<label>{t("settings.memoryEmbeddingDevice")}</label>
								<div style={{ display: "flex", gap: "12px", marginTop: "4px" }}>
									{(
										[
											["cpu", t("settings.memoryEmbeddingDeviceCpu")],
											["gpu", t("settings.memoryEmbeddingDeviceGpu")],
											["auto", t("settings.memoryEmbeddingDeviceAuto")],
										] as const
									).map(([val, label]) => (
										<label
											key={val}
											style={{
												display: "flex",
												alignItems: "center",
												gap: "6px",
											}}
										>
											<input
												type="radio"
												name="memory-embedding-device"
												value={val}
												checked={memoryEmbeddingDevice === val}
												onChange={() => {
													setMemoryEmbeddingDevice(val);
													persistConfig({ memoryEmbeddingDevice: val });
												}}
											/>
											{label}
										</label>
									))}
								</div>
								<div className="settings-hint">
									{t("settings.memoryEmbeddingDeviceHint")}
								</div>
							</div>
						)}
						{(memoryEmbeddingProvider === "vllm" ||
							memoryEmbeddingProvider === "ollama") && (
							<div
								style={{
									marginTop: "8px",
									display: "flex",
									flexDirection: "column",
									gap: "6px",
								}}
							>
								<input
									type="text"
									value={memoryEmbeddingBaseUrl}
									onChange={(e) => setMemoryEmbeddingBaseUrl(e.target.value)}
									onBlur={(e) =>
										persistConfig({ memoryEmbeddingBaseUrl: e.target.value })
									}
									placeholder="http://localhost:11434"
								/>
								<input
									type="password"
									value={memoryEmbeddingApiKey}
									onChange={(e) => setMemoryEmbeddingApiKey(e.target.value)}
									placeholder="sk-..."
								/>
								<input
									type="text"
									value={memoryEmbeddingModel}
									onChange={(e) => setMemoryEmbeddingModel(e.target.value)}
									onBlur={(e) =>
										persistConfig({ memoryEmbeddingModel: e.target.value })
									}
									placeholder="text-embedding-ada-002"
								/>
							</div>
						)}
						{/* naia 임베딩: 계정 미연결 시 안내(parity) */}
						{memoryEmbeddingProvider === "naia" && !naiaKey && (
							<div className="settings-field">
								<span className="settings-hint">
									⚠ {t("settings.memoryNaiaRequired")}
								</span>
							</div>
						)}
					</div>

					<div className="settings-actions">
						<button
							type="button"
							className="settings-save-btn"
							onClick={handleSave}
						>
							{saved ? t("settings.saved") : t("settings.save")}
						</button>
					</div>
				</>
			)}
			{activeSettingsTab === "knowledge" && <KnowledgeSettingsTab />}
			{activeSettingsTab === "skills" && <SkillsTab />}
			{activeSettingsTab === "memory" && (
				<>
					<div>
						<div className="settings-section-divider">
							<span>{t("settings.memorySection")}</span>
						</div>

						{/* Memory adapter */}
						<div className="settings-field">
							<label>{t("settings.memoryAdapter")}</label>
							<div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
								{(
									[
										["local", t("settings.memoryAdapterLocal")],
										["qdrant", t("settings.memoryAdapterQdrant")],
									] as const
								).map(([val, label]) => (
									<label
										key={val}
										style={{
											display: "flex",
											alignItems: "center",
											gap: "6px",
										}}
									>
										<input
											type="radio"
											name="memory-adapter"
											value={val}
											checked={memoryAdapter === val}
											onChange={() => {
												setMemoryAdapter(val);
												persistConfig({ memoryAdapter: val });
											}}
										/>
										{label}
									</label>
								))}
							</div>
						</div>

						{/* Qdrant fields */}
						{memoryAdapter === "qdrant" && (
							<>
								<div className="settings-field">
									<label>{t("settings.qdrantUrl")}</label>
									<input
										type="text"
										value={qdrantUrl}
										onChange={(e) => setQdrantUrl(e.target.value)}
										onBlur={(e) => persistConfig({ qdrantUrl: e.target.value })}
										placeholder="http://localhost:6333"
									/>
								</div>
								<div className="settings-field">
									<label>{t("settings.qdrantApiKey")}</label>
									<input
										type="password"
										value={qdrantApiKey}
										onChange={(e) => setQdrantApiKey(e.target.value)}
										placeholder="..."
									/>
								</div>
							</>
						)}

						{/* Backup section — 구현 검증 전까지 비활성. */}
						<div className="settings-field">
							<label>{t("settings.memoryBackup")}</label>
							<input
								type="password"
								value={backupPassword}
								onChange={(e) => setBackupPassword(e.target.value)}
								placeholder={t("settings.memoryBackupPassword")}
							/>
							<div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
								<button
									type="button"
									onClick={async () => {
										setBackupStatus("exporting");
										setBackupError("");
										try {
											const blob = await exportMemoryBackup(backupPassword);
											const url = URL.createObjectURL(
												new Blob([blob as BlobPart], {
													type: "application/octet-stream",
												}),
											);
											const a = document.createElement("a");
											a.href = url;
											a.download = "naia-memory-backup.bin";
											a.click();
											URL.revokeObjectURL(url);
											setBackupStatus("done");
											setTimeout(() => setBackupStatus("idle"), 2000);
										} catch (err) {
											setBackupStatus("error");
											setBackupError(String(err));
										}
									}}
								>
									{backupStatus === "exporting"
										? "..."
										: t("settings.memoryBackupExport")}
								</button>
								<button
									type="button"
									onClick={async () => {
										const pw = backupPassword;
										const fileInput = document.createElement("input");
										fileInput.type = "file";
										fileInput.accept = ".bin,.bak";
										fileInput.onchange = async () => {
											const file = fileInput.files?.[0];
											if (!file) return;
											setBackupStatus("importing");
											setBackupError("");
											try {
												const arrayBuffer = await file.arrayBuffer();
												await importMemoryBackup(
													new Uint8Array(arrayBuffer),
													pw,
												);
												setBackupStatus("done");
												setTimeout(() => setBackupStatus("idle"), 2000);
											} catch (err) {
												setBackupStatus("error");
												setBackupError(String(err));
											}
										};
										fileInput.click();
									}}
								>
									{backupStatus === "importing"
										? "..."
										: t("settings.memoryBackupImport")}
								</button>
							</div>
							{backupStatus === "done" && (
								<span
									className="settings-hint"
									style={{ color: "var(--success-color, #4caf50)" }}
								>
									✓
								</span>
							)}
							{backupStatus === "error" && (
								<span
									className="settings-hint"
									style={{ color: "var(--error-color, #f44336)" }}
								>
									{backupError}
								</span>
							)}
						</div>

						{/* Memory stats */}
						{facts.length > 0 && (
							<div className="settings-field">
								<span className="settings-hint">
									{t("settings.memoryStats")}:{" "}
									{t("settings.memoryFactCount").replace(
										"{{count}}",
										String(facts.length),
									)}
								</span>
							</div>
						)}

						{facts.length === 0 ? (
							<div className="settings-field">
								<span className="settings-hint">
									{t("settings.factsEmpty")}
								</span>
							</div>
						) : (
							<div className="facts-list">
								{facts.map((f) => (
									<div key={f.id} className="fact-item">
										<div className="fact-content">
											<span className="fact-key">{f.content}</span>
											{f.entities.length > 0 && (
												<span className="fact-value">
													{f.entities.join(", ")}
												</span>
											)}
										</div>
										<button
											type="button"
											className="fact-delete-btn"
											onClick={async () => {
												try {
													await deleteAgentFact(f.id);
													setFacts((prev) => prev.filter((x) => x.id !== f.id));
												} catch (err) {
													Logger.warn(
														"SettingsTab",
														"Failed to delete memory",
														{
															error: String(err),
														},
													);
												}
											}}
										>
											{t("settings.factDelete")}
										</button>
									</div>
								))}
							</div>
						)}
					</div>
					{/* qdrantApiKey needs Save (keychain write) */}
					<div className="settings-actions">
						<button
							type="button"
							className="settings-save-btn"
							onClick={handleSave}
						>
							{saved ? t("settings.saved") : t("settings.save")}
						</button>
					</div>
				</>
			)}
			{activeSettingsTab === "general" && (
				<>
					{/* Agent health check (#296) */}
					<div className="settings-field" data-testid="agent-health-section">
						<label>{t("settings.agentHealth")}</label>
						<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
							<span
								className={`agent-health-status agent-health-status--${agentHealthStatus}`}
								data-testid="agent-health-status"
							>
								{agentHealthStatus === "idle" && t("settings.agentHealthIdle")}
								{agentHealthStatus === "checking" &&
									t("settings.agentHealthChecking")}
								{agentHealthStatus === "healthy" &&
									t("settings.agentHealthHealthy")}
								{agentHealthStatus === "unhealthy" &&
									t("settings.agentHealthUnhealthy")}
							</span>
							{agentHealthCheckedAt && (
								<span
									className="agent-health-time"
									style={{
										fontSize: "0.75em",
										color: "var(--text-muted, #888)",
									}}
								>
									{agentHealthCheckedAt.toLocaleTimeString()}
								</span>
							)}
							<button
								type="button"
								className="voice-preview-btn"
								title="agent-health-check-btn"
								data-testid="agent-health-check-btn"
								onClick={async () => {
									setAgentHealthStatus("checking");
									try {
										const healthy = await invoke<boolean>("gateway_health");
										setAgentHealthStatus(healthy ? "healthy" : "unhealthy");
									} catch {
										setAgentHealthStatus("unhealthy");
									}
									setAgentHealthCheckedAt(new Date());
								}}
							>
								{t("settings.agentHealthCheck")}
							</button>
						</div>
					</div>

					{allowedToolsCount > 0 && (
						<div className="settings-field">
							<label>
								{t("settings.allowedTools")} ({allowedToolsCount})
							</label>
							<button
								type="button"
								className="voice-preview-btn"
								onClick={() => {
									clearAllowedTools();
									setAllowedToolsCount(0);
								}}
							>
								{t("settings.clearAllowedTools")}
							</button>
						</div>
					)}
				</>
			)}
			{activeSettingsTab === "general" && (
				<>
					{/* Log viewer (#297) — NAIA 계정은 profile 탭으로 이동 (#1 통합) */}
					<div className="settings-field" data-testid="log-viewer-section">
						<label>{t("settings.logViewer")}</label>
						<div
							className="lab-actions-row"
							style={{ flexWrap: "wrap", gap: "6px" }}
						>
							{(["naia.log", "llm-debug.log"] as const).map((file) => (
								<button
									key={file}
									type="button"
									className="voice-preview-btn"
									onClick={async () => {
										try {
											const logDir = await invoke<string>("get_log_dir");
											await invoke("open_log_in_editor", {
												path: `${logDir}/${file}`,
											});
										} catch (e) {
											Logger.warn("SettingsTab", "[log-viewer] open failed", {
												error: String(e),
											});
										}
									}}
								>
									{file}
								</button>
							))}
							<button
								type="button"
								className="voice-preview-btn"
								data-testid="log-viewer-btn"
								onClick={async () => {
									try {
										const logDir = await invoke<string>("get_log_dir");
										await openPath(logDir);
									} catch (e) {
										Logger.warn("SettingsTab", "[log-viewer] open failed", {
											error: String(e),
										});
									}
								}}
							>
								{t("settings.logViewerOpen")}
							</button>
						</div>
					</div>

					<div className="settings-danger-zone">
						{showResetConfirm ? (
							<div className="reset-confirm-panel">
								<p className="reset-confirm-msg">
									{t("settings.resetConfirm")}
								</p>
								<label className="reset-confirm-checkbox">
									<input
										type="checkbox"
										checked={resetClearHistory}
										onChange={(e) => setResetClearHistory(e.target.checked)}
									/>
									{t("settings.resetClearHistory")}
								</label>
								<div className="reset-confirm-actions">
									<button
										type="button"
										className="settings-reset-btn"
										onClick={executeReset}
									>
										{t("settings.resetExecute")}
									</button>
									<button
										type="button"
										className="settings-cancel-btn"
										onClick={() => {
											setShowResetConfirm(false);
										}}
									>
										{t("settings.cancel")}
									</button>
								</div>
							</div>
						) : (
							<button
								type="button"
								className="settings-reset-btn"
								onClick={handleReset}
							>
								{t("settings.reset")}
							</button>
						)}
					</div>

					<VersionFooter />

					<AboutSection />
				</>
			)}

			{/* STT Model Manager Modal — root-level (triggered from brain tab) */}
			{sttModelModalOpen && (
				<div
					className="panel-modal-overlay"
					onClick={() => setSttModelModalOpen(false)}
				>
					<div
						className="sync-dialog-card"
						style={{
							maxWidth: "520px",
							maxHeight: "85vh",
							overflow: "auto",
						}}
						onClick={(e) => e.stopPropagation()}
					>
						<h3>{t("settings.sttModelManagerTitle")}</h3>
						{sttModels
							.filter((m) => m.engine === sttProvider)
							.map((m) => (
								<div
									key={m.modelId}
									className="stt-model-row"
									style={{
										display: "flex",
										alignItems: "center",
										justifyContent: "space-between",
										gap: "8px",
										padding: "5px 0",
										borderBottom: "1px solid var(--border-color, #333)",
									}}
								>
									<div style={{ flex: 1, minWidth: 0 }}>
										<div
											style={{
												display: "flex",
												alignItems: "center",
												gap: "6px",
											}}
										>
											<input
												type="radio"
												name="stt-model-modal"
												value={m.modelId}
												checked={sttModel === m.modelId}
												disabled={!m.downloaded || !m.ready}
												onChange={() => setSttModel(m.modelId)}
											/>
											<strong style={{ fontSize: "0.9em" }}>
												{m.modelName}
											</strong>
											{m.downloaded && (
												<span
													style={{
														color: "var(--success-color, #4caf50)",
														fontSize: "0.75em",
													}}
												>
													✓
												</span>
											)}
										</div>
										<div
											style={{
												fontSize: "0.75em",
												opacity: 0.7,
												marginLeft: "22px",
											}}
										>
											{m.language === "multilingual"
												? t("settings.sttLangMultilingual")
												: m.language}{" "}
											· {m.sizeMb}MB
											{m.wer && m.wer !== "—" ? ` · WER ${m.wer}` : ""}
											{m.description &&
												` · ${
													(
														{
															"Fast, low quality. Not recommended for Korean.":
																t("settings.sttDescWhisperTiny"),
															"Similar quality to Vosk small.": t(
																"settings.sttDescWhisperBase",
															),
															"Noticeable improvement over Vosk.": t(
																"settings.sttDescWhisperSmall",
															),
															"Recommended. Good accuracy for Korean.": t(
																"settings.sttDescWhisperMedium",
															),
															"Best quality. Large download.": t(
																"settings.sttDescWhisperLarge",
															),
														} as Record<string, string>
													)[m.description] || m.description
												}`}
										</div>
									</div>
									<div style={{ flexShrink: 0, display: "flex", gap: "4px" }}>
										{!m.downloaded &&
											m.ready &&
											sttDownloading !== m.modelId && (
												<button
													type="button"
													style={{
														fontSize: "0.8em",
														padding: "2px 8px",
														cursor: "pointer",
													}}
													onClick={() => handleSttModelDownload(m.modelId)}
												>
													{t("settings.sttModelDownload")}
												</button>
											)}
										{!m.downloaded && !m.ready && (
											<span style={{ fontSize: "0.75em", opacity: 0.5 }}>
												{t("settings.sttModelNotReady")}
											</span>
										)}
										{sttDownloading === m.modelId && (
											<span style={{ fontSize: "0.8em" }}>
												{sttDownloadProgress}%
											</span>
										)}
										{m.downloaded && (
											<button
												type="button"
												style={{
													fontSize: "0.8em",
													padding: "2px 8px",
													cursor: "pointer",
													color: "var(--error-color, #f44)",
												}}
												onClick={() => handleSttModelDelete(m.modelId)}
											>
												{t("settings.sttModelDelete")}
											</button>
										)}
									</div>
								</div>
							))}
						<div className="sync-dialog-actions" style={{ marginTop: "12px" }}>
							<button
								type="button"
								className="onboarding-next-btn"
								onClick={() => setSttModelModalOpen(false)}
							>
								OK
							</button>
						</div>
					</div>
				</div>
			)}

			{syncDialogOpen && (
				<div className="sync-dialog-overlay">
					<div className="sync-dialog-card">
						<h3>{t("settings.labSyncDialog.title")}</h3>
						<p>{t("settings.labSyncDialog.message")}</p>
						<div className="sync-dialog-actions">
							<button
								type="button"
								className="onboarding-next-btn"
								onClick={handleSyncDialogApply}
							>
								{t("settings.labSyncDialog.useOnline")}
							</button>
							<button
								type="button"
								className="onboarding-back-btn"
								onClick={() => {
									setSyncDialogOpen(false);
									setSyncDialogOnlineConfig(null);
								}}
							>
								{t("settings.labSyncDialog.keepLocal")}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

function AboutSection() {
	return (
		<div className="settings-about">
			<div className="settings-section-divider">
				<span>About</span>
			</div>
			<div className="settings-about__body">
				<p className="settings-about__desc">{t("about.desc1")}</p>
				<div className="settings-about__alpha-badge">⚠ Alpha</div>
				<p className="settings-about__desc">{t("about.desc2")}</p>
				<div className="settings-about__links">
					<a
						href="https://github.com/nextain/naia-os"
						target="_blank"
						rel="noopener noreferrer"
						className="settings-about__link"
						onClick={(e) => {
							e.preventDefault();
							import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
								openUrl("https://github.com/nextain/naia-os"),
							);
						}}
					>
						{t("about.linkGithub")}
					</a>
					<a
						href="https://discord.com/invite/FGYJN7auty"
						target="_blank"
						rel="noopener noreferrer"
						className="settings-about__link"
						onClick={(e) => {
							e.preventDefault();
							import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
								openUrl("https://discord.com/invite/FGYJN7auty"),
							);
						}}
					>
						{t("about.linkDiscord")}
					</a>
					<a
						href="https://github.com/sponsors/nextain"
						target="_blank"
						rel="noopener noreferrer"
						className="settings-about__link settings-about__link--sponsor"
						onClick={(e) => {
							e.preventDefault();
							import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
								openUrl("https://github.com/sponsors/nextain"),
							);
						}}
					>
						{t("about.linkSponsor")}
					</a>
				</div>
			</div>
		</div>
	);
}

function VersionFooter() {
	const [appVersion, setAppVersion] = useState("");
	const [updateStatus, setUpdateStatus] = useState<
		"idle" | "checking" | "upToDate" | "available" | "failed"
	>("idle");
	const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

	useEffect(() => {
		import("@tauri-apps/api/app")
			.then(({ getVersion }) => getVersion())
			.then(setAppVersion)
			.catch(() => {});
	}, []);

	const handleCheckUpdate = async () => {
		setUpdateStatus("checking");
		try {
			const info = await checkForUpdate();
			if (info) {
				setUpdateInfo(info);
				setUpdateStatus("available");
			} else {
				setUpdateStatus("upToDate");
			}
		} catch {
			setUpdateStatus("failed");
		}
	};

	const handleInstall = async () => {
		if (!updateInfo) return;
		try {
			await updateInfo.installFn();
		} catch {
			setUpdateStatus("failed");
		}
	};

	return (
		<div className="version-footer">
			<span className="version-footer-text">
				{t("update.version")} {appVersion || "—"}
			</span>
			{updateStatus === "idle" && (
				<button
					type="button"
					className="version-footer-btn"
					onClick={handleCheckUpdate}
				>
					{t("update.checkNow")}
				</button>
			)}
			{updateStatus === "checking" && (
				<span className="version-footer-status">{t("update.checking")}</span>
			)}
			{updateStatus === "upToDate" && (
				<span className="version-footer-status">{t("update.upToDate")}</span>
			)}
			{updateStatus === "available" && updateInfo && (
				<button
					type="button"
					className="version-footer-btn"
					onClick={handleInstall}
				>
					{t("update.now")} ({updateInfo.version})
				</button>
			)}
			{updateStatus === "failed" && (
				<span className="version-footer-status">{t("update.failed")}</span>
			)}
		</div>
	);
}
