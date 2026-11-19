/**
 * 웹판 로컬 음악 (R10, UC-WEB-BGM-LOCAL-IMPORT).
 *
 * 데스크톱은 naia-settings/bgm-musics/ 폴더를 Rust 로 읽는다. 웹판에는 그
 * 폴더가 없어서 음악 앱 "로컬" 탭이 늘 "트랙 없음"이었다. 웹판에서는 같은
 * 자리를 이 브라우저의 OPFS(`naia-adk/naia-settings/bgm-musics/`)로 두고,
 * 사용자가 고른 음악 파일을 거기에 복사한다. 파일은 서버로 가지 않는다.
 */
import { isKioskDemo } from "../kiosk-demo/flag";
import { WEB_ADK_OPFS_DIR, WEB_ADK_PATH } from "./web-adk-path";

const BGM_PARTS = ["naia-settings", "bgm-musics"] as const;
export const WEB_BGM_MUSIC_DIR = `${WEB_ADK_PATH}/${BGM_PARTS.join("/")}`;
/** 한 파일 상한. 브라우저 저장소 할당량을 한 곡이 다 쓰지 않게 한다. */
export const WEB_BGM_MAX_BYTES = 200 * 1024 * 1024;

const AUDIO_MIME: Record<string, string> = {
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	aac: "audio/aac",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	opus: "audio/ogg",
	wav: "audio/wav",
	flac: "audio/flac",
	weba: "audio/webm",
};

export type WebBgmImportErrorCode =
	| "unsupported"
	| "not_audio"
	| "too_large"
	| "quota"
	| "write_failed";

export class WebBgmImportError extends Error {
	constructor(
		readonly code: WebBgmImportErrorCode,
		message?: string,
	) {
		super(message ?? code);
		this.name = "WebBgmImportError";
	}
}

function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** 음악 파일로 받을 수 있는 이름·형식인가. */
export function isWebBgmAudioFile(file: { name: string; type?: string }): boolean {
	const ext = extensionOf(file.name);
	if (ext in AUDIO_MIME) return true;
	return typeof file.type === "string" && file.type.startsWith("audio/");
}

export function webBgmAudioMime(name: string): string {
	return AUDIO_MIME[extensionOf(name)] ?? "";
}

export function isWebBgmImportSupported(): boolean {
	return (
		typeof navigator !== "undefined" &&
		typeof navigator.storage?.getDirectory === "function" &&
		!isKioskDemo()
	);
}

function safeName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	const cleaned = base.replace(/[\0-\x1f]/g, "").trim();
	if (!cleaned || cleaned === "." || cleaned === "..") return "music";
	return cleaned;
}

async function bgmDirectory(create: boolean): Promise<FileSystemDirectoryHandle> {
	const root = await navigator.storage.getDirectory();
	let dir = await root.getDirectoryHandle(WEB_ADK_OPFS_DIR, { create });
	for (const part of BGM_PARTS) {
		dir = await dir.getDirectoryHandle(part, { create });
	}
	return dir;
}

function isNotFound(error: unknown): boolean {
	return (
		error instanceof DOMException &&
		(error.name === "NotFoundError" || error.name === "TypeMismatchError")
	);
}

/** `opfs://naia-adk/naia-settings/bgm-musics/<name>` → `<name>`, 아니면 null. */
export function webBgmFileName(path: string): string | null {
	const prefix = `${WEB_BGM_MUSIC_DIR}/`;
	if (!path.startsWith(prefix)) return null;
	const name = path.slice(prefix.length);
	if (!name || name.includes("/") || name === "." || name === "..") return null;
	return name;
}

/** 브라우저에 올린 음악 파일 경로 목록(이름순). 폴더가 없으면 빈 목록. */
export async function listWebBgmMusicPaths(): Promise<string[]> {
	if (!isWebBgmImportSupported()) return [];
	let dir: FileSystemDirectoryHandle;
	try {
		dir = await bgmDirectory(false);
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
	const names: string[] = [];
	const iterable = dir as FileSystemDirectoryHandle & {
		values(): AsyncIterable<FileSystemHandle>;
	};
	for await (const entry of iterable.values()) {
		if (entry.kind === "file" && isWebBgmAudioFile({ name: entry.name })) {
			names.push(entry.name);
		}
	}
	names.sort((a, b) => a.localeCompare(b));
	return names.map((name) => `${WEB_BGM_MUSIC_DIR}/${name}`);
}

async function availableName(
	dir: FileSystemDirectoryHandle,
	name: string,
): Promise<string> {
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const suffix = dot > 0 ? name.slice(dot) : "";
	for (let i = 1; ; i += 1) {
		const candidate = i === 1 ? name : `${stem} (${i})${suffix}`;
		try {
			await dir.getFileHandle(candidate);
		} catch (error) {
			if (isNotFound(error)) return candidate;
			throw error;
		}
	}
}

/** 고른 음악 파일 하나를 브라우저 저장소에 복사하고 그 경로를 돌려준다. */
export async function importWebBgmMusic(file: File): Promise<string> {
	if (!isWebBgmImportSupported()) throw new WebBgmImportError("unsupported");
	if (!isWebBgmAudioFile(file)) throw new WebBgmImportError("not_audio");
	if (file.size > WEB_BGM_MAX_BYTES) throw new WebBgmImportError("too_large");
	const dir = await bgmDirectory(true);
	const name = await availableName(dir, safeName(file.name));
	const handle = await dir.getFileHandle(name, { create: true });
	let writer: FileSystemWritableFileStream | null = null;
	try {
		writer = await handle.createWritable();
		await writer.write(file);
		await writer.close();
	} catch (error) {
		await writer?.abort().catch(() => {});
		await dir.removeEntry(name).catch(() => {});
		if (error instanceof DOMException && error.name === "QuotaExceededError") {
			throw new WebBgmImportError("quota");
		}
		throw new WebBgmImportError(
			"write_failed",
			error instanceof Error ? error.message : String(error),
		);
	}
	return `${WEB_BGM_MUSIC_DIR}/${name}`;
}

/** 올린 음악 파일을 재생용 Blob(올바른 MIME)으로 읽는다. */
export async function readWebBgmMusicBlob(path: string): Promise<Blob> {
	const name = webBgmFileName(path);
	if (!name) throw new Error("web_bgm_invalid_path");
	const dir = await bgmDirectory(false);
	const file = await (await dir.getFileHandle(name)).getFile();
	const type = file.type || webBgmAudioMime(name);
	return type && type !== file.type ? new Blob([file], { type }) : file;
}

/** 올린 음악 파일 하나를 지운다. 이미 없으면 무시. */
export async function removeWebBgmMusic(path: string): Promise<void> {
	const name = webBgmFileName(path);
	if (!name) throw new Error("web_bgm_invalid_path");
	try {
		const dir = await bgmDirectory(false);
		await dir.removeEntry(name);
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
}
