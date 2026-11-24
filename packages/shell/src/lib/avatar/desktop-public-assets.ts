/**
 * Decides which files under `packages/shell/public/` are copied into desktop
 * builds. Web-only backgrounds and kiosk slide decks are excluded, while
 * `public/nva` preserves `manifest.json`, `.stacked.mp4` fallback clips, and
 * lightweight poster images so macOS `WKWebView` has H.264 transparency
 * fallbacks even when an older ADK workspace only contains `.webm` clips.
 */
export function shouldIncludeDesktopPublicAsset(
	relativePath: string,
	isDirectory = false,
): boolean {
	const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
	if (!normalized) return true;
	const segments = normalized.split("/");
	const top = segments[0];
	if (top === "backgrounds" || top === "kiosk-slides") {
		return false;
	}
	if (top === "nva") {
		if (isDirectory) {
			return segments.length <= 3;
		}
		if (/\.json$/i.test(normalized)) {
			return true;
		}
		if (/\.mp4$/i.test(normalized)) {
			return true;
		}
		if (/\/(idle\.webp|neutral-head\.png)$/i.test(normalized)) {
			return true;
		}
		return false;
	}
	return true;
}
