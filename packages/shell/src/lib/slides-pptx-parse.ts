/**
 * Browser PPTX reader for Slides (R27, 2026-11-19).
 *
 * The desktop app converts PPTX with LibreOffice (`slides_import.rs`).  The
 * web shell has no converter, so it reads the package itself: slide order and
 * size, each slide's text boxes, pictures and solid backgrounds, and speaker
 * notes.  The result feeds `slides-pptx-browser.ts`, which draws every slide
 * and writes an image PDF.  Layout is a simplified best-effort rendering (no
 * charts, SmartArt, gradients or theme fonts); notes follow the desktop
 * script format.
 */

import { unzipSync } from "fflate";
import slidesNotePlaceholders from "./slides-pptx-note-placeholders.json";

export const MAX_BROWSER_PPTX_BYTES = 128 * 1024 * 1024;
export const MAX_BROWSER_PPTX_SLIDES = 500;
const MAX_ZIP_ENTRIES = 4096;
const MAX_ZIP_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_NOTES_CHARS = 4 * 1024 * 1024;
const DEFAULT_SIZE = { cx: 12192000, cy: 6858000 };
const PLACEHOLDER_NOTES = new Set(slidesNotePlaceholders);
const NS_R =
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export const INVALID_PPTX = "slides_invalid_pptx";

export interface PptxRect {
	x: number;
	y: number;
	cx: number;
	cy: number;
}

export interface PptxTextRun {
	text: string;
	sizePt: number;
	bold: boolean;
	italic: boolean;
	color: string;
}

export interface PptxParagraph {
	align: "left" | "center" | "right";
	runs: PptxTextRun[];
	bullet: boolean;
}

export type PptxShape =
	| {
			kind: "text";
			rect: PptxRect;
			fill: string | null;
			anchor: "top" | "middle" | "bottom";
			paragraphs: PptxParagraph[];
	  }
	| { kind: "image"; rect: PptxRect; media: string };

export interface PptxSlide {
	background: { color: string } | { media: string } | null;
	shapes: PptxShape[];
	notes: string | null;
	text: string;
}

export interface PptxDeck {
	widthEmu: number;
	heightEmu: number;
	slides: PptxSlide[];
	/** Package paths to bytes for pictures referenced by slides. */
	media: Map<string, Uint8Array>;
}

function invalid(): Error {
	return new Error(INVALID_PPTX);
}

function children(node: Element | null | undefined, name: string): Element[] {
	if (!node) return [];
	return Array.from(node.children).filter((c) => c.localName === name);
}

function child(node: Element | null | undefined, name: string): Element | null {
	return children(node, name)[0] ?? null;
}

function path(node: Element | null | undefined, ...names: string[]) {
	let current: Element | null | undefined = node;
	for (const name of names) current = child(current, name);
	return current ?? null;
}

function descendants(node: Element | null | undefined, name: string) {
	if (!node) return [];
	return Array.from(node.getElementsByTagNameNS("*", name));
}

function intAttr(node: Element | null, name: string): number | null {
	const raw = node?.getAttribute(name);
	if (raw == null || !/^-?\d+$/.test(raw)) return null;
	return Number(raw);
}

function relId(node: Element | null, name: string): string | null {
	if (!node) return null;
	return node.getAttributeNS(NS_R, name) ?? node.getAttribute(`r:${name}`);
}

/** Resolve a relationship target against the part that owns the rels file. */
export function resolvePartPath(owner: string, target: string): string | null {
	if (target.startsWith("/")) return normalize(target.slice(1));
	const base = owner.split("/").slice(0, -1);
	return normalize([...base, target].join("/"));
}

function normalize(raw: string): string | null {
	const out: string[] = [];
	for (const part of raw.replace(/\\/g, "/").split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (!out.length) return null;
			out.pop();
		} else out.push(part);
	}
	return out.length ? out.join("/") : null;
}

function relsPath(part: string): string {
	const parts = part.split("/");
	const file = parts.pop();
	return [...parts, "_rels", `${file}.rels`].join("/");
}

interface Rel {
	type: string;
	target: string | null;
}

class Package {
	private readonly files: Record<string, Uint8Array>;
	private readonly xmlCache = new Map<string, Document | null>();
	private readonly decoder = new TextDecoder();

	constructor(bytes: Uint8Array) {
		if (bytes.length > MAX_BROWSER_PPTX_BYTES) throw invalid();
		if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw invalid();
		let count = 0;
		let total = 0;
		try {
			this.files = unzipSync(bytes, {
				filter: (file) => {
					count++;
					total += file.originalSize;
					if (count > MAX_ZIP_ENTRIES || total > MAX_ZIP_TOTAL_BYTES)
						throw invalid();
					return normalize(file.name) === file.name;
				},
			});
		} catch {
			throw invalid();
		}
	}

