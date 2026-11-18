import { Logger } from "./logger";

const TAG = "PptxOoxml";

export const PPTX_MIME_TYPE =
	"application/vnd.openxmlformats-officedocument.presentationml.presentation";

const MAX_PPTX_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2048;
const MAX_ZIP_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_XML_BYTES = 8 * 1024 * 1024;

const DEFAULT_SLIDE_WIDTH_EMU = 12_192_000; // 16:9 (13.333 in)
const DEFAULT_SLIDE_HEIGHT_EMU = 6_858_000; // 16:9 (7.5 in)
const DEFAULT_NOTES_WIDTH_EMU = 6_858_000;
const DEFAULT_NOTES_HEIGHT_EMU = 9_144_000;

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8");

export interface PptxBulletItem {
	text: string;
	level: number;
}

export interface PptxEmbeddedImage {
	id: string;
	mimeType: string;
	extension: "png" | "jpeg" | "gif" | "webp" | "svg";
	bytes: Uint8Array;
	dataUrl: string;
	xPct: number;
	yPct: number;
	wPct: number;
	hPct: number;
	alt?: string;
}

export interface PptxTableGrid {
	rows: string[][];
}

export interface PptxSlideRecord {
	index: number; // 1-based slide number
	title: string;
	subtitle?: string;
	bullets: PptxBulletItem[];
	tables: PptxTableGrid[];
	images: PptxEmbeddedImage[];
	backgroundHex?: string;
	notes: string;
	plainText: string;
}

export interface ParsedPptxDeck {
	slideWidthEmu: number;
	slideHeightEmu: number;
	slides: PptxSlideRecord[];
	speakerNotes: Map<number, string>;
	scriptMarkdown: string;
	pageTexts: string[];
}

export interface BuildPptxSlideInput {
	title: string;
	subtitle?: string;
	bullets?: ReadonlyArray<string | PptxBulletItem>;
	tables?: ReadonlyArray<PptxTableGrid>;
	images?: ReadonlyArray<
		Pick<PptxEmbeddedImage, "mimeType" | "extension" | "bytes"> &
			Partial<Pick<PptxEmbeddedImage, "xPct" | "yPct" | "wPct" | "hPct" | "alt">>
	>;
	backgroundHex?: string;
	notes?: string;
}

export interface BuildPptxDeckInput {
	title?: string;
	creator?: string;
	slideWidthEmu?: number;
	slideHeightEmu?: number;
	slides: ReadonlyArray<BuildPptxSlideInput>;
}

export interface PptxValidationReport {
	valid: boolean;
	slideCount: number;
	hasMaster: boolean;
	hasLayout: boolean;
	hasTheme: boolean;
	notesCount: number;
	errors: string[];
}

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i += 1) {
		let c = i;
		for (let k = 0; k < 8; k += 1) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[i] = c >>> 0;
	}
	return table;
})();

export function computeCrc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i += 1) {
		crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function writeU16LE(buf: Uint8Array, offset: number, val: number): void {
	buf[offset] = val & 0xff;
	buf[offset + 1] = (val >>> 8) & 0xff;
}

function writeU32LE(buf: Uint8Array, offset: number, val: number): void {
	buf[offset] = val & 0xff;
	buf[offset + 1] = (val >>> 8) & 0xff;
	buf[offset + 2] = (val >>> 16) & 0xff;
	buf[offset + 3] = (val >>> 24) & 0xff;
}

function readU16LE(buf: Uint8Array, offset: number): number {
	return buf[offset] | (buf[offset + 1] << 8);
}

function readU32LE(buf: Uint8Array, offset: number): number {
	return (
		(buf[offset] |
			(buf[offset + 1] << 8) |
			(buf[offset + 2] << 16) |
			(buf[offset + 3] << 24)) >>>
		0
	);
}

function safeZipEntryName(name: string): boolean {
	if (!name || name.length > 512) return false;
	if (name.startsWith("/") || name.includes("\\") || name.includes(":")) {
		return false;
	}
	for (let i = 0; i < name.length; i += 1) {
		if (name.charCodeAt(i) < 0x20) return false;
	}
	for (const segment of name.split("/")) {
		if (segment === "." || segment === "..") return false;
	}
	return true;
}

function normalizePptxTargetPath(baseDir: string, rawTarget: string): string | null {
	if (!rawTarget || rawTarget.includes("\\") || rawTarget.includes(":")) {
		return null;
	}
	const combined = rawTarget.startsWith("/")
		? rawTarget.slice(1)
		: baseDir
			? `${baseDir}/${rawTarget}`
			: rawTarget;
	const stack: string[] = [];
	for (const part of combined.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (stack.length === 0) return null;
			stack.pop();
			continue;
		}
		stack.push(part);
	}
	return stack.length > 0 ? stack.join("/") : null;
}

async function inflateRawBytes(compressed: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream !== "undefined") {
		const ds = new DecompressionStream("deflate-raw");
		const writer = ds.writable.getWriter();
		void writer.write(compressed as unknown as BufferSource);
		void writer.close();
		const reader = ds.readable.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				chunks.push(value);
				total += value.length;
				if (total > MAX_ZIP_TOTAL_BYTES) {
					throw new Error("invalid_pptx");
				}
			}
		}
		const out = new Uint8Array(total);
		let pos = 0;
		for (const chunk of chunks) {
			out.set(chunk, pos);
			pos += chunk.length;
		}
		return out;
	}
	throw new Error("invalid_pptx");
}

function isXmlEntryName(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.endsWith(".xml") || lower.endsWith(".rels");
}

