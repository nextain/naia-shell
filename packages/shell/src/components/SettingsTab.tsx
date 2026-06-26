import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef, useState } from "react";
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
} from "../lib/adk-store";
import {
	DEFAULT_AVATAR_MODEL,
	getDefaultTtsVoiceForAvatar,
	getDefaultVoiceForAvatar,
} from "../lib/avatar-presets";
import { syncLinkedChannels } from "../lib/channel-sync";
import {
	directToolCall,
	sendAuthUpdate,
	sendCredsUpdate,
	sendNotifyConfig,
} from "../lib/chat-service";
import {
	type AppConfig,
	DEFAULT_GATEWAY_URL,
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
	resolveConfiguredGatewayUrl,
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
import { type Locale, getLocale, setLocale, t } from "../lib/i18n";
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
	VRAM_TIERS,
	resolveActiveTier,
	tierProvidedCapabilities,
} from "../lib/capabilities/vram-tiers";
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
import { usePanelStore } from "../stores/panel";
import { clearSavedCamera } from "./AvatarCanvas";
import { RefAudioSection } from "./RefAudioSection";
import { SkillsTab } from "./SkillsTab";

const LLM_PROVIDERS = listLlmProviders();

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

	return {
		...base,
		provider: "nextain",
		model: nextModel,
		apiKey: "",
		naiaKey: nextNaiaKey,
		naiaUserId: nextNaiaUserId || undefined,
		voice: base.voice ?? getDefaultVoiceForAvatar(base.vrmModel),
	};
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

interface DeviceNode {
	nodeId: string;
	displayName?: string;
	platform?: string;
}

interface PairReq {
	requestId: string;
	nodeId: string;
	status: string;
}

