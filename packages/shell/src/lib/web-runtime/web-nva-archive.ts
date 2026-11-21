/**
 * Browser OPFS `.nva` archive reader and asset listing for Web edition (R17).
 *
 * Files imported into `opfs://naia-adk/naia-settings/nva-files/` via the File
 * Explorer stay stored as original `.nva` ZIP archives (preserving download
 * fidelity for FR-WEB-SETTINGS-FILES.3), while the Avatar settings picker and
 * `VideoAvatarCanvas` list and play them directly in the browser without native
 * Tauri IPC or server uploads.
 */

import { unzipSync } from "fflate";
import { isKioskDemo } from "../kiosk-demo/flag";
import {
	type NvaManifest,
	collectNvaManifestClipPaths,
	isPrebakedNvaManifest,
	parseNvaManifest,
	resolveNvaAssetPath,
} from "../nva";
import { WEB_ADK_OPFS_DIR, WEB_ADK_PATH } from "./web-adk-path";
import {
	hasParentDirectorySegment,
	isBenignWebSettingsListError,
	isNotFoundError,
	splitWebAdkPath,
} from "./web-adk-policy";
import { WEB_NVA_ASSETS } from "./web-assets";

export const WEB_NVA_FILES_DIR = `${WEB_ADK_PATH}/naia-settings/nva-files`;
export const WEB_SETTINGS_ASSETS_CHANGED_EVENT =
	"naia-web-settings-assets-changed";

export const MAX_WEB_NVA_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_WEB_NVA_ENTRIES = 512;
const MAX_WEB_NVA_UNZIPPED_BYTES = 512 * 1024 * 1024;

export interface LoadedWebNvaArchive {
	readonly bundleDir: string;
	readonly manifest: NvaManifest;
	/** ZIP 안의 정규화 경로별 원본 바이트. 가져오기 검증을 노출한다. */
	readonly files: ReadonlyMap<string, Uint8Array>;
	resolveAssetUrl(
		relativePath: string,
		useStackedAlpha: boolean,
	): Promise<string>;
	loadAssetBlob(
		relativePath: string,
		useStackedAlpha: boolean,
	): Promise<Blob>;
}

function nvaAssetMimeType(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	if (ext === "webm") return "video/webm";
	if (ext === "mp4") return "video/mp4";
	if (ext === "png") return "image/png";
	if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
	if (ext === "webp") return "image/webp";
	if (ext === "json") return "application/json";
	return "application/octet-stream";
}

function normalizeArchiveEntryPath(rawName: string): string | null {
	if (!rawName || rawName.includes("\0")) return null;
	const unified = rawName
		.replace(/\\/g, "/")
		.replace(/^(?:\.\/)+/, "")
		.replace(/^\/+/, "");
	if (!unified || unified.endsWith("/")) return null;
	const parts = unified.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) {
		return null;
	}
	return parts.join("/");
}

async function openOpfsDirectory(
	parts: readonly string[],
): Promise<FileSystemDirectoryHandle | null> {
	if (
		typeof navigator === "undefined" ||
		typeof navigator.storage?.getDirectory !== "function"
	) {
		return null;
	}
	try {
		const originRoot = await navigator.storage.getDirectory();
		let dir = await originRoot.getDirectoryHandle(WEB_ADK_OPFS_DIR);
		for (const part of parts) {
			dir = await dir.getDirectoryHandle(part);
		}
		return dir;
	} catch (error) {
		// 폴더가 없을 때만 null. 권한·용량 오류는 호출자가 목록·선택을
		// 보존하고 원인을 표시할 수 있도록 그대로 던진다.
		if (isBenignWebSettingsListError(error)) return null;
		throw error;
	}
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
	if (typeof blob.arrayBuffer === "function") {
		return new Uint8Array(await blob.arrayBuffer());
	}
	return new Uint8Array(await new Response(blob).arrayBuffer());
}

/**
 * List user-imported `.nva` archives (and extracted directories, if any) under
 * `opfs://naia-adk/naia-settings/nva-files`. 폴더가 없거나 저장소 API가 없을
 * 때만 빈 목록을 돌려준다. 나머지 저장소 오류는 그대로 던진다.
 */
export async function listWebUploadedNvaModels(): Promise<string[]> {
	if (isKioskDemo()) return [];
	const dir = await openOpfsDirectory(["naia-settings", "nva-files"]);
	if (!dir) return [];
	const found: string[] = [];
	try {
		const iterable = dir as FileSystemDirectoryHandle & {
			values(): AsyncIterable<FileSystemHandle>;
		};
		for await (const entry of iterable.values()) {
			if (entry.name.startsWith(".")) continue;
			if (entry.kind === "file" && /\.nva$/i.test(entry.name)) {
				found.push(entry.name);
			} else if (entry.kind === "directory") {
				found.push(entry.name);
			}
		}
	} catch (error) {
		if (isBenignWebSettingsListError(error)) return [];
		throw error;
	}
	found.sort((a, b) => a.localeCompare(b));
	return found;
}

/**
 * Combined web NVA list: built-in static bundles first, followed by user-uploaded
 * OPFS `.nva` models without duplicates.
 */
