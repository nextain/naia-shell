import { Logger } from "../../lib/logger";

const TAG = "IeumZipOoxmlEngine";

export type StudioDocKind =
	| "docx"
	| "xlsx"
	| "pptx"
	| "hwpx"
	| "xmind"
	| "markdown";

export interface DocxBlock {
	id: string;
	kind: "heading1" | "heading2" | "paragraph" | "bullet";
	text: string;
}

export interface SheetGrid {
	name: string;
	rows: string[][];
}

export interface SlideItem {
	id: string;
	title: string;
	bullets: string[];
	notes: string;
}

export interface MindmapNode {
	id: string;
	title: string;
	children: MindmapNode[];
}

export interface StudioDocument {
	kind: StudioDocKind;
	fileName: string;
	title: string;
	docxBlocks: DocxBlock[];
	sheet: SheetGrid;
	slides: SlideItem[];
	hwpxParagraphs: string[];
	mindmap: MindmapNode;
	markdownText: string;
}

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8");

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

export function crc32(bytes: Uint8Array): number {
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

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream === "undefined") {
		throw new Error("DecompressionStream unavailable in current runtime");
	}
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

/**
 * Pure browser ZIP reader supporting Stored (0) and Deflate (8) entries.
 */
export async function readZipEntries(
	archive: Uint8Array,
): Promise<Map<string, Uint8Array>> {
	Logger.debug(TAG, "reading zip archive", { byteLength: archive.byteLength });
	let eocdOffset = -1;
	const minOffset = Math.max(0, archive.length - 65557);
	for (let i = archive.length - 22; i >= minOffset; i -= 1) {
		if (readU32LE(archive, i) === 0x06054b50) {
			eocdOffset = i;
			break;
		}
	}
	if (eocdOffset < 0) {
		throw new Error("Invalid ZIP archive: EOCD signature not found");
	}
	const entryCount = readU16LE(archive, eocdOffset + 10);
	const centralDirOffset = readU32LE(archive, eocdOffset + 16);
	const result = new Map<string, Uint8Array>();

	let ptr = centralDirOffset;
	for (let idx = 0; idx < entryCount; idx += 1) {
		if (ptr + 46 > archive.length || readU32LE(archive, ptr) !== 0x02014b50) {
			break;
		}
		const method = readU16LE(archive, ptr + 10);
		const compressedSize = readU32LE(archive, ptr + 20);
		const nameLen = readU16LE(archive, ptr + 28);
		const extraLen = readU16LE(archive, ptr + 30);
		const commentLen = readU16LE(archive, ptr + 32);
		const localHeaderOffset = readU32LE(archive, ptr + 42);
		const name = UTF8_DECODER.decode(
			archive.subarray(ptr + 46, ptr + 46 + nameLen),
		);
		ptr += 46 + nameLen + extraLen + commentLen;

		if (name.endsWith("/") || name.includes("..")) {
			continue;
		}
		if (
			localHeaderOffset + 30 > archive.length ||
			readU32LE(archive, localHeaderOffset) !== 0x04034b50
		) {
			continue;
		}
		const localNameLen = readU16LE(archive, localHeaderOffset + 26);
		const localExtraLen = readU16LE(archive, localHeaderOffset + 28);
		const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
		const rawSlice = archive.subarray(dataStart, dataStart + compressedSize);

		if (method === 0) {
			result.set(name, new Uint8Array(rawSlice));
		} else if (method === 8) {
			result.set(name, await inflateRaw(rawSlice));
		}
	}
	return result;
}

/**
 * Pure browser deterministic ZIP writer (Stored method 0, universally compatible with OOXML/HWPX/XMind).
 */
