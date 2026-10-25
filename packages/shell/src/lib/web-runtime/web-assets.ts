// 웹판 번들 자산 카탈로그 — 기본 작업공간 묶음(naia-settings/vrm-files·background)의
// 웹판 대응물. 데스크톱은 워크스페이스 naia-settings/에서 invoke 경유로 읽지만,
// 웹판에는 Tauri IPC가 없어 dist에 함께 실린 정적 자산을 HTTP로 읽는다.
// 아바타 표시 코드는 그대로(AvatarCanvas resolveAssetUrl → /avatars/* 그대로 fetch)
// 두고, 목록·기본값만 여기서 제공한다. 새 렌더러 없음.

/** 테스트에서 웹 모드를 강제하기 위한 오버라이드 (vitest의 MODE는 "test"). */
let webModeOverride: boolean | null = null;

/** 웹판 빌드인가. 데스크톱 조건부 감춤·웹 기본값의 단일 판별점. */
export function isWebMode(): boolean {
	if (webModeOverride !== null) return webModeOverride;
	return import.meta.env.MODE === "web";
}

/** 최상위 documentElement에 웹판 여부(data-naia-web="true")를 동기화한다. */
export function syncWebModeRootAttribute(): void {
	if (typeof document === "undefined" || !document.documentElement) return;
	if (isWebMode()) {
		document.documentElement.setAttribute("data-naia-web", "true");
	} else {
		document.documentElement.removeAttribute("data-naia-web");
	}
}

/** 단위 시험용 오버라이드. null이면 실제 빌드 모드로 복귀. */
export function setWebAssetsModeForTests(value: boolean | null): void {
	webModeOverride = value;
	syncWebModeRootAttribute();
}

export type WebBackgroundAssetKind = "image" | "video";

export interface WebBundledAsset {
	/** bare 파일명 (config backgroundVideo·라벨 표시용). */
	filename: string;
	/** 화면 표시 라벨. */
	label: string;
	/** dist 기준 절대 URL (/avatars/*, /backgrounds/*). */
	url: string;
	/** 미디어 종류 (배경 그림/영상 구분). */
	kind?: WebBackgroundAssetKind;
}

export interface WebBackgroundAsset extends WebBundledAsset {
	kind: WebBackgroundAssetKind;
}

/**
 * 웹판 VRM 카탈로그 — dist /avatars/*.vrm 중 기본 묶음으로 노출할 4종.
 * AVATAR_PRESETS(데스크톱 naia-settings/vrm-files 명명)와 같은 캐릭터를
 * 가리키되, 실제 번들된 파일명을 쓴다 (옛 번호와 어긋난 것은 여기만 맞춤).
 */
export const WEB_VRM_ASSETS: readonly WebBundledAsset[] = [
	{
		filename: "03-OL_Woman.vrm",
		label: "OL Woman",
		url: "/avatars/03-OL_Woman.vrm",
	},
	{
		filename: "01-Sendagaya-Shino-uniform.vrm",
		label: "Shino",
		url: "/avatars/01-Sendagaya-Shino-uniform.vrm",
	},
	{
		filename: "04-Hood_Boy.vrm",
		label: "Hood Boy",
		url: "/avatars/04-Hood_Boy.vrm",
	},
	{
		filename: "02-Sakurada-Fumiriya.vrm",
		label: "Sakurada Fumiriya",
		url: "/avatars/02-Sakurada-Fumiriya.vrm",
	},
];

/**
 * 웹판 배경 카탈로그 — dist /backgrounds/* (정식 배경 그림 6종 + 반복 재생 영상 2종).
 * 이전의 아바타 썸네일 16:9 확대 파생본(ol-woman-dusk.webp, shino-uniform-dusk.webp)은
 * 화면에 얼굴만 거대하게 보이는 원인이므로 폐기하고 정식 배경으로 교체했다.
 */
