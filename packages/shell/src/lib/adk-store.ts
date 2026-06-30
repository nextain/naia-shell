import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { type AppConfig, LAB_GATEWAY_URL } from "./config";
import { buildSlotsManifest, serializeSlotsManifest } from "./slots/manifest";

const ADK_PATH_KEY = "naia-adk-path";

// ── ADK Path ──────────────────────────────────────────────────────────────────

export function getAdkPath(): string | null {
	return localStorage.getItem(ADK_PATH_KEY);
}

export function setAdkPath(path: string): void {
	// Normalize: remove trailing slash/backslash
	const normalized = path.replace(/[/\\]+$/, "");
	localStorage.setItem(ADK_PATH_KEY, normalized);
	// Persist to ~/.naia/adk-path so naia-agent reads it at next spawn
	invoke("write_naia_path_cache", { adkPath: normalized }).catch(() => {
		// Non-fatal: agent falls back to ~/.naia/ paths
	});
}

export function isAdkInitialized(): boolean {
	return !!getAdkPath();
}

export function clearAdkPath(): void {
	localStorage.removeItem(ADK_PATH_KEY);
}

// ── Asset listing ─────────────────────────────────────────────────────────────

export type NaiaAssetSubdir =
	| "vrm-files"
	| "background"
	| "bgm-musics"
	| "nva-files";

/** Returns absolute file paths inside {adkPath}/naia-settings/{subdir}/ */
export async function listNaiaAssets(
	subdir: NaiaAssetSubdir,
): Promise<string[]> {
	const adkPath = getAdkPath();
	if (!adkPath) return [];
	try {
		const filenames = await invoke<string[]>("list_naia_assets", {
			adkPath,
			subdir,
		});
		const sep = adkPath.includes("\\") ? "\\" : "/";
		return filenames.map(
			(name) => `${adkPath}${sep}naia-settings${sep}${subdir}${sep}${name}`,
		);
	} catch {
		return [];
	}
}

/** Convert a local file path to an asset:// URL for use in <video>/<audio>/<img> */
export function toAssetUrl(filePath: string): string {
	return convertFileSrc(filePath);
}

const LOCAL_MIME_TYPES: Record<string, string> = {
	mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", aac: "audio/aac", flac: "audio/flac",
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
	mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
};
const BLOB_URL_EXTS = new Set(Object.keys(LOCAL_MIME_TYPES));

/**
 * Read a local file via Rust and return a blob: URL.
 * Works for images, audio, and video (IPC is local so transfer is fast).
 * Caller is responsible for revoking the returned blob URL when done.
 */
export async function toLocalBlobUrl(filePath: string): Promise<string> {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	if (!BLOB_URL_EXTS.has(ext)) {
		// Video or unknown — asset URL (may fail on Windows, no workaround without streaming)
		return convertFileSrc(filePath);
	}
	const mimeType = LOCAL_MIME_TYPES[ext];
	try {
		// Rust returns base64 to avoid JSON number-array OOM (14 MB file → ~200 MB JS heap).
		const b64 = await invoke<string>("read_local_binary", {
			path: filePath,
			allowedBase: getAdkPath() ?? "",
		});
		const raw = atob(b64);
		const bytes = new Uint8Array(raw.length);
		for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
		const blob = new Blob([bytes], { type: mimeType });
		return URL.createObjectURL(blob);
	} catch {
		return convertFileSrc(filePath);
	}
}

/** Copy bundled default assets (VRM/background/BGM) into naia-settings on first init.
 *  Rust reads from the app resource directory directly — no IPC binary transfer. */
export async function copyBundledAssets(adkPath: string): Promise<void> {
	await invoke("copy_bundled_assets", { adkPath });
}

// ── File-based config ─────────────────────────────────────────────────────────

// G-03: Secret keys — stripped from config.json (flow via OS keychain / IPC creds_update).
const SECRET_CONFIG_KEYS = new Set([
	"apiKey", "naiaKey", "googleApiKey",
	"openaiTtsApiKey", "elevenlabsApiKey", "gatewayToken", "openaiRealtimeApiKey",
	"memoryEmbeddingApiKey", "memoryLlmApiKey", "qdrantApiKey",
]);