export function writeZipEntries(
	entries: ReadonlyArray<{ name: string; data: Uint8Array | string }>,
): Uint8Array {
	const normalized = entries.map((e) => ({
		nameBytes: UTF8_ENCODER.encode(e.name),
		dataBytes:
			typeof e.data === "string" ? UTF8_ENCODER.encode(e.data) : e.data,
	}));

	const localParts: Uint8Array[] = [];
	const centralParts: Uint8Array[] = [];
	let offset = 0;

	for (const item of normalized) {
		const crc = crc32(item.dataBytes);
		const size = item.dataBytes.length;
		const nameLen = item.nameBytes.length;

		const localHeader = new Uint8Array(30 + nameLen);
		writeU32LE(localHeader, 0, 0x04034b50);
		writeU16LE(localHeader, 4, 20);
		writeU16LE(localHeader, 6, 0x0800); // UTF-8 filename flag
		writeU16LE(localHeader, 8, 0); // Stored
		writeU16LE(localHeader, 10, 0);
		writeU16LE(localHeader, 12, 0x5421); // fixed DOS date
		writeU32LE(localHeader, 14, crc);
		writeU32LE(localHeader, 18, size);
		writeU32LE(localHeader, 22, size);
		writeU16LE(localHeader, 26, nameLen);
		writeU16LE(localHeader, 28, 0);
		localHeader.set(item.nameBytes, 30);

		const centralHeader = new Uint8Array(46 + nameLen);
		writeU32LE(centralHeader, 0, 0x02014b50);
		writeU16LE(centralHeader, 4, 20);
		writeU16LE(centralHeader, 6, 20);
		writeU16LE(centralHeader, 8, 0x0800);
		writeU16LE(centralHeader, 10, 0);
		writeU16LE(centralHeader, 12, 0);
		writeU16LE(centralHeader, 14, 0x5421);
		writeU32LE(centralHeader, 16, crc);
		writeU32LE(centralHeader, 20, size);
		writeU32LE(centralHeader, 24, size);
		writeU16LE(centralHeader, 28, nameLen);
		writeU16LE(centralHeader, 30, 0);
		writeU16LE(centralHeader, 32, 0);
		writeU16LE(centralHeader, 34, 0);
		writeU16LE(centralHeader, 36, 0);
		writeU32LE(centralHeader, 38, 0);
		writeU32LE(centralHeader, 42, offset);
		centralHeader.set(item.nameBytes, 46);

		localParts.push(localHeader, item.dataBytes);
		centralParts.push(centralHeader);
		offset += localHeader.length + size;
	}

	const centralSize = centralParts.reduce((acc, b) => acc + b.length, 0);
	const eocd = new Uint8Array(22);
	writeU32LE(eocd, 0, 0x06054b50);
	writeU16LE(eocd, 4, 0);
	writeU16LE(eocd, 6, 0);
	writeU16LE(eocd, 8, normalized.length);
	writeU16LE(eocd, 10, normalized.length);
	writeU32LE(eocd, 12, centralSize);
	writeU32LE(eocd, 16, offset);
	writeU16LE(eocd, 20, 0);

	const totalSize = offset + centralSize + eocd.length;
	const archive = new Uint8Array(totalSize);
	let cursor = 0;
	for (const part of localParts) {
		archive.set(part, cursor);
		cursor += part.length;
	}
	for (const part of centralParts) {
		archive.set(part, cursor);
		cursor += part.length;
	}
	archive.set(eocd, cursor);
	return archive;
}

