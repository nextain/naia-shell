import { Logger } from "../../logger";
import type { NvaManifest } from "../../nva";
import { isNarrowPortraitScreen } from "../../web-runtime/web-assets";

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
	// 좁은 세로 화면(모바일 웹·모바일 앱 공통)에서는 64MB atlas.bin 등 대용량 선발 로드가 연결 풀·메모리를
	// 점유해 아바타 기본 클립·음성 합성·설정 청크를 막으므로 건너뛴다.
	if (isNarrowPortraitScreen()) {
		Logger.debug("SpeechAssetPrewarm", "speech asset prewarm skipped on mobile");
		return;
	}
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