// G-08: UI-only fields — naia-agent doesn't consume these. Stripped to prevent
// flattenConfig() from polluting process.env with THEME, PANEL_POSITION, BGM_TRACK, etc.
const UI_ONLY_CONFIG_KEYS = new Set([
	// Appearance
	"theme", "backgroundImage", "backgroundVideo", "vrmModel", "customVrms", "customBgs",
	// STT/TTS UI features
	"sttProvider", "sttModel", "naiaCloudSttBackend",
	"ttsEnabled", "ttsVoice", "ttsProvider", "naiaCloudTtsBackend", "ttsEngine",
	"ttsOutputDeviceId", "sttInputDeviceId", "vllmSttHost", "vllmSttModel", "vllmTtsHost",
	// Voice/Live UI
	"liveProvider", "liveVoice", "liveModel", "openaiRealtimeVoice", "voice", "voiceConversation",
	// Panel layout
	"panelPosition", "panelVisible", "panelSize", "deletedPanels",
	// BGM / media player state
	"bgmTrack", "bgmSource", "bgmYoutubeVideoId", "bgmYoutubeTitle",
	"bgmYoutubeChannel", "bgmYoutubeThumbnail", "bgmVolume", "bgmPlaying",
	// Gateway TTS routing (UI-side routing, not agent)
	"gatewayTtsAuto", "gatewayTtsMode",
	// Per-session Discord state
	"discordSessionMigrated", "lastProcessedDiscordMessageId",
	// Locale (agent receives per-request via IPC systemPrompt)
	"locale",
	// User display ID (not used by agent directly)
	"naiaUserId",
]);

function stripForAgent(config: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(config)) {
		if (!SECRET_CONFIG_KEYS.has(k) && !UI_ONLY_CONFIG_KEYS.has(k)) out[k] = v;
	}
	return out;
}

/**
 * Build the explicit env-var mappings that naia-agent's loadEnvAndConfig()
 * cannot derive from camelCase flattenConfig() alone.
 *
 * G-02: ollama/vllm → OPENAI_BASE_URL
 * G-05: memoryEmbeddingProvider → NAIA_EMBED_PROVIDER / NAIA_EMBED_MODEL
 * G-07: nextain → NAIA_MAIN_PROVIDER=naia (not "nextain")
 * CR-fix-1: nextain → NAIA_ANYLLM_BASE_URL (naia-agent:241 requires both KEY+URL)
 */
export function buildNaiaConfigEnv(cfg: {
	provider?: string;
	model?: string;
	ollamaHost?: string;
	vllmHost?: string;
	naiaGatewayUrl?: string;
	memoryEmbeddingProvider?: string;
	memoryEmbeddingModel?: string;
	memoryEmbeddingBaseUrl?: string;
	memoryLlmProvider?: string;
	memoryLlmModel?: string;
	memoryLlmBaseUrl?: string;
	agentName?: string;
	userName?: string;
	speechStyle?: string;
	locale?: string;
}): Record<string, string> {
	const out: Record<string, string> = {};

	// NAIA_MAIN_PROVIDER / NAIA_MAIN_MODEL — flattenConfig produces PROVIDER/MODEL,
	// not NAIA_MAIN_*. Write them explicitly so --stdio mode resolves the right branch.
	if (cfg.provider) {
		out.NAIA_MAIN_PROVIDER = cfg.provider === "nextain" ? "naia" : cfg.provider;
	}
	if (cfg.model) out.NAIA_MAIN_MODEL = cfg.model;

	// NAIA_ANYLLM_BASE_URL — naia-agent buildLLMClient() requires BOTH
	// NAIA_ANYLLM_API_KEY AND NAIA_ANYLLM_BASE_URL to activate the naia branch.
	// Without this, standalone cold-start falls through to lower-priority providers.
	if (cfg.provider === "nextain") {
		out.NAIA_ANYLLM_BASE_URL =
			cfg.naiaGatewayUrl?.trim() ||
			LAB_GATEWAY_URL;
	}

	// OPENAI_BASE_URL — agent uses this for both ollama and vllm (no-auth OpenAI-compat).
	if (cfg.provider === "ollama" && cfg.ollamaHost) {
		out.OPENAI_BASE_URL = cfg.ollamaHost.replace(/\/?$/, "/v1");
	} else if (cfg.provider === "vllm" && cfg.vllmHost) {
		out.OPENAI_BASE_URL = cfg.vllmHost.replace(/\/?$/, "/v1");
	}

	// NAIA_EMBED_PROVIDER / NAIA_EMBED_MODEL — optional; absent = OfflineEmbeddingProvider.
	const ep = cfg.memoryEmbeddingProvider;
	if (ep && ep !== "none" && ep !== "offline") {
		const embedDefaults: Record<string, string> = {
			naia: "google/text-embedding-004",
			vllm: "BAAI/bge-m3",
			ollama: "nomic-embed-text",
		};
		out.NAIA_EMBED_PROVIDER = ep;
		out.NAIA_EMBED_MODEL = cfg.memoryEmbeddingModel || embedDefaults[ep] || "";
		if (cfg.memoryEmbeddingBaseUrl) {
			out.NAIA_EMBED_BASE_URL = cfg.memoryEmbeddingBaseUrl;
		}
	}

	if (cfg.agentName) out.NAIA_AGENT_NAME = cfg.agentName;
	if (cfg.userName) out.NAIA_USER_NAME = cfg.userName;
	if (cfg.speechStyle) out.NAIA_SPEECH_STYLE = cfg.speechStyle;
	if (cfg.locale) out.NAIA_LOCALE = cfg.locale;

	if (cfg.memoryLlmProvider && cfg.memoryLlmProvider !== "none") {
		out.NAIA_LLM_PROVIDER = cfg.memoryLlmProvider;
		if (cfg.memoryLlmModel) out.NAIA_LLM_MODEL = cfg.memoryLlmModel;
		if (cfg.memoryLlmBaseUrl) out.NAIA_LLM_BASE_URL = cfg.memoryLlmBaseUrl;
	}

	return out;
}