export async function readPptxZipEntries(
	zipBytes: Uint8Array,
): Promise<Map<string, Uint8Array>> {
	Logger.debug(TAG, "reading zip entries", { size: zipBytes.length });
	if (
		zipBytes.length < 22 ||
		zipBytes.length > MAX_PPTX_BYTES ||
		zipBytes[0] !== 0x50 ||
		zipBytes[1] !== 0x4b
	) {
		throw new Error("invalid_pptx");
	}

	let eocdOffset = -1;
	const minOffset = Math.max(0, zipBytes.length - 65558);
	for (let i = zipBytes.length - 22; i >= minOffset; i -= 1) {
		if (readU32LE(zipBytes, i) === 0x06054b50) {
			eocdOffset = i;
			break;
		}
	}
	if (eocdOffset < 0) {
		throw new Error("invalid_pptx");
	}

	const entryCount = readU16LE(zipBytes, eocdOffset + 10);
	if (entryCount === 0 || entryCount > MAX_ZIP_ENTRIES) {
		throw new Error("invalid_pptx");
	}
	const cdOffset = readU32LE(zipBytes, eocdOffset + 16);
	if (cdOffset >= zipBytes.length) {
		throw new Error("invalid_pptx");
	}

	const entries = new Map<string, Uint8Array>();
	let ptr = cdOffset;
	let totalUncompressed = 0;

	for (let idx = 0; idx < entryCount && ptr + 46 <= zipBytes.length; idx += 1) {
		if (readU32LE(zipBytes, ptr) !== 0x02014b50) break;
		const compression = readU16LE(zipBytes, ptr + 10);
		const compSize = readU32LE(zipBytes, ptr + 20);
		const uncompSize = readU32LE(zipBytes, ptr + 24);
		const nameLen = readU16LE(zipBytes, ptr + 28);
		const extraLen = readU16LE(zipBytes, ptr + 30);
		const commentLen = readU16LE(zipBytes, ptr + 32);
		const localHeaderOffset = readU32LE(zipBytes, ptr + 42);
		if (ptr + 46 + nameLen > zipBytes.length) {
			throw new Error("invalid_pptx");
		}
		const name = UTF8_DECODER.decode(
			zipBytes.subarray(ptr + 46, ptr + 46 + nameLen),
		);
		ptr += 46 + nameLen + extraLen + commentLen;

		if (name.endsWith("/")) continue;
		if (!safeZipEntryName(name)) {
			throw new Error("invalid_pptx");
		}
		if (isXmlEntryName(name) && uncompSize > MAX_XML_BYTES) {
			throw new Error("invalid_pptx");
		}
		totalUncompressed += uncompSize;
		if (totalUncompressed > MAX_ZIP_TOTAL_BYTES) {
			throw new Error("invalid_pptx");
		}

		if (
			localHeaderOffset + 30 > zipBytes.length ||
			readU32LE(zipBytes, localHeaderOffset) !== 0x04034b50
		) {
			throw new Error("invalid_pptx");
		}
		const localNameLen = readU16LE(zipBytes, localHeaderOffset + 26);
		const localExtraLen = readU16LE(zipBytes, localHeaderOffset + 28);
		const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
		if (dataStart + compSize > zipBytes.length) {
			throw new Error("invalid_pptx");
		}
		const rawSlice = zipBytes.subarray(dataStart, dataStart + compSize);

		if (compression === 0) {
			entries.set(name, rawSlice.slice());
		} else if (compression === 8) {
			const inflated = await inflateRawBytes(rawSlice);
			if (isXmlEntryName(name) && inflated.length > MAX_XML_BYTES) {
				throw new Error("invalid_pptx");
			}
			entries.set(name, inflated);
		} else {
			throw new Error("invalid_pptx");
		}
	}

	if (entries.size === 0) {
		throw new Error("invalid_pptx");
	}
	return entries;
}

export function writePptxZipEntries(
	files: ReadonlyArray<{ name: string; data: Uint8Array | string }>,
): Uint8Array {
	Logger.debug(TAG, "writing zip archive", { fileCount: files.length });
	const prepared = files.map((file) => {
		const nameBytes = UTF8_ENCODER.encode(file.name);
		const dataBytes =
			typeof file.data === "string" ? UTF8_ENCODER.encode(file.data) : file.data;
		const crc = computeCrc32(dataBytes);
		return { nameBytes, dataBytes, crc };
	});

	let localTotal = 0;
	let centralTotal = 0;
	for (const item of prepared) {
		localTotal += 30 + item.nameBytes.length + item.dataBytes.length;
		centralTotal += 46 + item.nameBytes.length;
	}

	const out = new Uint8Array(localTotal + centralTotal + 22);
	let localOffset = 0;
	const offsets: number[] = [];

	// Valid DOS date/time: 1980-01-01 00:00:00 (date = 0x0021, time = 0x0000)
	const dosTime = 0x0000;
	const dosDate = 0x0021;

	for (const item of prepared) {
		offsets.push(localOffset);
		writeU32LE(out, localOffset, 0x04034b50);
		writeU16LE(out, localOffset + 4, 20);
		writeU16LE(out, localOffset + 6, 0x0800); // UTF-8 filename flag
		writeU16LE(out, localOffset + 8, 0); // Stored
		writeU16LE(out, localOffset + 10, dosTime);
		writeU16LE(out, localOffset + 12, dosDate);
		writeU32LE(out, localOffset + 14, item.crc);
		writeU32LE(out, localOffset + 18, item.dataBytes.length);
		writeU32LE(out, localOffset + 22, item.dataBytes.length);
		writeU16LE(out, localOffset + 26, item.nameBytes.length);
		writeU16LE(out, localOffset + 28, 0);
		out.set(item.nameBytes, localOffset + 30);
		out.set(item.dataBytes, localOffset + 30 + item.nameBytes.length);
		localOffset += 30 + item.nameBytes.length + item.dataBytes.length;
	}

	const cdStart = localOffset;
	let cdPtr = cdStart;
	for (let i = 0; i < prepared.length; i += 1) {
		const item = prepared[i];
		writeU32LE(out, cdPtr, 0x02014b50);
		writeU16LE(out, cdPtr + 4, 20);
		writeU16LE(out, cdPtr + 6, 20);
		writeU16LE(out, cdPtr + 8, 0x0800);
		writeU16LE(out, cdPtr + 10, 0);
		writeU16LE(out, cdPtr + 12, dosTime);
		writeU16LE(out, cdPtr + 14, dosDate);
		writeU32LE(out, cdPtr + 16, item.crc);
		writeU32LE(out, cdPtr + 20, item.dataBytes.length);
		writeU32LE(out, cdPtr + 24, item.dataBytes.length);
		writeU16LE(out, cdPtr + 28, item.nameBytes.length);
		writeU16LE(out, cdPtr + 30, 0);
		writeU16LE(out, cdPtr + 32, 0);
		writeU16LE(out, cdPtr + 34, 0);
		writeU16LE(out, cdPtr + 36, 0);
		writeU32LE(out, cdPtr + 38, 0);
		writeU32LE(out, cdPtr + 42, offsets[i]);
		out.set(item.nameBytes, cdPtr + 46);
		cdPtr += 46 + item.nameBytes.length;
	}

	writeU32LE(out, cdPtr, 0x06054b50);
	writeU16LE(out, cdPtr + 4, 0);
	writeU16LE(out, cdPtr + 6, 0);
	writeU16LE(out, cdPtr + 8, prepared.length);
	writeU16LE(out, cdPtr + 10, prepared.length);
	writeU32LE(out, cdPtr + 12, cdPtr - cdStart);
	writeU32LE(out, cdPtr + 16, cdStart);
	writeU16LE(out, cdPtr + 20, 0);

	return out;
}

