/**
 * 웹판 설정의 NVA·배경 가져오기 (R-web-nva-background-import).
 *
 * 데스크톱은 Tauri 파일 대화상자 + `import_naia_asset` IPC 로
 * `naia-settings/{background,nva-files}/` 에 넣는다. 웹판에는 그 둘(네이티브
 * 대화상자·IPC)이 없어 설정 화면의 `<input type=file>` 로 받는 파일을
 * 탐색기와 같은 함수(`importWebWorkspaceFile`)로 같은 OPFS 폴더에 저장한다.
 * 확장자 검증·잠금·임시 파일·저장 완료 후 변경 이벤트는 탐색기 경로를 그대로
 * 재사용하므로, 설정에서 고르거나 탐색기에서 넣어도 열린 목록이 함께 바뀐다.
 */

import { isKioskDemo } from "../kiosk-demo/flag";
import { Logger } from "../logger";
import { WEB_ADK_PATH } from "./web-adk-path";
import {
	WEB_SETTINGS_ROOT,
	webSettingsImportExtensions,
} from "./web-settings-catalog";
import {
	getWebWorkspaceFile,
	importWebWorkspaceFile,
} from "./web-workspace-files";
import {
	MAX_WEB_NVA_ARCHIVE_BYTES,
	WEB_NVA_FILES_DIR,
	WEB_SETTINGS_ASSETS_CHANGED_EVENT,
	parseWebNvaZipBytes,
} from "./web-nva-archive";

/** 웹판 설정에서 사용자가 올린 배경 파일이 사는 OPFS 폴더. */
export const WEB_SETTINGS_BACKGROUND_DIR = `${WEB_SETTINGS_ROOT}/background`;

/** 배경 이미지·영상 한 파일 상한. 음악(R10, 200MB)과 같은 브라우저 할당 규칙. */
export const WEB_SETTINGS_BACKGROUND_MAX_BYTES = 200 * 1024 * 1024;

export type WebSettingsAssetKind = "background" | "nva-files";

export type WebSettingsAssetImportErrorCode =
	| "unsupported"
	| "too_large"
	| "invalid_nva"
	| "unplayable"
	| "quota"
	| "write_failed"
	| "unsupported_browser";

export class WebSettingsAssetImportError extends Error {
	constructor(
		readonly code: WebSettingsAssetImportErrorCode,
		message?: string,
	) {
		super(message ?? code);
		this.name = "WebSettingsAssetImportError";
	}
}

const BACKGROUND_IMAGE_EXTS = new Set([
	"png",
	"jpg",
	"jpeg",
	"webp",
	"gif",
	"bmp",
	"avif",
]);
const BACKGROUND_VIDEO_EXTS = new Set([
	"mp4",
	"webm",
	"mov",
	"ogg",
	"avi",
]);

/** 설정 자산 폴더. 배경은 이미지·영상 폴더, NVA는 `.nva` 보관 폴더. */
export function webSettingsAssetDir(kind: WebSettingsAssetKind): string {
	return kind === "background"
		? WEB_SETTINGS_BACKGROUND_DIR
		: WEB_NVA_FILES_DIR;
}

/** 이 브라우저에서 설정 자산 가져오기를 쓸 수 있는가. */
export function isWebSettingsAssetImportSupported(): boolean {
	return (
		typeof navigator !== "undefined" &&
		typeof navigator.storage?.getDirectory === "function" &&
		!isKioskDemo()
	);
}

function leafName(path: string): string {
	return path.split(/[/\\]/).filter(Boolean).pop() ?? "";
}

/**
 * 저장된 배경 식별자를 현재 목록에서 정확히 푼다.
 *
 * - 전체 식별자(`opfs://…`·`/backgrounds/…`)가 목록에 있으면 그것을 고른다.
 *   새로고침 뒤에는 이 식별자로 임시 Blob URL을 다시 만든다.
 * - 이전 저장값(bare 파일명)은 번들 카탈로그에서 먼저 찾는다. 같은 이름의
 *   사용자 파일이 있어도 bare 이름은 안정적인 번들을 가리킨다.
 * - 사용자 파일은 전체 OPFS 식별자로만 고른다. 끝부분 일치(`endsWith`)로
 *   판정하면 `xmy-photo.webp` 가 `my-photo.webp` 로 잘못 골라진다.
 * - 못 찾으면 null (호출자가 기본 배경 + 기존 목록으로 복구한다).
 */
export function resolveWebBackgroundSelection(
	saved: string | undefined,
	paths: readonly string[],
): string | null {
	const trimmed = typeof saved === "string" ? saved.trim() : "";
	if (!trimmed || trimmed.includes("..")) return null;
	if (paths.length === 0) return null;
	const exact = paths.find((path) => path === trimmed);
	if (exact) return exact;
	const leaf = leafName(trimmed);
	if (!leaf || leaf === "." || leaf === ".." || leaf.includes("\0")) return null;
	const bundled = paths.find(
		(path) => !path.startsWith(`${WEB_ADK_PATH}/`) && leafName(path) === leaf,
	);
	if (bundled) return bundled;
	return paths.find((path) => leafName(path) === leaf) ?? null;
}