/**
 * G-04: Map a naia-os API key field + provider → the naia-agent env var name.
 * Returns null when the provider doesn't use a keychain-storable key
 * (e.g. ollama/vllm are open, gemini routes through naia-cloud).
 */
function resolveAgentEnvKey(
	provider: string,
	keyField: "apiKey" | "naiaKey",
): string | null {
	if (keyField === "naiaKey") return "NAIA_ANYLLM_API_KEY";
	// #329 fix: `apiKey` and `naiaKey` MUST NOT map to the same env var.
	// Pre-fix, `provider === "nextain"` mapped both fields to
	// `NAIA_ANYLLM_API_KEY`, so a stale Gemini `apiKey` from an earlier
	// session would overwrite the valid `naiaKey` via the secret IPC race
	// — observed as `[오류] Unauthorized` in 2026-05-26 e2e 04 debugging.
	// nextain provider uses `naiaKey` only; the `apiKey` field is for
	// direct providers (anthropic / openai / glm) and has no meaning here.
	if (provider === "nextain") return null;
	switch (provider) {
		case "anthropic": return "ANTHROPIC_API_KEY";
		case "openai":    return "OPENAI_API_KEY";
		case "glm":       return "GLM_API_KEY";
		case "zai":       return "GLM_API_KEY"; // zai = z.ai/Zhipu GLM (config provider id) — agent 도 동일 매핑
		case "gemini":    return "GEMINI_API_KEY"; // direct Google AI Studio key (≠ nextain/Vertex). agent keychain-secret-store 거울
		case "xai":       return "XAI_API_KEY"; // grok. agent keychain-secret-store 거울 — 이게 빠져 키가 안 써져 401 났음
		default:          return null; // ollama, vllm, claude-code-cli — no persisted key (local / SDK 인증)
	}
}

/**
 * Write an API key to naia-agent's OS keychain (DPAPI/macOS Keychain/Secret Service)
 * so the standalone agent can read it on startup without a separate `naia-agent login`.
 * Silently no-ops if the provider doesn't use a keychain-storable key.
 */
export async function writeAgentKey(
	provider: string,
	keyField: "apiKey" | "naiaKey",
	value: string,
): Promise<void> {
	const adkPath = getAdkPath();
	if (!adkPath || !value) return;
	const envKey = resolveAgentEnvKey(provider, keyField);
	if (!envKey) return;
	await invoke("write_agent_key", { adkPath, envKey, value }).catch(() => {
		// Keychain write failure is non-fatal — creds_update IPC handles current session.
	});
}

