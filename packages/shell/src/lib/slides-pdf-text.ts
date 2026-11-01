/**
 * Rebuild readable text from pdf.js `getTextContent().items`.
 *
 * pdf.js often emits one item per glyph run or fragment (Korean decks can
 * come out one syllable per item). Joining items with " " therefore splits
 * words apart. This helper uses item geometry instead:
 * - items on the same line are joined with "" unless the horizontal gap
 *   between them is a real word gap (relative to the font size);
 * - `hasEOL` or a vertical jump of about half a line starts a new line;
 * - whitespace inside each line is collapsed, empty lines are dropped.
 *
 * Pure: no pdf.js import, so it can be unit-tested with plain objects.
 */

/** Structural subset of pdf.js `TextItem`. `TextMarkedContent` has no `str`. */
export interface PdfTextItemLike {
	str?: unknown;
	transform?: readonly number[];
	width?: number;
	height?: number;
	hasEOL?: boolean;
}

/** A gap wider than this fraction of the font size counts as a word space. */
export const PDF_WORD_GAP_RATIO = 0.2;
/** A baseline shift larger than this fraction of the font size is a new line. */
export const PDF_LINE_SHIFT_RATIO = 0.5;

interface Placed {
	endX: number;
	y: number;
	size: number;
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function fontSizeOf(item: PdfTextItemLike): number {
	const t = item.transform;
	const fromMatrix =
		t && finite(t[2]) && finite(t[3]) ? Math.hypot(t[2], t[3]) : 0;
	const fromScaleX = t && finite(t[0]) ? Math.abs(t[0]) : 0;
	const fromHeight = finite(item.height) ? Math.abs(item.height) : 0;
	return Math.max(fromMatrix, fromHeight) || fromScaleX;
}

function placementOf(item: PdfTextItemLike): Placed | null {
	const t = item.transform;
	if (!t || !finite(t[4]) || !finite(t[5])) return null;
	const width = finite(item.width) ? item.width : 0;
	return { endX: t[4] + width, y: t[5], size: fontSizeOf(item) };
}

export function pdfTextFromItems(items: readonly unknown[]): string {
	const lines: string[] = [];
	let current = "";
	let prev: Placed | null = null;

	const breakLine = () => {
		lines.push(current);
		current = "";
		prev = null;
	};

	for (const raw of items) {
		if (!raw || typeof raw !== "object" || !("str" in raw)) continue;
		const item = raw as PdfTextItemLike;
		if (typeof item.str !== "string") continue;
		const str = item.str;

		if (str !== "") {
			const here = placementOf(item);
			if (prev && here) {
				const size = Math.max(prev.size, here.size);
				if (
					size > 0 &&
					Math.abs(here.y - prev.y) > PDF_LINE_SHIFT_RATIO * size
				) {
					breakLine();
				} else {
					const startX = (item.transform as readonly number[])[4];
					const gap = startX - prev.endX;
					if (
						size > 0 &&
						gap > PDF_WORD_GAP_RATIO * size &&
						!/\s$/.test(current) &&
						!/^\s/.test(str)
					) {
						current += " ";
					}
				}
			}
			current += str;
			prev = here;
		}

		if (item.hasEOL) breakLine();
	}
	lines.push(current);

	return lines
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.join("\n");
}
