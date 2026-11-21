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
	hasParentDirectorySegment,
	isBenignWebSettingsListError,
	isNotFoundError,
} from "./web-adk-policy";
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
	probeWebNvaArchiveDecodable,
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

/**
 * 배경 가져오기·선택·복원이 공유하는 단일 미디어 계약. BMP를 포함한
 * 브라우저 표시 가능 이미지와 영상 확장자다. 설정 화면과 복원 훅은
 * 이 집합으로만 판정한다(각자 목록을 두면 BMP처럼 어긋난다).
 */
export const WEB_BACKGROUND_IMAGE_EXTS = new Set([
	"png",
	"jpg",
	"jpeg",
	"webp",
	"gif",
	"bmp",
	"avif",
]);
export const WEB_BACKGROUND_VIDEO_EXTS = new Set([
	"mp4",
	"webm",
	"mov",
	"ogg",
	"avi",
]);

/** 배경 경로의 렌더러용 미디어 종류. 모르면 ""(호출자가 기본 처리). */
export function getWebBackgroundMediaType(path: string): "image" | "video" | "" {
	const extension =
		path.split("?")[0]?.split(".").pop()?.toLowerCase() ?? "";
	if (WEB_BACKGROUND_VIDEO_EXTS.has(extension)) return "video";
	if (WEB_BACKGROUND_IMAGE_EXTS.has(extension)) return "image";
	return "";
}

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
 * - 전체 식별자(`opfs://…`·`/backgrounds/…`)는 목록과 정확히 일치할 때만
 *   고른다. 목록에 없는 전체 식별자는 소실된 것이다. basename으로 내려가
 *   동명 번들을 대신 고르면 소실이 정상 복원으로 위장된다.
 * - 이전 저장값(bare 파일명)은 번들 카탈로그에서 먼저 찾는다. 같은 이름의
 *   사용자 파일이 있어도 bare 이름은 안정적인 번들을 가리킨다. 번들에도
 *   없으면 같은 이름의 사용자 파일을 고른다(레거시 bare 저장값).
 * - 끝부분 일치(`endsWith`)는 쓰지 않는다. `xmy-photo.webp` 가
 *   `my-photo.webp` 로 잘못 골라진다.
 * - 실제 상위 구간(`..`)이 있으면 거부한다. 파일명 안의 점(`photo..png`)은
 *   정상 이름으로 통과한다.
 * - 못 찾으면 null (호출자가 기본 배경 + 기존 목록으로 복구하고 원인을 표시한다).
 */
export function resolveWebBackgroundSelection(
	saved: string | undefined,
	paths: readonly string[],
): string | null {
	const trimmed = typeof saved === "string" ? saved.trim() : "";
	if (!trimmed || hasParentDirectorySegment(trimmed)) return null;
	if (paths.length === 0) return null;
	const exact = paths.find((path) => path === trimmed);
	if (exact) return exact;
	// 전체 식별자 모양인데 목록에 없으면 소실이다. basename으로 번들을
	// 대신 고르지 않는다.
	if (trimmed.includes("/")) return null;
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
	if (!trimmed || hasParentDirectorySegment(trimmed)) return null;
	if (entries.includes(trimmed)) return trimmed;
	const leaf = leafName(trimmed);
	if (!leaf || leaf === "." || leaf === ".." || leaf.includes("\0")) return null;
	return entries.includes(leaf) ? leaf : null;
}

/**
 * 웹판 자산 삭제 가능 판정. 번들 카탈로그 항목은 목록에 남아 있어야 하므로
 * 지우지 않는다. 배경은 사용자 식별자(`opfs://…`)만, NVA는 업로드 목록에
 * 있는 항목만 삭제 대상이다.
 */
export function canDeleteWebSettingsAsset(
	kind: WebSettingsAssetKind,
	storedIdentifier: string,
	uploadedNvas: readonly string[],
): boolean {
	if (!storedIdentifier) return false;
	if (kind === "background") {
		return storedIdentifier.startsWith(`${WEB_ADK_PATH}/`);
	}
	return resolveWebNvaSelection(storedIdentifier, uploadedNvas) !== null;
}

async function backgroundDirectory(
	create: boolean,
): Promise<FileSystemDirectoryHandle> {
	const root = await navigator.storage.getDirectory();
	let directory = await root.getDirectoryHandle("naia-adk", { create });
	directory = await directory.getDirectoryHandle("naia-settings", { create });
	return directory.getDirectoryHandle("background", { create });
}