	bytes(name: string): Uint8Array | null {
		return this.files[name] ?? null;
	}

	xml(name: string): Document | null {
		if (this.xmlCache.has(name)) return this.xmlCache.get(name) ?? null;
		const raw = this.files[name];
		let doc: Document | null = null;
		if (raw) {
			const parsed = new DOMParser().parseFromString(
				this.decoder.decode(raw),
				"application/xml",
			);
			if (!parsed.getElementsByTagName("parsererror").length) doc = parsed;
		}
		this.xmlCache.set(name, doc);
		return doc;
	}

	rels(part: string): Map<string, Rel> {
		const out = new Map<string, Rel>();
		const doc = this.xml(relsPath(part));
		for (const rel of descendants(doc?.documentElement, "Relationship")) {
			const id = rel.getAttribute("Id");
			const target = rel.getAttribute("Target");
			if (!id || !target) continue;
			const external = rel.getAttribute("TargetMode") === "External";
			out.set(id, {
				type: (rel.getAttribute("Type") ?? "").split("/").pop() ?? "",
				target: external ? null : resolvePartPath(part, target),
			});
		}
		return out;
	}
}

function hexColor(node: Element | null): string | null {
	const srgb = child(node, "srgbClr")?.getAttribute("val");
	if (srgb && /^[0-9a-f]{6}$/i.test(srgb)) return `#${srgb}`;
	const sys = child(node, "sysClr")?.getAttribute("lastClr");
	if (sys && /^[0-9a-f]{6}$/i.test(sys)) return `#${sys}`;
	const scheme = child(node, "schemeClr")?.getAttribute("val");
	if (scheme) {
		if (/^(bg1|lt1)$/.test(scheme)) return "#ffffff";
		if (/^(tx1|dk1)$/.test(scheme)) return "#000000";
		if (/^(tx2|dk2)$/.test(scheme)) return "#44546a";
		if (/^(bg2|lt2)$/.test(scheme)) return "#e7e6e6";
		if (/^accent/.test(scheme)) return "#4472c4";
	}
	return null;
}

function readXfrm(spPr: Element | null): PptxRect | null {
	const xfrm = child(spPr, "xfrm");
	const off = child(xfrm, "off");
	const ext = child(xfrm, "ext");
	const x = intAttr(off, "x");
	const y = intAttr(off, "y");
	const cx = intAttr(ext, "cx");
	const cy = intAttr(ext, "cy");
	if (x == null || y == null || cx == null || cy == null) return null;
	return { x, y, cx, cy };
}

interface Placeholder {
	type: string;
	idx: string | null;
}

function placeholderOf(shape: Element): Placeholder | null {
	const nv = child(shape, "nvSpPr") ?? child(shape, "nvPicPr");
	const ph = path(nv, "nvPr", "ph");
	if (!ph) return null;
	return {
		type: ph.getAttribute("type") ?? "body",
		idx: ph.getAttribute("idx"),
	};
}

function sameKind(a: string, b: string): boolean {
	const group = (t: string) => (t === "ctrTitle" ? "title" : t);
	return group(a) === group(b);
}

/** Layout/master shape a slide placeholder inherits its frame from. */
function findInherited(tree: Element | null, ph: Placeholder): Element | null {
	const shapes = children(tree, "sp");
	if (ph.idx != null) {
		const byIdx = shapes.find((s) => placeholderOf(s)?.idx === ph.idx);
		if (byIdx) return byIdx;
	}
	return (
		shapes.find((s) => {
			const other = placeholderOf(s);
			return other != null && sameKind(other.type, ph.type);
		}) ?? null
	);
}

function backgroundOf(
	cSld: Element | null,
	rels: Map<string, Rel>,
): PptxSlide["background"] {
	const bgPr = path(cSld, "bg", "bgPr");
	if (bgPr) {
		const color = hexColor(child(bgPr, "solidFill"));
		if (color) return { color };
		const embed = relId(path(bgPr, "blipFill", "blip"), "embed");
		const target = embed ? rels.get(embed)?.target : null;
		if (target) return { media: target };
	}
	const ref = path(cSld, "bg", "bgRef");
	const refColor = hexColor(ref);
	return refColor ? { color: refColor } : null;
}

function textOf(paragraph: Element): string {
	let out = "";
	for (const node of Array.from(paragraph.children)) {
		if (node.localName === "r" || node.localName === "fld")
			out += child(node, "t")?.textContent ?? "";
		else if (node.localName === "br") out += "\n";
	}
	return out;
}