export async function listWebNvaAssets(): Promise<string[]> {
	const uploaded = await listWebUploadedNvaModels();
	if (uploaded.length === 0) return [...WEB_NVA_ASSETS];
	const seen = new Set<string>(WEB_NVA_ASSETS);
	const merged = [...WEB_NVA_ASSETS];
	for (const item of uploaded) {
		if (!seen.has(item)) {
			seen.add(item);
			merged.push(item);
		}
	}
	return merged;
}

/**
 * Returns true when `nvaModel` may refer to an OPFS-imported `.nva` model rather
 * than one of the 5 static `/nva/<bundle>` directories or a Studio preview URL.
 */
export function isCandidateWebUploadedNvaModel(nvaModel: string): boolean {
	const trimmed = nvaModel.trim();
	if (!trimmed || isKioskDemo()) return false;
	if (
		trimmed.startsWith("/api/nva-preview/") ||
		/^https?:\/\//i.test(trimmed)
	) {
		return false;
	}
	if (trimmed.startsWith(`${WEB_ADK_PATH}/`)) return true;
	if (/\.nva$/i.test(trimmed)) return true;
	return !WEB_NVA_ASSETS.includes(trimmed);
}

/** Parse and validate an in-memory `.nva` ZIP buffer into a playable bundle. */
export function parseWebNvaZipBytes(
	rawBytes: Uint8Array,
	bundleDir: string,
): LoadedWebNvaArchive {
	if (rawBytes.byteLength === 0 || rawBytes.byteLength > MAX_WEB_NVA_ARCHIVE_BYTES) {
		throw new Error("nva_archive_size_invalid");
	}
	let entryCount = 0;
	let unzippedTotal = 0;
	let rawEntries: Record<string, Uint8Array>;
	try {
		rawEntries = unzipSync(rawBytes, {
			filter(file) {
				if (++entryCount > MAX_WEB_NVA_ENTRIES) {
					throw new Error("nva_archive_too_many_entries");
				}
				unzippedTotal += file.originalSize ?? 0;
				if (unzippedTotal > MAX_WEB_NVA_UNZIPPED_BYTES) {
					throw new Error("nva_archive_too_large");
				}
				return true;
			},
		});
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.startsWith("nva_archive_")
		) {
			throw error;
		}
		throw new Error("nva_invalid_zip");
	}

	const normalizedFiles = new Map<string, Uint8Array>();
	for (const [rawName, content] of Object.entries(rawEntries)) {
		if (rawName.endsWith("/") && content.byteLength === 0) continue;
		const normalized = normalizeArchiveEntryPath(rawName);
		if (!normalized) {
			throw new Error("nva_invalid_entry_path");
		}
		normalizedFiles.set(normalized, content);
	}

	let files = normalizedFiles;
	if (!files.has("manifest.json")) {
		// Unwrap a single top-level folder (`my-avatar/manifest.json`) when present.
		const prefixes = new Set<string>();
		for (const key of files.keys()) {
			const slash = key.indexOf("/");
			if (slash <= 0) {
				prefixes.clear();
				break;
			}
			prefixes.add(key.slice(0, slash + 1));
		}
		if (prefixes.size === 1) {
			const [prefix] = [...prefixes];
			if (prefix && files.has(`${prefix}manifest.json`)) {
				const unwrapped = new Map<string, Uint8Array>();
				for (const [key, value] of files.entries()) {
					unwrapped.set(key.slice(prefix.length), value);
				}
				files = unwrapped;
			}
		}
	}

	const manifestBytes = files.get("manifest.json");
	if (!manifestBytes) {
		throw new Error("nva_missing_manifest");
	}
	const manifestText = new TextDecoder("utf-8", { fatal: false }).decode(
		manifestBytes,
	);
	const manifest = parseNvaManifest(manifestText);
	if (!isPrebakedNvaManifest(manifest)) {
		throw new Error("NVA requires vrm_slots prebaked WebM assets");
	}
	const stackedAlternates = new Set(
		Object.values(manifest.stacked_alpha?.clips ?? {}).filter(
			(value): value is string => typeof value === "string",
		),
	);
	for (const clipPath of collectNvaManifestClipPaths(manifest)) {
		resolveNvaAssetPath(bundleDir, clipPath);
		// stacked_alpha 대체본은 없어도 된다. 나머지 필수 클립은 ZIP 안에
		// 있어야 한다. 없으면 저장·선택 전에 실패한다(재생 시점이 아님).
		if (stackedAlternates.has(clipPath)) continue;
		const normalizedClip = normalizeArchiveEntryPath(clipPath);
		if (!normalizedClip || !files.has(normalizedClip)) {
			throw new Error(`nva_missing_clip:${clipPath}`);
		}
	}

	const pickArchiveRelativePath = (
		relativePath: string,
		useStackedAlpha: boolean,
	): string => {
		resolveNvaAssetPath(bundleDir, relativePath);
		const cleanRel = normalizeArchiveEntryPath(relativePath);
		if (!cleanRel) throw new Error("Invalid NVA asset path");
		if (useStackedAlpha) {
			const stackedCandidate =
				manifest.stacked_alpha?.clips?.[cleanRel] ??
				manifest.stacked_alpha?.clips?.[relativePath];
			if (stackedCandidate) {
				const cleanStacked = normalizeArchiveEntryPath(stackedCandidate);
				if (cleanStacked && files.has(cleanStacked)) {
					return cleanStacked;
				}
			}
		}
		return cleanRel;
	};

	const normalizedBundleDir = bundleDir.replace(/\/+$/, "");

	return {
		bundleDir: normalizedBundleDir,
		manifest,
		files,
		async resolveAssetUrl(relativePath, useStackedAlpha) {
			const chosen = pickArchiveRelativePath(relativePath, useStackedAlpha);
			return `${normalizedBundleDir}/${chosen}`;
		},
		async loadAssetBlob(relativePath, useStackedAlpha) {
			const chosen = pickArchiveRelativePath(relativePath, useStackedAlpha);
			const bytes = files.get(chosen);
			if (!bytes) {
				throw new Error(`NVA asset ${chosen} unavailable (404)`);
			}
			return new Blob([bytes as BlobPart], { type: nvaAssetMimeType(chosen) });
		},
	};
}

