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