export const WEB_BACKGROUND_ASSETS: readonly WebBackgroundAsset[] = [
	{
		filename: "naia-dawn-city-uhd.webp",
		label: "새벽 도시",
		url: "/backgrounds/naia-dawn-city-uhd.webp",
		kind: "image",
	},
	{
		filename: "naia-jina-minho-war-room-uhd.webp",
		label: "작전실 — 나이아·지나·민호",
		url: "/backgrounds/naia-jina-minho-war-room-uhd.webp",
		kind: "image",
	},
	{
		filename: "naia-sunrise-river.webp",
		label: "강변 해돋이",
		url: "/backgrounds/naia-sunrise-river.webp",
		kind: "image",
	},
	{
		filename: "naia-rainy-studio.webp",
		label: "비 오는 작업실",
		url: "/backgrounds/naia-rainy-studio.webp",
		kind: "image",
	},
	{
		filename: "naia-starlight-lake.webp",
		label: "별빛 호수",
		url: "/backgrounds/naia-starlight-lake.webp",
		kind: "image",
	},
	{
		filename: "naia-sky-garden.webp",
		label: "하늘 정원",
		url: "/backgrounds/naia-sky-garden.webp",
		kind: "image",
	},
	{
		filename: "naia-starlight-lake-live.mp4",
		label: "별빛 호수 (움직이는 배경)",
		url: "/backgrounds/naia-starlight-lake-live.mp4",
		kind: "video",
	},
	{
		filename: "naia-rainy-studio-live.mp4",
		label: "비 오는 작업실 (움직이는 배경)",
		url: "/backgrounds/naia-rainy-studio-live.mp4",
		kind: "video",
	},
];

/**
 * 웹판 NVA 번들 카탈로그 — dist /nva/<묶음>/ 에 실린 6종 이름 목록 (기본: naia).
 */
export const WEB_NVA_ASSETS: readonly string[] = [
	"naia",
	"naia-anime",
	"jina",
	"jina-anime",
	"minho",
	"minho-anime",
];

/** 웹판 NVA 기본값 (번들 이름). */
export const WEB_DEFAULT_NVA = WEB_NVA_ASSETS[0];

/** 웹판 아바타 기본값 (config vrmModel이 비었을 때). */
export const WEB_DEFAULT_VRM = WEB_VRM_ASSETS[0].url;
/** 웹판 배경 기본값 (config backgroundVideo가 비었을 때, bare 파일명). */
export const WEB_DEFAULT_BACKGROUND = WEB_BACKGROUND_ASSETS[0].filename;
/** 웹판 배경 기본값 URL. */
export const WEB_DEFAULT_BACKGROUND_URL = WEB_BACKGROUND_ASSETS[0].url;

/**
 * 아바타 썸네일을 16:9로 잘라 얼굴만 크게 보이던 폐기 웹판 배경 파일명.
 * 기존 사용자 설정(localStorage `naia-config`, OPFS `ui-config.json`·`config.json`)에
 * 남아 있으면 새 기본 배경(`WEB_DEFAULT_BACKGROUND`)으로 마이그레이션한다.
 */
export const RETIRED_WEB_BACKGROUND_FILENAMES: readonly string[] = [
	"ol-woman-dusk.webp",
	"shino-uniform-dusk.webp",
];

export function isRetiredWebBackground(value: unknown): boolean {
	if (typeof value !== "string" || value.length === 0) return false;
	const trimmed = value.trim();
	return RETIRED_WEB_BACKGROUND_FILENAMES.some(
		(name) => trimmed === name || trimmed.endsWith(`/${name}`),
	);
}

/**
 * 설정 레코드(`backgroundVideo`, `backgroundImage`)에 폐기된 웹 배경 파일명이 있으면
 * 새 기본값(`WEB_DEFAULT_BACKGROUND`)으로 치환하고 변경 여부를 돌려준다.
 */
export function normalizeRetiredWebBackgroundInRecord(
	record: Record<string, unknown>,
): boolean {
	let changed = false;
	if (isRetiredWebBackground(record.backgroundVideo)) {
		record.backgroundVideo = WEB_DEFAULT_BACKGROUND;
		changed = true;
	}
	if (isRetiredWebBackground(record.backgroundImage)) {
		record.backgroundImage = String(record.backgroundImage).startsWith("/")
			? WEB_DEFAULT_BACKGROUND_URL
			: WEB_DEFAULT_BACKGROUND;
		changed = true;
	}
	return changed;
}

/** 웹판 번들 자산 URL인가 (/avatars/*, /backgrounds/*, /assets/* …). */
export function isWebBundledAssetUrl(path: string): boolean {
	return (
		path.startsWith("/avatars/") ||
		path.startsWith("/backgrounds/") ||
		path.startsWith("/assets/") ||
		path.startsWith("avatars/") ||
		path.startsWith("assets/")
	);
}
