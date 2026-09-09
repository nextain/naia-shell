import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
	type AppConfig,
	DERIVED_AGENT_ENV_KEYS,
	LAB_GATEWAY_URL,
	loadConfig,
	mergeBootConfig,
	saveConfig,
} from "./config";
import { Logger } from "./logger";
import { SECRET_KEYS, deleteSecretKey, getSecretKey } from "./secure-store";
import {
	type SlotsManifest,
	buildSlotsManifest,
	serializeSlotsManifest,
} from "./slots/manifest";

const ADK_PATH_KEY = "naia-adk-path";

// App starts children before the workspace-owned config files have finished
// hydrating. A child may persist a harmless UI preference during that window,
// but its incomplete bootstrap object must never replace the config SoT.
// Standalone utility/test callers never begin this gate and retain the normal
// immediate-write behavior.
let configHydrationPending = false;

export function beginNaiaConfigHydration(): void {
	configHydrationPending = true;
}

export function completeNaiaConfigHydration(): void {
	configHydrationPending = false;
}

export function isNaiaConfigHydrationPending(): boolean {
	return configHydrationPending;
}

// ── ADK Path ──────────────────────────────────────────────────────────────────

export function getAdkPath(): string | null {
	return localStorage.getItem(ADK_PATH_KEY);
}

export async function setAdkPath(path: string): Promise<void> {
	// Normalize: remove trailing slash/backslash
	const normalized = path.replace(/[/\\]+$/, "");
	localStorage.setItem(ADK_PATH_KEY, normalized);
	// config.workspaceRoot is defined as an adkPath mirror (see config.ts). The
	// two used to drift: onboarding's AdkSetupScreen writes only the adk path,
	// while a stale config.workspaceRoot could survive a partial reset — and
	// WorkspaceCenterArea prefers config.workspaceRoot, so the old repo (e.g.
	// the dev-detected alpha-adk) kept winning over the freshly selected path.
	// Mirror the value here so no caller can leave the two SoTs inconsistent.
	const cfg = loadConfig();
	if (cfg && cfg.workspaceRoot !== normalized) {
		saveConfig({ ...cfg, workspaceRoot: normalized });
	}
	// Persist to ~/.naia/adk-path. Native restarts/rebinds an already-running
	// agent when this changes, so setup must await completion before continuing.
	await invoke("write_naia_path_cache", { adkPath: normalized });
	// The workspace app is keepAlive and mounts during onboarding, before the
	// user has picked a workspace. Announce the new binding so it re-reads the
	// path and re-runs workspace_set_root instead of staying on whatever it
	// auto-detected first (the dev cwd). #447-6.
	if (typeof window !== "undefined") {
		window.dispatchEvent(
			new CustomEvent("naia-adk-path-changed", { detail: normalized }),
		);
	}
}

export function isAdkInitialized(): boolean {
	return !!getAdkPath();
}

export function clearAdkPath(): void {
	localStorage.removeItem(ADK_PATH_KEY);
}

/**
 * Forget only the selected workspace binding. The workspace and its settings
 * remain untouched; the next launch returns to the ADK setup screen.
 */
export async function resetAdkPathBinding(): Promise<void> {
	await invoke("clear_naia_path_cache");
	clearAdkPath();
	const cfg = loadConfig();
	if (cfg?.workspaceRoot !== undefined) {
		saveConfig({ ...cfg, workspaceRoot: undefined });
	}
}

/**
 * Reset only persisted application configuration. Workspace assets and
 * knowledge remain intact; credentials are removed from the secure store.
 * The bootstrap pointer is cleared last so a failed native/secure-store reset
 * remains retryable from the same workspace instead of silently resurrecting
 * a partial configuration on the next launch.
 */
export async function resetNaiaPersistedSettings(): Promise<void> {
	const adkPath = getAdkPath();
	if (adkPath) {
		await invoke("reset_naia_config_files", { adkPath });
	}
	await Promise.all(SECRET_KEYS.map((key) => deleteSecretKey(key)));
	localStorage.removeItem("naia-config");
	clearAdkPath();
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
	mp3: "audio/mpeg",
	ogg: "audio/ogg",
	wav: "audio/wav",
	aac: "audio/aac",
	flac: "audio/flac",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
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
	"apiKey",
	"naiaKey",
	"googleApiKey",
	"openaiTtsApiKey",
	"elevenlabsApiKey",
	"gatewayToken",
	"openaiRealtimeApiKey",
	"memoryEmbeddingApiKey",
	"memoryLlmApiKey",
	"subLlmApiKey",
	"qdrantApiKey",
]);

