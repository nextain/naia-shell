/**
 * Browser PPTX import for Slides (R27, 2026-11-19).
 *
 * Draws each slide parsed by `slides-pptx-parse.ts` on a canvas and writes the
 * pictures into an image-only PDF, so the existing PDF viewer, presenter and
 * script flow work unchanged on the web.  Speaker notes become the same
 * `## NN.` script the desktop LibreOffice import produces.
 */

import type { SlidesOpenedPdf } from "./slides-files";
import {
	INVALID_PPTX,
	type PptxDeck,
	type PptxShape,
	type PptxSlide,
	parsePptx,
	pptxScriptMarkdown,
} from "./slides-pptx-parse";

const EMU_PER_POINT = 12700;
const RENDER_WIDTH_PX = 1600;
const JPEG_QUALITY = 0.88;
const FONT_STACK =
	'"Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif';

export function isPptxFile(file: Pick<File, "name" | "type">): boolean {
	return (
		/\.pptx$/i.test(file.name) ||
		file.type ===
			"application/vnd.openxmlformats-officedocument.presentationml.presentation"
	);
}

export interface PdfImagePage {
	jpeg: Uint8Array;
	pixelWidth: number;
	pixelHeight: number;
	/** Page size in PDF points. */
	width: number;
	height: number;
}