function readParagraphs(
	txBody: Element | null,
	defaultSize: number,
	defaultBullet: boolean,
): PptxParagraph[] {
	const out: PptxParagraph[] = [];
	for (const p of children(txBody, "p")) {
		const pPr = child(p, "pPr");
		const algn = pPr?.getAttribute("algn");
		const runs: PptxTextRun[] = [];
		for (const node of Array.from(p.children)) {
			if (node.localName === "br") {
				runs.push({
					text: "\n",
					sizePt: defaultSize,
					bold: false,
					italic: false,
					color: "#000000",
				});
				continue;
			}
			if (node.localName !== "r" && node.localName !== "fld") continue;
			const text = child(node, "t")?.textContent ?? "";
			if (!text) continue;
			const rPr = child(node, "rPr");
			const sz = intAttr(rPr, "sz");
			runs.push({
				text,
				sizePt: sz ? sz / 100 : defaultSize,
				bold: rPr?.getAttribute("b") === "1",
				italic: rPr?.getAttribute("i") === "1",
				color: hexColor(child(rPr, "solidFill")) ?? "#000000",
			});
		}
		out.push({
			align: algn === "ctr" ? "center" : algn === "r" ? "right" : "left",
			runs,
			bullet:
				defaultBullet &&
				!child(pPr, "buNone") &&
				runs.some((r) => r.text.trim()),
		});
	}
	return out;
}

interface Frame {
	/** Map child coordinates of a group to slide coordinates. */
	map(rect: PptxRect): PptxRect;
}

const IDENTITY: Frame = { map: (rect) => rect };

function groupFrame(grpSp: Element, parent: Frame): Frame {
	const xfrm = path(grpSp, "grpSpPr", "xfrm");
	const off = child(xfrm, "off");
	const ext = child(xfrm, "ext");
	const chOff = child(xfrm, "chOff");
	const chExt = child(xfrm, "chExt");
	const vals = [
		intAttr(off, "x"),
		intAttr(off, "y"),
		intAttr(ext, "cx"),
		intAttr(ext, "cy"),
		intAttr(chOff, "x"),
		intAttr(chOff, "y"),
		intAttr(chExt, "cx"),
		intAttr(chExt, "cy"),
	];
	if (vals.some((v) => v == null)) return parent;
	const [x, y, cx, cy, chx, chy, chcx, chcy] = vals as number[];
	const sx = chcx ? cx / chcx : 1;
	const sy = chcy ? cy / chcy : 1;
	return {
		map: (r) =>
			parent.map({
				x: x + (r.x - chx) * sx,
				y: y + (r.y - chy) * sy,
				cx: r.cx * sx,
				cy: r.cy * sy,
			}),
	};
}

interface ShapeContext {
	rels: Map<string, Rel>;
	layoutTree: Element | null;
	masterTree: Element | null;
}

function readShapes(
	tree: Element | null,
	ctx: ShapeContext,
	frame: Frame,
	out: PptxShape[],
	texts: string[],
) {
	for (const node of Array.from(tree?.children ?? [])) {
		if (node.localName === "grpSp") {
			readShapes(node, ctx, groupFrame(node, frame), out, texts);
			continue;
		}
		if (node.localName === "pic") {
			const rect = readXfrm(child(node, "spPr"));
			const embed = relId(path(node, "blipFill", "blip"), "embed");
			const media = embed ? ctx.rels.get(embed)?.target : null;
			if (rect && media)
				out.push({ kind: "image", rect: frame.map(rect), media });
			continue;
		}
		if (node.localName !== "sp") continue;
		const ph = placeholderOf(node);
		let rect = readXfrm(child(node, "spPr"));
		let inheritedBody: Element | null = null;
		if (ph) {
			const fromLayout = findInherited(ctx.layoutTree, ph);
			const fromMaster = findInherited(
				ctx.masterTree,
				placeholderOf(fromLayout ?? node) ?? ph,
			);
			rect ??=
				readXfrm(child(fromLayout, "spPr")) ??
				readXfrm(child(fromMaster, "spPr"));
			inheritedBody =
				path(fromLayout, "txBody", "bodyPr") ??
				path(fromMaster, "txBody", "bodyPr");
		}
		if (!rect) continue;
		const isTitle = ph != null && sameKind(ph.type, "title");
		const isBody = ph != null && (ph.type === "body" || ph.type === "obj");
		const defaultSize = isTitle ? 40 : ph?.type === "subTitle" ? 24 : 18;
		const txBody = child(node, "txBody");
		const paragraphs = readParagraphs(txBody, defaultSize, isBody);
		const bodyPr = child(txBody, "bodyPr");
		const anchorAttr =
			bodyPr?.getAttribute("anchor") ?? inheritedBody?.getAttribute("anchor");
		const fill = hexColor(path(node, "spPr", "solidFill"));
		const text = paragraphs
			.map((p) => p.runs.map((r) => r.text).join(""))
			.join("\n")
			.trim();
		if (!text && !fill) continue;
		if (text) texts.push(text);
		out.push({
			kind: "text",
			rect: frame.map(rect),
			fill,
			anchor:
				anchorAttr === "ctr"
					? "middle"
					: anchorAttr === "b"
						? "bottom"
						: isTitle
							? "middle"
							: "top",
			paragraphs,
		});
	}
}

