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

function defaultUserAgent(): string {
	try {
		if (
			typeof navigator !== "undefined" &&
			typeof navigator.userAgent === "string"
		) {
			return navigator.userAgent;
		}
	} catch {
		// ignore
	}
	return "";
}

/**
 * Safari 및 iOS/iPadOS/WebKit 계열 브라우저처럼 VP9 알파 WebM을 투명하게 그리지 못하는
 * 환경에서 상하 분리(stacked color+alpha) MP4 경로를 쓸지 판별한다.
 *
 * 우선순위:
 * 1. 주소 `?nva_alpha=webm` → false
 * 2. 주소 `?nva_alpha=stacked` → true
 * 3. 애플 웹킷 엔진(`AppleWebKit` 이 있고 `Chrome/`·`Chromium/`·`Edg/` 가 없거나 `CriOS`/`FxiOS`/`EdgiOS` 인 경우) → true
 * 4. 나머지 → false
 */
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

	const ua = input.userAgent ?? defaultUserAgent();
	if (!ua.includes("AppleWebKit")) return false;
	if (/(CriOS|FxiOS|EdgiOS)(\/|\b)/.test(ua)) return true;
	if (/(Chrome|Chromium|Edg)\//.test(ua)) return false;
	return true;
}

/** 클립 URL 또는 경로가 `.stacked.mp4` 로 끝나는지 판별한다. */
export function isStackedAlphaClipUrl(urlOrPath: string): boolean {
	const clean = urlOrPath.split(/[?#]/)[0] ?? "";
	return /\.stacked\.mp4$/i.test(clean);
}