// G-08: UI-only fields — naia-agent doesn't consume these. Stripped to prevent
// flattenConfig() from polluting process.env with THEME, APP_POSITION, BGM_TRACK, etc.
const UI_ONLY_CONFIG_KEYS = new Set([
	// UI-local preferences are grouped by the shell so individual screens can
	// migrate their legacy localStorage keys without adding agent fields.
	"uiPreferences",
	// Appearance
	"theme",
	"backgroundImage",
	"backgroundVideo",
	"vrmModel",
	"avatarProvider",
	"nvaModel",
	"customVrms",
	"customBgs",
	// Settings presentation preferences
	"modelSortMode",
	// STT/TTS UI features
	"sttProvider",
	"sttModel",
	"naiaCloudSttBackend",
	"ttsEnabled",
	"ttsVoice",
	"ttsProvider",
	"naiaCloudTtsBackend",
	"ttsEngine",
	"ttsOutputDeviceId",
	"sttInputDeviceId",
	"vllmSttHost",
	"vllmSttModel",
	"vllmTtsHost",
	// Voice/Live UI
	"liveProvider",
	"liveVoice",
	"liveModel",
	"openaiRealtimeVoice",
	"voice",
	"voiceConversation",
	// App layout
	"appPosition",
	"appVisible",
	"appSize",
	"deletedApps",
	// BGM / media player state
	"bgmTrack",
	"bgmSource",
	"bgmYoutubeVideoId",
	"bgmYoutubeTitle",
	"bgmYoutubeChannel",
	"bgmYoutubeThumbnail",
	"bgmYoutubeBackgroundVideo",
	"bgmVolume",
	"bgmPlaying",
	// Opt-in proactive speech profile (shell configures agent at startup)
	"proactiveSpeechProfile",
	"proactiveSpeechPermitted",
	"proactiveSpeechIdleMs",
	"proactiveSpeechIntervalMs",
	"proactiveSpeechTimezone",
	"proactiveSpeechBgmAutoPlay",
	"proactiveSpeechWeatherConsented",
	"proactiveSpeechWeatherLatitude",
	"proactiveSpeechWeatherLongitude",
	"proactiveSpeechKnowledgeScope",
	// Gateway TTS routing (UI-side routing, not agent)
	"gatewayTtsAuto",
	"gatewayTtsMode",
	// Per-session Discord state
	"discordSessionMigrated",
	"lastProcessedDiscordMessageId",
	// Locale (agent receives per-request via IPC systemPrompt)
	"locale",
	// User display ID (not used by agent directly)
	"naiaUserId",
]);

// #515 — agent 는 chat_request 의 provider 를 받지 않는다(grpc-codec "provider 제거=정본").
// 활성 provider 는 오로지 이 config.json 의 llmRoles.main 으로 재구성되는데, openai 커스텀
// 호스트는 최상위 openaiBaseUrl 에만 저장돼 main.baseUrl 이 비면 채팅이 기본 api.openai.com
// 으로 샌다(모델 목록만 새 호스트를 보는 실측 결함). 기록 직전에 main role 로 동기화한다.
// URL 정규화는 이 파일의 OPENAI_BASE_URL env 규칙(중복 /v1 방지)과 동일해야 한다.
export function syncMainRoleOpenAiBaseUrl(
	agentConfig: Record<string, unknown>,
): void {
	const roles =
		agentConfig.llmRoles && typeof agentConfig.llmRoles === "object"
			? (agentConfig.llmRoles as Record<string, unknown>)
			: {};
	const main =
		roles.main && typeof roles.main === "object"
			? (roles.main as Record<string, string>)
			: {};
	if (main.inherit) return; // 상속 마커는 건드리지 않는다(agent 가 별도 해석)
	const provider =
		main.provider ??
		(typeof agentConfig.provider === "string" ? agentConfig.provider : undefined);
	if (provider !== "openai") return;
	const raw =
		typeof agentConfig.openaiBaseUrl === "string"
			? agentConfig.openaiBaseUrl.trim()
			: "";
	if (raw) {
		main.baseUrl = `${raw.replace(/\/+$/, "").replace(/\/v1$/i, "")}/v1`;
	} else {
		// 커스텀 호스트를 지웠으면 main role 의 화석 baseUrl 도 지워 공식 endpoint 로 복귀시킨다.
		delete main.baseUrl;
		if (Object.keys(main).length === 0) return;
	}
	if (!main.provider) main.provider = provider;
	if (
		!main.model &&
		typeof agentConfig.model === "string" &&
		agentConfig.model
	)
		main.model = agentConfig.model;
	roles.main = main;
	agentConfig.llmRoles = roles;
}

