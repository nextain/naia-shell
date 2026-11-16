import type { NvaManifest } from "../nva";

export interface ShouldUseStackedAlphaInput {
	search?: string;
	userAgent?: string;
}

export interface WebKitVp9AlphaProbeInput {
	userAgent?: string;
	canPlayVp9Webm?: boolean;
}

export interface NvaClipCandidate {
	/** Bundle-relative clip path (e.g. `clips/idle.stacked.mp4`). */
	path: string;
	/** Whether the clip packs top-half RGB + bottom-half grayscale alpha. */
	stackedAlpha: boolean;
	/** True when synthesized from `.webm` convention rather than explicitly declared in `manifest.json`. */
	inferredFallback?: boolean;
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
		if (typeof navigator !== "undefined" && typeof navigator.userAgent === "string") {
			return navigator.userAgent;
		}
	} catch {
		// ignore
	}
	return "";
}

/** Prefer studio-baked color/alpha on every browser and desktop webview; keep the explicit `?nva_alpha=webm` override. */
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

/**
 * True on macOS/iOS WKWebView and Safari, or when the runtime `<video>` element
 * reports that VP9 WebM cannot be decoded. Note that Linux WebKitGTK is NOT
 * macOS/iOS AppleWebKit (its UA includes `Linux` / `X11` / `Wayland` and decodes
 * VP9 alpha via GStreamer), so we distinguish Apple WebKit (`Macintosh`,
 * `Mac OS X`, `iPhone`, `iPad`, `iPod`) without Chromium/Firefox engines.
 */
export function isWebKitWithoutVp9Alpha(
	input: WebKitVp9AlphaProbeInput = {},
): boolean {
	if (input.canPlayVp9Webm === false) {
		return true;
	}
	const ua = input.userAgent ?? defaultUserAgent();
	if (!ua) return false;
	if (/jsdom/i.test(ua)) return false;
	const isApplePlatform = /(Macintosh|Mac OS X|iPhone|iPad|iPod)/i.test(ua);
	const isAppleWebKit = /AppleWebKit\//i.test(ua);
	const isChromiumOrGecko =
		/(Chrome\/|Chromium\/|CriOS\/|Edg\/|OPR\/|FxiOS\/|Firefox\/)/i.test(ua);
	if (isApplePlatform && isAppleWebKit && !isChromiumOrGecko) {
		return true;
	}
	return false;
}

/** 클립 URL 또는 경로가 `.stacked.mp4` 로 끝나는지 판별한다. */
export function isStackedAlphaClipUrl(urlOrPath: string): boolean {
	const clean = urlOrPath.split(/[?#]/)[0] ?? "";
	return /\.stacked\.mp4$/i.test(clean);
}

/**
 * 데스크톱 `toLocalBlobUrl()`이 반환하는 `blob:tauri://localhost/<uuid>` URL은
 * 확장자가 사라지므로 `<video>` 요소의 `dataset.naiaStackedAlpha`와 해석 경로를 함께 검사한다.
 */
export function markVideoStackedAlpha(
	video: HTMLVideoElement,
	stackedAlpha: boolean,
	resolvedPath?: string,
): void {
	video.dataset.naiaStackedAlpha = stackedAlpha ? "true" : "false";
	if (resolvedPath) {
		video.dataset.naiaResolvedPath = resolvedPath;
	} else {
		delete video.dataset.naiaResolvedPath;
	}
}

export function isStackedAlphaVideoElement(
	video: HTMLVideoElement,
	fallbackUrlOrPath = "",
): boolean {
	if (video.dataset.naiaStackedAlpha === "true") return true;
	if (video.dataset.naiaStackedAlpha === "false") return false;
	if (
		video.dataset.naiaResolvedPath &&
		isStackedAlphaClipUrl(video.dataset.naiaResolvedPath)
	) {
		return true;
	}
	return isStackedAlphaClipUrl(fallbackUrlOrPath || video.dataset.naiaClipUrl || video.src || "");
}

/**
 * 매니페스트와 플랫폼 미디어 지원 여부에 따라 시도할 클립 후보 목록을 우선순위대로 반환한다.
 * - `manifest.stacked_alpha.clips` 매핑이 있고 `preferStackedAlpha`이면 해당 `.stacked.mp4`를 최우선으로 둔다.
 * - 매핑이 없더라도 VP9+Alpha 미지원 환경(macOS `WKWebView`/Safari)에서 원본이 `.webm`이면
 *   동반 `.stacked.mp4` → 크로마키 `.mp4` → 원본 `.webm` 순서로 폴백 후보를 생성한다.
 * - 일반 환경(Windows WebView2 / Linux WebKitGTK)에서도 원본 `.webm` 디코드가 실패할 때를 대비해
 *   동반 `.stacked.mp4`·`.mp4`를 후순위 폴백으로 둔다.
 */
export function resolveNvaClipCandidates(
	manifest: NvaManifest,
	relativePath: string,
	options: {
		preferStackedAlpha?: boolean;
		webmUnsupported?: boolean;
	} = {},
): NvaClipCandidate[] {
	const preferStacked = options.preferStackedAlpha ?? shouldUseStackedAlpha();
	const webmUnsupported = options.webmUnsupported ?? isWebKitWithoutVp9Alpha();
	const normalizedRel = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
	const seen = new Set<string>();
	const candidates: NvaClipCandidate[] = [];

	const push = (
		path: string | undefined,
		stackedAlpha: boolean,
		inferredFallback = false,
	) => {
		if (!path) return;
		const clean = path.replace(/\\/g, "/").replace(/^\/+/, "");
		if (!clean || seen.has(clean)) return;
		seen.add(clean);
		candidates.push({ path: clean, stackedAlpha, inferredFallback });
	};

	const mappedStacked =
		manifest.stacked_alpha?.clips?.[normalizedRel] ??
		manifest.stacked_alpha?.clips?.[relativePath];

	if (preferStacked && mappedStacked) {
		push(mappedStacked, true, false);
	}

	const isWebm = /\.webm$/i.test(normalizedRel);
	const inferredStacked = isWebm
		? normalizedRel.replace(/\.webm$/i, ".stacked.mp4")
		: undefined;
	const inferredMp4 =
		isWebm && !isStackedAlphaClipUrl(normalizedRel)
			? normalizedRel.replace(/\.webm$/i, ".mp4")
			: undefined;

	if (isWebm && webmUnsupported) {
		if (preferStacked) {
			push(inferredStacked, true, true);
		}
		push(inferredMp4, false, true);
		push(normalizedRel, false, false);
	} else {
		push(normalizedRel, isStackedAlphaClipUrl(normalizedRel), false);
		if (isWebm && preferStacked) {
			push(inferredStacked, true, true);
		}
		if (isWebm) {
			push(inferredMp4, false, true);
		}
	}

	return candidates;
}