/**
 * 브라우저에 올린 배경 파일의 전체 식별자 목록(이름순). 폴더가 없거나
 * 저장소 API가 없을 때만 []. 권한·용량 오류는 그대로 던진다.
 */
export async function listWebBackgroundPaths(): Promise<string[]> {
	if (isKioskDemo()) return [];
	let directory: FileSystemDirectoryHandle;
	try {
		directory = await backgroundDirectory(false);
	} catch (error) {
		if (isBenignWebSettingsListError(error)) return [];
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

/**
 * 사용자 배경·NVA 파일을 브라우저 저장소에서 읽는다. OPFS에 없는 사용자
 * 파일은 실패한다. 번들 대체 읽기(탐색기의 정적 자산 읽기)는 하지 않는다.
 * 소실된 사용자 파일이 동명 번들로 위장되면 복구 흐름이 타지 않기 때문이다.
 */
export async function readWebSettingsAssetBlob(path: string): Promise<Blob> {
	if (
		!path.startsWith(`${WEB_SETTINGS_BACKGROUND_DIR}/`) &&
		!path.startsWith(`${WEB_NVA_FILES_DIR}/`)
	) {
		throw new Error("web_settings_asset_invalid_path");
	}
	return getWebWorkspaceFile(path, { allowBundledFallback: false });
}

function asciiBytes(value: string): number[] {
	return Array.from(value, (char) => char.charCodeAt(0));
}

function startsWithBytes(header: Uint8Array, magic: number[]): boolean {
	return (
		header.length >= magic.length &&
		magic.every((byte, index) => header[index] === byte)
	);
}

/** 이미지 앞 바이트가 확장자와 같은 형식인가. 형식 불일치를 저장 전에 거른다. */
function matchesImageMagic(header: Uint8Array, extension: string): boolean {
	switch (extension) {
		case "png":
			return startsWithBytes(header, [
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
			]);
		case "jpg":
		case "jpeg":
			return startsWithBytes(header, [0xff, 0xd8, 0xff]);
		case "gif":
			return (
				startsWithBytes(header, asciiBytes("GIF87a")) ||
				startsWithBytes(header, asciiBytes("GIF89a"))
			);
		case "webp":
			return (
				header.length >= 12 &&
				startsWithBytes(header, asciiBytes("RIFF")) &&
				header[8] === 0x57 &&
				header[9] === 0x45 &&
				header[10] === 0x42 &&
				header[11] === 0x50
			);
		case "bmp":
			return startsWithBytes(header, asciiBytes("BM"));
		case "avif":
			return (
				header.length >= 12 &&
				header[4] === 0x66 &&
				header[5] === 0x74 &&
				header[6] === 0x79 &&
				header[7] === 0x70 &&
				header[8] === 0x61 &&
				header[9] === 0x76 &&
				header[10] === 0x69 &&
				header[11] === 0x66
			);
		default:
			return false;
	}
}

/**
 * 이미지·영상이 이 브라우저에서 실제로 재생되는가.
 *
 * - 이미지: 앞 바이트 형식 검사를 항상 한다. `createImageBitmap` 이 있으면
 *   전체 디코드까지 확인한다. 형식이 다르면 저장하지 않는다.
 * - 영상: `canPlayType` 이 빈 문자열을 돌려주거나 예외를 던지면(지원하지
 *   않는다고 알리면) 가져오지 않고 실패를 돌려준다. 지원한다고 하면 실제
 *   로드로 확인한다. DOM이 없는 비브라우저 런타임은 확장자 검사까지만 한다.
 */
export async function probeWebBackgroundPlayable(file: File): Promise<boolean> {
	const dot = file.name.lastIndexOf(".");
	const extension = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
	if (WEB_BACKGROUND_IMAGE_EXTS.has(extension)) {
		let header: Uint8Array;
		try {
			header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
		} catch {
			return false;
		}
		if (!matchesImageMagic(header, extension)) return false;
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
	if (WEB_BACKGROUND_VIDEO_EXTS.has(extension)) {
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
			return false;
		}
		if (!support) return false;
		let objectUrl: string;
		try {
			objectUrl = URL.createObjectURL(file);
		} catch {
			return false;
		}
		return new Promise((resolve) => {
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
		// 검사 순서: ZIP·매니페스트 문법→필수 클립 존재→브라우저 디코드.
		// 손상·누락 클립은 저장·선택 전에 여기서 실패하고 이전 선택을 유지한다.
		try {
			const archive = parseWebNvaZipBytes(bytes, `${directory}/${name}`);
			const decodable = await probeWebNvaArchiveDecodable(archive);
			if (decodable === false) {
				throw new Error("nva_clip_unplayable");
			}
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
