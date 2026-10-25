import { Logger } from "../../lib/logger";

const TAG = "CharCardParser";

export const MAX_CARD_FILE_BYTES = 20 * 1024 * 1024; // 20 MB
export const MAX_CARD_JSON_CHARS = 2 * 1024 * 1024; // 2 MB characters
export const MAX_LOREBOOK_ENTRIES = 1000;

export type CardParseErrorCode =
	| "FILE_TOO_LARGE"
	| "JSON_TOO_LARGE"
	| "TOO_MANY_LOREBOOK_ENTRIES"
	| "CHARX_NOT_SUPPORTED"
	| "NOT_PNG_OR_JSON"
	| "PNG_CORRUPT_CHUNK"
	| "PNG_NO_CARD_CHUNK"
	| "INVALID_BASE64"
	| "INVALID_JSON"
	| "UNKNOWN_SPEC"
	| "MISSING_NAME";

export type CardSpecVersion = "v1" | "v2" | "v3";
export type CardSourceFormat = "png" | "json";

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
	| { ok: true; card: NormalizedCharacterCard }
	| { ok: false; code: CardParseErrorCode; detail?: string };

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const ZIP_PK_SIGNATURE = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

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
			code: "PNG_CORRUPT_CHUNK" | "PNG_NO_CARD_CHUNK";
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
		if (type === "tEXt") {
			const nullIdx = data.indexOf(0);
			if (nullIdx > 0) {
				const keyword = readLatin1(data.subarray(0, nullIdx)).toLowerCase();
				if (keyword === "ccv3" || keyword === "chara") {
					const textValue = readLatin1(data.subarray(nullIdx + 1));
					if (keyword === "ccv3") {
						ccv3Payload = textValue;
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
			if (kwEnd > 0 && kwEnd + 3 <= data.byteLength) {
				const keyword = readLatin1(data.subarray(0, kwEnd)).toLowerCase();
				const compressionFlag = data[kwEnd + 1];
				if (
					compressionFlag === 0 &&
					(keyword === "ccv3" || keyword === "chara")
				) {
					const langStart = kwEnd + 3;
					const langEnd = data.indexOf(0, langStart);
					if (langEnd >= langStart) {
						const transStart = langEnd + 1;
						const transEnd = data.indexOf(0, transStart);
						if (transEnd >= transStart) {
							const textBytes = data.subarray(transEnd + 1);
							try {
								const textValue = readUtf8(textBytes);
								if (keyword === "ccv3") {
									ccv3Payload = textValue;
								} else if (charaPayload === null) {
									charaPayload = textValue;
								}
							} catch {
								// Ignore malformed UTF-8 in non-matching or broken iTXt
							}
						}
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

	if (!sawIend && offset !== bytes.byteLength) {
		return { ok: false, code: "PNG_CORRUPT_CHUNK", detail: "unterminated PNG" };
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
	if ("spec" in rawObj && rawObj.spec !== undefined && rawObj.spec !== null) {
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

	const dataLayer = isPlainRecord(rawObj.data) ? rawObj.data : null;
	if ((specVersion === "v2" || specVersion === "v3") && !dataLayer) {
		// V2/V3 spec requires `data` object, though some cards also mirror fields at top-level.
		// If neither `data` nor top-level `name` exists, fail cleanly.
		if (typeof rawObj.name !== "string") {
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

export function parseCharacterCardBytes(
	bytes: Uint8Array,
	fileName = "",
): CardParseResult {
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
		startsWithBytes(bytes, ZIP_PK_SIGNATURE)
	) {
		return { ok: false, code: "CHARX_NOT_SUPPORTED" };
	}

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