export function escapeOoxmlText(raw: string): string {
	let cleaned = "";
	for (let i = 0; i < raw.length; i += 1) {
		const code = raw.charCodeAt(i);
		if (code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20) {
			cleaned += raw[i];
		}
	}
	return cleaned
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function parseXmlDocument(xmlText: string): Document {
	const cleaned = xmlText.replace(/^\uFEFF/, "");
	const parser = new DOMParser();
	const doc = parser.parseFromString(cleaned, "application/xml");
	if (doc.getElementsByTagName("parsererror").length > 0) {
		throw new Error("invalid_pptx");
	}
	return doc;
}

function elementsByLocal(
	root: Document | Element,
	localName: string,
): Element[] {
	const out: Element[] = [];
	const all = root.getElementsByTagName("*");
	for (let i = 0; i < all.length; i += 1) {
		const el = all.item(i);
		if (!el) continue;
		const ln = el.localName || el.tagName.split(":").pop() || "";
		if (ln === localName) out.push(el);
	}
	return out;
}

function firstElementByLocal(
	root: Document | Element,
	localName: string,
): Element | null {
	const all = root.getElementsByTagName("*");
	for (let i = 0; i < all.length; i += 1) {
		const el = all.item(i);
		if (!el) continue;
		const ln = el.localName || el.tagName.split(":").pop() || "";
		if (ln === localName) return el;
	}
	return null;
}

function attrByLocal(el: Element, localAttrName: string): string | null {
	for (let i = 0; i < el.attributes.length; i += 1) {
		const attr = el.attributes.item(i);
		if (!attr) continue;
		const ln = attr.localName || attr.name.split(":").pop() || "";
		if (ln === localAttrName) return attr.value;
	}
	return null;
}

interface OoxmlRelationship {
	id: string;
	type: string;
	target: string;
	external: boolean;
}

function parseOoxmlRelationships(xmlText: string): Map<string, OoxmlRelationship> {
	const doc = parseXmlDocument(xmlText);
	const map = new Map<string, OoxmlRelationship>();
	for (const rel of elementsByLocal(doc, "Relationship")) {
		const id = rel.getAttribute("Id") ?? "";
		const type = rel.getAttribute("Type") ?? "";
		const target = rel.getAttribute("Target") ?? "";
		const targetMode = (rel.getAttribute("TargetMode") ?? "").toLowerCase();
		if (id && target) {
			map.set(id, {
				id,
				type,
				target,
				external: targetMode === "external",
			});
		}
	}
	return map;
}

function uint8ToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const slice = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode(...slice);
	}
	return btoa(binary);
}

function detectImageMediaType(
	path: string,
): { mimeType: string; extension: PptxEmbeddedImage["extension"] } | null {
	const lower = path.toLowerCase();
	if (lower.endsWith(".png")) {
		return { mimeType: "image/png", extension: "png" };
	}
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
		return { mimeType: "image/jpeg", extension: "jpeg" };
	}
	if (lower.endsWith(".gif")) {
		return { mimeType: "image/gif", extension: "gif" };
	}
	if (lower.endsWith(".webp")) {
		return { mimeType: "image/webp", extension: "webp" };
	}
	if (lower.endsWith(".svg")) {
		return { mimeType: "image/svg+xml", extension: "svg" };
	}
	return null;
}

function extractParagraphText(pEl: Element): string {
	let text = "";
	const walk = (node: Node) => {
		if (node.nodeType !== 1) return;
		const el = node as Element;
		const ln = el.localName || el.tagName.split(":").pop() || "";
		if (ln === "t") {
			text += el.textContent ?? "";
			return;
		}
		if (ln === "br") {
			text += "\n";
			return;
		}
		if (ln === "tab") {
			text += "\t";
			return;
		}
		for (let i = 0; i < el.childNodes.length; i += 1) {
			const child = el.childNodes.item(i);
			if (child) walk(child);
		}
	};
	walk(pEl);
	return text;
}

