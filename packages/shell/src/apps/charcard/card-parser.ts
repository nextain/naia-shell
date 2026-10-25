import { Logger } from "../../lib/logger";

const TAG = "CharCardParser";

export const MAX_CARD_FILE_BYTES = 20 * 1024 * 1024; // 20 MB
export const MAX_CARD_JSON_CHARS = 2 * 1024 * 1024; // 2 MB characters
export const MAX_LOREBOOK_ENTRIES = 1000;
export const MAX_CHARX_ENTRIES = 2000;
export const MAX_CHARX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_CHARX_TOTAL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB

export type CardParseErrorCode =
	| "FILE_TOO_LARGE"
	| "JSON_TOO_LARGE"
	| "TOO_MANY_LOREBOOK_ENTRIES"
	| "CHARX_UNSUPPORTED_ENV"
	| "CHARX_CORRUPT_ZIP"
	| "CHARX_MISSING_CARD_JSON"
	| "CHARX_ZIP64_NOT_SUPPORTED"
	| "CHARX_ENCRYPTED"
	| "CHARX_DECOMPRESSION_BOMB"
	| "NOT_PNG_OR_JSON"
	| "PNG_CORRUPT_CHUNK"
	| "PNG_NO_CARD_CHUNK"
	| "INVALID_BASE64"
	| "INVALID_JSON"
	| "UNKNOWN_SPEC"
	| "INVALID_SPEC_VERSION"
	| "MISSING_NAME";

export type CardSpecVersion = "v1" | "v2" | "v3";
export type CardSourceFormat = "png" | "json" | "charx";

export interface NormalizedLorebookEntry {
	id: string;
	name: string;
	comment: string;
	keys: string[];
	secondary_keys: string[];
	content: string;
	enabled: boolean;
	constant: boolean;
	insertion_order: number;
	priority: number;
}

export interface NormalizedCharacterBook {
	name: string;
	description: string;
	entries: NormalizedLorebookEntry[];
}

export interface NormalizedCharacterCard {
	specVersion: CardSpecVersion;
	sourceFormat: CardSourceFormat;
	chunkKeyword?: "ccv3" | "chara";
	name: string;
	description: string;
	personality: string;
	scenario: string;
	first_mes: string;
	alternate_greetings: string[];
	mes_example: string;
	system_prompt: string;
	post_history_instructions: string;
	creator: string;
	creator_notes: string;
	tags: string[];
	character_book: NormalizedCharacterBook;
	rawJson: Record<string, unknown>;
}

export type CardParseResult =
	| {
			ok: true;
			card: NormalizedCharacterCard;
			imageBytes?: Uint8Array;
			imageMimeType?: string;
	  }
	| { ok: false; code: CardParseErrorCode; detail?: string };

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const ZIP_PK_SIGNATURE = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const ZIP_EMPTY_EOCD_SIGNATURE = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);

const CRC32_TABLE: Uint32Array = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[i] = c >>> 0;
	}
	return table;
})();

export function computeCrc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.byteLength; i++) {
		crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function startsWithBytes(bytes: Uint8Array, prefix: Uint8Array): boolean {
	if (bytes.byteLength < prefix.byteLength) return false;
	for (let i = 0; i < prefix.byteLength; i++) {
		if (bytes[i] !== prefix[i]) return false;
	}
	return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			const trimmed = item.trim();
			if (trimmed.length > 0) out.push(item);
		}
	}
	return out;
}

function asNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function readLatin1(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		out += String.fromCharCode(bytes[i]);
	}
	return out;
}

function readUtf8(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function decodeBase64Utf8(
	encoded: string,
): { ok: true; text: string } | { ok: false } {
	const cleaned = encoded.replace(/[\r\n\s]+/g, "");
	if (cleaned.length === 0) return { ok: false };
	// Accept standard or URL-safe base64, padding optional
	const standard = cleaned.replace(/-/g, "+").replace(/_/g, "/");
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(standard)) {
		return { ok: false };
	}
	const remainder = standard.length % 4;
	if (remainder === 1) return { ok: false };
	const padded =
		remainder === 0 ? standard : standard + "=".repeat(4 - remainder);
	try {
		const binary = atob(padded);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		const text = readUtf8(bytes);
		return { ok: true, text };
	} catch {
		return { ok: false };
	}
}

