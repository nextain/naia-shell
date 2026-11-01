import { describe, expect, it } from "vitest";
import { pdfTextFromItems } from "../slides-pdf-text";

/** pdf.js-like TextItem: transform = [scaleX, skewY, skewX, scaleY, x, y]. */
function item(
	str: string,
	x: number,
	width: number,
	opts: { y?: number; size?: number; hasEOL?: boolean } = {},
) {
	const size = opts.size ?? 20;
	return {
		str,
		dir: "ltr",
		transform: [size, 0, 0, size, x, opts.y ?? 700],
		width,
		height: size,
		fontName: "g_d0_f1",
		hasEOL: opts.hasEOL ?? false,
	};
}

/** Lay out syllables edge to edge (zero gap), as pdf.js emits per-glyph runs. */
function syllables(
	text: string,
	x0: number,
	opts: { y?: number; hasEOL?: boolean } = {},
) {
	const chars = [...text];
	return chars.map((ch, i) =>
		item(ch, x0 + i * 20, 20, {
			y: opts.y,
			hasEOL: opts.hasEOL === true && i === chars.length - 1,
		}),
	);
}

describe("pdfTextFromItems", () => {
	it("joins Korean items that arrive one syllable at a time without spaces", () => {
		expect(pdfTextFromItems(syllables("안녕하세요", 72))).toBe("안녕하세요");
	});

	it("keeps a real word gap between Korean words split into syllables", () => {
		const items = [
			...syllables("발표를", 72),
			...syllables("시작합니다", 72 + 3 * 20 + 6),
		];
		expect(pdfTextFromItems(items)).toBe("발표를 시작합니다");
	});

	it("inserts a single space for a real horizontal gap", () => {
		expect(
			pdfTextFromItems([item("hello", 72, 50), item("world", 72 + 50 + 6, 50)]),
		).toBe("hello world");
	});

	it("does not add a second space when an item already carries whitespace", () => {
		expect(
			pdfTextFromItems([
				item("hello ", 72, 56),
				item("world", 72 + 56 + 6, 50),
			]),
		).toBe("hello world");
	});

	it("does not split a word on tiny kerning gaps", () => {
		expect(
			pdfTextFromItems([
				item("Pre", 72, 30),
				item("sentation", 72 + 30 + 1, 90),
			]),
		).toBe("Presentation");
	});

	it("breaks lines on hasEOL, including Korean syllable runs", () => {
		const items = [
			...syllables("첫째 줄", 72, { hasEOL: true }),
			...syllables("둘째 줄", 72, { hasEOL: true }),
		];
		expect(pdfTextFromItems(items)).toBe("첫째 줄\n둘째 줄");
	});

	it("handles pdf.js empty EOL marker items without merging lines", () => {
		const items = [
			item("Line one", 72, 80),
			{ ...item("", 152, 0), hasEOL: true },
			item("Line two", 72, 80),
		];
		expect(pdfTextFromItems(items)).toBe("Line one\nLine two");
	});

	it("breaks lines on a baseline jump even without hasEOL", () => {
		const items = [
			item("Title", 72, 50, { y: 700 }),
			item("Body", 72, 40, { y: 660 }),
		];
		expect(pdfTextFromItems(items)).toBe("Title\nBody");
	});

	it("keeps small baseline shifts (superscripts) on the same line", () => {
		const items = [
			item("x", 72, 10, { y: 700 }),
			item("2", 82, 8, { y: 706, size: 12 }),
		];
		expect(pdfTextFromItems(items)).toBe("x2");
	});

	it("skips TextMarkedContent items that have no str", () => {
		const items = [
			{ type: "beginMarkedContentProps", id: "mc0" },
			...syllables("안녕", 72),
			{ type: "endMarkedContent" },
			{ type: "beginMarkedContent", tag: "Artifact" },
			...syllables("하세요", 72 + 2 * 20),
			{ type: "endMarkedContent" },
		];
		expect(pdfTextFromItems(items)).toBe("안녕하세요");
	});

	it("collapses whitespace, drops empty lines, and returns empty for no text", () => {
		expect(
			pdfTextFromItems([
				item("  a   b  ", 72, 60, { hasEOL: true }),
				item("   ", 72, 10, { y: 660, hasEOL: true }),
				item("c", 72, 10, { y: 620 }),
			]),
		).toBe("a b\nc");
		expect(pdfTextFromItems([])).toBe("");
		expect(pdfTextFromItems([{ type: "endMarkedContent" }, null, 3])).toBe("");
	});
});