const IGNORED_PLACEHOLDER_TYPES = new Set(["sldnum", "dt", "ftr", "hdr"]);

function extractSpeakerNotesFromXml(xmlText: string): string {
	const doc = parseXmlDocument(xmlText);
	const paragraphs: string[] = [];
	for (const sp of elementsByLocal(doc, "sp")) {
		const ph = firstElementByLocal(sp, "ph");
		const phType = (ph?.getAttribute("type") ?? "").toLowerCase();
		if (IGNORED_PLACEHOLDER_TYPES.has(phType)) continue;
		const txBody = firstElementByLocal(sp, "txBody");
		if (!txBody) continue;
		for (const p of elementsByLocal(txBody, "p")) {
			const line = extractParagraphText(p).trim();
			if (line) paragraphs.push(line);
		}
	}
	return paragraphs.join("\n").trim();
}

function buildScriptMarkdownFromNotes(notes: Map<number, string>): string {
	if (notes.size === 0) return "";
	const sorted = [...notes.entries()].sort(([a], [b]) => a - b);
	return sorted
		.map(([page, text]) => `## ${page}\n${text.trim()}`)
		.join("\n\n");
}

function clampPct(value: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(100, Number(value.toFixed(2))));
}

export async function parsePptxPresentation(
	bytes: Uint8Array,
): Promise<ParsedPptxDeck> {
	Logger.debug(TAG, "parsing PPTX presentation", { byteLength: bytes.length });
	const entries = await readPptxZipEntries(bytes);

	const presBytes = entries.get("ppt/presentation.xml");
	const presRelsBytes = entries.get("ppt/_rels/presentation.xml.rels");
	if (!presBytes || !presRelsBytes) {
		throw new Error("invalid_pptx");
	}

	const presDoc = parseXmlDocument(UTF8_DECODER.decode(presBytes));
	const presRels = parseOoxmlRelationships(UTF8_DECODER.decode(presRelsBytes));

	const sldSzEl = firstElementByLocal(presDoc, "sldSz");
	const rawCx = Number.parseInt(sldSzEl?.getAttribute("cx") ?? "", 10);
	const rawCy = Number.parseInt(sldSzEl?.getAttribute("cy") ?? "", 10);
	const slideWidthEmu =
		Number.isFinite(rawCx) && rawCx > 0 ? rawCx : DEFAULT_SLIDE_WIDTH_EMU;
	const slideHeightEmu =
		Number.isFinite(rawCy) && rawCy > 0 ? rawCy : DEFAULT_SLIDE_HEIGHT_EMU;

	const sldIdLst = firstElementByLocal(presDoc, "sldIdLst");
	const sldIdEls = sldIdLst ? elementsByLocal(sldIdLst, "sldId") : [];
	if (sldIdEls.length === 0 || sldIdEls.length > 500) {
		throw new Error("invalid_pptx");
	}

	const slidePaths: string[] = [];
	for (const sldIdEl of sldIdEls) {
		const relId =
			sldIdEl.getAttribute("r:id") ??
			sldIdEl.getAttributeNS(
				"http://schemas.openxmlformats.org/officeDocument/2006/relationships",
				"id",
			);
		if (!relId) throw new Error("invalid_pptx");
		const rel = presRels.get(relId);
		if (!rel || rel.external) throw new Error("invalid_pptx");
		const normalized = rel.target.startsWith("/ppt/")
			? normalizePptxTargetPath("", rel.target)
			: rel.target.startsWith("ppt/")
				? normalizePptxTargetPath("", rel.target)
				: normalizePptxTargetPath("ppt", rel.target);
		if (!normalized || !normalized.startsWith("ppt/") || !entries.has(normalized)) {
			throw new Error("invalid_pptx");
		}
		slidePaths.push(normalized);
	}

	const slides: PptxSlideRecord[] = [];
	const speakerNotes = new Map<number, string>();
	const pageTexts: string[] = [];

	for (let i = 0; i < slidePaths.length; i += 1) {
		const slideIndex = i + 1;
		const slidePath = slidePaths[i];
		const slideBytes = entries.get(slidePath);
		if (!slideBytes) throw new Error("invalid_pptx");
		const slideDoc = parseXmlDocument(UTF8_DECODER.decode(slideBytes));

		const lastSlash = slidePath.lastIndexOf("/");
		const slideDir = lastSlash >= 0 ? slidePath.slice(0, lastSlash) : "ppt/slides";
		const slideFile = lastSlash >= 0 ? slidePath.slice(lastSlash + 1) : slidePath;
		const slideRelsPath = `${slideDir}/_rels/${slideFile}.rels`;
		const slideRelsBytes = entries.get(slideRelsPath);
		const slideRels = slideRelsBytes
			? parseOoxmlRelationships(UTF8_DECODER.decode(slideRelsBytes))
			: new Map<string, OoxmlRelationship>();

		let backgroundHex: string | undefined;
		const bgEl = firstElementByLocal(slideDoc, "bg");
		if (bgEl) {
			const clrEl = firstElementByLocal(bgEl, "srgbClr");
			const val = clrEl?.getAttribute("val") ?? "";
			if (/^[0-9A-Fa-f]{6}$/.test(val)) {
				backgroundHex = `#${val.toUpperCase()}`;
			}
		}

		let title = "";
		let subtitle: string | undefined;
		const bullets: PptxBulletItem[] = [];

		for (const sp of elementsByLocal(slideDoc, "sp")) {
			const ph = firstElementByLocal(sp, "ph");
			const phType = (ph?.getAttribute("type") ?? "").toLowerCase();
			if (IGNORED_PLACEHOLDER_TYPES.has(phType)) continue;
			const txBody = firstElementByLocal(sp, "txBody");
			if (!txBody) continue;

			const shapeLines: PptxBulletItem[] = [];
			for (const p of elementsByLocal(txBody, "p")) {
				const text = extractParagraphText(p).trim();
				if (!text) continue;
				const pPr = firstElementByLocal(p, "pPr");
				const rawLvl = Number.parseInt(pPr?.getAttribute("lvl") ?? "0", 10);
				const level =
					Number.isFinite(rawLvl) && rawLvl >= 0 ? Math.min(rawLvl, 4) : 0;
				shapeLines.push({ text, level });
			}
			if (shapeLines.length === 0) continue;

			if (phType === "title" || phType === "ctrtitle") {
				if (!title) {
					title = shapeLines.map((l) => l.text).join(" ");
				} else {
					bullets.push(...shapeLines);
				}
			} else if (phType === "subtitle" && !subtitle) {
				subtitle = shapeLines.map((l) => l.text).join(" ");
			} else if (!title && bullets.length === 0 && !ph) {
				title = shapeLines[0].text;
				if (shapeLines.length > 1) {
					bullets.push(...shapeLines.slice(1));
				}
			} else {
				bullets.push(...shapeLines);
			}
		}

		if (!title && bullets.length > 0) {
			title = bullets[0].text;
			bullets.shift();
		}

		const tables: PptxTableGrid[] = [];
		for (const tbl of elementsByLocal(slideDoc, "tbl")) {
			const rows: string[][] = [];
			for (const tr of elementsByLocal(tbl, "tr")) {
				const row: string[] = [];
				for (const tc of elementsByLocal(tr, "tc")) {
					const cellText = elementsByLocal(tc, "p")
						.map((p) => extractParagraphText(p).trim())
						.filter(Boolean)
						.join(" ");
					row.push(cellText);
				}
				if (row.length > 0) rows.push(row);
			}
			if (rows.length > 0) tables.push({ rows });
		}

		const images: PptxEmbeddedImage[] = [];
		for (const pic of elementsByLocal(slideDoc, "pic")) {
			const blip = firstElementByLocal(pic, "blip");
			const embedId = blip ? attrByLocal(blip, "embed") : null;
			if (!embedId) continue;
			const rel = slideRels.get(embedId);
			if (!rel || rel.external) continue;
			const mediaPath = normalizePptxTargetPath(slideDir, rel.target);
			if (!mediaPath || !mediaPath.startsWith("ppt/")) continue;
			const mediaBytes = entries.get(mediaPath);
			const mediaType = detectImageMediaType(mediaPath);
			if (!mediaBytes || !mediaType || mediaBytes.length > 12 * 1024 * 1024) {
				continue;
			}

			const spPr = firstElementByLocal(pic, "spPr");
			const xfrm = spPr ? firstElementByLocal(spPr, "xfrm") : null;
			const off = xfrm ? firstElementByLocal(xfrm, "off") : null;
			const ext = xfrm ? firstElementByLocal(xfrm, "ext") : null;
			const x = Number.parseInt(off?.getAttribute("x") ?? "0", 10);
			const y = Number.parseInt(off?.getAttribute("y") ?? "0", 10);
			const cx = Number.parseInt(ext?.getAttribute("cx") ?? "0", 10);
			const cy = Number.parseInt(ext?.getAttribute("cy") ?? "0", 10);
			const cNvPr = firstElementByLocal(pic, "cNvPr");
			const alt =
				cNvPr?.getAttribute("descr") || cNvPr?.getAttribute("name") || undefined;

			images.push({
				id: `slide-${slideIndex}-img-${images.length + 1}`,
				mimeType: mediaType.mimeType,
				extension: mediaType.extension,
				bytes: mediaBytes,
				dataUrl: `data:${mediaType.mimeType};base64,${uint8ToBase64(mediaBytes)}`,
				xPct: clampPct((x / slideWidthEmu) * 100, 8),
				yPct: clampPct((y / slideHeightEmu) * 100, 20),
				wPct: clampPct(
					cx > 0 ? (cx / slideWidthEmu) * 100 : 40,
					40,
				),
				hPct: clampPct(
					cy > 0 ? (cy / slideHeightEmu) * 100 : 45,
					45,
				),
				alt,
			});
		}

		let notes = "";
		for (const rel of slideRels.values()) {
			if (rel.external || !rel.type.endsWith("/notesSlide")) continue;
			const notesPath = normalizePptxTargetPath(slideDir, rel.target);
			if (!notesPath || !notesPath.startsWith("ppt/")) continue;
			const notesBytes = entries.get(notesPath);
			if (!notesBytes) continue;
			notes = extractSpeakerNotesFromXml(UTF8_DECODER.decode(notesBytes));
			break;
		}
		if (notes) {
			speakerNotes.set(slideIndex, notes);
		}

		const plainParts: string[] = [];
		if (title) plainParts.push(title);
		if (subtitle) plainParts.push(subtitle);
		for (const b of bullets) plainParts.push(b.text);
		for (const tbl of tables) {
			for (const row of tbl.rows) {
				const joined = row.filter(Boolean).join(" | ");
				if (joined) plainParts.push(joined);
			}
		}
		const plainText = plainParts.join("\n").trim();
		pageTexts.push(plainText);

		slides.push({
			index: slideIndex,
			title: title || `Slide ${slideIndex}`,
			subtitle,
			bullets,
			tables,
			images,
			backgroundHex,
			notes,
			plainText,
		});
	}

	return {
		slideWidthEmu,
		slideHeightEmu,
		slides,
		speakerNotes,
		scriptMarkdown: buildScriptMarkdownFromNotes(speakerNotes),
		pageTexts,
	};
}