/**
 * Write a non-provider-scoped secret to the agent's OS keychain under an explicit
 * account name (envKey). 메모리 비밀(embed/qdrant/llm apiKey)처럼 provider 매핑이 없는
 * 시크릿용 — config.json 에서 strip 되므로 agent 가 키체인 account(NAIA_MEMORY_*_API_KEY)로 읽는다.
 * envKey 는 alphanumeric + underscore 만(Rust write_agent_key 검증). 빈 값/adk 없음 = no-op.
 */
export async function writeAgentSecret(
	envKey: string,
	value: string,
): Promise<void> {
	const adkPath = getAdkPath();
	if (!adkPath || !value) return;
	await invoke("write_agent_key", { adkPath, envKey, value }).catch(() => {
		// Non-fatal — env fallback / next save retries.
	});
}

/**
 * provider 의 키(apiKey/naiaKey)가 *저장돼 있는지*만 확인한다(값은 안 가져옴 — 비밀을 webview 로 되읽지
 * 않는다). 근거 = naia-settings/credentials 매니페스트. Settings 가 입력란을 `*****`(저장됨)로 마스킹하는 데 사용.
 */
export async function agentKeyExists(
	provider: string,
	keyField: "apiKey" | "naiaKey",
): Promise<boolean> {
	const adkPath = getAdkPath();
	if (!adkPath) return false;
	const envKey = resolveAgentEnvKey(provider, keyField);
	if (!envKey) return false;
	return invoke<boolean>("agent_key_exists", { adkPath, envKey }).catch(() => false);
}

export async function readNaiaConfig(): Promise<Record<
	string,
	unknown
> | null> {
	const adkPath = getAdkPath();
	if (!adkPath) return null;
	try {
		const json = await invoke<string>("read_naia_config", { adkPath });
		if (!json) return null;
		return JSON.parse(json) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Cross-seam contract (UC-MODEL-SELECT): a provider/model SELECTION in the UI must
 * become the agent's persisted config — both the `model` field (read by the gRPC
 * agent on ReloadSettings/SetWorkspace) AND the NAIA_MAIN_MODEL env (stdio fallback).
 *
 * Pure on purpose: the production bug (2026-06-17) was that the model dropdown +
 * handleProviderChange only called setModel/setProvider (React state) and never
 * persisted, so the agent kept loading a stale model (e.g. an omni
 * `gemini-2.5-flash-live` left over from a prior voice session) while the UI showed
 * the newly-picked `gemini-3.1-flash-lite`. No test exercised the UI→config seam
 * (every e2e injected config via writeConfig), so it shipped silently. This function
 * is the contract anchor: given the current config + a selection, it returns the exact
 * config that must be persisted. Callers persist it via saveConfig + writeNaiaConfig.
 */
export function applyModelSelectionToConfig(
	current: Record<string, unknown> | null,
	provider: string,
	model: string,
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...(current ?? {}), provider, model };
	return { ...next, ...buildNaiaConfigEnv(next as Parameters<typeof buildNaiaConfigEnv>[0]) };
}

// ── 워크스페이스별 UI 정체성(VRM/배경/BGM) — ui-config.json (agent 미소비, env 오염 방지) ──────────
// config.json 은 agent 가 읽어 stripForAgent 로 UI키가 제거됨 → UI 설정이 전역 localStorage 에만 살아
// 워크스페이스 전환 시 복원되지 않았다(S72 버그). 이 키들을 워크스페이스별 ui-config.json 에 분리 저장/복원(FR-WS.2).
const UI_IDENTITY_KEYS = [
	"vrmModel",
	"backgroundImage",
	"backgroundVideo",
	"bgmTrack",
	"customVrms",
	"customBgs",
] as const;

function extractUiConfig(
	config: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of UI_IDENTITY_KEYS) {
		if (config[k] !== undefined) out[k] = config[k];
	}
	return out;
}

/** UI 정체성 키만 `{adkPath}/naia-settings/ui-config.json` 에 저장(FR-WS.2). 비치명. */
export async function writeNaiaUiConfig(
	config: Record<string, unknown>,
): Promise<void> {
	const adkPath = getAdkPath();
	if (!adkPath) return;
	await invoke("write_naia_ui_config", {
		adkPath,
		json: JSON.stringify(extractUiConfig(config), null, 2),
	}).catch(() => {
		/* 비치명 — 다음 저장 시 재시도 */
	});
}