export function escapeXml(raw: string): string {
	return raw
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function parseXmlDoc(xml: string): Document {
	const parser = new DOMParser();
	return parser.parseFromString(xml, "application/xml");
}

function elementsByLocalName(
	root: Document | Element,
	localName: string,
): Element[] {
	const out: Element[] = [];
	const all = root.getElementsByTagName("*");
	for (let i = 0; i < all.length; i += 1) {
		const el = all.item(i);
		if (el && (el.localName === localName || el.tagName.endsWith(`:${localName}`))) {
			out.push(el);
		}
	}
	return out;
}

// ─── DOCX ────────────────────────────────────────────────────────────────────

export async function parseDocxBytes(bytes: Uint8Array): Promise<DocxBlock[]> {
	const entries = await readZipEntries(bytes);
	const docXmlBytes = entries.get("word/document.xml");
	if (!docXmlBytes) {
		throw new Error("Missing word/document.xml in .docx file");
	}
	const doc = parseXmlDoc(UTF8_DECODER.decode(docXmlBytes));
	const paragraphs = elementsByLocalName(doc, "p");
	const blocks: DocxBlock[] = [];

	paragraphs.forEach((p, idx) => {
		const texts = elementsByLocalName(p, "t")
			.map((t) => t.textContent ?? "")
			.join("");
		const trimmed = texts.trim();
		if (!trimmed) return;
		const styleEl = elementsByLocalName(p, "pStyle")[0];
		const styleVal = (
			styleEl?.getAttribute("w:val") ??
			styleEl?.getAttribute("val") ??
			""
		).toLowerCase();
		const hasNumPr = elementsByLocalName(p, "numPr").length > 0;
		let kind: DocxBlock["kind"] = "paragraph";
		if (styleVal.includes("heading1") || styleVal === "title" || styleVal === "1") {
			kind = "heading1";
		} else if (styleVal.includes("heading2") || styleVal === "2") {
			kind = "heading2";
		} else if (hasNumPr || styleVal.includes("list")) {
			kind = "bullet";
		}
		blocks.push({
			id: `p-${idx + 1}`,
			kind,
			text: trimmed,
		});
	});

	return blocks.length > 0
		? blocks
		: [{ id: "p-1", kind: "paragraph", text: "" }];
}

export function buildDocxBytes(blocks: ReadonlyArray<DocxBlock>): Uint8Array {
	const bodyParagraphs = blocks
		.map((b) => {
			const styleXml =
				b.kind === "heading1"
					? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'
					: b.kind === "heading2"
						? '<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>'
						: b.kind === "bullet"
							? '<w:pPr><w:pStyle w:val="ListParagraph"/></w:pPr>'
							: "";
			const displayText = b.kind === "bullet" && !b.text.startsWith("• ")
				? `• ${b.text}`
				: b.text;
			return `<w:p>${styleXml}<w:r><w:t xml:space="preserve">${escapeXml(displayText)}</w:t></w:r></w:p>`;
		})
		.join("");

	const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

	const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

	const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

	const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>
</w:styles>`;

	const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyParagraphs}<w:sectPr/></w:body>
</w:document>`;

	return writeZipEntries([
		{ name: "[Content_Types].xml", data: contentTypes },
		{ name: "_rels/.rels", data: rels },
		{ name: "word/_rels/document.xml.rels", data: docRels },
		{ name: "word/styles.xml", data: stylesXml },
		{ name: "word/document.xml", data: documentXml },
	]);
}

// ─── XLSX / CSV + Formula Evaluator ──────────────────────────────────────────

function colIndexFromLetters(letters: string): number {
	let col = 0;
	for (let i = 0; i < letters.length; i += 1) {
		col = col * 26 + (letters.toUpperCase().charCodeAt(i) - 64);
	}
	return col - 1;
}

export function colLettersFromIndex(index: number): string {
	let n = index + 1;
	let out = "";
	while (n > 0) {
		const rem = (n - 1) % 26;
		out = String.fromCharCode(65 + rem) + out;
		n = Math.floor((n - 1) / 26);
	}
	return out;
}

function parseCellRef(ref: string): { row: number; col: number } | null {
	const m = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
	if (!m) return null;
	return {
		col: colIndexFromLetters(m[1]),
		row: Number.parseInt(m[2], 10) - 1,
	};
}

export function evaluateSheetCell(
	rows: ReadonlyArray<ReadonlyArray<string>>,
	rowIdx: number,
	colIdx: number,
	visited = new Set<string>(),
): string {
	const raw = rows[rowIdx]?.[colIdx] ?? "";
	if (!raw.startsWith("=")) return raw;
	const key = `${rowIdx}:${colIdx}`;
	if (visited.has(key)) return "#CYCLE!";
	visited.add(key);

	const expr = raw.slice(1).trim();
	const rangeMatch = /^(SUM|AVERAGE|MIN|MAX)\(\s*([A-Za-z]+\d+)\s*:\s*([A-Za-z]+\d+)\s*\)$/i.exec(
		expr,
	);
	if (rangeMatch) {
		const fn = rangeMatch[1].toUpperCase();
		const start = parseCellRef(rangeMatch[2]);
		const end = parseCellRef(rangeMatch[3]);
		if (!start || !end) return "#REF!";
		const nums: number[] = [];
		for (
			let r = Math.min(start.row, end.row);
			r <= Math.max(start.row, end.row);
			r += 1
		) {
			for (
				let c = Math.min(start.col, end.col);
				c <= Math.max(start.col, end.col);
				c += 1
			) {
				const v = Number(
					evaluateSheetCell(rows, r, c, new Set(visited)).replace(/,/g, ""),
				);
				if (!Number.isNaN(v)) nums.push(v);
			}
		}
		if (nums.length === 0) return "0";
		if (fn === "SUM") return String(nums.reduce((a, b) => a + b, 0));
		if (fn === "AVERAGE") {
			const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
			return Number.isInteger(avg) ? String(avg) : avg.toFixed(2);
		}
		if (fn === "MIN") return String(Math.min(...nums));
		if (fn === "MAX") return String(Math.max(...nums));
	}

	// Simple cell arithmetic e.g. =B2+C2 or =B2*1.1
	let cycleDetected = false;
	const substituted = expr.replace(/\b([A-Za-z]+\d+)\b/g, (token) => {
		const ref = parseCellRef(token);
		if (!ref) return "0";
		const cellStr = evaluateSheetCell(rows, ref.row, ref.col, new Set(visited));
		if (cellStr === "#CYCLE!") {
			cycleDetected = true;
			return "0";
		}
		const resolved = Number(cellStr.replace(/,/g, ""));
		return Number.isNaN(resolved) ? "0" : String(resolved);
	});
	if (cycleDetected) return "#CYCLE!";
	if (/^[0-9+\-*/().\s]+$/.test(substituted)) {
		try {
			const val = Function(`"use strict"; return (${substituted});`)() as number;
			if (typeof val === "number" && Number.isFinite(val)) {
				return Number.isInteger(val) ? String(val) : val.toFixed(2);
			}
		} catch {
			return "#ERROR!";
		}
	}
	return raw;
}

export async function parseXlsxBytes(bytes: Uint8Array): Promise<SheetGrid> {
	const entries = await readZipEntries(bytes);
	const sharedStrings: string[] = [];
	const sstBytes = entries.get("xl/sharedStrings.xml");
	if (sstBytes) {
		const sstDoc = parseXmlDoc(UTF8_DECODER.decode(sstBytes));
		for (const si of elementsByLocalName(sstDoc, "si")) {
			const text = elementsByLocalName(si, "t")
				.map((t) => t.textContent ?? "")
				.join("");
			sharedStrings.push(text);
		}
	}

	const sheetEntry =
		entries.get("xl/worksheets/sheet1.xml") ??
		[...entries.entries()].find(([k]) => k.startsWith("xl/worksheets/sheet"))?.[1];
	if (!sheetEntry) {
		throw new Error("Missing worksheet XML in .xlsx file");
	}
	const sheetDoc = parseXmlDoc(UTF8_DECODER.decode(sheetEntry));
	const rowEls = elementsByLocalName(sheetDoc, "row");
	let maxRow = 5;
	let maxCol = 4;
	const cellMap = new Map<string, string>();

	rowEls.forEach((rowEl, fallbackR) => {
		const rAttr = Number.parseInt(rowEl.getAttribute("r") ?? "", 10);
		const rIdx = Number.isFinite(rAttr) && rAttr > 0 ? rAttr - 1 : fallbackR;
		maxRow = Math.max(maxRow, rIdx + 1);
		const cells = elementsByLocalName(rowEl, "c");
		cells.forEach((cellEl, fallbackC) => {
			const ref = parseCellRef(cellEl.getAttribute("r") ?? "");
			const cIdx = ref ? ref.col : fallbackC;
			maxCol = Math.max(maxCol, cIdx + 1);
			const cellType = cellEl.getAttribute("t") ?? "";
			const formulaEl = elementsByLocalName(cellEl, "f")[0];
			if (formulaEl?.textContent) {
				cellMap.set(`${rIdx}:${cIdx}`, `=${formulaEl.textContent}`);
				return;
			}
			if (cellType === "inlineStr") {
				const text = elementsByLocalName(cellEl, "t")
					.map((t) => t.textContent ?? "")
					.join("");
				cellMap.set(`${rIdx}:${cIdx}`, text);
				return;
			}
			const rawVal = elementsByLocalName(cellEl, "v")[0]?.textContent ?? "";
			if (cellType === "s") {
				const idx = Number.parseInt(rawVal, 10);
				cellMap.set(`${rIdx}:${cIdx}`, sharedStrings[idx] ?? "");
			} else {
				cellMap.set(`${rIdx}:${cIdx}`, rawVal);
			}
		});
	});

	const rows: string[][] = [];
	for (let r = 0; r < maxRow; r += 1) {
		const row: string[] = [];
		for (let c = 0; c < maxCol; c += 1) {
			row.push(cellMap.get(`${r}:${c}`) ?? "");
		}
		rows.push(row);
	}
	return { name: "Sheet1", rows };
}

export function buildXlsxBytes(sheet: SheetGrid): Uint8Array {
	const rowsXml = sheet.rows
		.map((row, rIdx) => {
			const cellsXml = row
				.map((val, cIdx) => {
					const trimmed = val.trim();
					if (!trimmed) return "";
					const cellRef = `${colLettersFromIndex(cIdx)}${rIdx + 1}`;
					if (trimmed.startsWith("=")) {
						const evaluated = evaluateSheetCell(sheet.rows, rIdx, cIdx);
						const numeric = Number(evaluated);
						const vTag = Number.isFinite(numeric) ? `<v>${numeric}</v>` : "";
						return `<c r="${cellRef}"><f>${escapeXml(trimmed.slice(1))}</f>${vTag}</c>`;
					}
					const asNum = Number(trimmed);
					if (trimmed !== "" && Number.isFinite(asNum)) {
						return `<c r="${cellRef}"><v>${asNum}</v></c>`;
					}
					return `<c r="${cellRef}" t="inlineStr"><is><t>${escapeXml(val)}</t></is></c>`;
				})
				.filter(Boolean)
				.join("");
			return `<row r="${rIdx + 1}">${cellsXml}</row>`;
		})
		.join("");

	const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

	const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

	const wbXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${escapeXml(sheet.name || "Sheet1")}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

	const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

	const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowsXml}</sheetData>
</worksheet>`;

	return writeZipEntries([
		{ name: "[Content_Types].xml", data: contentTypes },
		{ name: "_rels/.rels", data: rels },
		{ name: "xl/workbook.xml", data: wbXml },
		{ name: "xl/_rels/workbook.xml.rels", data: wbRels },
		{ name: "xl/worksheets/sheet1.xml", data: sheetXml },
	]);
}

export function buildCsvText(sheet: SheetGrid): string {
	return sheet.rows
		.map((row, r) =>
			row
				.map((_, c) => {
					const val = evaluateSheetCell(sheet.rows, r, c);
					return /[",\n]/.test(val) ? `"${val.replace(/"/g, '""')}"` : val;
				})
				.join(","),
		)
		.join("\n");
}