const MINIMAL_THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Naia Office Theme">
  <a:themeElements>
    <a:clrScheme name="Naia">
      <a:dk1><a:srgbClr val="111827"/></a:dk1>
      <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1F2937"/></a:dk2>
      <a:lt2><a:srgbClr val="F3F4F6"/></a:lt2>
      <a:accent1><a:srgbClr val="4F46E5"/></a:accent1>
      <a:accent2><a:srgbClr val="0EA5E9"/></a:accent2>
      <a:accent3><a:srgbClr val="10B981"/></a:accent3>
      <a:accent4><a:srgbClr val="F59E0B"/></a:accent4>
      <a:accent5><a:srgbClr val="EC4899"/></a:accent5>
      <a:accent6><a:srgbClr val="8B5CF6"/></a:accent6>
      <a:hlink><a:srgbClr val="2563EB"/></a:hlink>
      <a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="NaiaFonts">
      <a:majorFont>
        <a:latin typeface="Calibri"/>
        <a:ea typeface="Malgun Gothic"/>
        <a:cs typeface="Arial"/>
      </a:majorFont>
      <a:minorFont>
        <a:latin typeface="Calibri"/>
        <a:ea typeface="Malgun Gothic"/>
        <a:cs typeface="Arial"/>
      </a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="NaiaFmt">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
        <a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
        <a:ln w="28575"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
  <a:objectDefaults/>
  <a:extraClrSchemeLst/>
