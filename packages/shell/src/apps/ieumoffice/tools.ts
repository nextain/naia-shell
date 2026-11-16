import { Logger } from "../../lib/logger";
import {
	type DocxBlock,
	type SlideItem,
	type StudioDocKind,
	type StudioDocument,
	mindmapToDocxBlocks,
	mindmapToSlides,
} from "./zip-ooxml-engine";

const TAG = "IeumOfficeTools";

export const SKILL_IEUMOFFICE_STUDIO = "skill_ieumoffice_studio";

export interface IeumStudioToolState {
	activeTab: "studio" | "connect" | "download";
	doc: StudioDocument;
	desktopInstalled: boolean;
	desktopMcpEnabled: boolean;
	desktopVersion?: string;
}

export interface IeumStudioToolMutators {
	getState: () => IeumStudioToolState;
	setProposedEdit: (proposal: { summary: string; nextText: string }) => void;
	applyDocumentUpdate: (updater: (prev: StudioDocument) => StudioDocument) => void;
}

export function serializeActiveDocument(doc: StudioDocument): string {
	switch (doc.kind) {
		case "docx":
			return doc.docxBlocks
				.map((b) => {
					if (b.kind === "heading1") return `# ${b.text}`;
					if (b.kind === "heading2") return `## ${b.text}`;
					if (b.kind === "bullet") return `- ${b.text}`;
					return b.text;
				})
				.join("\n");
		case "xlsx":
			return doc.sheet.rows.map((r) => r.join("\t")).join("\n");
		case "pptx":
			return doc.slides
				.map(
					(s, idx) =>
						`[Slide ${idx + 1}] ${s.title}\n${s.bullets.map((b) => `- ${b}`).join("\n")}`,
				)
				.join("\n\n");
		case "hwpx":
			return doc.hwpxParagraphs.join("\n");
		case "xmind":
			return [
				doc.mindmap.title,
				...doc.mindmap.children.flatMap((c) => [
					`- ${c.title}`,
					...c.children.map((leaf) => `  - ${leaf.title}`),
				]),
			].join("\n");
		case "markdown":
			return doc.markdownText;
	}
}

