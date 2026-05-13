import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";

const ADK_PATH_KEY = "naia-adk-path";

// ── ADK Path ──────────────────────────────────────────────────────────────────

export function getAdkPath(): string | null {
	return localStorage.getItem(ADK_PATH_KEY);
}

export function setAdkPath(path: string): void {
	// Normalize: remove trailing slash/backslash
	const normalized = path.replace(/[/\\]+$/, "");
	localStorage.setItem(ADK_PATH_KEY, normalized);
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
	| "splash-img";

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
		json: JSON.stringify(config, null, 2),
	});
}