</a:theme>`;

const SLIDE_MASTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg>
      <p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef>
    </p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst>
    <p:sldLayoutId id="2147483649" r:id="rId1"/>
  </p:sldLayoutIdLst>
  <p:txStyles>
    <p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3600" b="1"/></a:lvl1pPr></p:titleStyle>
    <p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600"><a:defRPr sz="2000"/></a:lvl1pPr></p:bodyStyle>
    <p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>
  </p:txStyles>
</p:sldMaster>`;

const SLIDE_LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="obj" preserve="1">
  <p:cSld name="Title and Content">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;

const NOTES_MASTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notesMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:notesStyle><a:lvl1pPr><a:defRPr sz="1200"/></a:lvl1pPr></p:notesStyle>
</p:notesMaster>`;

export function buildPptxPresentation(input: BuildPptxDeckInput): Uint8Array {
	const slideWidthEmu = input.slideWidthEmu ?? DEFAULT_SLIDE_WIDTH_EMU;
	const slideHeightEmu = input.slideHeightEmu ?? DEFAULT_SLIDE_HEIGHT_EMU;
	const deckTitle = (input.title ?? "Naia Presentation").trim() || "Naia Presentation";
	const creator = (input.creator ?? "Naia Slides").trim() || "Naia Slides";
	const rawSlides =
		input.slides.length > 0
			? input.slides
			: [{ title: deckTitle, bullets: [], notes: "" }];

	Logger.debug(TAG, "building OOXML PPTX presentation", {
		slideCount: rawSlides.length,
		slideWidthEmu,
		slideHeightEmu,
	});

	const files: Array<{ name: string; data: Uint8Array | string }> = [];
	const usedImageExtensions = new Map<string, string>();
	let mediaCounter = 0;

	const slideOverrides: string[] = [];
	const notesOverrides: string[] = [];
	const presSlideRels: string[] = [];
	const presSlideIdEntries: string[] = [];

	// rId1 = slideMaster1, rId2 = notesMaster1, rId3 = presProps, rId4 = viewProps, rId5 = theme1, rId6 = tableStyles
	const firstSlideRelIdx = 7;

	rawSlides.forEach((slide, idx) => {
		const slideNo = idx + 1;
		const presRelId = `rId${firstSlideRelIdx + idx}`;
		presSlideIdEntries.push(`<p:sldId id="${256 + idx}" r:id="${presRelId}"/>`);
		presSlideRels.push(
			`  <Relationship Id="${presRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${slideNo}.xml"/>`,
		);
		slideOverrides.push(
			`  <Override PartName="/ppt/slides/slide${slideNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
		);

		const normalizedBullets: PptxBulletItem[] = (slide.bullets ?? [])
			.map((b) =>
				typeof b === "string"
					? { text: b.trim(), level: 0 }
					: { text: b.text.trim(), level: Math.max(0, Math.min(4, b.level)) },
			)
			.filter((b) => b.text.length > 0);

		const slideRelLines: string[] = [
			`  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
		];
		let nextSlideRel = 2;

		const notesText = (slide.notes ?? "").trim();
		const hasNotes = notesText.length > 0;
		if (hasNotes) {
			const notesRelId = `rId${nextSlideRel++}`;
			slideRelLines.push(
				`  <Relationship Id="${notesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${slideNo}.xml"/>`,
			);
			notesOverrides.push(
				`  <Override PartName="/ppt/notesSlides/notesSlide${slideNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
			);

			const noteParas = notesText
				.split(/\r?\n/)
				.map(
					(line) =>
						`<a:p><a:r><a:rPr lang="ko-KR" dirty="0"/><a:t>${escapeOoxmlText(line)}</a:t></a:r></a:p>`,
				)
				.join("");

			files.push({
				name: `ppt/notesSlides/notesSlide${slideNo}.xml`,
				data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder 1"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="685800" y="4343400"/><a:ext cx="5486400" cy="4114800"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/>${noteParas}</p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Slide Number Placeholder 2"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" sz="quarter" idx="10"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{7F9E1A10-0000-4000-8000-000000000001}" type="slidenum"><a:rPr lang="ko-KR"/><a:t>${slideNo}</a:t></a:fld></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:notes>`,
			});
			files.push({
				name: `ppt/notesSlides/_rels/notesSlide${slideNo}.xml.rels`,
				data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="../notesMasters/notesMaster1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${slideNo}.xml"/>
</Relationships>`,
			});
		}

		let nextShapeId = 2;
		const shapeXmlBlocks: string[] = [];

		const titleText = (slide.title || `Slide ${slideNo}`).trim();
		shapeXmlBlocks.push(`      <p:sp>
        <p:nvSpPr><p:cNvPr id="${nextShapeId++}" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="685800" y="457200"/><a:ext cx="${slideWidthEmu - 1_371_600}" cy="1143000"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR" sz="3200" b="1" dirty="0"/><a:t>${escapeOoxmlText(titleText)}</a:t></a:r></a:p></p:txBody>
      </p:sp>`);

		if (slide.subtitle && slide.subtitle.trim()) {
			shapeXmlBlocks.push(`      <p:sp>
        <p:nvSpPr><p:cNvPr id="${nextShapeId++}" name="Subtitle 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="685800" y="1620000"/><a:ext cx="${slideWidthEmu - 1_371_600}" cy="540000"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR" sz="2000" dirty="0"/><a:t>${escapeOoxmlText(slide.subtitle.trim())}</a:t></a:r></a:p></p:txBody>
      </p:sp>`);
		}

		const hasImages = (slide.images?.length ?? 0) > 0;
		const bodyWidth = hasImages
			? Math.round((slideWidthEmu - 1_600_000) * 0.56)
			: slideWidthEmu - 1_371_600;
		const bodyTop = slide.subtitle?.trim() ? 2_260_000 : 1_828_800;
		const bodyParasXml =
			normalizedBullets.length > 0
				? normalizedBullets
						.map(
							(b) =>
								`<a:p><a:pPr lvl="${b.level}"/><a:r><a:rPr lang="ko-KR" sz="2000" dirty="0"/><a:t>${escapeOoxmlText(b.text)}</a:t></a:r></a:p>`,
						)
						.join("")
				: "<a:p><a:endParaRPr lang=\"ko-KR\" dirty=\"0\"/></a:p>";

		shapeXmlBlocks.push(`      <p:sp>
        <p:nvSpPr><p:cNvPr id="${nextShapeId++}" name="Content Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="2"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="685800" y="${bodyTop}"/><a:ext cx="${bodyWidth}" cy="${Math.max(1_800_000, slideHeightEmu - bodyTop - 540_000)}"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/>${bodyParasXml}</p:txBody>
      </p:sp>`);

		for (const table of slide.tables ?? []) {
			if (table.rows.length === 0) continue;
			const colCount = Math.max(1, ...table.rows.map((r) => r.length));
			const tableWidth = slideWidthEmu - 1_371_600;
			const colWidth = Math.floor(tableWidth / colCount);
			const gridCols = Array.from({ length: colCount }, () => `<a:gridCol w="${colWidth}"/>`).join("");
			const trsXml = table.rows
				.map((row) => {
					const cellsXml = Array.from({ length: colCount }, (_, cIdx) => {
						const cellVal = escapeOoxmlText(row[cIdx] ?? "");
						return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR" sz="1600"/><a:t>${cellVal}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`;
					}).join("");
					return `<a:tr h="370840">${cellsXml}</a:tr>`;
				})
				.join("");
			shapeXmlBlocks.push(`      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="${nextShapeId++}" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="685800" y="3800000"/><a:ext cx="${tableWidth}" cy="${table.rows.length * 370_840}"/></p:xfrm>
        <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${gridCols}</a:tblGrid>${trsXml}</a:tbl></a:graphicData></a:graphic>
      </p:graphicFrame>`);
		}

		for (const img of slide.images ?? []) {
			mediaCounter += 1;
			const mediaFile = `image${mediaCounter}.${img.extension}`;
			usedImageExtensions.set(img.extension, img.mimeType);
			files.push({ name: `ppt/media/${mediaFile}`, data: img.bytes });
			const imgRelId = `rId${nextSlideRel++}`;
			slideRelLines.push(
				`  <Relationship Id="${imgRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaFile}"/>`,
			);
			const xEmu = Math.round(((img.xPct ?? 60) / 100) * slideWidthEmu);
			const yEmu = Math.round(((img.yPct ?? 26) / 100) * slideHeightEmu);
			const wEmu = Math.max(
				360_000,
				Math.round(((img.wPct ?? 34) / 100) * slideWidthEmu),
			);
			const hEmu = Math.max(
				360_000,
				Math.round(((img.hPct ?? 52) / 100) * slideHeightEmu),
			);
			const descr = escapeOoxmlText(img.alt ?? `Picture ${mediaCounter}`);
			shapeXmlBlocks.push(`      <p:pic>
        <p:nvPicPr><p:cNvPr id="${nextShapeId++}" name="${descr}" descr="${descr}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="${imgRelId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
        <p:spPr><a:xfrm><a:off x="${xEmu}" y="${yEmu}"/><a:ext cx="${wEmu}" cy="${hEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      </p:pic>`);
		}

		const bgXml =
			slide.backgroundHex && /^#[0-9A-Fa-f]{6}$/.test(slide.backgroundHex)
				? `\n    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="${slide.backgroundHex.slice(1).toUpperCase()}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
				: "";

		files.push({
			name: `ppt/slides/slide${slideNo}.xml`,
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>${bgXml}
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
${shapeXmlBlocks.join("\n")}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`,
		});

		files.push({
			name: `ppt/slides/_rels/slide${slideNo}.xml.rels`,
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${slideRelLines.join("\n")}
</Relationships>`,
		});
	});

	const mediaDefaults = [...usedImageExtensions.entries()]
		.map(
			([ext, mime]) =>
				`  <Default Extension="${ext}" ContentType="${mime}"/>`,
		)
		.join("\n");

	const isoNow = "2026-11-18T00:00:00Z";

	const rootFiles: Array<{ name: string; data: Uint8Array | string }> = [
		{
			name: "[Content_Types].xml",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
${mediaDefaults ? `${mediaDefaults}\n` : ""}  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>
  <Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>
  <Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>
${slideOverrides.join("\n")}
${notesOverrides.length > 0 ? `${notesOverrides.join("\n")}\n` : ""}</Types>`,
		},
		{
			name: "_rels/.rels",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
		},
		{
			name: "docProps/core.xml",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeOoxmlText(deckTitle)}</dc:title>
  <dc:creator>${escapeOoxmlText(creator)}</dc:creator>
  <cp:lastModifiedBy>${escapeOoxmlText(creator)}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${isoNow}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${isoNow}</dcterms:modified>
</cp:coreProperties>`,
		},
		{
			name: "docProps/app.xml",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Naia Slides</Application>
  <PresentationFormat>Widescreen</PresentationFormat>
  <Slides>${rawSlides.length}</Slides>
  <Notes>${notesOverrides.length}</Notes>
</Properties>`,
		},
		{
			name: "ppt/presentation.xml",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>
  <p:sldIdLst>${presSlideIdEntries.join("")}</p:sldIdLst>
  <p:sldSz cx="${slideWidthEmu}" cy="${slideHeightEmu}"/>
  <p:notesSz cx="${DEFAULT_NOTES_WIDTH_EMU}" cy="${DEFAULT_NOTES_HEIGHT_EMU}"/>
  <p:defaultTextStyle>
    <a:defPPr><a:defRPr lang="ko-KR"/></a:defPPr>
  </p:defaultTextStyle>
</p:presentation>`,
		},
		{
			name: "ppt/_rels/presentation.xml.rels",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="notesMasters/notesMaster1.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
  <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>
${presSlideRels.join("\n")}
</Relationships>`,
		},
		{
			name: "ppt/presProps.xml",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`,
		},
		{
			name: "ppt/viewProps.xml",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`,
		},
		{
			name: "ppt/tableStyles.xml",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
		},
		{ name: "ppt/theme/theme1.xml", data: MINIMAL_THEME_XML },
		{ name: "ppt/slideMasters/slideMaster1.xml", data: SLIDE_MASTER_XML },
		{
			name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
		},
		{ name: "ppt/slideLayouts/slideLayout1.xml", data: SLIDE_LAYOUT_XML },
		{
			name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
		},
		{ name: "ppt/notesMasters/notesMaster1.xml", data: NOTES_MASTER_XML },
		{
			name: "ppt/notesMasters/_rels/notesMaster1.xml.rels",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
		},
	];

	return writePptxZipEntries([...rootFiles, ...files]);
}

