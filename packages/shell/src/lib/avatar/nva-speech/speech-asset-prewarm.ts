import { Logger } from "../../logger";
import type { NvaManifest } from "../../nva";

/**
 * Speech asset bytes fetched before the avatar renderer exists (kiosk entry
 * screen), keyed by the web asset URL the renderer will ask for. The renderer
 * takes each entry once, so the bytes are then owned by its own blob cache.
 */
const prewarmed = new Map<string, Promise<Blob>>();
let prewarmedBundle: string | null = null;

/** Web URL of one bundle asset: its stacked color/alpha clip when the bundle has one. */
export function resolveWebNvaAssetUrl(
	bundleDir: string,
	manifest: NvaManifest,
	relativePath: string,
	useStackedAlpha: boolean,
	resolvePath: (bundleDir: string, relativePath: string) => string,
): string {
	const validatedBase = resolvePath(bundleDir, relativePath);
	const normalizedRel = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
	const stackedRel = useStackedAlpha
		? (manifest.stacked_alpha?.clips?.[normalizedRel] ??
			manifest.stacked_alpha?.clips?.[relativePath])
		: undefined;
	return stackedRel ? resolvePath(bundleDir, stackedRel) : validatedBase;
}

/** Bytes fetched ahead for `url`, or null (never rejects; a failed prewarm is just a miss). */
export async function takePrewarmedSpeechAsset(
	url: string,
): Promise<Blob | null> {
	const entry = prewarmed.get(url);
	if (!entry) return null;
	prewarmed.delete(url);
	return entry.catch(() => null);
}

/**
 * Fetch the canonical speech assets of web bundle `nvaModel` in the background
 * so the first spoken sentence can already move the mouth. Best effort: every
 * failure is swallowed and the renderer fetches on its own later.
 */
export async function prewarmWebSpeechAssets(
	nvaModel: string | undefined,
): Promise<void> {
	const segments = nvaModel?.split(/[/\\]/).filter(Boolean) ?? [];
	const bundleName = segments.at(-1) ?? "";
	if (
		!bundleName ||
		segments.includes("..") ||
		!/^[a-z0-9-]+$/.test(bundleName) ||
		prewarmedBundle === bundleName ||
		typeof fetch !== "function"
	)
		return;
	prewarmedBundle = bundleName;
	try {
		const [{ parseNvaManifest, resolveNvaAssetPath }, stage, alpha] =
			await Promise.all([
				import("../../nva"),
				import("./canonical-speech-stage"),
				import("../nva-stacked-alpha"),
			]);
		const directory = `/nva/${bundleName}`;
		const response = await fetch(`${directory}/manifest.json`);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const manifest = parseNvaManifest(await response.text());
		if (!stage.hasCanonicalSpeechMotion(manifest)) return;
		const useStacked = alpha.shouldUseStackedAlpha();
		for (const path of stage.canonicalSpeechAssetPaths(manifest)) {
			const url = resolveWebNvaAssetUrl(
				directory,
				manifest,
				path,
				useStacked,
				resolveNvaAssetPath,
			);
			if (prewarmed.has(url)) continue;
			const loading = fetch(url).then((res) => {
				if (!res.ok) throw new Error(`NVA asset ${path} unavailable`);
				return res.blob();
			});
			loading.catch(() => {
				if (prewarmed.get(url) === loading) prewarmed.delete(url);
			});
			prewarmed.set(url, loading);
		}
	} catch {
		prewarmedBundle = null;
		Logger.debug("SpeechAssetPrewarm", "speech asset prewarm skipped");
	}
}

/** Test seam: forget every prewarmed asset. */
export function resetSpeechAssetPrewarmForTests(): void {
	prewarmed.clear();
	prewarmedBundle = null;
}
