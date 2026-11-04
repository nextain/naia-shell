/**
 * Small Markdown contract used by the Slides page editor.
 *
 * A section is identified by its numeric `##` heading.  The map deliberately
 * keeps empty sections: an empty section is an authored choice and must not be
 * confused with a page that has no section at all (which still falls back to
 * the PDF text for narration).
 */

export interface SlideVideoDirective {
	page: number;
	order: number;
	fileName: string;
	validName: boolean;
	section: string;
}

export type SlideScriptSections = Map<number, string> & {
	videoDirectives?: SlideVideoDirective[];
};

function normalizeSectionText(text: string): string {
	return text.replace(/\r\n?/g, "\n").trim();
}

function escapeSectionBody(text: string): string {
	return normalizeSectionText(text)
		.split("\n")
		.map((line) => (/^##\s+/.test(line) ? `\\${line}` : line))
		.join("\n");
}

function isValidPage(page: number): boolean {
	return Number.isInteger(page) && page >= 1;
}

export function isValidSlideVideoFileName(fileName: string): boolean {
	if (
		!fileName ||
		fileName.length > 180 ||
		fileName.startsWith(".") ||
		fileName.includes("..") ||
		fileName.includes("/") ||
		fileName.includes("\\") ||
		/[":*?<>|]/u.test(fileName) ||
		[...fileName].some((character) => {
			const code = character.charCodeAt(0);
			return code <= 0x1f || code === 0x7f;
		}) ||
		fileName.trim() !== fileName
	) {
		return false;
	}
	return /\.(?:mp4|webm|m4v)$/i.test(fileName);
}

/** Parse video headings independently from page narration sections. */
export function parseSlideVideoDirectives(
	markdown: string,
): SlideVideoDirective[] {
	const lines = String(markdown ?? "")
		.replace(/\r\n?/g, "\n")
		.split("\n");
	const directives: SlideVideoDirective[] = [];
	for (let index = 0; index < lines.length; index++) {
		const match = lines[index].match(
			/^##\s+(\d+)-(\d+)\.\s+\[(?:영상|video)\](?:\s+(.*))?\s*$/i,
		);
		if (!match) continue;
		const page = Number.parseInt(match[1], 10);
		const order = Number.parseInt(match[2], 10);
		let end = index + 1;
		while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
		const fileName = (match[3] ?? "").trim();
		directives.push({
			page,
			order,
			fileName,
			validName:
				isValidPage(page) &&
				Number.isInteger(order) &&
				order >= 1 &&
				isValidSlideVideoFileName(fileName),
			section: lines.slice(index, end).join("\n").trimEnd(),
		});
	}
	return directives.sort(
		(left, right) => left.page - right.page || left.order - right.order,
	);
}

/** Parse `## 1.`/`## 1)`/`## 1` sections while retaining empty sections. */
export function parseSlideScript(markdown: string): SlideScriptSections {
	const sections: SlideScriptSections = new Map();
	sections.videoDirectives = parseSlideVideoDirectives(markdown);
	const lines = String(markdown ?? "")
		.replace(/\r\n?/g, "\n")
		.split("\n");
	let page: number | null = null;
	let buffer: string[] = [];

	const flush = () => {
		if (page == null || !isValidPage(page)) return;
		sections.set(page, normalizeSectionText(buffer.join("\n")));
	};

	for (const line of lines) {
		const match = line.match(/^##\s+(\d+)(?:[.)]|\s|$)/);
		if (match) {
			flush();
			page = Number.parseInt(match[1], 10);
			buffer = [];
			continue;
		}
		if (/^##\s+/.test(line)) {
			flush();
			page = null;
			buffer = [];
			continue;
		}
		if (page != null) {
			buffer.push(/^\\##\s+/.test(line) ? line.slice(1) : line);
		}
	}
	flush();
	return sections;
}

/** Serialize sections in physical page order, including authored-empty pages. */
export function serializeSlideScript(
	sections: ReadonlyMap<number, string>,
): string {
	const pageSections = [...sections.entries()]
		.filter(([page]) => isValidPage(page))
		.sort(([left], [right]) => left - right)
		.map(([page, text]) => {
			const body = escapeSectionBody(text);
			return body ? `## ${page}.\n${body}` : `## ${page}.`;
		});
	const videoDirectives =
		"videoDirectives" in sections && Array.isArray(sections.videoDirectives)
			? sections.videoDirectives
			: [];
	return [
		...pageSections,
		...videoDirectives.map(({ section }) => section),
	].join("\n\n");
}

/** Replace or append one page without losing empty sections in the script. */
export function replaceSlideScriptPage(
	markdown: string,
	page: number,
	text: string,
): string {
	if (!isValidPage(page)) throw new Error("slides_invalid_page");
	const source = String(markdown ?? "").replace(/\r\n?/g, "\n");
	const lines = source.split("\n");
	let headingIndex = -1;
	for (let index = 0; index < lines.length; index++) {
		const match = lines[index].match(/^##\s+(\d+)(?:[.)]|\s|$)/);
		if (match && Number.parseInt(match[1], 10) === page) headingIndex = index;
	}
	const body = escapeSectionBody(text);
	if (headingIndex < 0) {
		const section = body ? `## ${page}.\n${body}` : `## ${page}.`;
		return source.trim() ? `${source.trimEnd()}\n\n${section}` : section;
	}

	let nextHeadingIndex = lines.length;
	for (let index = headingIndex + 1; index < lines.length; index++) {
		if (/^##\s+/.test(lines[index])) {
			nextHeadingIndex = index;
			break;
		}
	}
	const prefix = lines.slice(0, headingIndex + 1).join("\n");
	const suffix = lines.slice(nextHeadingIndex).join("\n");
	if (!suffix) return body ? `${prefix}\n${body}` : prefix;
	return body ? `${prefix}\n${body}\n\n${suffix}` : `${prefix}\n\n${suffix}`;
}