function normalizeLocalPath(path: string): string {
	if (!path.startsWith("file://")) return path;
	try {
		return decodeURIComponent(new URL(path).pathname);
	} catch {
		return path.replace(/^file:\/\//, "");
	}
}

function DevicePairingSection() {
	const [nodes, setNodes] = useState<DeviceNode[]>([]);
	const [pairRequests, setPairRequests] = useState<PairReq[]>([]);
	const [loading, setLoading] = useState(false);

	const fetchDevices = useCallback(async () => {
		const config = loadConfig();
		const gatewayUrl = resolveConfiguredGatewayUrl(config);
		if (!gatewayUrl) return;
		setLoading(true);
		try {
			const [nodesRes, pairRes] = await Promise.all([
				directToolCall({
					toolName: "skill_device",
					args: { action: "node_list" },
					requestId: `dev-nodes-${Date.now()}`,
					gatewayUrl,
				}),
				directToolCall({
					toolName: "skill_device",
					args: { action: "pair_list" },
					requestId: `dev-pairs-${Date.now()}`,
					gatewayUrl,
				}),
			]);

			if (nodesRes.success && nodesRes.output) {
				const parsed = JSON.parse(nodesRes.output);
				setNodes(parsed.nodes || []);
			}
			if (pairRes.success && pairRes.output) {
				const parsed = JSON.parse(pairRes.output);
				setPairRequests(parsed.requests || []);
			}
		} catch (err) {
			Logger.warn("DevicePairing", "Failed to fetch devices", {
				error: String(err),
			});
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchDevices();
	}, [fetchDevices]);

	const handlePairAction = useCallback(
		async (requestId: string, action: "approve" | "reject") => {
			const config = loadConfig();
			const gatewayUrl = resolveConfiguredGatewayUrl(config);
			if (!gatewayUrl) return;
			try {
				await directToolCall({
					toolName: "skill_device",
					args: { action: `pair_${action}`, requestId },
					requestId: `dev-${action}-${Date.now()}`,
					gatewayUrl,
				});
				fetchDevices();
			} catch (err) {
				Logger.warn("DevicePairing", `Failed to ${action}`, {
					error: String(err),
				});
			}
		},
		[fetchDevices],
	);

	return (
		<>
			<div className="settings-section-divider">
				<span>{t("settings.deviceSection")}</span>
			</div>
			<div className="settings-field">
				<span className="settings-hint">{t("settings.deviceHint")}</span>
			</div>

			{loading ? (
				<div className="settings-field">
					<span className="settings-hint">{t("settings.deviceLoading")}</span>
				</div>
			) : (
				<>
					{/* Paired nodes */}
					{nodes.length === 0 ? (
						<div className="settings-field">
							<span className="settings-hint">{t("settings.deviceEmpty")}</span>
						</div>
					) : (
						<div className="device-nodes-list">
							{nodes.map((node) => (
								<div key={node.nodeId} className="device-node-card">
									<span className="device-node-name">
										{node.displayName || node.nodeId}
									</span>
									{node.platform && (
										<span className="device-node-platform">
											{node.platform}
										</span>
									)}
								</div>
							))}
						</div>
					)}

					{/* Pair requests */}
					{pairRequests.length > 0 && (
						<>
							<div className="settings-field">
								<label>{t("settings.devicePairRequests")}</label>
							</div>
							<div className="device-pair-requests">
								{pairRequests.map((req) => (
									<div key={req.requestId} className="device-pair-card">
										<span className="device-pair-node">{req.nodeId}</span>
										<span className="device-pair-status">
											{req.status === "pending"
												? t("settings.devicePending")
												: req.status}
										</span>
										{req.status === "pending" && (
											<div className="device-pair-actions">
												<button
													type="button"
													className="device-pair-approve"
													onClick={() =>
														handlePairAction(req.requestId, "approve")
													}
												>
													{t("settings.deviceApprove")}
												</button>
												<button
													type="button"
													className="device-pair-reject"
													onClick={() =>
														handlePairAction(req.requestId, "reject")
													}
												>
													{t("settings.deviceReject")}
												</button>
											</div>
										)}
									</div>
								))}
							</div>
						</>
					)}

					{pairRequests.length === 0 && nodes.length > 0 && (
						<div className="settings-field">
							<span className="settings-hint">
								{t("settings.deviceNoPairRequests")}
							</span>
						</div>
					)}
				</>
			)}
		</>
	);
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
		"general" | "ai" | "models" | "skills" | "memory" | "info"
	>("general");
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
	const pushModal = usePanelStore((s) => s.pushModal);
	const popModal = usePanelStore((s) => s.popModal);
	// 설정 패널이 실제로 열렸는지 — 오디오 장치 enumerate(navigator.mediaDevices)를 *기동 시*(SettingsTab 은
	// keepAlive 로 항상 마운트)가 아니라 사용자가 설정을 열 때만 실행하기 위함. getUserMedia/enumerateDevices 는
	// WebKitGTK + 일부 오디오 장치(USB Audio IEC958)에서 GstIntRange 버그로 web process 를 ~90초 동기 stall
	// 시켜 *전체 기동을 90초 막는다*(2026-06-13 실측·격리 확정). 설정 미개방 시 미디어 미접촉 = 기동 즉시.
	const isSettingsActive = usePanelStore((s) => s.activePanel === "settings");
	const storeTtsEnabled = usePanelStore((s) => s.ttsEnabled);
	const setStoreTtsEnabled = usePanelStore((s) => s.setTtsEnabled);
	const [savedVrmModel, setSavedVrmModel] = useState(
		normalizeLocalPath(existing?.vrmModel ?? DEFAULT_AVATAR_MODEL),
	);
	const [savedBgImage, setSavedBgImage] = useState(
		normalizeLocalPath(existing?.backgroundImage ?? ""),
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
	const [localGpuTier, setLocalGpuTier] = useState<
		"off" | "auto" | "external-llm-6g" | "avatar-voice-12g" | "full-local-24g"
	>(existing?.localGpuTier ?? "off");
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
	const [gatewayUrl, setGatewayUrl] = useState(existing?.gatewayUrl ?? "");
	const [gatewayToken, setGatewayToken] = useState(
		existing?.gatewayToken ?? "",
	);
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
	const [labWaiting, setLabWaiting] = useState(false);
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

	// Voice wake state
	const [voiceWakeTriggers, setVoiceWakeTriggers] = useState<string[]>([]);
	const [voiceWakeInput, setVoiceWakeInput] = useState("");
	const [voiceWakeLoading, setVoiceWakeLoading] = useState(false);
	const [voiceWakeSaved, setVoiceWakeSaved] = useState(false);
	// Discord integration — unverified, hidden until stabilized
	// const [discordBotConnected, setDiscordBotConnected] = useState(false);
	// const [discordBotLoading, setDiscordBotLoading] = useState(false);

	// In-app confirmation state (replaces window.confirm to avoid WebKitGTK double-dialog)
	const [showResetConfirm, setShowResetConfirm] = useState(false);
	const [resetClearHistory, setResetClearHistory] = useState(false);
	const [showLabDisconnect, setShowLabDisconnect] = useState(false);
	const [_showReOnboarding, _setShowReOnboarding] = useState(false);

	const fetchVoiceWake = useCallback(async () => {
		setVoiceWakeLoading(true);
		try {
			const result = await directToolCall({
				toolName: "skill_voicewake",
				args: { action: "get" },
				requestId: `vw-get-${Date.now()}`,
			});
			if (result.success && result.output) {
				const data = JSON.parse(result.output);
				setVoiceWakeTriggers(data.triggers || []);
			}
		} catch (err) {
			Logger.warn("SettingsTab", "Failed to load voice wake triggers", {
				error: String(err),
			});
		} finally {
			setVoiceWakeLoading(false);
		}
	}, []);

	// Discord integration — unverified, hidden until stabilized
	// const fetchDiscordBotStatus = useCallback(async () => { ... }, [gatewayUrl, gatewayToken]);

	useEffect(() => {
		fetchVoiceWake();
	}, [fetchVoiceWake]);

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
					usePanelStore.getState().setActivePanel(null);
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

	// Revert on unmount if not saved
	useEffect(() => {
		return () => {
			// Restore saved VRM when leaving settings without saving
			const currentVrm = useAvatarStore.getState().modelPath;
			if (currentVrm !== savedVrmModel) {
				setAvatarModelPath(savedVrmModel);
			}
			const currentBg = useAvatarStore.getState().backgroundImage;
			if (currentBg !== savedBgImage) {
				setAvatarBackgroundImage(savedBgImage);
			}
		};
	}, [
		savedVrmModel,
		savedBgImage,
		setAvatarModelPath,
		setAvatarBackgroundImage,
	]);

	function handleProviderChange(id: ProviderId) {
		setProvider(id);
		if (id !== "ollama") {
			setModel(getDefaultLlmModel(id));
		}
		setError("");
		if (id === "nextain" && !naiaKey) {
			setError("Naia 계정 로그인이 필요합니다. 먼저 Naia에 로그인하세요.");
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
		// 활성 음성 세션(naia-omni)에 새 인식 언어를 즉시 핀(재연결 없음). ChatPanel 이 수신.
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
				setError("미리듣기를 사용하려면 Naia 로그인이 필요합니다.");
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
				`TTS 미리듣기 실패: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			setIsPreviewing(false);
		}
	}

	function handleVoiceWakeAdd() {
		const trimmed = voiceWakeInput.trim();
		if (trimmed && !voiceWakeTriggers.includes(trimmed)) {
			setVoiceWakeTriggers((prev) => [...prev, trimmed]);
			setVoiceWakeInput("");
		}
	}

	function handleVoiceWakeRemove(trigger: string) {
		setVoiceWakeTriggers((prev) => prev.filter((item) => item !== trigger));
	}

	async function handleVoiceWakeSave() {
		try {
			await directToolCall({
				toolName: "skill_voicewake",
				args: { action: "set", triggers: voiceWakeTriggers },
				requestId: `vw-set-${Date.now()}`,
			});
			setVoiceWakeSaved(true);
			setTimeout(() => setVoiceWakeSaved(false), 2000);
		} catch (err) {
			Logger.warn("SettingsTab", "Failed to save voice wake triggers", {
				error: String(err),
			});
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
			setError("Naia 계정 로그인이 필요합니다. Naia 계정 연결 후 저장하세요.");
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
			customVrms: customVrms.length > 0 ? customVrms : undefined,
			customBgs: customBgs.length > 0 ? customBgs : undefined,
			backgroundImage: backgroundImage || undefined,
			backgroundVideo: backgroundVideoFilename || undefined,
			sttProvider: sttProvider || undefined,
			sttModel: sttModel || undefined,
			localGpuTier: localGpuTier !== "off" ? localGpuTier : undefined,
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
				memoryEmbeddingProvider === "offline" ? memoryEmbeddingDevice : undefined,
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
		if (resolvedApiKey) void writeAgentKey(newConfig.provider, "apiKey", resolvedApiKey);
		if (naiaKey) void writeAgentKey(newConfig.provider, "naiaKey", naiaKey);
		// #18: 메모리 비밀(embed/qdrant/llm apiKey)도 OS 키체인에 기록 — config.json 에선 strip 되므로
		// agent loadMemoryConfig 가 키체인 account(NAIA_MEMORY_*_API_KEY)로 읽는다(provider 무관 → writeAgentSecret).
		if (newConfig.memoryEmbeddingApiKey)
			void writeAgentSecret("NAIA_MEMORY_EMBED_API_KEY", newConfig.memoryEmbeddingApiKey);
		if (newConfig.qdrantApiKey)
			void writeAgentSecret("NAIA_MEMORY_QDRANT_API_KEY", newConfig.qdrantApiKey);
		if (newConfig.memoryLlmApiKey)
			void writeAgentSecret("NAIA_MEMORY_LLM_API_KEY", newConfig.memoryLlmApiKey);
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
		setSavedBgImage(backgroundImage);
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
	// #2 / FR-VRAM.2: when a local GPU tier is active (opt-in; "off" by default →
	// empty → no change), its locally-served capabilities fold in so
	// deriveSettingsSlots hides the external slots the local tier covers.
	const activeLocalTier = resolveActiveTier(localGpuTier, detectedVramGb);
	const localTierCapabilities = activeLocalTier
		? tierProvidedCapabilities(activeLocalTier)
		: [];
	const effectiveCapabilities: ModelCapability[] = Array.from(
		new Set([...baseCapabilities, ...localTierCapabilities]),
	);
	const capabilitySlots = deriveSettingsSlots(effectiveCapabilities);
	const omniVoices = selectedModelMeta?.voices;
	// Ref-audio (voice clone) only applies to naia-omni sessions — naia-* omni
	// models or a local vllm-omni server. Gemini Live is omni too but has no
	// voice-clone surface, so mounting RefAudioSection there just 404s on
	// GET /v1/ref-audio. Gate the section on this.
	const supportsRefAudio =
		isSelectedOmni && (modelIdLower.startsWith("naia-") || provider === "vllm");
	const manualUrl = `${getNaiaWebBaseUrl()}/${locale}/manual`;

	// Discord integration — unverified, hidden until stabilized
	// async function handleDiscordBotConnect() { ... }

	return (
		<div className="settings-tab">
			<div className="settings-tab-bar">
				<button
					type="button"
					className={`settings-tab-btn${activeSettingsTab === "general" ? " settings-tab-btn--active" : ""}`}
					onClick={() => setActiveSettingsTab("general")}
				>
					{t("settings.tabGeneral")}
				</button>
				<button
					type="button"
					className={`settings-tab-btn${activeSettingsTab === "ai" ? " settings-tab-btn--active" : ""}`}
					onClick={() => setActiveSettingsTab("ai")}
				>
					{t("settings.tabAI")}
				</button>
				<button
					type="button"
					className={`settings-tab-btn${activeSettingsTab === "models" ? " settings-tab-btn--active" : ""}`}
					onClick={() => setActiveSettingsTab("models")}
				>
					{t("settings.tabModels")}
				</button>
				<button
					type="button"
					className={`settings-tab-btn${activeSettingsTab === "skills" ? " settings-tab-btn--active" : ""}`}
					onClick={() => setActiveSettingsTab("skills")}
				>
					{t("settings.tabSkills")}
				</button>
				<button
					type="button"
					className={`settings-tab-btn${activeSettingsTab === "memory" ? " settings-tab-btn--active" : ""}`}
					onClick={() => setActiveSettingsTab("memory")}
				>
					{t("settings.tabMemory")}
				</button>
				<button
					type="button"
					className={`settings-tab-btn${activeSettingsTab === "info" ? " settings-tab-btn--active" : ""}`}
					onClick={() => setActiveSettingsTab("info")}
				>
					{t("settings.tabInfo")}
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

					<div className="settings-section-divider">
						<span>{t("settings.avatarSection")}</span>
					</div>

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
					</div>

					<div className="settings-field">
						<label>{t("settings.background")}</label>
						<div className="vrm-list">
							<button
								type="button"
								className={`vrm-list-item${!activeBgPath ? " vrm-list-item--active" : ""}`}
								onClick={handleClearNaiaBg}
							>
								없음 (기본)
							</button>
							{naiaBgs.length === 0 && (
								<span className="vrm-list-empty">
									naia-settings/background/ 에 파일을 추가하세요
								</span>
							)}
							{naiaBgs.map((path) => {
								const label = (path.split(/[/\\]/).pop() ?? path).replace(
									/\.[^.]+$/,
									"",
								);
								return (
									<button
										key={path}
										type="button"
										className={`vrm-list-item${activeBgPath === path ? " vrm-list-item--active" : ""}`}
										onClick={() => handleNaiaBgSelect(path)}
									>
										{label}
									</button>
								);
							})}
						</div>
					</div>

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
			{activeSettingsTab === "ai" && (
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
								</option>
							))}
						</select>
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
										saveConfig(nextSel as unknown as Parameters<typeof saveConfig>[0]);
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

					{/* Local GPU profile (#2 / FR-VRAM): detect VRAM → pick a local
					    tier; opt-in folds the tier's capabilities into the slots
					    below (hides external slots the local tier covers). Default
					    "off" = no change. Local serving runs via the separate
					    windows-manager runtime; real-time (RTF) is a measured gate. */}
					<div className="settings-field">
						<label htmlFor="local-gpu-tier">로컬 GPU 프로파일</label>
						<select
							id="local-gpu-tier"
							value={localGpuTier}
							onChange={(e) =>
								setLocalGpuTier(e.target.value as typeof localGpuTier)
							}
						>
							<option value="off">사용 안 함</option>
							<option value="auto">
								{detectedVramGb != null
									? `자동 (감지: 약 ${detectedVramGb} GB)`
									: "자동 (VRAM 미감지 — 수동 선택)"}
							</option>
							{VRAM_TIERS.map((tier) => (
								<option key={tier.id} value={tier.id}>
									{tier.label}
								</option>
							))}
						</select>
						<div className="settings-hint">
							{activeLocalTier
								? `로컬 제공 능력: ${tierProvidedCapabilities(activeLocalTier).join(", ")} · 실시간(RTF)은 측정 게이트(미보장), 로컬 실행은 windows-manager 런타임 필요`
								: "GPU VRAM 으로 로컬 아바타·음성 tier 를 선택합니다. 로컬 실행 런타임은 별도(windows-manager)이며 실시간 여부는 측정으로 결정됩니다."}
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

					{/* Voice settings — shown only when the model needs an external
					    STT and/or TTS slot (#365). omni models cover voice in+out,
					    so the section stays hidden. */}
					{capabilitySlots.showVoiceSection && (
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
									onChange={(e) => setTtsEnabled(e.target.checked)}
								/>
							</div>

							{capabilitySlots.needsExternalStt && (
								<>
									{/* STT slot — hidden when the model already covers voice
									    input (omni / ASR), shown otherwise (#365). */}
									{/* Voice status summary */}
									<div
										className="settings-field"
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

									{/* STT Provider */}
									<div className="settings-field">
										<label>{t("settings.sttProvider")}</label>
										<select
											value={sttProvider}
											onChange={(e) => {
												const next = e.target.value as SttProviderId;
												setSttProvider(next);
												// Clear model selection when switching engine type
												setSttModel("");
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
												value={
													existing?.naiaCloudSttBackend ?? "google-cloud-stt"
												}
												onChange={(e) => {
													if (existing)
														saveConfig({
															...existing,
															naiaCloudSttBackend: e.target.value,
														});
												}}
											>
												<option value="google-cloud-stt">
													Google Cloud STT
												</option>
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
															if (
																sttMeta.apiKeyConfigField === "googleApiKey"
															) {
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
							)}

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
										// Load API key for the selected provider
										if (next === "openai")
											setGatewayTtsApiKey(existing?.openaiTtsApiKey ?? "");
										else if (next === "elevenlabs")
											setGatewayTtsApiKey(existing?.elevenlabsApiKey ?? "");
										else if (next === "google")
											setGatewayTtsApiKey(existing?.googleApiKey ?? "");
										else setGatewayTtsApiKey("");
										// Reset voice to provider default
										const meta = listTtsProviderMetas().find(
											(p) => p.id === next,
										);
										if (meta?.voices?.[0]) {
											persistTtsVoice(meta.voices[0].id);
										} else if (next === "edge") {
											// Edge voice will be selected from gateway/hardcoded list
											persistTtsVoice("");
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
										</option>
									))}
								</select>
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
											<label htmlFor="tts-api-key">
												{t("settings.ttsApiKey")}
											</label>
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
							{/* vLLM TTS: host URL input */}
							{ttsProvider === "vllm" && (
								<div className="settings-field">
									<label>vLLM TTS Host</label>
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
										placeholder={DEFAULT_VLLM_HOST}
									/>
									<div className="settings-hint">
										Free (local) — e.g. Kokoro
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
						</>
					)}

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
			{activeSettingsTab === "models" && (
				<>
					<div className="settings-section-divider">
						<span>{t("settings.modelsSection")}</span>
					</div>

					{/* ── Main LLM (대화) — 상세는 AI 탭, 여기선 요약 + 이동 ── */}
					<div className="settings-field">
						<label>{t("settings.modelsMainLlm")}</label>
						<div className="settings-hint">{t("settings.modelsMainLlmHint")}</div>
						<div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" }}>
							<span style={{ fontWeight: 600 }}>{provider} / {model || "—"}</span>
							<button type="button" onClick={() => setActiveSettingsTab("ai")}>
								{t("settings.modelsEditInAi")}
							</button>
						</div>
					</div>

					{/* ── Small LLM (요약·사실추출) ── */}
					<div className="settings-field">
						<label>{t("settings.modelsSmallLlm")}</label>
						<div className="settings-hint">{t("settings.modelsSmallLlmHint")}</div>
						<div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "4px" }}>
							{(
								[
									["none", t("settings.memoryLlmNone")],
									["naia", t("settings.memoryLlmNaia")],
									["vllm", t("settings.memoryLlmVllm")],
									["ollama", t("settings.memoryLlmOllama")],
								] as const
							).map(([val, label]) => (
								<label key={val} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
									<input
										type="radio"
										name="memory-llm"
										value={val}
										checked={memoryLlmProvider === val}
										onChange={() => setMemoryLlmProvider(val)}
									/>
									{label}
								</label>
							))}
						</div>
						{(memoryLlmProvider === "vllm" || memoryLlmProvider === "ollama") && (
							<div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "6px" }}>
								<input
									type="text"
									value={memoryLlmBaseUrl}
									onChange={(e) => setMemoryLlmBaseUrl(e.target.value)}
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
									placeholder={t("settings.model")}
								/>
							</div>
						)}
					</div>

					{/* ── Embedding (의미검색) ── */}
					<div className="settings-field">
						<label>{t("settings.modelsEmbedding")}</label>
						<div className="settings-hint">{t("settings.modelsEmbeddingHint")}</div>
						<div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "4px" }}>
							{(
								[
									["none", t("settings.memoryEmbeddingNone")],
									["offline", t("settings.memoryEmbeddingOffline")],
									["vllm", t("settings.memoryEmbeddingVllm")],
									["ollama", t("settings.memoryEmbeddingOllama")],
									["naia", t("settings.memoryEmbeddingNaia")],
								] as const
							).map(([val, label]) => (
								<label key={val} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
									<input
										type="radio"
										name="memory-embedding"
										value={val}
										checked={memoryEmbeddingProvider === val}
										onChange={() => setMemoryEmbeddingProvider(val)}
									/>
									{label}
								</label>
							))}
						</div>
						{memoryEmbeddingProvider === "offline" && (
							<div style={{ marginTop: "8px" }}>
								<label>{t("settings.memoryOfflineModelSelect")}</label>
								<div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "4px", marginBottom: "8px" }}>
									{(
										[
											["all-MiniLM-L6-v2", t("settings.memoryOfflineModelLight")],
											["all-mpnet-base-v2", t("settings.memoryOfflineModelAccurate")],
										] as const
									).map(([val, label]) => (
										<label key={val} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
											<input
												type="radio"
												name="memory-offline-model"
												value={val}
												checked={memoryOfflineModel === val}
												onChange={() => setMemoryOfflineModel(val)}
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
										<label key={val} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
											<input
												type="radio"
												name="memory-embedding-device"
												value={val}
												checked={memoryEmbeddingDevice === val}
												onChange={() => setMemoryEmbeddingDevice(val)}
											/>
											{label}
										</label>
									))}
								</div>
								<div className="settings-hint">{t("settings.memoryEmbeddingDeviceHint")}</div>
							</div>
						)}
						{(memoryEmbeddingProvider === "vllm" || memoryEmbeddingProvider === "ollama") && (
							<div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "6px" }}>
								<input
									type="text"
									value={memoryEmbeddingBaseUrl}
									onChange={(e) => setMemoryEmbeddingBaseUrl(e.target.value)}
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
									placeholder="text-embedding-ada-002"
								/>
							</div>
						)}
						{/* naia 임베딩: 계정 미연결 시 안내(parity) */}
						{memoryEmbeddingProvider === "naia" && !naiaKey && (
							<div className="settings-field">
								<span className="settings-hint">⚠ {t("settings.memoryNaiaRequired")}</span>
							</div>
						)}
					</div>

					<div className="settings-actions">
						<button type="button" className="settings-save-btn" onClick={handleSave}>
							{saved ? t("settings.saved") : t("settings.save")}
						</button>
					</div>
				</>
			)}
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
											onChange={() => setMemoryAdapter(val)}
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
					{/* 메모리 설정 저장 — 다른 탭과 동일하게 handleSave 로 saveConfig(localStorage) +
					    writeNaiaConfig(naia-settings/config.json = agent 가 읽는 싱크)에 반영. */}
					<div className="settings-actions">
						<button type="button" className="settings-save-btn" onClick={handleSave}>
							{saved ? t("settings.saved") : t("settings.save")}
						</button>
					</div>
				</>
			)}
			{activeSettingsTab === "general" && (
				<>
					<div className="settings-section-divider">
						<span>{t("settings.toolsSection")}</span>
					</div>

					<div className="settings-field settings-toggle-row">
						<label htmlFor="tools-toggle">{t("settings.enableTools")}</label>
						<input
							id="tools-toggle"
							type="checkbox"
							checked={enableTools}
							onChange={(e) => setEnableTools(e.target.checked)}
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
							onChange={(e) => setEnableThinking(e.target.checked)}
						/>
					</div>

					<div className="settings-field">
						<label htmlFor="gateway-url-input">
							{t("settings.gatewayUrl")}
						</label>
						<input
							id="gateway-url-input"
							type="text"
							value={gatewayUrl}
							onChange={(e) => setGatewayUrl(e.target.value)}
							placeholder={DEFAULT_GATEWAY_URL}
						/>
					</div>

					<div className="settings-field">
						<label htmlFor="gateway-token-input">
							{t("settings.gatewayToken")}
						</label>
						<input
							id="gateway-token-input"
							type="password"
							value={gatewayToken}
							onChange={(e) => setGatewayToken(e.target.value)}
						/>
					</div>

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

					{/* Discord ID / target — managed via Channels tab & OAuth deep link */}

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

					{enableTools && (
						<>
							<div className="settings-section-divider">
								<span>{t("settings.channelsSection")}</span>
							</div>

							{/* Discord channel card — unverified, hidden until stabilized
					<div className="channel-card channel-card--full" data-testid="discord-settings-card">
						<span className="settings-hint" style={{ display: "block", marginBottom: 8 }}>{t("settings.channelsHint")}</span>
						<div className="channel-card-header">
							<span className="channel-name">Discord</span>
							<span
								className={`channel-status-badge ${discordBotConnected ? "connected" : "disconnected"}`}
								data-testid="channel-status"
							>
								{discordBotConnected
									? t("channels.connected")
									: discordBotLoading
										? "..."
										: t("channels.disconnected")}
							</span>
						</div>
						<div className="settings-field" style={{ marginBottom: 6 }}>
							<div style={{ display: "flex", gap: 8 }}>
								<button
									type="button"
									className="voice-preview-btn"
									onClick={handleDiscordBotConnect}
									disabled={discordBotLoading}
								>
									{discordBotLoading
										? t("settings.discordBotConnecting")
										: discordBotConnected
											? t("settings.discordBotReconnect")
											: t("settings.discordBotConnect")}
								</button>
								<button
									type="button"
									className="voice-preview-btn"
									onClick={() => fetchDiscordBotStatus()}
									disabled={discordBotLoading}
								>
									{t("settings.discordCheckStatus")}
								</button>
							</div>
						</div>
						<div className="settings-field">
							<label htmlFor="discord-user-id">Discord User ID</label>
							<input
								id="discord-user-id"
								type="text"
								value={discordDefaultUserId}
								onChange={(e) => setDiscordDefaultUserId(e.target.value)}
								placeholder={t("settings.discordUserIdPlaceholder")}
							/>
						</div>
						<div className="settings-field">
							<label htmlFor="discord-dm-channel-id">
								Discord DM Channel ID
							</label>
							<input
								id="discord-dm-channel-id"
								type="text"
								value={discordDmChannelId}
								onChange={(e) => setDiscordDmChannelId(e.target.value)}
								placeholder={t("settings.discordDmChannelIdPlaceholder")}
							/>
						</div>
					</div>
				*/}

							<div className="settings-section-divider">
								<span>{t("settings.voiceConversation")}</span>
							</div>
							<div className="settings-field">
								<span className="settings-hint">
									{t("settings.voiceWakeHint")}
								</span>
							</div>
							{voiceWakeLoading ? (
								<div className="settings-field">
									<span className="settings-hint">
										{t("settings.voiceWakeLoading")}
									</span>
								</div>
							) : (
								<>
									<div className="settings-field">
										<label>{t("settings.voiceWakeTriggers")}</label>
										<div
											className="voice-wake-triggers"
											data-testid="voice-wake-triggers"
										>
											{voiceWakeTriggers.map((trigger) => (
												<span key={trigger} className="voice-wake-tag">
													{trigger}
													<button
														type="button"
														className="voice-wake-tag-remove"
														onClick={() => handleVoiceWakeRemove(trigger)}
													>
														×
													</button>
												</span>
											))}
										</div>
									</div>
									<div className="settings-field voice-wake-add-row">
										<input
											type="text"
											data-testid="voice-wake-input"
											value={voiceWakeInput}
											onChange={(e) => setVoiceWakeInput(e.target.value)}
											placeholder={t("settings.voiceWakePlaceholder")}
											onKeyDown={(e) => {
												if (e.key === "Enter") handleVoiceWakeAdd();
											}}
										/>
										<button type="button" onClick={handleVoiceWakeAdd}>
											{t("settings.voiceWakeAdd")}
										</button>
									</div>
									<div className="settings-field">
										<button
											type="button"
											className="voice-preview-btn"
											data-testid="voice-wake-save"
											onClick={handleVoiceWakeSave}
										>
											{voiceWakeSaved
												? t("settings.voiceWakeSaved")
												: t("settings.voiceWakeSave")}
										</button>
									</div>
								</>
							)}
						</>
					)}

					{enableTools && <DevicePairingSection />}
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
			{activeSettingsTab === "info" && (
				<>
					<div className="settings-section-divider">
						<span>{t("settings.labSection")}</span>
					</div>

					<div className="settings-field">
						<label>
							{naiaKey
								? t("settings.labConnected")
								: t("settings.labDisconnected")}
						</label>
						{naiaKey ? (
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
											openUrl(
												`${getNaiaWebBaseUrl()}/${locale}/billing`,
											).catch(() => {})
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
																// Reset Naia-dependent STT/TTS to defaults
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
														// (gateway sync 제거됨 2026-06-12 — 죽은 gateway.json. discord 해제 시 config 는 saveConfig 로 영속.)
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
						) : (
							<button
								type="button"
								className="voice-preview-btn"
								disabled={labWaiting}
								onClick={startLabLogin}
							>
								{labWaiting
									? t("onboard.lab.waiting")
									: t("settings.labConnect")}
							</button>
						)}
					</div>
					{/* Log viewer (#297) */}
					<div className="settings-field" data-testid="log-viewer-section">
						<label>{t("settings.logViewer")}</label>
						<div
							className="lab-actions-row"
							style={{ flexWrap: "wrap", gap: "6px" }}
						>
							{(
								[
									"naia.log",
									"gateway.log",
									"node-host.log",
									"llm-debug.log",
								] as const
							).map((file) => (
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

					<div className="settings-actions">
						<button
							type="button"
							className="settings-save-btn"
							onClick={handleSave}
						>
							{saved ? t("settings.saved") : t("settings.save")}
						</button>
					</div>

					<VersionFooter />

					<AboutSection />

					{/* STT Model Manager Modal */}
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
											<div
												style={{ flexShrink: 0, display: "flex", gap: "4px" }}
											>
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
								<div
									className="sync-dialog-actions"
									style={{ marginTop: "12px" }}
								>
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
				</>
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
