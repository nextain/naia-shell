export interface ShouldUseStackedAlphaInput {
	search?: string;
	userAgent?: string;
}

function defaultSearch(): string {
	try {
		if (
			typeof window !== "undefined" &&
			typeof window.location?.search === "string"
		) {
			return window.location.search;
		}
	} catch {
		// ignore
	}
	return "";
}

/** Prefer studio-baked color/alpha on every browser; keep the explicit WebM override. */
export function shouldUseStackedAlpha(
	input: ShouldUseStackedAlphaInput = {},
): boolean {
	const rawSearch = input.search ?? defaultSearch();
	const normalizedSearch = rawSearch.startsWith("?")
		? rawSearch.slice(1)
		: rawSearch;
	const params = new URLSearchParams(normalizedSearch);
	const alphaParam = params.get("nva_alpha")?.trim().toLowerCase();
	if (alphaParam === "webm") return false;
	if (alphaParam === "stacked") return true;

	return true;
}

/** 클립 URL 또는 경로가 `.stacked.mp4` 로 끝나는지 판별한다. */
export function isStackedAlphaClipUrl(urlOrPath: string): boolean {
	const clean = urlOrPath.split(/[?#]/)[0] ?? "";
	return /\.stacked\.mp4$/i.test(clean);
}