// ─── PPTX ────────────────────────────────────────────────────────────────────

export async function parsePptxBytes(bytes: Uint8Array): Promise<SlideItem[]> {
	const entries = await readZipEntries(bytes);
	const slideEntries = [...entries.entries()]
		.filter(([k]) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
		.sort(([a], [b]) => {
			const na = Number.parseInt(/\d+/.exec(a)?.[0] ?? "0", 10);
			const nb = Number.parseInt(/\d+/.exec(b)?.[0] ?? "0", 10);
			return na - nb;
		});

	if (slideEntries.length === 0) {
		throw new Error("No slide XML entries found in .pptx file");
	}

	return slideEntries.map(([name, xmlBytes], idx) => {
		const doc = parseXmlDoc(UTF8_DECODER.decode(xmlBytes));
		const shapes = elementsByLocalName(doc, "sp");
		const lines: string[] = [];
		for (const sp of shapes) {
			const paragraphs = elementsByLocalName(sp, "p");
			for (const p of paragraphs) {
				const text = elementsByLocalName(p, "t")
					.map((t) => t.textContent ?? "")
					.join("")
					.trim();
				if (text) lines.push(text);
			}
		}
		const slideNo = Number.parseInt(/\d+/.exec(name)?.[0] ?? String(idx + 1), 10);
		const notesBytes = entries.get(`ppt/notesSlides/notesSlide${slideNo}.xml`);
		const notes = notesBytes
			? elementsByLocalName(parseXmlDoc(UTF8_DECODER.decode(notesBytes)), "t")
					.map((t) => t.textContent ?? "")
					.join(" ")
					.trim()
			: "";
		return {
			id: `slide-${idx + 1}`,
			title: lines[0] ?? `Slide ${idx + 1}`,
			bullets: lines.slice(1).length > 0 ? lines.slice(1) : [""],
			notes,
		};
	});
}

export function buildPptxBytes(slides: ReadonlyArray<SlideItem>): Uint8Array {
	const safeSlides = slides.length > 0 ? slides : [{ id: "slide-1", title: "Slide 1", bullets: [""], notes: "" }];
	const files: Array<{ name: string; data: string }> = [];

	const slideOverrides = safeSlides
		.map(
			(_, i) =>
				`  <Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
		)
		.join("\n");

	files.push({
		name: "[Content_Types].xml",
		data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
${slideOverrides}
</Types>`,
	});

	files.push({
		name: "_rels/.rels",
		data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`,
	});

	const sldIdLst = safeSlides
		.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
		.join("");
	files.push({
		name: "ppt/presentation.xml",
		data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>${sldIdLst}</p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`,
	});

	const presRels = safeSlides
		.map(
			(_, i) =>
				`  <Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
		)
		.join("\n");
	files.push({
		name: "ppt/_rels/presentation.xml.rels",
		data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${presRels}
</Relationships>`,
	});

	safeSlides.forEach((s, idx) => {
		const bulletParas = s.bullets
			.filter((b) => b.trim().length > 0)
			.map(
				(b) =>
					`<a:p><a:r><a:rPr lang="ko-KR" sz="2000"/><a:t>${escapeXml(b)}</a:t></a:r></a:p>`,
			)
			.join("");
		files.push({
			name: `ppt/slides/slide${idx + 1}.xml`,
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="685800" y="457200"/><a:ext cx="10820400" cy="1143000"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR" sz="3200" b="1"/><a:t>${escapeXml(s.title)}</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Content 2"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="685800" y="1828800"/><a:ext cx="10820400" cy="4343400"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/>${bulletParas || "<a:p><a:endParaRPr/></a:p>"}</p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`,
		});
	});

	return writeZipEntries(files);
}

// ─── HWPX (OWPML) ────────────────────────────────────────────────────────────

export async function parseHwpxBytes(bytes: Uint8Array): Promise<string[]> {
	const entries = await readZipEntries(bytes);
	const sectionEntries = [...entries.entries()]
		.filter(([k]) => /^Contents\/section\d+\.xml$/i.test(k))
		.sort(([a], [b]) => a.localeCompare(b));
	if (sectionEntries.length === 0) {
		throw new Error("Missing Contents/section*.xml in .hwpx file");
	}
	const paragraphs: string[] = [];
	for (const [, secBytes] of sectionEntries) {
		const doc = parseXmlDoc(UTF8_DECODER.decode(secBytes));
		for (const p of elementsByLocalName(doc, "p")) {
			const text = elementsByLocalName(p, "t")
				.map((t) => t.textContent ?? "")
				.join("")
				.trim();
			if (text) paragraphs.push(text);
		}
	}
	return paragraphs.length > 0 ? paragraphs : [""];
}

export function buildHwpxBytes(
	paragraphs: ReadonlyArray<string>,
	title: string,
): Uint8Array {
	const pXml = paragraphs
		.map(
			(line, idx) =>
				`<hp:p id="${idx + 1}"><hp:run charPrIDRef="0"><hp:t>${escapeXml(line)}</hp:t></hp:run></hp:p>`,
		)
		.join("");

	return writeZipEntries([
		{ name: "mimetype", data: "application/hwp+zip" },
		{
			name: "version.xml",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="0" buildNumber="1"/>`,
		},
		{
			name: "META-INF/container.xml",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>`,
		},
		{
			name: "Contents/content.hpf",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf/" version="1.0"><opf:metadata><opf:title>${escapeXml(title)}</opf:title></opf:metadata><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="header"/><opf:itemref idref="section0"/></opf:spine></opf:package>`,
		},
		{
			name: "Contents/header.xml",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" secCnt="1"/>`,
		},
		{
			name: "Contents/section0.xml",
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">${pXml}</hs:sec>`,
		},
	]);
}

