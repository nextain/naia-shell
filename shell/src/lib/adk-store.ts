import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { LAB_GATEWAY_URL } from "./config";

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
	| "bgm-musics";

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
	switch (provider) {
		case "anthropic": return "ANTHROPIC_API_KEY";
		case "openai":    return "OPENAI_API_KEY";
		case "nextain":   return "NAIA_ANYLLM_API_KEY";
		case "glm":       return "GLM_API_KEY";
		default:          return null; // ollama, vllm, gemini, claude-code-cli — no persisted key
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

export async function writeNaiaConfig(
	config: Record<string, unknown>,
): Promise<void> {
	const adkPath = getAdkPath();
	if (!adkPath) return;
	await invoke("write_naia_config", {
		adkPath,
		json: JSON.stringify(stripForAgent(config), null, 2),
	});
}
