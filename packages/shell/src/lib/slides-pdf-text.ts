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

/**
 * A gap wider than this fraction of the (smaller) font size counts as a word
 * space. Kerning / letter-spacing gaps stay well below it.
 */
export const PDF_WORD_GAP_RATIO = 0.15;
/** A baseline shift larger than this fraction of the font size is a new line. */
export const PDF_LINE_SHIFT_RATIO = 0.5;

interface Placed {
	/** Origin of the item (transform e, f). */
	x: number;
	y: number;
	/** Unit vector of the text advance direction (from transform a, b). */
	dx: number;
	dy: number;
	/** Advance width along (dx, dy). */
	width: number;
	size: number;
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function fontSizeOf(item: PdfTextItemLike): number {
	const t = item.transform;
	const fromMatrix =
		t && finite(t[2]) && finite(t[3]) ? Math.hypot(t[2], t[3]) : 0;
	const fromScaleX =
		t && finite(t[0]) && finite(t[1]) ? Math.hypot(t[0], t[1]) : 0;
	const fromHeight = finite(item.height) ? Math.abs(item.height) : 0;
	return Math.max(fromMatrix, fromHeight) || fromScaleX;
}

function placementOf(item: PdfTextItemLike): Placed | null {
	const t = item.transform;
	if (!t || !finite(t[4]) || !finite(t[5])) return null;
	const a = finite(t[0]) ? t[0] : 1;
	const b = finite(t[1]) ? t[1] : 0;
	const len = Math.hypot(a, b);
	return {
		x: t[4],
		y: t[5],
		dx: len > 0 ? a / len : 1,
		dy: len > 0 ? b / len : 0,
		width: finite(item.width) ? item.width : 0,
		size: fontSizeOf(item),
	};
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
				// Measure in the previous item's own text direction, so rotated
				// and vertical runs behave like horizontal ones.
				const relX = here.x - prev.x;
				const relY = here.y - prev.y;
				const along = relX * prev.dx + relY * prev.dy;
				const across = -relX * prev.dy + relY * prev.dx;
				const lineSize = Math.max(prev.size, here.size);
				const gapSize = Math.min(prev.size, here.size) || lineSize;
				if (
					lineSize > 0 &&
					Math.abs(across) > PDF_LINE_SHIFT_RATIO * lineSize
				) {
					breakLine();
				} else if (
					gapSize > 0 &&
					// A real gap after the previous run, or a jump back before its
					// start (items emitted out of visual order / right to left).
					(along - prev.width > PDF_WORD_GAP_RATIO * gapSize ||
						along < -PDF_WORD_GAP_RATIO * gapSize) &&
					!/\s$/.test(current) &&
					!/^\s/.test(str)
				) {
					current += " ";
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
