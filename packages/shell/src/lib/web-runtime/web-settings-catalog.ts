import { WEB_ADK_PATH } from "./web-adk-path";
import { splitWebAdkPath } from "./web-adk-policy";
import {
	WEB_BACKGROUND_ASSETS,
	WEB_NVA_ASSETS,
	WEB_VRM_ASSETS,
	resolveWebPublicAssetUrl,
} from "./web-assets";

// R32: 웹판 ADK 파일 목록의 naia-settings 폴더.
// 데스크톱은 기본 배경·아바타를 작업 공간 `naia-settings/background`·`vrm-files`·`nva-files`
// 에 실제 파일로 둔다. 웹판은 같은 파일을 앱 정적 자산(/backgrounds, /avatars, /nva)으로
// 싣고 있으므로, 브라우저 저장소(OPFS)에 복사하지 않고 같은 이름의 폴더 아래 "앱 기본 파일"로
// 목록에만 겹쳐 보인다. 사용자가 올린 파일(예: bgm-musics)은 OPFS 의 실제 파일이다.

export const WEB_SETTINGS_ROOT = `${WEB_ADK_PATH}/naia-settings`;

export interface WebWorkspaceEntry {
	name: string;
	kind: "file" | "directory";
	bundled?: boolean;
}

interface WebBundledSettingsEntry extends WebWorkspaceEntry {
	url?: string;
}

const WEB_SETTINGS_IMPORT_EXTENSIONS = new Map<string, readonly string[]>([
	[
		`${WEB_SETTINGS_ROOT}/background`,
		[".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".mp4"],
	],
	[`${WEB_SETTINGS_ROOT}/vrm-files`, [".vrm"]],
	[`${WEB_SETTINGS_ROOT}/nva-files`, [".nva"]],
]);

const SUBDIRS = new Map<string, readonly WebBundledSettingsEntry[]>([
	[
		"background",
		WEB_BACKGROUND_ASSETS.map(({ filename, url }) => ({
			name: filename,
			kind: "file",
			url,
		})),
	],
	[
		"vrm-files",
		WEB_VRM_ASSETS.map(({ filename, url }) => ({
			name: filename,
			kind: "file",
			url,
		})),
	],
	["bgm-musics", []],
	["nva-files", WEB_NVA_ASSETS.map((name) => ({ name, kind: "directory" }))],
]);

export function webSettingsImportExtensions(
	path: string,
): readonly string[] | undefined {
	return WEB_SETTINGS_IMPORT_EXTENSIONS.get(path);
}

function settingsParts(path: string): string[] | null {
	const parts = splitWebAdkPath(path);
	if (!parts || parts[0] !== "naia-settings") return null;
	return parts.slice(1);
}

/** 이 폴더 아래 겹쳐 보일 앱 기본 파일·폴더. 해당 없으면 빈 목록. */
export function webBundledSettingsEntries(
	parentPath: string,
): readonly WebBundledSettingsEntry[] {
	if (parentPath === WEB_ADK_PATH) {
		return [{ name: "naia-settings", kind: "directory" }];
	}
	const rest = settingsParts(parentPath);
	if (!rest) return [];
	if (rest.length === 0) {
		return Array.from(SUBDIRS.keys(), (name) => ({ name, kind: "directory" }));
	}
	if (rest.length === 1) return SUBDIRS.get(rest[0]) ?? [];
	if (
		rest.length === 2 &&
		rest[0] === "nva-files" &&
		WEB_NVA_ASSETS.includes(rest[1])
	) {
		return [
			{
				name: "manifest.json",
				kind: "file",
				url: `/nva/${rest[1]}/manifest.json`,
			},
		];
	}
	return [];
}

/** 앱 기본 폴더(OPFS 에 없어도 열 수 있는 폴더)인가. */
export function isWebBundledSettingsDirectory(path: string): boolean {
	const slash = path.lastIndexOf("/");
	const parent = path.slice(0, slash);
	const name = path.slice(slash + 1);
	return webBundledSettingsEntries(parent).some(
		(entry) => entry.kind === "directory" && entry.name === name,
	);
}

/** 앱 기본 파일이면 그 정적 자산 주소(BASE_URL 반영), 아니면 null. */
export function webBundledSettingsFileUrl(path: string): string | null {
	const slash = path.lastIndexOf("/");
	const parent = path.slice(0, slash);
	const name = path.slice(slash + 1);
	const entry = webBundledSettingsEntries(parent).find(
		(item) => item.kind === "file" && item.name === name,
	);
	return entry?.url ? resolveWebPublicAssetUrl(entry.url) : null;
}

/** OPFS 실제 목록 위에 앱 기본 항목을 겹친다. 같은 이름은 실제 파일이 이긴다. */
export function mergeWebBundledSettingsEntries(
	parentPath: string,
	found: readonly WebWorkspaceEntry[],
): WebWorkspaceEntry[] {
	const names = new Set(found.map((entry) => entry.name));
	const extra = webBundledSettingsEntries(parentPath)
		.filter((entry) => !names.has(entry.name))
		.map(({ name, kind }) => ({ name, kind, bundled: true }));
	return [...found, ...extra];
}