/** Minimal PDF 1.4 writer: one full-page DCT (JPEG) image per page. */
export function writeImagePdf(pages: PdfImagePage[]): Uint8Array {
	if (!pages.length) throw new Error(INVALID_PPTX);
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const offsets: number[] = [];
	let length = 0;
	const push = (data: string | Uint8Array) => {
		const bytes = typeof data === "string" ? encoder.encode(data) : data;
		chunks.push(bytes);
		length += bytes.length;
	};
	const object = (id: number, body: () => void) => {
		offsets[id] = length;
		push(`${id} 0 obj\n`);
		body();
		push("\nendobj\n");
	};
	const num = (n: number) => Number(n.toFixed(2)).toString();

	push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
	const pageIds = pages.map((_, i) => 3 + i * 3);
	object(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
	object(2, () =>
		push(
			`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds
				.map((id) => `${id} 0 R`)
				.join(" ")}] >>`,
		),
	);
	pages.forEach((page, i) => {
		const pageId = pageIds[i];
		const contentId = pageId + 1;
		const imageId = pageId + 2;
		const w = num(page.width);
		const h = num(page.height);
		object(pageId, () =>
			push(
				`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
			),
		);
		const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
		object(contentId, () =>
			push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
		);
		object(imageId, () => {
			push(
				`<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
			);
			push(page.jpeg);
			push("\nendstream");
		});
	});
	const count = 3 + pages.length * 3;
	const xref = length;
	push(`xref\n0 ${count}\n0000000000 65535 f \n`);
	for (let id = 1; id < count; id++)
		push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
	push(
		`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
	);

	const out = new Uint8Array(length);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

function mediaType(name: string): string {
	const ext = name.split(".").pop()?.toLowerCase();
	if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
	if (ext === "gif") return "image/gif";
	if (ext === "svg") return "image/svg+xml";
	if (ext === "webp") return "image/webp";
	if (ext === "bmp") return "image/bmp";
	return "image/png";
}

async function decodeImages(deck: PptxDeck) {
	const images = new Map<string, ImageBitmap>();
	for (const [name, bytes] of deck.media) {
		try {
			const blob = new Blob([bytes as BlobPart], { type: mediaType(name) });
			images.set(name, await createImageBitmap(blob));
		} catch {
			// EMF/WMF and broken pictures are skipped; the slide still renders.
		}
	}
	return images;
}

function wrapLine(
	ctx: CanvasRenderingContext2D,
	text: string,
	maxWidth: number,
): string[] {
	const fits = (s: string) => ctx.measureText(s).width <= maxWidth;
	const lines: string[] = [];
	let line = "";
	// Break on spaces; split a word that alone is too wide (CJK has no spaces).
	for (const token of text.match(/\s+|\S+/g) ?? []) {
		if (fits(line + token)) {
			line += token;
			continue;
		}
		if (line.trim()) lines.push(line.trimEnd());
		line = "";
		const word = token.trimStart();
		if (fits(word)) {
			line = word;
			continue;
		}
		for (const ch of word) {
			if (line && !fits(line + ch)) {
				lines.push(line);
				line = ch;
			} else line += ch;
		}
	}
	if (line.trim() || !lines.length) lines.push(line.trimEnd());
	return lines;
}

function drawText(
	ctx: CanvasRenderingContext2D,
	shape: Extract<PptxShape, { kind: "text" }>,
	scale: number,
) {
	const x = shape.rect.x * scale;
	const y = shape.rect.y * scale;
	const w = shape.rect.cx * scale;
	const h = shape.rect.cy * scale;
	if (shape.fill) {
		ctx.fillStyle = shape.fill;
		ctx.fillRect(x, y, w, h);
	}
	const inset = 91440 * scale;
	const maxWidth = Math.max(1, w - inset * 2);
	const ptToPx = EMU_PER_POINT * scale;
	type Line = {
		text: string;
		font: string;
		color: string;
		size: number;
		align: CanvasTextAlign;
	};
	const lines: Line[] = [];
	for (const paragraph of shape.paragraphs) {
		const first = paragraph.runs.find((r) => r.text.trim()) ??
			paragraph.runs[0] ?? {
				sizePt: 18,
				bold: false,
				italic: false,
				color: "#000000",
			};
		const size = first.sizePt * ptToPx;
		const font = `${first.italic ? "italic " : ""}${first.bold ? "700 " : "400 "}${size}px ${FONT_STACK}`;
		ctx.font = font;
		const text = `${paragraph.bullet ? "• " : ""}${paragraph.runs
			.map((r) => r.text)
			.join("")}`;
		for (const part of text.split("\n")) {
			for (const wrapped of wrapLine(ctx, part, maxWidth)) {
				lines.push({
					text: wrapped,
					font,
					color: first.color,
					size,
					align: paragraph.align,
				});
			}
		}
	}
	const total = lines.reduce((sum, l) => sum + l.size * 1.2, 0);
	let cursor =
		shape.anchor === "middle"
			? y + (h - total) / 2
			: shape.anchor === "bottom"
				? y + h - inset - total
				: y + inset;
	ctx.save();
	ctx.beginPath();
	ctx.rect(x, y, w, h);
	ctx.clip();
	ctx.textBaseline = "top";
	for (const line of lines) {
		ctx.font = line.font;
		ctx.fillStyle = line.color;
		ctx.textAlign = line.align;
		const lx =
			line.align === "center"
				? x + w / 2
				: line.align === "right"
					? x + w - inset
					: x + inset;
		ctx.fillText(line.text, lx, cursor + line.size * 0.1);
		cursor += line.size * 1.2;
	}
	ctx.restore();
}

function drawSlide(
	ctx: CanvasRenderingContext2D,
	slide: PptxSlide,
	images: Map<string, ImageBitmap>,
	scale: number,
	width: number,
	height: number,
) {
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, width, height);
	const bg = slide.background;
	if (bg && "color" in bg) {
		ctx.fillStyle = bg.color;
		ctx.fillRect(0, 0, width, height);
	} else if (bg) {
		const image = images.get(bg.media);
		if (image) ctx.drawImage(image, 0, 0, width, height);
	}
	for (const shape of slide.shapes) {
		if (shape.kind === "image") {
			const image = images.get(shape.media);
			if (image)
				ctx.drawImage(
					image,
					shape.rect.x * scale,
					shape.rect.y * scale,
					shape.rect.cx * scale,
					shape.rect.cy * scale,
				);
		} else drawText(ctx, shape, scale);
	}
}

async function canvasJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
	const blob = await new Promise<Blob | null>((resolve) =>
		canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
	);
	if (!blob) throw new Error("slides_conversion_failed");
	return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Convert a PPTX chosen in the browser into the same shape the desktop
 * picker returns.  Throws `slides_invalid_pptx` for unreadable packages.
 */
export async function importPptxInBrowser(
	file: File,
	onProgress?: (phase: string) => void,
	signal?: AbortSignal,
): Promise<SlidesOpenedPdf> {
	const aborted = () => {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	};
	onProgress?.("reading");
	const bytes = new Uint8Array(await file.arrayBuffer());
	aborted();
	onProgress?.("parsing");
	const deck = parsePptx(bytes);
	aborted();
	onProgress?.("converting");
	const images = await decodeImages(deck);
	const width = RENDER_WIDTH_PX;
	const height = Math.max(
		1,
		Math.round((RENDER_WIDTH_PX * deck.heightEmu) / deck.widthEmu),
	);
	const scale = width / deck.widthEmu;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("slides_conversion_failed");
	if (document.fonts?.ready) await document.fonts.ready;
	const pages: PdfImagePage[] = [];
	try {
		for (const slide of deck.slides) {
			aborted();
			drawSlide(ctx, slide, images, scale, width, height);
			pages.push({
				jpeg: await canvasJpeg(canvas),
				pixelWidth: width,
				pixelHeight: height,
				width: deck.widthEmu / EMU_PER_POINT,
				height: deck.heightEmu / EMU_PER_POINT,
			});
		}
	} finally {
		for (const image of images.values()) image.close();
	}
	const pdf = writeImagePdf(pages);
	const base = file.name.replace(/\.pptx$/i, "");
	const script = pptxScriptMarkdown(deck.slides.map((s) => s.notes));
	onProgress?.("complete");
	return {
		file: new File([pdf as BlobPart], `${base}.pdf`, {
			type: "application/pdf",
		}),
		script: script ? { name: `${base}.md`, text: script } : null,
		scriptReadFailed: false,
		videos: [],
		videoReadFailures: [],
		pageTexts: deck.slides.map((s) => s.text),
	};
}