function stripForAgent(
	config: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(config)) {
		if (
			SECRET_CONFIG_KEYS.has(k) ||
			UI_ONLY_CONFIG_KEYS.has(k) ||
			DERIVED_AGENT_ENV_KEYS.has(k)
		)
			continue;
		if (k === "llmRoles" && v && typeof v === "object" && !Array.isArray(v)) {
			const roles: Record<string, unknown> = {};
			for (const role of ["expert", "main", "sub", "memory"]) {
				const raw = (v as Record<string, unknown>)[role];
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
				const source = raw as Record<string, unknown>;
				const clean: Record<string, string> = {};
				for (const field of [
					"provider",
					"model",
					"baseUrl",
					"credentialRef",
					"inherit",
				]) {
					if (typeof source[field] === "string" && source[field])
						clean[field] = source[field] as string;
				}
				if (Object.keys(clean).length) roles[role] = clean;
			}
			out[k] = roles;
			continue;
		}
		out[k] = v;
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
	openaiBaseUrl?: string;
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
		out.NAIA_ANYLLM_BASE_URL = cfg.naiaGatewayUrl?.trim() || LAB_GATEWAY_URL;
	}

	// OPENAI_BASE_URL is scoped to the active provider so a saved host can never leak.
	if (cfg.provider === "openai" && cfg.openaiBaseUrl?.trim()) {
		out.OPENAI_BASE_URL = `${cfg.openaiBaseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "")}/v1`;
	} else if (cfg.provider === "ollama" && cfg.ollamaHost) {
		out.OPENAI_BASE_URL = `${cfg.ollamaHost.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`;
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
		case "anthropic":
			return "ANTHROPIC_API_KEY";
		case "openai":
			return "OPENAI_API_KEY";
		case "glm":
			return "GLM_API_KEY";
		case "zai":
			return "GLM_API_KEY"; // zai = z.ai/Zhipu GLM (config provider id) — agent 도 동일 매핑
		case "gemini":
			return "GEMINI_API_KEY"; // direct Google AI Studio key (≠ nextain/Vertex). agent keychain-secret-store 거울
		case "xai":
			return "XAI_API_KEY"; // grok. agent keychain-secret-store 거울 — 이게 빠져 키가 안 써져 401 났음
		case "ollama":
			return "OPENAI_API_KEY"; // remote/authenticated Ollama uses the OpenAI-compatible client
		default:
			return null; // vllm, claude-code-cli, codex, grok — no persisted key (local / CLI 로그인)
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
	await writeAgentKeyStrict(provider, keyField, value).catch(() => {
		// Best-effort callers still have an in-process creds_update fallback.
	});
}

/**
 * Persist a provider credential for flows that cannot report completion until
 * the standalone Agent can recover the same credential after a restart.
 */
export async function writeAgentKeyStrict(
	provider: string,
	keyField: "apiKey" | "naiaKey",
	value: string,
): Promise<void> {
	const adkPath = getAdkPath();
	if (!adkPath) throw new Error("ADK path is not configured");
	if (!value) throw new Error("Agent credential is empty");
	const envKey = resolveAgentEnvKey(provider, keyField);
	if (!envKey) return;
	await invoke("write_agent_key", { adkPath, envKey, value });
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
	return invoke<boolean>("agent_key_exists", { adkPath, envKey }).catch(
		() => false,
	);
}

/**
 * Reads the workspace configuration file.  A workspace may be in the middle of
 * first-run creation, so callers must treat this as a partial configuration and
 * provide their own required-field defaults before using it as an AppConfig.
 */
function resolveAdkPath(adkPathOverride?: string | null): string | null {
	return adkPathOverride === undefined ? getAdkPath() : adkPathOverride;
}