interface ExtractedPngCardChunk {
	keyword: "ccv3" | "chara";
	base64Payload: string;
}

export function extractPngCardChunk(bytes: Uint8Array):
	| { ok: true; chunk: ExtractedPngCardChunk }
	| {
			ok: false;
			code: "PNG_CORRUPT_CHUNK" | "PNG_NO_CARD_CHUNK" | "INVALID_BASE64";
			detail?: string;
	  } {
	if (!startsWithBytes(bytes, PNG_SIGNATURE)) {
		return {
			ok: false,
			code: "PNG_CORRUPT_CHUNK",
			detail: "missing signature",
		};
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 8;
	let ccv3Payload: string | null = null;
	let ccv3CorruptEncoding = false;
	let charaPayload: string | null = null;
	let sawIend = false;

	while (offset < bytes.byteLength) {
		if (offset + 12 > bytes.byteLength) {
			return {
				ok: false,
				code: "PNG_CORRUPT_CHUNK",
				detail: "truncated chunk header",
			};
		}
		const length = view.getUint32(offset, false);
		const typeBytes = bytes.subarray(offset + 4, offset + 8);
		const type = readLatin1(typeBytes);
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;
		const chunkEnd = dataEnd + 4; // +4 for CRC
		if (
			length > bytes.byteLength ||
			chunkEnd > bytes.byteLength ||
			dataEnd < dataStart
		) {
			return {
				ok: false,
				code: "PNG_CORRUPT_CHUNK",
				detail: `chunk ${type} length ${length} exceeds file bounds`,
			};
		}

		const data = bytes.subarray(dataStart, dataEnd);
		const expectedCrc = view.getUint32(dataEnd, false);
		const actualCrc = computeCrc32(bytes.subarray(offset + 4, dataEnd));
		if (actualCrc !== expectedCrc) {
			return {
				ok: false,
				code: "PNG_CORRUPT_CHUNK",
				detail: `chunk ${type} CRC mismatch`,
			};
		}

		if (type === "tEXt") {
			const nullIdx = data.indexOf(0);
			if (nullIdx > 0) {
				const keyword = readLatin1(data.subarray(0, nullIdx)).toLowerCase();
				if (keyword === "ccv3" || keyword === "chara") {
					const textValue = readLatin1(data.subarray(nullIdx + 1));
					if (keyword === "ccv3") {
						ccv3Payload = textValue;
						ccv3CorruptEncoding = false;
					} else if (charaPayload === null) {
						charaPayload = textValue;
					}
				}
			}
		} else if (type === "iTXt") {
			// iTXt layout:
			// keyword (1-79 bytes) + 0x00
			// compression flag (1 byte: 0 = uncompressed)
			// compression method (1 byte)
			// language tag + 0x00
			// translated keyword + 0x00
			// text (UTF-8)
			const kwEnd = data.indexOf(0);
			if (kwEnd > 0) {
				const keyword = readLatin1(data.subarray(0, kwEnd)).toLowerCase();
				if (keyword === "ccv3" || keyword === "chara") {
					if (kwEnd + 3 <= data.byteLength && data[kwEnd + 1] === 0) {
						const langStart = kwEnd + 3;
						const langEnd = data.indexOf(0, langStart);
						const transStart = langEnd >= langStart ? langEnd + 1 : -1;
						const transEnd = transStart >= 0 ? data.indexOf(0, transStart) : -1;
						if (transEnd >= transStart && transStart >= 0) {
							const textBytes = data.subarray(transEnd + 1);
							try {
								const textValue = readUtf8(textBytes);
								if (keyword === "ccv3") {
									ccv3Payload = textValue;
									ccv3CorruptEncoding = false;
								} else if (charaPayload === null) {
									charaPayload = textValue;
								}
							} catch {
								if (keyword === "ccv3") {
									ccv3CorruptEncoding = true;
								}
							}
						} else if (keyword === "ccv3") {
							ccv3CorruptEncoding = true;
						}
					} else if (keyword === "ccv3") {
						ccv3CorruptEncoding = true;
					}
				}
			}
		} else if (type === "IEND") {
			sawIend = true;
			offset = chunkEnd;
			break;
		}

		offset = chunkEnd;
	}

	if (!sawIend) {
		return { ok: false, code: "PNG_CORRUPT_CHUNK", detail: "unterminated PNG" };
	}

	if (ccv3CorruptEncoding) {
		return {
			ok: false,
			code: "INVALID_BASE64",
			detail: "corrupted ccv3 iTXt chunk",
		};
	}

	if (ccv3Payload !== null) {
		return {
			ok: true,
			chunk: { keyword: "ccv3", base64Payload: ccv3Payload },
		};
	}
	if (charaPayload !== null) {
		return {
			ok: true,
			chunk: { keyword: "chara", base64Payload: charaPayload },
		};
	}
	return { ok: false, code: "PNG_NO_CARD_CHUNK" };
}

function normalizeCharacterBook(
	rawBook: unknown,
):
	| { ok: true; book: NormalizedCharacterBook }
	| { ok: false; code: "TOO_MANY_LOREBOOK_ENTRIES" } {
	if (!isPlainRecord(rawBook)) {
		return {
			ok: true,
			book: { name: "", description: "", entries: [] },
		};
	}
	const rawEntries = Array.isArray(rawBook.entries)
		? rawBook.entries
		: isPlainRecord(rawBook.entries)
			? Object.values(rawBook.entries)
			: [];

	if (rawEntries.length > MAX_LOREBOOK_ENTRIES) {
		return { ok: false, code: "TOO_MANY_LOREBOOK_ENTRIES" };
	}

	const entries: NormalizedLorebookEntry[] = [];
	for (let i = 0; i < rawEntries.length; i++) {
		const item = rawEntries[i];
		if (!isPlainRecord(item)) continue;
		const keys = asStringArray(item.keys ?? item.key);
		const secondaryKeys = asStringArray(
			item.secondary_keys ?? item.keysecondary,
		);
		const content = asString(item.content);
		const enabled = asBoolean(
			item.enabled,
			typeof item.disable === "boolean" ? !item.disable : true,
		);
		const constant = asBoolean(item.constant, false);
		const insertionOrder = asNumber(item.insertion_order ?? item.order, 100);
		const priority = asNumber(item.priority, 10);
		const name = asString(item.name);
		const comment = asString(item.comment);
		const id =
			typeof item.id === "string" || typeof item.id === "number"
				? String(item.id)
				: `entry-${i + 1}`;
		entries.push({
			id,
			name,
			comment,
			keys,
			secondary_keys: secondaryKeys,
			content,
			enabled,
			constant,
			insertion_order: insertionOrder,
			priority,
		});
	}

	return {
		ok: true,
		book: {
			name: asString(rawBook.name),
			description: asString(rawBook.description),
			entries,
		},
	};
}

export function normalizeCardJsonObject(
	rawObj: unknown,
	sourceFormat: CardSourceFormat,
	chunkKeyword?: "ccv3" | "chara",
): CardParseResult {
	if (!isPlainRecord(rawObj)) {
		return { ok: false, code: "INVALID_JSON", detail: "root is not an object" };
	}

	let specVersion: CardSpecVersion = "v1";
	const hasExplicitSpec =
		"spec" in rawObj && rawObj.spec !== undefined && rawObj.spec !== null;
	if (hasExplicitSpec) {
		if (rawObj.spec === "chara_card_v3") {
			specVersion = "v3";
		} else if (rawObj.spec === "chara_card_v2") {
			specVersion = "v2";
		} else {
			return {
				ok: false,
				code: "UNKNOWN_SPEC",
				detail: String(rawObj.spec),
			};
		}
	} else if (chunkKeyword === "ccv3") {
		specVersion = "v3";
	} else if (chunkKeyword === "chara" && isPlainRecord(rawObj.data)) {
		specVersion = "v2";
	}

	if (specVersion === "v2" || specVersion === "v3") {
		const rawSpecVersion = rawObj.spec_version;
		if (rawSpecVersion !== undefined) {
			if (typeof rawSpecVersion !== "string") {
				return {
					ok: false,
					code: "INVALID_SPEC_VERSION",
					detail: String(rawSpecVersion),
				};
			}
			const validPrefix =
				specVersion === "v2"
					? rawSpecVersion.startsWith("2.0")
					: rawSpecVersion.startsWith("3.");
			if (!validPrefix) {
				return {
					ok: false,
					code: "INVALID_SPEC_VERSION",
					detail: rawSpecVersion,
				};
			}
		}
	}

	const dataLayer = isPlainRecord(rawObj.data) ? rawObj.data : null;
	if (specVersion === "v2" || specVersion === "v3") {
		if (!dataLayer) {
			return {
				ok: false,
				code: "INVALID_JSON",
				detail: "V2/V3 card requires a data object",
			};
		}
		if (typeof dataLayer.name !== "string" || !dataLayer.name.trim()) {
			return { ok: false, code: "MISSING_NAME" };
		}
	}

	const pickString = (key: string): string => {
		if (dataLayer && typeof dataLayer[key] === "string") {
			return dataLayer[key] as string;
		}
		if (typeof rawObj[key] === "string") {
			return rawObj[key] as string;
		}
		return "";
	};

	const pickStringArray = (key: string): string[] => {
		if (dataLayer && Array.isArray(dataLayer[key])) {
			return asStringArray(dataLayer[key]);
		}
		if (Array.isArray(rawObj[key])) {
			return asStringArray(rawObj[key]);
		}
		return [];
	};

	const name = pickString("name").trim();
	if (!name) {
		return { ok: false, code: "MISSING_NAME" };
	}

	const rawBook =
		(dataLayer && isPlainRecord(dataLayer.character_book)
			? dataLayer.character_book
			: null) ??
		(isPlainRecord(rawObj.character_book) ? rawObj.character_book : null);

	const bookCheck = normalizeCharacterBook(rawBook);
	if (!bookCheck.ok) {
		return { ok: false, code: bookCheck.code };
	}

	const card: NormalizedCharacterCard = {
		specVersion,
		sourceFormat,
		...(chunkKeyword ? { chunkKeyword } : {}),
		name,
		description: pickString("description"),
		personality: pickString("personality"),
		scenario: pickString("scenario"),
		first_mes: pickString("first_mes"),
		alternate_greetings: pickStringArray("alternate_greetings"),
		mes_example: pickString("mes_example"),
		system_prompt: pickString("system_prompt"),
		post_history_instructions: pickString("post_history_instructions"),
		creator: pickString("creator"),
		creator_notes: pickString("creator_notes"),
		tags: pickStringArray("tags"),
		character_book: bookCheck.book,
		rawJson: rawObj,
	};

	return { ok: true, card };
}

export function parseCharacterCardJsonText(
	jsonText: string,
	sourceFormat: CardSourceFormat = "json",
	chunkKeyword?: "ccv3" | "chara",
): CardParseResult {
	if (jsonText.length > MAX_CARD_JSON_CHARS) {
		return { ok: false, code: "JSON_TOO_LARGE" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (error) {
		return {
			ok: false,
			code: "INVALID_JSON",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	return normalizeCardJsonObject(parsed, sourceFormat, chunkKeyword);
}

interface ZipCentralDirEntry {
	path: string;
	method: number;
	flags: number;
	crc32: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
}

function isUnsafeZipPath(path: string): boolean {
	if (!path) return true;
	if (
		path.includes("\0") ||
		path.includes("\\") ||
		path.startsWith("/") ||
		/^[A-Za-z]:/.test(path) ||
		path.includes("..")
	) {
		return true;
	}
	const segments = path.split("/");
	return segments.some((seg) => seg === "" || seg === "." || seg === "..");
}

function hasZip64ExtraField(extra: Uint8Array): boolean {
	if (extra.byteLength < 4) return false;
	const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
	let offset = 0;
	while (offset + 4 <= extra.byteLength) {
		const headerId = view.getUint16(offset, true);
		const dataSize = view.getUint16(offset + 2, true);
		if (headerId === 0x0001) return true;
		offset += 4 + dataSize;
	}
	return false;
}

async function inflateRawWithSizeCheck(
	compressed: Uint8Array,
	expectedUncompressedSize: number,
	maxAllowedBytes: number,
): Promise<
	| { ok: true; bytes: Uint8Array }
	| {
			ok: false;
			code:
				| "CHARX_UNSUPPORTED_ENV"
				| "CHARX_DECOMPRESSION_BOMB"
				| "CHARX_CORRUPT_ZIP";
			detail?: string;
	  }
> {
	if (typeof DecompressionStream !== "function") {
		return { ok: false, code: "CHARX_UNSUPPORTED_ENV" };
	}
	let ds: DecompressionStream;
	try {
		ds = new DecompressionStream("deflate-raw");
	} catch {
		return { ok: false, code: "CHARX_UNSUPPORTED_ENV" };
	}

	const writer = ds.writable.getWriter();
	const reader = ds.readable.getReader();
	const writeTask = (async () => {
		try {
			await writer.write(new Uint8Array(compressed));
			await writer.close();
		} catch {
			// Reader cancellation or stream error is handled on the reader side
		}
	})();

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value && value.byteLength > 0) {
				totalBytes += value.byteLength;
				if (
					totalBytes > expectedUncompressedSize ||
					totalBytes > maxAllowedBytes
				) {
					await reader.cancel().catch(() => {});
					await writeTask;
					return {
						ok: false,
						code: "CHARX_DECOMPRESSION_BOMB",
						detail: "decompressed stream exceeded declared or maximum size",
					};
				}
				chunks.push(value);
			}
		}
		await writeTask;
	} catch (err) {
		await reader.cancel().catch(() => {});
		await writeTask;
		return {
			ok: false,
			code: "CHARX_CORRUPT_ZIP",
			detail: err instanceof Error ? err.message : String(err),
		};
	}

	if (totalBytes !== expectedUncompressedSize) {
		return {
			ok: false,
			code: "CHARX_DECOMPRESSION_BOMB",
			detail: `declared size ${expectedUncompressedSize} != actual ${totalBytes}`,
		};
	}

	const out = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, bytes: out };
}

function resolveImageMimeFromPathOrExt(
	path: string,
	extHint?: string,
): "image/png" | "image/jpeg" | "image/webp" | null {
	const lowerPath = path.toLowerCase();
	const lowerExt = (extHint ?? "").trim().toLowerCase().replace(/^\./, "");
	if (lowerPath.endsWith(".png") || lowerExt === "png") {
		return "image/png";
	}
	if (
		lowerPath.endsWith(".jpg") ||
		lowerPath.endsWith(".jpeg") ||
		lowerExt === "jpg" ||
		lowerExt === "jpeg"
	) {
		return "image/jpeg";
	}
	if (lowerPath.endsWith(".webp") || lowerExt === "webp") {
		return "image/webp";
	}
	return null;
}

export async function parseCharxBytes(
	bytes: Uint8Array,
): Promise<CardParseResult> {
	if (bytes.byteLength > MAX_CARD_FILE_BYTES) {
		return { ok: false, code: "FILE_TOO_LARGE" };
	}
	if (bytes.byteLength < 22) {
		return {
			ok: false,
			code: "CHARX_CORRUPT_ZIP",
			detail: "archive shorter than EOCD",
		};
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const minEocdOffset = Math.max(0, bytes.byteLength - 22 - 0xffff);
	let eocdPos = -1;
	for (let pos = bytes.byteLength - 22; pos >= minEocdOffset; pos--) {
		if (view.getUint32(pos, true) === 0x06054b50) {
			const commentLen = view.getUint16(pos + 20, true);
			if (pos + 22 + commentLen === bytes.byteLength) {
				eocdPos = pos;
				break;
			}
		}
	}

	if (eocdPos < 0) {
		return {
			ok: false,
			code: "CHARX_CORRUPT_ZIP",
			detail: "EOCD record not found",
		};
	}

	if (eocdPos >= 20 && view.getUint32(eocdPos - 20, true) === 0x07064b50) {
		return {
			ok: false,
			code: "CHARX_ZIP64_NOT_SUPPORTED",
			detail: "ZIP64 EOCD locator present",
		};
	}

	const diskNumber = view.getUint16(eocdPos + 4, true);
	const cdStartDisk = view.getUint16(eocdPos + 6, true);
	const entriesOnDisk = view.getUint16(eocdPos + 8, true);
	const totalEntries = view.getUint16(eocdPos + 10, true);
	const cdSize = view.getUint32(eocdPos + 12, true);
	const cdOffset = view.getUint32(eocdPos + 16, true);

	if (
		diskNumber === 0xffff ||
		cdStartDisk === 0xffff ||
		entriesOnDisk === 0xffff ||
		totalEntries === 0xffff ||
		cdSize === 0xffffffff ||
		cdOffset === 0xffffffff
	) {
		return {
			ok: false,
			code: "CHARX_ZIP64_NOT_SUPPORTED",
			detail: "ZIP64 sentinel in EOCD",
		};
	}

	if (diskNumber !== 0 || cdStartDisk !== 0 || entriesOnDisk !== totalEntries) {
		return {
			ok: false,
			code: "CHARX_CORRUPT_ZIP",
			detail: "multi-disk ZIP not supported",
		};
	}

	if (totalEntries > MAX_CHARX_ENTRIES) {
		return {
			ok: false,
			code: "CHARX_DECOMPRESSION_BOMB",
			detail: `too many ZIP entries: ${totalEntries}`,
		};
	}

	if (cdOffset > eocdPos || cdSize > eocdPos - cdOffset) {
		return {
			ok: false,
			code: "CHARX_CORRUPT_ZIP",
			detail: "central directory out of bounds",
		};
	}

	const validEntries: ZipCentralDirEntry[] = [];
	let declaredTotalUncompressed = 0;
	let cdPtr = cdOffset;
	const cdEnd = cdOffset + cdSize;

	for (let i = 0; i < totalEntries; i++) {
		if (cdPtr + 46 > cdEnd) {
			return {
				ok: false,
				code: "CHARX_CORRUPT_ZIP",
				detail: "truncated central directory entry",
			};
		}
		if (view.getUint32(cdPtr, true) !== 0x02014b50) {
			return {
				ok: false,
				code: "CHARX_CORRUPT_ZIP",
				detail: "invalid central directory signature",
			};
		}

		const flags = view.getUint16(cdPtr + 8, true);
		const method = view.getUint16(cdPtr + 10, true);
		const crc32 = view.getUint32(cdPtr + 16, true);
		const compressedSize = view.getUint32(cdPtr + 20, true);
		const uncompressedSize = view.getUint32(cdPtr + 24, true);
		const fileNameLen = view.getUint16(cdPtr + 28, true);
		const extraLen = view.getUint16(cdPtr + 30, true);
		const commentLen = view.getUint16(cdPtr + 32, true);
		const localHeaderOffset = view.getUint32(cdPtr + 42, true);

		const entryEnd = cdPtr + 46 + fileNameLen + extraLen + commentLen;
		if (entryEnd > cdEnd) {
			return {
				ok: false,
				code: "CHARX_CORRUPT_ZIP",
				detail: "central directory entry exceeds bounds",
			};
		}

		if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || method === 99) {
			return {
				ok: false,
				code: "CHARX_ENCRYPTED",
				detail: "encrypted ZIP entry is not supported",
			};
		}

		const extraBytes = bytes.subarray(
			cdPtr + 46 + fileNameLen,
			cdPtr + 46 + fileNameLen + extraLen,
		);
		if (
			compressedSize === 0xffffffff ||
			uncompressedSize === 0xffffffff ||
			localHeaderOffset === 0xffffffff ||
			hasZip64ExtraField(extraBytes)
		) {
			return {
				ok: false,
				code: "CHARX_ZIP64_NOT_SUPPORTED",
				detail: "ZIP64 entry is not supported",
			};
		}

		const nameBytes = bytes.subarray(cdPtr + 46, cdPtr + 46 + fileNameLen);
		cdPtr = entryEnd;

		let entryPath: string;
		try {
			entryPath = readUtf8(nameBytes);
		} catch {
			continue;
		}

		// Ignore directories and unsafe paths (.., absolute path, backslash)
		if (entryPath.endsWith("/") || isUnsafeZipPath(entryPath)) {
			continue;
		}

		if (method !== 0 && method !== 8) {
			return {
				ok: false,
				code: "CHARX_CORRUPT_ZIP",
				detail: `unsupported compression method ${method}`,
			};
		}

		declaredTotalUncompressed += uncompressedSize;
		if (declaredTotalUncompressed > MAX_CHARX_TOTAL_UNCOMPRESSED_BYTES) {
			return {
				ok: false,
				code: "CHARX_DECOMPRESSION_BOMB",
				detail: "total declared uncompressed size exceeds 50MB",
			};
		}

		validEntries.push({
			path: entryPath,
			method,
			flags,
			crc32,
			compressedSize,
			uncompressedSize,
			localHeaderOffset,
		});
	}

	const extractedMap = new Map<string, Uint8Array>();
	let actualTotalUncompressed = 0;

	for (const entry of validEntries) {
		const lhOffset = entry.localHeaderOffset;
		if (lhOffset + 30 > cdOffset) {
			return {
				ok: false,
				code: "CHARX_CORRUPT_ZIP",
				detail: "local file header out of bounds",
			};
		}
		if (view.getUint32(lhOffset, true) !== 0x04034b50) {
			return {
				ok: false,
				code: "CHARX_CORRUPT_ZIP",
				detail: "invalid local file header signature",
			};
		}
		const lfFlags = view.getUint16(lhOffset + 6, true);
		const lfMethod = view.getUint16(lhOffset + 8, true);
		const lfNameLen = view.getUint16(lhOffset + 26, true);
		const lfExtraLen = view.getUint16(lhOffset + 28, true);

		if ((lfFlags & 0x0001) !== 0 || (lfFlags & 0x0040) !== 0) {
			return {
				ok: false,
				code: "CHARX_ENCRYPTED",
				detail: "encrypted local header",
			};
		}
		if (lfMethod !== entry.method) {
			return {
				ok: false,
				code: "CHARX_CORRUPT_ZIP",
				detail: "compression method mismatch between CD and local header",
			};
		}

		const dataStart = lhOffset + 30 + lfNameLen + lfExtraLen;
		const dataEnd = dataStart + entry.compressedSize;
		if (dataStart < 0 || dataEnd > cdOffset || dataEnd < dataStart) {
			return {
				ok: false,
				code: "CHARX_CORRUPT_ZIP",
				detail: "entry data out of bounds",
			};
		}

		const remainingTotalBudget =
			MAX_CHARX_TOTAL_UNCOMPRESSED_BYTES - actualTotalUncompressed;
		if (entry.uncompressedSize > remainingTotalBudget) {
			return {
				ok: false,
				code: "CHARX_DECOMPRESSION_BOMB",
				detail: "uncompressed size exceeds 50MB total budget",
			};
		}

		let content: Uint8Array;
		if (entry.method === 0) {
			if (entry.compressedSize !== entry.uncompressedSize) {
				return {
					ok: false,
					code: "CHARX_DECOMPRESSION_BOMB",
					detail: "stored entry compressed size != uncompressed size",
				};
			}
			content = bytes.subarray(dataStart, dataEnd);
			actualTotalUncompressed += content.byteLength;
		} else {
			const inflated = await inflateRawWithSizeCheck(
				bytes.subarray(dataStart, dataEnd),
				entry.uncompressedSize,
				remainingTotalBudget,
			);
			if (!inflated.ok) {
				return inflated;
			}
			content = inflated.bytes;
			actualTotalUncompressed += content.byteLength;
		}

		if (computeCrc32(content) !== entry.crc32) {
			return {
				ok: false,
				code: "CHARX_CORRUPT_ZIP",
				detail: `CRC32 mismatch on ${entry.path}`,
			};
		}

		extractedMap.set(entry.path, content);
	}

	const cardJsonBytes = extractedMap.get("card.json");
	if (!cardJsonBytes) {
		return { ok: false, code: "CHARX_MISSING_CARD_JSON" };
	}

	let cardJsonText: string;
	try {
		cardJsonText = readUtf8(cardJsonBytes).trim();
	} catch {
		return {
			ok: false,
			code: "INVALID_JSON",
			detail: "card.json is not valid UTF-8",
		};
	}

	const cleanCardJson = cardJsonText.startsWith("\uFEFF")
		? cardJsonText.slice(1).trim()
		: cardJsonText;
	const parsedCard = parseCharacterCardJsonText(cleanCardJson, "charx");
	if (!parsedCard.ok) {
		return parsedCard;
	}

	const rawObj = parsedCard.card.rawJson;
	const dataLayer = isPlainRecord(rawObj.data) ? rawObj.data : null;
	const rawAssets = Array.isArray(dataLayer?.assets)
		? dataLayer.assets
		: Array.isArray(rawObj.assets)
			? rawObj.assets
			: [];

	let selectedIconBytes: Uint8Array | undefined;
	let selectedIconMime: string | undefined;

	for (const item of rawAssets) {
		if (!isPlainRecord(item)) continue;
		const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
		const uri = typeof item.uri === "string" ? item.uri.trim() : "";
		if (type !== "icon" || !/^embedd?ed:\/\//i.test(uri)) {
			continue;
		}
		const relPath = uri.replace(/^embedd?ed:\/\//i, "").replace(/^\.\//, "");
		if (isUnsafeZipPath(relPath)) continue;
		const mime = resolveImageMimeFromPathOrExt(
			relPath,
			typeof item.ext === "string" ? item.ext : undefined,
		);
		if (!mime) continue;
		const assetBytes = extractedMap.get(relPath);
		if (!assetBytes) continue;
		if (assetBytes.byteLength > MAX_CHARX_IMAGE_BYTES) {
			return {
				ok: false,
				code: "CHARX_DECOMPRESSION_BOMB",
				detail: "embedded icon image exceeds 10MB limit",
			};
		}
		selectedIconBytes = assetBytes;
		selectedIconMime = mime;
		if (typeof item.name === "string" && item.name.toLowerCase() === "main") {
			break;
		}
	}

	return {
		ok: true,
		card: parsedCard.card,
		...(selectedIconBytes && selectedIconMime
			? { imageBytes: selectedIconBytes, imageMimeType: selectedIconMime }
			: {}),
	};
}

export function parsePngOrJsonCardBytes(
	bytes: Uint8Array,
	fileName = "",
): CardParseResult {
	if (bytes.byteLength > MAX_CARD_FILE_BYTES) {
		return { ok: false, code: "FILE_TOO_LARGE" };
	}

	const lowerName = fileName.trim().toLowerCase();

	if (startsWithBytes(bytes, PNG_SIGNATURE)) {
		const chunkResult = extractPngCardChunk(bytes);
		if (!chunkResult.ok) {
			return {
				ok: false,
				code: chunkResult.code,
				detail: chunkResult.detail,
			};
		}
		const decoded = decodeBase64Utf8(chunkResult.chunk.base64Payload);
		if (!decoded.ok) {
			return { ok: false, code: "INVALID_BASE64" };
		}
		return parseCharacterCardJsonText(
			decoded.text,
			"png",
			chunkResult.chunk.keyword,
		);
	}

	if (lowerName.endsWith(".png")) {
		return { ok: false, code: "NOT_PNG_OR_JSON", detail: "invalid PNG header" };
	}

	let text: string;
	try {
		text = readUtf8(bytes).trim();
	} catch {
		return { ok: false, code: "NOT_PNG_OR_JSON" };
	}

	// Strip UTF-8 BOM if present
	const cleanText = text.startsWith("\uFEFF") ? text.slice(1).trim() : text;
	if (!cleanText.startsWith("{")) {
		if (lowerName.endsWith(".json")) {
			return { ok: false, code: "INVALID_JSON" };
		}
		return { ok: false, code: "NOT_PNG_OR_JSON" };
	}

	return parseCharacterCardJsonText(cleanText, "json");
}

export async function parseCharacterCardBytes(
	bytes: Uint8Array,
	fileName = "",
): Promise<CardParseResult> {
	Logger.debug(TAG, "parsing character card bytes", {
		fileName,
		byteLength: bytes.byteLength,
	});

	if (bytes.byteLength > MAX_CARD_FILE_BYTES) {
		return { ok: false, code: "FILE_TOO_LARGE" };
	}

	const lowerName = fileName.trim().toLowerCase();
	if (
		lowerName.endsWith(".charx") ||
		startsWithBytes(bytes, ZIP_PK_SIGNATURE) ||
		startsWithBytes(bytes, ZIP_EMPTY_EOCD_SIGNATURE)
	) {
		return parseCharxBytes(bytes);
	}

	return parsePngOrJsonCardBytes(bytes, fileName);
}