/**
 * 저장된 NVA 식별자를 현재 목록 항목으로 푼다. 목록은 bare 이름
 * (`naia` 같은 번들·`custom.nva` 같은 업로드)이므로 전체 OPFS 식별자는
 * 끝 이름으로 푼다. 사용자 `naia.nva` 와 번들 `naia` 는 서로 다른 항목이다.
 */
export function resolveWebNvaSelection(
	saved: string | undefined,
	entries: readonly string[],
): string | null {
	const trimmed = typeof saved === "string" ? saved.trim() : "";
	if (!trimmed || trimmed.includes("..")) return null;
	if (entries.includes(trimmed)) return trimmed;
	const leaf = leafName(trimmed);
	if (!leaf || leaf === "." || leaf === ".." || leaf.includes("\0")) return null;
	return entries.includes(leaf) ? leaf : null;
}

function isNotFoundError(error: unknown): boolean {
	return (
		error instanceof DOMException &&
		(error.name === "NotFoundError" || error.name === "TypeMismatchError")
	);
}

async function backgroundDirectory(
	create: boolean,
): Promise<FileSystemDirectoryHandle> {
	const root = await navigator.storage.getDirectory();
	let directory = await root.getDirectoryHandle("naia-adk", { create });
	directory = await directory.getDirectoryHandle("naia-settings", { create });
	return directory.getDirectoryHandle("background", { create });
}

/** 브라우저에 올린 배경 파일의 전체 식별자 목록(이름순). 폴더가 없으면 []. */
export async function listWebBackgroundPaths(): Promise<string[]> {
	if (isKioskDemo()) return [];
	let directory: FileSystemDirectoryHandle;
	try {
		directory = await backgroundDirectory(false);
	} catch (error) {
		if (isNotFoundError(error)) return [];
		throw error;
	}
	const allowed =
		webSettingsImportExtensions(WEB_SETTINGS_BACKGROUND_DIR) ?? [];
	const names: string[] = [];
	const iterable = directory as FileSystemDirectoryHandle & {
		values(): AsyncIterable<FileSystemHandle>;
	};
	for await (const entry of iterable.values()) {
		if (entry.kind !== "file" || entry.name.startsWith(".")) continue;
		const lower = entry.name.toLowerCase();
		if (!allowed.some((extension) => lower.endsWith(extension))) continue;
		names.push(entry.name);
	}
	names.sort((a, b) => a.localeCompare(b));
	return names.map((name) => `${WEB_SETTINGS_BACKGROUND_DIR}/${name}`);
}

/** 사용자 배경 파일을 브라우저 저장소에서 읽는다(없으면 번들 대체·없으면 실패). */
export async function readWebSettingsAssetBlob(path: string): Promise<Blob> {
	if (
		!path.startsWith(`${WEB_SETTINGS_BACKGROUND_DIR}/`) &&
		!path.startsWith(`${WEB_NVA_FILES_DIR}/`)
	) {
		throw new Error("web_settings_asset_invalid_path");
	}
	return getWebWorkspaceFile(path);
}

/**
 * 이미지·영상이 이 브라우저에서 실제로 재생되는가. 탐지 API 가 없으면
 * 확장자 검사에 맡기고 true 를 돌려준다(단위 시험·구형 환경).
 */
export async function probeWebBackgroundPlayable(file: File): Promise<boolean> {
	const dot = file.name.lastIndexOf(".");
	const extension = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
	if (BACKGROUND_IMAGE_EXTS.has(extension)) {
		if (typeof createImageBitmap === "function") {
			try {
				const bitmap = await createImageBitmap(file);
				bitmap.close?.();
				return true;
			} catch {
				return false;
			}
		}
		return true;
	}
	if (BACKGROUND_VIDEO_EXTS.has(extension)) {
		if (typeof document === "undefined") return true;
		const video = document.createElement("video");
		const mime =
			extension === "mov"
				? "video/quicktime"
				: extension === "avi"
					? "video/x-msvideo"
					: `video/${extension}`;
		let support = "";
		try {
			support = video.canPlayType(mime);
		} catch {
			return true;
		}
		if (!support) return true;
		return new Promise((resolve) => {
			const objectUrl = URL.createObjectURL(file);
			const done = (ok: boolean) => {
				URL.revokeObjectURL(objectUrl);
				resolve(ok);
			};
			const timer = setTimeout(() => done(false), 5000);
			video.onloadeddata = () => {
				clearTimeout(timer);
				done(true);
			};
			video.onerror = () => {
				clearTimeout(timer);
				done(false);
			};
			video.preload = "metadata";
			video.src = objectUrl;
		});
	}
	return true;
}