/** Same selection as the desktop parser: body placeholders, else all text. */
function notesText(doc: Document | null): string | null {
	const tree = path(doc?.documentElement, "cSld", "spTree");
	if (!tree) return null;
	const body: string[] = [];
	const all: string[] = [];
	for (const sp of descendants(tree, "sp")) {
		const ph = placeholderOf(sp);
		const text = children(child(sp, "txBody"), "p").map(textOf).join("\n");
		if (ph?.type === "sldNum" || ph?.type === "sldImg") continue;
		all.push(text);
		if (ph?.type === "body") body.push(text);
	}
	if (all.join("").length > MAX_NOTES_CHARS) throw invalid();
	const text = (body.length ? body : all)
		.join("\n")
		.replace(/\r/g, "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.join("\n")
		.trim();
	return text && !PLACEHOLDER_NOTES.has(text) ? text : null;
}

/** Desktop-compatible script: one `## NN.` heading per physical slide. */
export function pptxScriptMarkdown(notes: Array<string | null>): string | null {
	if (!notes.some((n) => n)) return null;
	return notes
		.map(
			(note, i) =>
				`## ${String(i + 1).padStart(2, "0")}.\n${note ? `${note}\n` : ""}`,
		)
		.join("");
}

export function parsePptx(bytes: Uint8Array): PptxDeck {
	const pkg = new Package(bytes);
	const presentationPart = "ppt/presentation.xml";
	const presentation = pkg.xml(presentationPart)?.documentElement;
	if (!presentation) throw invalid();
	const sldSz = child(presentation, "sldSz");
	const widthEmu = intAttr(sldSz, "cx") ?? DEFAULT_SIZE.cx;
	const heightEmu = intAttr(sldSz, "cy") ?? DEFAULT_SIZE.cy;
	if (widthEmu <= 0 || heightEmu <= 0) throw invalid();
	const presRels = pkg.rels(presentationPart);
	const ids = children(child(presentation, "sldIdLst"), "sldId");
	if (!ids.length || ids.length > MAX_BROWSER_PPTX_SLIDES) throw invalid();

	const media = new Map<string, Uint8Array>();
	const keepMedia = (target: string) => {
		const data = pkg.bytes(target);
		if (data) media.set(target, data);
	};
	const slides: PptxSlide[] = [];
	for (const sldId of ids) {
		const id = relId(sldId, "id");
		const slidePart = id ? presRels.get(id)?.target : null;
		const slideDoc = slidePart ? pkg.xml(slidePart) : null;
		if (!slidePart || !slideDoc) throw invalid();
		const rels = pkg.rels(slidePart);
		const layoutPart = [...rels.values()].find(
			(r) => r.type === "slideLayout",
		)?.target;
		const layoutDoc = layoutPart ? pkg.xml(layoutPart) : null;
		const masterPart = layoutPart
			? [...pkg.rels(layoutPart).values()].find((r) => r.type === "slideMaster")
					?.target
			: null;
		const masterDoc = masterPart ? pkg.xml(masterPart) : null;
		const cSld = child(slideDoc.documentElement, "cSld");
		const layoutCSld = child(layoutDoc?.documentElement, "cSld");
		const masterCSld = child(masterDoc?.documentElement, "cSld");

		const background =
			backgroundOf(cSld, rels) ??
			(layoutPart ? backgroundOf(layoutCSld, pkg.rels(layoutPart)) : null) ??
			(masterPart ? backgroundOf(masterCSld, pkg.rels(masterPart)) : null);
		if (background && "media" in background) keepMedia(background.media);

		const shapes: PptxShape[] = [];
		const texts: string[] = [];
		readShapes(
			child(cSld, "spTree"),
			{
				rels,
				layoutTree: child(layoutCSld, "spTree"),
				masterTree: child(masterCSld, "spTree"),
			},
			IDENTITY,
			shapes,
			texts,
		);
		for (const shape of shapes)
			if (shape.kind === "image") keepMedia(shape.media);

		const notesPart = [...rels.values()].find(
			(r) => r.type === "notesSlide",
		)?.target;
		slides.push({
			background,
			shapes,
			notes: notesPart ? notesText(pkg.xml(notesPart)) : null,
			text: texts.join("\n"),
		});
	}
	return { widthEmu, heightEmu, slides, media };
}