export function applySerializedTextToDocument(
	doc: StudioDocument,
	rawText: string,
): StudioDocument {
	const cleaned = rawText
		.replace(/^```[a-zA-Z]*\n?/, "")
		.replace(/\n?```$/, "")
		.trim();
	const lines = cleaned
		.split(/\r?\n/)
		.map((l) => l.trimEnd())
		.filter((l) => l.trim().length > 0);
	if (lines.length === 0) return doc;

	switch (doc.kind) {
		case "docx": {
			const nextBlocks: DocxBlock[] = lines.map((line, i) => {
				const trimmed = line.trim();
				if (trimmed.startsWith("## ")) {
					return { id: `ai-${i + 1}`, kind: "heading2", text: trimmed.slice(3) };
				}
				if (trimmed.startsWith("# ")) {
					return { id: `ai-${i + 1}`, kind: "heading1", text: trimmed.slice(2) };
				}
				if (trimmed.startsWith("- ") || trimmed.startsWith("• ")) {
					return { id: `ai-${i + 1}`, kind: "bullet", text: trimmed.slice(2) };
				}
				return { id: `ai-${i + 1}`, kind: "paragraph", text: trimmed };
			});
			return { ...doc, docxBlocks: nextBlocks };
		}
		case "xlsx": {
			const rows = lines.map((line) =>
				line.includes("\t")
					? line.split("\t").map((c) => c.trim())
					: line.split(",").map((c) => c.trim()),
			);
			return { ...doc, sheet: { ...doc.sheet, rows } };
		}
		case "pptx": {
			const slides: SlideItem[] = [];
			let current: SlideItem | null = null;
			for (const line of lines) {
				const trimmed = line.trim();
				const slideHeader = /^\[Slide\s*\d+\]\s*(.+)$/i.exec(trimmed) ?? /^#\s+(.+)$/.exec(trimmed);
				if (slideHeader) {
					if (current) slides.push(current);
					current = {
						id: `slide-${slides.length + 1}`,
						title: slideHeader[1].trim(),
						bullets: [],
						notes: "",
					};
				} else {
					if (!current) {
						current = {
							id: "slide-1",
							title: trimmed,
							bullets: [],
							notes: "",
						};
					} else {
						current.bullets.push(trimmed.replace(/^[-•*]\s*/, ""));
					}
				}
			}
			if (current) slides.push(current);
			return slides.length > 0 ? { ...doc, slides } : doc;
		}
		case "hwpx":
			return { ...doc, hwpxParagraphs: lines.map((l) => l.trim()) };
		case "xmind": {
			const rootTitle = lines[0]?.replace(/^#\s*/, "").trim() || doc.mindmap.title;
			const branches: StudioDocument["mindmap"]["children"] = [];
			for (const line of lines.slice(1)) {
				if (/^\s{2,}[-•*]/.test(line) && branches.length > 0) {
					const parent = branches[branches.length - 1];
					parent.children.push({
						id: `${parent.id}-${parent.children.length + 1}`,
						title: line.replace(/^\s*[-•*]\s*/, "").trim(),
						children: [],
					});
				} else {
					branches.push({
						id: `b-${branches.length + 1}`,
						title: line.replace(/^\s*[-•*]\s*/, "").trim(),
						children: [],
					});
				}
			}
			return {
				...doc,
				mindmap: {
					id: "root",
					title: rootTitle,
					children: branches.length > 0 ? branches : doc.mindmap.children,
				},
			};
		}
		case "markdown":
			return { ...doc, markdownText: cleaned };
	}
}

export function handleIeumStudioToolCall(
	args: Record<string, unknown>,
	mutators: IeumStudioToolMutators,
): Record<string, unknown> {
	const action = typeof args.action === "string" ? args.action : "status";
	Logger.debug(TAG, "handling tool call", { action });
	const state = mutators.getState();

	switch (action) {
		case "status":
			return {
				ok: true,
				activeTab: state.activeTab,
				documentKind: state.doc.kind,
				fileName: state.doc.fileName,
				desktopInstalled: state.desktopInstalled,
				desktopMcpEnabled: state.desktopMcpEnabled,
				desktopVersion: state.desktopVersion ?? null,
				officialRepoUrl: "https://github.com/pblsketch/ieumoffice",
				officialReleasesUrl: "https://github.com/pblsketch/ieumoffice/releases",
			};
		case "read_document":
			return {
				ok: true,
				documentKind: state.doc.kind,
				fileName: state.doc.fileName,
				content: serializeActiveDocument(state.doc),
			};
		case "propose_edit": {
			const content = typeof args.content === "string" ? args.content.trim() : "";
			if (!content) {
				return { ok: false, error: "content is required for propose_edit" };
			}
			const summary =
				typeof args.summary === "string" && args.summary.trim()
					? args.summary.trim()
					: "AI edit proposal";
			mutators.setProposedEdit({ summary, nextText: content });
			return {
				ok: true,
				proposed: true,
				documentKind: state.doc.kind,
				summary,
			};
		}
		case "switch_format": {
			const validKinds: StudioDocKind[] = [
				"docx",
				"xlsx",
				"pptx",
				"hwpx",
				"xmind",
				"markdown",
			];
			const format = args.format as StudioDocKind;
			if (!validKinds.includes(format)) {
				return { ok: false, error: "unsupported format" };
			}
			mutators.applyDocumentUpdate((prev) => ({ ...prev, kind: format }));
			return { ok: true, documentKind: format };
		}
		case "convert_mindmap": {
			const target = args.target === "docx" ? "docx" : "pptx";
			mutators.applyDocumentUpdate((prev) =>
				target === "pptx"
					? {
							...prev,
							kind: "pptx",
							slides: mindmapToSlides(prev.mindmap),
						}
					: {
							...prev,
							kind: "docx",
							docxBlocks: mindmapToDocxBlocks(prev.mindmap),
						},
			);
			return { ok: true, convertedTo: target };
		}
		default:
			return { ok: false, error: `unknown action: ${action}` };
	}
}