export function slidesFromPageTextsAndNotes(
	pageTexts: ReadonlyArray<string>,
	speakerNotes: ReadonlyMap<number, string>,
	fallbackCount = 0,
): BuildPptxSlideInput[] {
	const count = Math.max(pageTexts.length, fallbackCount);
	const out: BuildPptxSlideInput[] = [];
	for (let i = 0; i < count; i += 1) {
		const pageNo = i + 1;
		const lines = (pageTexts[i] ?? "")
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean);
		const title = lines[0] ?? `Slide ${pageNo}`;
		const bullets = lines.slice(1);
		const notes = speakerNotes.get(pageNo) ?? "";
		out.push({ title, bullets, notes });
	}
	return out;
}

export async function validatePptxBytes(
	bytes: Uint8Array,
): Promise<PptxValidationReport> {
	const errors: string[] = [];
	try {
		const entries = await readPptxZipEntries(bytes);
		const requiredParts = [
			"[Content_Types].xml",
			"_rels/.rels",
			"ppt/presentation.xml",
			"ppt/_rels/presentation.xml.rels",
			"ppt/slideMasters/slideMaster1.xml",
			"ppt/slideLayouts/slideLayout1.xml",
			"ppt/theme/theme1.xml",
		];
		for (const part of requiredParts) {
			if (!entries.has(part)) {
				errors.push(`missing_part:${part}`);
			}
		}
		for (const [name, data] of entries.entries()) {
			if (isXmlEntryName(name)) {
				try {
					parseXmlDocument(UTF8_DECODER.decode(data));
				} catch {
					errors.push(`malformed_xml:${name}`);
				}
			}
		}
		const deck = await parsePptxPresentation(bytes);
		for (let i = 0; i < deck.slides.length; i += 1) {
			const slideNo = i + 1;
			if (!entries.has(`ppt/slides/_rels/slide${slideNo}.xml.rels`)) {
				// Not an error for external decks with arbitrary slide filenames, only check if slide{N}.xml exists
				if (entries.has(`ppt/slides/slide${slideNo}.xml`)) {
					errors.push(`missing_slide_rels:${slideNo}`);
				}
			}
		}
		return {
			valid: errors.length === 0 && deck.slides.length > 0,
			slideCount: deck.slides.length,
			hasMaster: entries.has("ppt/slideMasters/slideMaster1.xml"),
			hasLayout: entries.has("ppt/slideLayouts/slideLayout1.xml"),
			hasTheme: entries.has("ppt/theme/theme1.xml"),
			notesCount: deck.speakerNotes.size,
			errors,
		};
	} catch (err) {
		errors.push(err instanceof Error ? err.message : String(err));
		return {
			valid: false,
			slideCount: 0,
			hasMaster: false,
			hasLayout: false,
			hasTheme: false,
			notesCount: 0,
			errors,
		};
	}
}