function parsePersistedConfig<T extends object>(
	command: string,
	json: unknown,
): T | null {
	if (typeof json !== "string") {
		throw new Error(`${command}_invalid_response`);
	}
	if (json.trim() === "") return null;
	const parsed: unknown = JSON.parse(json);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${command}_invalid_json`);
	}
	return parsed as T;
}

export async function readNaiaConfig(
	adkPathOverride?: string | null,
): Promise<Partial<AppConfig> | null> {
	const adkPath = resolveAdkPath(adkPathOverride);
	if (!adkPath) return null;
	const json = await invoke<unknown>("read_naia_config", { adkPath });
	return parsePersistedConfig<Partial<AppConfig>>("read_naia_config", json);
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
	const previousRoles = current?.llmRoles;
	const roles =
		previousRoles &&
		typeof previousRoles === "object" &&
		!Array.isArray(previousRoles)
			? (previousRoles as Record<string, unknown>)
			: {};
	const previousMain = roles.main;
	const main =
		previousMain &&
		typeof previousMain === "object" &&
		!Array.isArray(previousMain)
			? (previousMain as Record<string, unknown>)
			: {};
	// A provider/model switch is an immediate main-role edit too. Keeping only
	// the legacy flat fields here was the stale-main-provider seam that made
	// the UI and the reloaded agent disagree until a later Apply click.
	const next: Record<string, unknown> = {
		...(current ?? {}),
		provider,
		model,
		llmRoles: { ...roles, main: { ...main, provider, model } },
	};
	return {
		...next,
		...buildNaiaConfigEnv(next as Parameters<typeof buildNaiaConfigEnv>[0]),
	};
}

// ── 워크스페이스별 UI 정체성(VRM/배경/BGM) — ui-config.json (agent 미소비, env 오염 방지) ──────────
// config.json 은 agent 가 읽어 stripForAgent 로 UI키가 제거됨 → UI 설정이 전역 localStorage 에만 살았다.
// "localStorage = adkPath 뿐" (UC-CONFIG-SOT / FR-CONFIG-SOT.4) 를 지키려면 **config.json 에서 strip 하는
// UI 키 = ui-config.json 에 저장하는 키** 가 일치해야 한다 — 안 그러면 어느 파일에도 SoT 가 없는 키
// (vllmTtsHost·theme·appPosition 등)가 부팅 시 기본값으로 리셋된다(로컬 보이스 호스트 저장 안 됨 회귀).
// 따라서 ui-config.json 에는 `UI_ONLY_CONFIG_KEYS` 전체를 저장하되, **영속 부적절한 세션/휘발 상태만 제외**한다.
const UI_SESSION_ONLY_KEYS = new Set<string>([
	// Per-session Discord state — 워크스페이스 정체성 아님, 세션마다 갱신.
	"discordSessionMigrated",
	"lastProcessedDiscordMessageId",
	// 미디어 재생 중 여부 — 휘발 UI 상태(다음 실행에 이어서 재생하지 않는다).
	"bgmPlaying",
]);

/** ui-config.json 에 저장할 UI 키 = UI_ONLY 전체 − 세션/휘발 상태. */
const UI_PERSIST_KEYS: readonly string[] = [...UI_ONLY_CONFIG_KEYS].filter(
	(k) => !UI_SESSION_ONLY_KEYS.has(k),
);

/**
 * Applies a UI-config patch without treating an omitted key as a delete.
 *
 * During boot several independent UI components persist their own small state
 * (for example BGM volume).  Those callers do not necessarily have the fully
 * hydrated configuration yet.  Replacing ui-config.json with that subset
 * erased the selected NVA and local voice host.  An own property with
 * `undefined` remains an explicit delete, so Settings can still clear a
 * persisted choice deliberately.
 */
function mergeUiConfigPatch(
	persisted: Record<string, unknown> | null,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const next = { ...(persisted ?? {}) };
	for (const key of UI_PERSIST_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
		if (patch[key] === undefined) {
			delete next[key];
		} else {
			next[key] = patch[key];
		}
	}
	return next;
}

/** UI 정체성 키만 `{adkPath}/naia-settings/ui-config.json` 에 저장(FR-WS.2). */
async function writeNaiaUiConfigNow(
	config: Record<string, unknown>,
	adkPathOverride?: string | null,
): Promise<boolean> {
	const adkPath = resolveAdkPath(adkPathOverride);
	if (!adkPath) return false;
	try {
		// Preserve existing selections when a caller supplies only the UI fields it
		// owns. An empty file is a valid first-run state; I/O and malformed data
		// return false here so the enclosing config transaction can reject it.
		const json = JSON.stringify(
			mergeUiConfigPatch(await readNaiaUiConfig(adkPath), config),
			null,
			2,
		);
		await invoke("write_naia_ui_config", {
			adkPath,
			json,
		});
		return true;
	} catch {
		return false;
	}
}

/** Serialize standalone UI patches with full config writes. */
export function writeNaiaUiConfig(
	config: Record<string, unknown>,
	adkPathOverride?: string | null,
): Promise<boolean> {
	if (configHydrationPending) return Promise.resolve(false);
	const configSnapshot = snapshotConfig(config);
	const adkPath = resolveAdkPath(adkPathOverride);
	const operation = naiaConfigWriteTail.then(() =>
		writeNaiaUiConfigNow(configSnapshot, adkPath),
	);
	naiaConfigWriteTail = operation.then(
		() => undefined,
		() => undefined,
	);
	return operation;
}

/** ui-config.json 읽기(워크스페이스 전환 복원용). 없으면 null. */
export async function readNaiaUiConfig(
	adkPathOverride?: string | null,
): Promise<Record<string, unknown> | null> {
	const adkPath = resolveAdkPath(adkPathOverride);
	if (!adkPath) return null;
	const json = await invoke<unknown>("read_naia_ui_config", { adkPath });
	return parsePersistedConfig<Record<string, unknown>>(
		"read_naia_ui_config",
		json,
	);
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
	const fileConfig = (await readNaiaConfig(adkPath)) ?? {};
	const uiConfig = (await readNaiaUiConfig(adkPath)) ?? {};
	const merged = {
		...(mergeBootConfig(null, fileConfig, uiConfig) ?? {}),
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
let slotsManifestWriteTail: Promise<void> = Promise.resolve();

async function writeSlotsManifestNow(
	config: AppConfig,
	detectedVramGb?: number,
	adkPathOverride?: string | null,
): Promise<SlotsManifest | null> {
	const adkPath = resolveAdkPath(adkPathOverride);
	if (!adkPath) return null;
	// ★tier 해석(buildSlotsManifest 가 "auto" → 해석된 id 로)에 VRAM 이 필요.
	// 호출처가 vram 을 안 넘기면 자체 감지(detect_gpu_vram IPC) — 모든 write 경로가
	// Record the resolved voice-only loader tier in the manifest.
	let vram = detectedVramGb;
	if (vram === undefined) {
		try {
			const { detectGpuVramGb } = await import("./capabilities/gpu");
			vram = (await detectGpuVramGb()) ?? undefined;
		} catch {
			/* IPC 미가용(온보딩 전 등) — tier 미해석, loader 가 --gpu 로 폴백 */
		}
	}
	const manifest = buildSlotsManifest(config, {
		detectedVramGb: vram,
		now: () => new Date().toISOString(),
	});
	await invoke("write_slots_manifest", {
		adkPath,
		json: serializeSlotsManifest(manifest),
	});
	return manifest;
}

/** Serialize native manifest writes so hydration, profile restore, and logout
 * cannot race and leave an older account/tier snapshot on disk. */
export function writeSlotsManifest(
	config: AppConfig,
	detectedVramGb?: number,
	adkPathOverride?: string | null,
): Promise<SlotsManifest | null> {
	const configSnapshot = snapshotConfig(config);
	const adkPath = resolveAdkPath(adkPathOverride);
	const operation = slotsManifestWriteTail.then(() =>
		writeSlotsManifestNow(configSnapshot, detectedVramGb, adkPath),
	);
	slotsManifestWriteTail = operation.then(
		() => undefined,
		() => undefined,
	);
	return operation;
}

let naiaConfigWriteTail: Promise<void> = Promise.resolve();

function snapshotConfig<T>(config: T): T {
	if (Array.isArray(config)) {
		return config.map((item) => snapshotConfig(item)) as T;
	}
	if (config && typeof config === "object") {
		const snapshot: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(config)) {
			snapshot[key] = snapshotConfig(value);
		}
		return snapshot as T;
	}
	return config;
}

async function writeNaiaConfigNow(
	config: Record<string, unknown>,
	adkPath: string | null,
): Promise<void> {
	if (!adkPath) return;
	const publicAgentConfig = stripForAgent(config);
	syncMainRoleOpenAiBaseUrl(publicAgentConfig); // #515
	const normalizedAgentConfig = {
		...publicAgentConfig,
		...buildNaiaConfigEnv(
			publicAgentConfig as Parameters<typeof buildNaiaConfigEnv>[0],
		),
	};
	const normalizedAgentConfigJson = JSON.stringify(
		normalizedAgentConfig,
		null,
		2,
	);
	await invoke("write_naia_config", {
		adkPath,
		json: normalizedAgentConfigJson,
	});
	// UI 정체성(VRM/배경/BGM)은 agent 가 안 읽으므로 별도 ui-config.json 에 — 워크스페이스 전환 복원용(FR-WS.2).
	if (!(await writeNaiaUiConfigNow(config, adkPath))) {
		throw new Error("ui-config write failed");
	}
	// R2.2a: 로컬 cascade 구동 결정용 slots-manifest.json 동기화(windows-manager loader 가 read).
	// 비밀 0(buildSlotsManifest 가 provider/model 만 직렬화). 항상 config 와 동기.
	// 실패는 config 저장을 막지 않되(부가 산출물) 영구 stale 추적 위해 로깅.
	// The public config intentionally omits naiaKey. Restore only its presence for
	// the derived member gate; buildSlotsManifest never serializes the credential.
	// Without this, any ordinary UI-config sync overwrites a valid member manifest
	// with gate.naiaAccount=false and tears down the selected local voice/avatar.
	let manifestConfig = config as unknown as AppConfig;
	// The write path is captured when the transaction is queued. If the user
	// switches ADKs while an awaited write is in flight, never read the newly
	// selected ADK's credential into the old workspace's manifest. Login/setup
	// passes its freshly persisted key in `config`, so it remains safe even
	// while hydration is still pending.
	if (!manifestConfig.naiaKey && adkPath === getAdkPath()) {
		try {
			const naiaKey = await getSecretKey("naiaKey");
			if (naiaKey) manifestConfig = { ...manifestConfig, naiaKey };
		} catch {
			// Native start_voxcpm2 independently verifies the profile. A secure
			// store failure therefore remains fail-closed here.
		}
	}
	await writeSlotsManifest(manifestConfig, undefined, adkPath).catch((e) => {
		Logger.warn("adk-store", "slots-manifest write failed", {
			error: e instanceof Error ? e.message : String(e),
		});
	});
	// 저장 성공은 실행 중 Agent가 provider와 memory 재적용을 확인한 뒤에만
	// 확정한다. 아직 Agent가 없는 온보딩 상태는 native가 available:false로
	// 정상 반환하며, 다음 SetWorkspace가 저장 파일을 읽는다.
	// Do not deduplicate this acknowledgement by config text: the Agent may
	// have restarted or retained an old memory instance since the prior write.
	await invoke("reload_agent_settings");
}

/**
 * Persist a complete config to one captured ADK path.
 *
 * Setup uses this while App hydration is pending: the ordinary writer remains
 * gated so an incomplete localStorage snapshot cannot win the startup race,
 * while the explicit selected-workspace transaction can finish before setup
 * calls onComplete(). Both the path and deep config snapshot are captured
 * before entering the shared write tail.
 */
export function writeNaiaConfigAtPath(
	config: Record<string, unknown>,
	adkPath: string | null,
): Promise<void> {
	const configSnapshot = snapshotConfig(config);
	const pathSnapshot = adkPath ? adkPath.replace(/[/\\]+$/, "") : null;
	const operation = naiaConfigWriteTail.then(() =>
		writeNaiaConfigNow(configSnapshot, pathSnapshot),
	);
	naiaConfigWriteTail = operation.then(
		() => undefined,
		() => undefined,
	);
	return operation;
}

/** Keep config, UI config, and the derived slots manifest as one ordered
 * transaction. In particular, logout must remain after any pending restore. */
export function writeNaiaConfig(
	config: Record<string, unknown>,
): Promise<void> {
	if (configHydrationPending) return Promise.resolve();
	return writeNaiaConfigAtPath(config, getAdkPath());
}