// ─── XMIND + Mindmap Converters ──────────────────────────────────────────────

interface RawXmindTopic {
	id?: string;
	title?: string;
	children?: { attached?: RawXmindTopic[] };
}

function fromRawXmindTopic(raw: RawXmindTopic, fallbackId: string): MindmapNode {
	const attached = raw.children?.attached ?? [];
	return {
		id: raw.id || fallbackId,
		title: raw.title || "Topic",
		children: attached.map((child, idx) =>
			fromRawXmindTopic(child, `${fallbackId}-${idx + 1}`),
		),
	};
}

function toRawXmindTopic(node: MindmapNode): RawXmindTopic {
	return {
		id: node.id,
		title: node.title,
		...(node.children.length > 0
			? {
					children: {
						attached: node.children.map(toRawXmindTopic),
					},
				}
			: {}),
	};
}

export async function parseXmindBytes(bytes: Uint8Array): Promise<MindmapNode> {
	const entries = await readZipEntries(bytes);
	const contentBytes = entries.get("content.json");
	if (!contentBytes) {
		throw new Error("Missing content.json in .xmind file");
	}
	const parsed = JSON.parse(UTF8_DECODER.decode(contentBytes)) as Array<{
		rootTopic?: RawXmindTopic;
	}>;
	const root = parsed[0]?.rootTopic;
	if (!root) {
		throw new Error("Invalid .xmind content.json: missing rootTopic");
	}
	return fromRawXmindTopic(root, "root");
}