/** ui-config.json 읽기(워크스페이스 전환 복원용). 없으면 null. */
export async function readNaiaUiConfig(): Promise<Record<
	string,
	unknown
> | null> {
	const adkPath = getAdkPath();
	if (!adkPath) return null;
	try {
		const json = await invoke<string>("read_naia_ui_config", { adkPath });
		if (!json) return null;
		return JSON.parse(json) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * 워크스페이스 전환 시 그 워크스페이스의 설정을 localStorage `naia-config` 로 복원(FR-WS.1/.3).
 * config.json(persona·이름·말투·locale·provider/model 등 agent 소비분) + ui-config.json(VRM/배경/BGM)
 * 을 병합. AdkSetupScreen handleLoadConfirm 과 동형(전환 경로의 비대칭 해소). reload 직전에 호출한다.
 * 누락 키는 자연히 빠져 호출측(avatar store 등)의 번들 기본값 폴백으로 떨어진다(FR-WS.3).
 */
export async function applyWorkspaceConfigToLocal(): Promise<void> {
	const adkPath = getAdkPath();
	if (!adkPath) return;
	const fileConfig = (await readNaiaConfig()) ?? {};
	const uiConfig = (await readNaiaUiConfig()) ?? {};
	const merged = {
		...fileConfig,
		...uiConfig,
		onboardingComplete: true,
		workspaceRoot: adkPath,
	};
	localStorage.setItem("naia-config", JSON.stringify(merged));
}

/**
 * R2.2a: AppConfig → slots-manifest.json write(`{adk}/naia-settings/`).
 * windows-manager loader 가 read 해 어느 로컬 서비스(VoxCPM2 등)를 띄울지 결정(Phase 2 계약).
 * 비밀(naiaKey/apiKey) 미포함 — buildSlotsManifest 가 provider/model/localUrl 만 직렬화.
 */
export async function writeSlotsManifest(
	config: AppConfig,
	detectedVramGb?: number,
): Promise<void> {
	const adkPath = getAdkPath();
	if (!adkPath) return;
	const manifest = buildSlotsManifest(config, {
		detectedVramGb,
		now: () => new Date().toISOString(),
	});
	await invoke("write_slots_manifest", {
		adkPath,
		json: serializeSlotsManifest(manifest),
	});
}

export async function writeNaiaConfig(
	config: Record<string, unknown>,
): Promise<void> {
	const adkPath = getAdkPath();
	if (!adkPath) return;
	await invoke("write_naia_config", {
		adkPath,
		json: JSON.stringify(stripForAgent(config), null, 2),
	});
	// UI 정체성(VRM/배경/BGM)은 agent 가 안 읽으므로 별도 ui-config.json 에 — 워크스페이스 전환 복원용(FR-WS.2).
	await writeNaiaUiConfig(config);
	// R2.2a: 로컬 cascade 구동 결정용 slots-manifest.json 동기화(windows-manager loader 가 read).
	// 비밀 0(buildSlotsManifest 가 provider/model 만 직렬화). 항상 config 와 동기.
	// 실패는 config 저장을 막지 않되(부가 산출물) 영구 stale 추적 위해 로깅.
	await writeSlotsManifest(config as unknown as AppConfig).catch((e) => {
		console.warn("[adk-store] slots-manifest write failed", e);
	});
	// 설정 변경(특히 provider/model)을 에이전트에 즉시 반영 — naia-settings 재로딩 후 활성 provider swap(정본 R1-2:
	// "라이브 변경 = OS 가 naia-settings 갱신 후 ReloadSettings 재호출"). gRPC=설정 기반(대화는 메시지만)이라
	// 이 트리거가 없으면 에이전트는 기동 시 config 에 고정돼 UI 모델 전환이 안 먹는다(=실측 회귀). 에이전트 미가동 시 swallow.
	try {
		await invoke("send_to_agent_command", { message: JSON.stringify({ type: "reload_settings" }) });
	} catch {
		/* 에이전트 미연결(온보딩/기동 전) — 다음 기동 시 SetWorkspace 가 로딩 */
	}
}
