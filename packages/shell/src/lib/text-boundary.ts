/**
 * Return one separator when removing an inline marker would join two words.
 * Newlines and existing horizontal whitespace already provide a boundary.
 */
export function wordBoundaryForRemovedMarker(
	text: string,
	start: number,
	end: number,
): string {
	const before = text[start - 1];
	const after = text[end];
	return before && after && !/\s/u.test(before) && !/\s/u.test(after)
		? " "
		: "";
}