export function buildXmindBytes(root: MindmapNode): Uint8Array {
	const content = JSON.stringify(
		[
			{
				id: "sheet-1",
				class: "sheet",
				title: root.title,
				rootTopic: toRawXmindTopic(root),
			},
		],
		null,
		2,
	);
	const manifest = JSON.stringify(
		{ "file-entries": { "content.json": {}, "metadata.json": {} } },
		null,
		2,
	);
	const metadata = JSON.stringify(
		{ creator: { name: "IeumOffice Web Studio (Naia)", version: "0.2.0" } },
		null,
		2,
	);
	return writeZipEntries([
		{ name: "content.json", data: content },
		{ name: "manifest.json", data: manifest },
		{ name: "metadata.json", data: metadata },
	]);
}

export function mindmapToSlides(root: MindmapNode): SlideItem[] {
	const cover: SlideItem = {
		id: "slide-1",
		title: root.title,
		bullets: root.children.map((c) => c.title),
		notes: "",
	};
	const branchSlides: SlideItem[] = root.children.map((branch, idx) => ({
		id: `slide-${idx + 2}`,
		title: branch.title,
		bullets:
			branch.children.length > 0
				? branch.children.map((leaf) => leaf.title)
				: [branch.title],
		notes: "",
	}));
	return [cover, ...branchSlides];
}

export function mindmapToDocxBlocks(root: MindmapNode): DocxBlock[] {
	const out: DocxBlock[] = [
		{ id: "mm-title", kind: "heading1", text: root.title },
	];
	let seq = 1;
	for (const branch of root.children) {
		out.push({ id: `mm-h-${seq}`, kind: "heading2", text: branch.title });
		seq += 1;
		for (const leaf of branch.children) {
			out.push({ id: `mm-b-${seq}`, kind: "bullet", text: leaf.title });
			seq += 1;
		}
	}
	return out;
}
