// 웹판 번들 자산 카탈로그 — 기본 작업공간 묶음(naia-settings/vrm-files·background)의
// 웹판 대응물. 데스크톱은 워크스페이스 naia-settings/에서 invoke 경유로 읽지만,
// 웹판에는 Tauri IPC가 없어 dist에 함께 실린 정적 자산을 HTTP로 읽는다.
// 아바타 표시 코드는 그대로(AvatarCanvas resolveAssetUrl → /avatars/* 그대로 fetch)
// 두고, 목록·기본값만 여기서 제공한다. 새 렌더러 없음.

/** 테스트에서 웹 모드를 강제하기 위한 오버라이드 (vitest의 MODE는 "test"). */
let webModeOverride: boolean | null = null;

/** 단위 시험용 오버라이드. null이면 실제 빌드 모드로 복귀. */
export function setWebAssetsModeForTests(value: boolean | null): void {
	webModeOverride = value;
}

/** 웹판 빌드인가. 데스크톱 조건부 감춤·웹 기본값의 단일 판별점. */
export function isWebMode(): boolean {
	if (webModeOverride !== null) return webModeOverride;
	return import.meta.env.MODE === "web";
}

export interface WebBundledAsset {
	/** bare 파일명 (config backgroundVideo·라벨 표시용). */
	filename: string;
	/** 화면 표시 라벨. */
	label: string;
	/** dist 기준 절대 URL (/avatars/*, /backgrounds/*). */
	url: string;
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
 * 웹판 배경 카탈로그 — dist /backgrounds/*.webp (naia-settings/background 정식 UHD 배경).
 * 이전의 아바타 썸네일 16:9 확대 파생본(ol-woman-dusk.webp, shino-uniform-dusk.webp)은
 * 화면에 얼굴만 거대하게 보이는 원인이므로 폐기하고 정식 배경으로 교체했다.
 */
export const WEB_BACKGROUND_ASSETS: readonly WebBundledAsset[] = [
	{
		filename: "naia-dawn-city-uhd.webp",
		label: "naia-dawn-city-uhd",
		url: "/backgrounds/naia-dawn-city-uhd.webp",
	},
	{
		filename: "naia-jina-minho-war-room-uhd.webp",
		label: "naia-jina-minho-war-room-uhd",
		url: "/backgrounds/naia-jina-minho-war-room-uhd.webp",
	},
];

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