/**
 * 아카이브 대표 클립이 이 브라우저에서 실제로 디코드되는가를 확인한다.
 * true(디코드 성공)·false(디코드 실패)·null(여기서 판정 불가: DOM·미디어
 * 스택이 없거나 브라우저가 지원 여부를 알리지 않을 때)을 돌려준다. null은
 * 존재 검사가 끝난 뒤 건너뛰라는 뜻이지 통과가 아니다.
 */
export async function probeWebNvaArchiveDecodable(
	archive: LoadedWebNvaArchive,
): Promise<boolean | null> {
	const stackedAlternates = new Set(
		Object.values(archive.manifest.stacked_alpha?.clips ?? {}).filter(
			(value): value is string => typeof value === "string",
		),
	);
	const first = collectNvaManifestClipPaths(archive.manifest)
		.filter((clip) => !stackedAlternates.has(clip))
		.map((clip) => normalizeArchiveEntryPath(clip))
		.find((clip): clip is string => !!clip);
	if (!first) return null;
	const bytes = archive.files.get(first);
	if (!bytes) return false;
	if (typeof document === "undefined") return null;
	let support = "";
	try {
		support = document.createElement("video").canPlayType(
			nvaAssetMimeType(first),
		);
	} catch {
		return null;
	}
	if (!support) return null;
	let objectUrl: string;
	try {
		objectUrl = URL.createObjectURL(
			new Blob([bytes as BlobPart], { type: nvaAssetMimeType(first) }),
		);
	} catch {
		return null;
	}
	return new Promise((resolve) => {
		const video = document.createElement("video");
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

async function findUploadedNvaFile(
	nvaModel: string,
): Promise<{ file: File; bundleDir: string } | null> {
	const trimmed = nvaModel.trim();
	if (!trimmed || hasParentDirectorySegment(trimmed)) return null;

	if (trimmed.startsWith(`${WEB_ADK_PATH}/`)) {
		const parts = splitWebAdkPath(trimmed);
		if (!parts || parts.length < 2) return null;
		const dir = await openOpfsDirectory(parts.slice(0, -1));
		if (!dir) return null;
		try {
			const handle = await dir.getFileHandle(parts[parts.length - 1]);
			return { file: await handle.getFile(), bundleDir: trimmed };
		} catch (error) {
			if (isNotFoundError(error)) return null;
			throw error;
		}
	}

	const segments = trimmed.split(/[/\\]/).filter(Boolean);
	const leaf = segments.at(-1) ?? "";
	if (!leaf || leaf === "." || leaf === "..") return null;

	const nvaDir = await openOpfsDirectory(["naia-settings", "nva-files"]);
	if (!nvaDir) return null;

	const candidates = /\.nva$/i.test(leaf) ? [leaf] : [leaf, `${leaf}.nva`];
	for (const candidate of candidates) {
		if (!/\.nva$/i.test(candidate)) continue;
		try {
			const handle = await nvaDir.getFileHandle(candidate);
			return {
				file: await handle.getFile(),
				bundleDir: `${WEB_NVA_FILES_DIR}/${candidate}`,
			};
		} catch (error) {
			if (!isNotFoundError(error)) throw error;
		}
	}
	return null;
}

/**
 * Resolve an OPFS-uploaded `.nva` archive if present. Returns `null` when no
 * matching OPFS archive exists so built-in `/nva/<bundle>` loading can proceed.
 */
export async function loadWebUploadedNvaArchive(
	nvaModel: string,
): Promise<LoadedWebNvaArchive | null> {
	if (!isCandidateWebUploadedNvaModel(nvaModel)) return null;
	const located = await findUploadedNvaFile(nvaModel);
	if (!located) return null;
	if (located.file.size > MAX_WEB_NVA_ARCHIVE_BYTES) {
		throw new Error("nva_archive_size_invalid");
	}
	const bytes = await readBlobBytes(located.file);
	return parseWebNvaZipBytes(bytes, located.bundleDir);
}