/**
 * 설정에서 고른 파일 하나를 검사하고 브라우저 저장소에 넣는다. 저장된 전체
 * 식별자를 돌려준다. 검사 순서: 형식→크기→내용(NVA ZIP·배경 재생)→저장.
 * 저장(목록 갱신·적용·다시 열기)은 성공한 뒤에만 이어간다.
 */
export async function importWebSettingsAsset(
	kind: WebSettingsAssetKind,
	file: File,
): Promise<string> {
	if (!isWebSettingsAssetImportSupported()) {
		throw new WebSettingsAssetImportError("unsupported_browser");
	}
	const directory = webSettingsAssetDir(kind);
	const name = (file.name ?? "").split(/[/\\]/).pop() ?? "";
	const allowed = webSettingsImportExtensions(directory) ?? [];
	if (
		!name ||
		name === "." ||
		name === ".." ||
		!allowed.some((extension) => name.toLowerCase().endsWith(extension))
	) {
		throw new WebSettingsAssetImportError(
			"unsupported",
			`Unsupported settings file type: ${name}`,
		);
	}
	if (kind === "nva-files") {
		if (file.size > MAX_WEB_NVA_ARCHIVE_BYTES) {
			throw new WebSettingsAssetImportError(
				"too_large",
				`NVA archive exceeds ${MAX_WEB_NVA_ARCHIVE_BYTES} bytes`,
			);
		}
		const bytes = new Uint8Array(await file.arrayBuffer());
		try {
			parseWebNvaZipBytes(bytes, `${directory}/${name}`);
		} catch (error) {
			throw new WebSettingsAssetImportError(
				"invalid_nva",
				error instanceof Error ? error.message : "nva_invalid_zip",
			);
		}
	} else {
		if (file.size > WEB_SETTINGS_BACKGROUND_MAX_BYTES) {
			throw new WebSettingsAssetImportError(
				"too_large",
				`Background file exceeds ${WEB_SETTINGS_BACKGROUND_MAX_BYTES} bytes`,
			);
		}
		if (!(await probeWebBackgroundPlayable(file))) {
			throw new WebSettingsAssetImportError(
				"unplayable",
				`Background file is not playable: ${name}`,
			);
		}
	}
	try {
		// 탐색기 함수는 OPFS 최상위 폴더가 이미 있다고 본다. 설정 첫 올리기가
		// 빈 브라우저에서도 되도록 부모 폴더를 여기서 만든다.
		const root = await navigator.storage.getDirectory();
		let parent = await root.getDirectoryHandle("naia-adk", { create: true });
		parent = await parent.getDirectoryHandle("naia-settings", { create: true });
		await parent.getDirectoryHandle(
			kind === "background" ? "background" : "nva-files",
			{ create: true },
		);
		return await importWebWorkspaceFile({ path: directory, directory: null }, file);
	} catch (error) {
		if (error instanceof DOMException && error.name === "QuotaExceededError") {
			throw new WebSettingsAssetImportError("quota");
		}
		Logger.warn("WebSettingsAssets", "web settings asset import failed", {
			kind,
			name,
			error: error instanceof Error ? error.message : String(error),
		});
		throw new WebSettingsAssetImportError(
			"write_failed",
			error instanceof Error ? error.message : String(error),
		);
	}
}

/** 사용자 자산 하나를 지운다. 이미 없으면 무시하고 열린 목록을 갱신한다. */
export async function removeWebSettingsAsset(path: string): Promise<void> {
	const directory = path.startsWith(`${WEB_SETTINGS_BACKGROUND_DIR}/`)
		? WEB_SETTINGS_BACKGROUND_DIR
		: path.startsWith(`${WEB_NVA_FILES_DIR}/`)
			? WEB_NVA_FILES_DIR
			: null;
	if (!directory) {
		throw new WebSettingsAssetImportError("unsupported", `Not a user asset: ${path}`);
	}
	const name = path.slice(directory.length + 1);
	if (
		!name ||
		name.includes("/") ||
		name.includes("\\") ||
		name === "." ||
		name === ".."
	) {
		throw new WebSettingsAssetImportError("unsupported", `Invalid asset name: ${name}`);
	}
	const parts =
		directory === WEB_SETTINGS_BACKGROUND_DIR
			? (["naia-adk", "naia-settings", "background"] as const)
			: (["naia-adk", "naia-settings", "nva-files"] as const);
	try {
		const root = await navigator.storage.getDirectory();
		let dir = await root.getDirectoryHandle(parts[0]);
		for (const part of parts.slice(1)) dir = await dir.getDirectoryHandle(part);
		await dir.removeEntry(name);
	} catch (error) {
		if (isNotFoundError(error)) return;
		throw error;
	}
	globalThis.window?.dispatchEvent(
		new Event(WEB_SETTINGS_ASSETS_CHANGED_EVENT),
	);
}
