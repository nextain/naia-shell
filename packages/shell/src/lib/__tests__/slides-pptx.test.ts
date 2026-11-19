// @vitest-environment jsdom
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { isPptxFile, writeImagePdf } from "../slides-pptx-browser";
import {
	INVALID_PPTX,
	parsePptx,
	pptxScriptMarkdown,
	resolvePartPath,
} from "../slides-pptx-parse";

const NS =
	'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL =
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PNG_1PX = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	),
	(c) => c.charCodeAt(0),
);

function rels(entries: Array<[string, string, string]>) {
	return `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
		.map(
			([id, type, target]) =>
				`<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`,
		)
		.join("")}</Relationships>`;
}

/** Two-slide deck: a title placeholder that inherits its frame, a picture, notes. */
function samplePptx(): Uint8Array {
	const files: Record<string, Uint8Array> = {
		"ppt/presentation.xml": strToU8(
			`<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`,
		),
		"ppt/_rels/presentation.xml.rels": strToU8(
			rels([
				["rId2", "slide", "slides/slide1.xml"],
				["rId3", "slide", "/ppt/slides/slide2.xml"],
			]),
		),
		"ppt/slides/slide1.xml": strToU8(
			`<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="102030"/></a:solidFill></p:bgPr></p:bg><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="3600" b="1"><a:solidFill><a:srgbClr val="FFCC00"/></a:solidFill></a:rPr><a:t>R27 발표 제목</a:t></a:r></a:p></p:txBody></p:sp>
<p:pic><p:nvPicPr><p:cNvPr id="3" name="Pic"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId5"/></p:blipFill><p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="300" cy="400"/></a:xfrm></p:spPr></p:pic>
</p:spTree></p:cSld></p:sld>`,
		),
		"ppt/slides/_rels/slide1.xml.rels": strToU8(
			rels([
				["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
				["rId5", "image", "../media/image1.png"],
				["rId9", "notesSlide", "../notesSlides/notesSlide1.xml"],
			]),
		),
		"ppt/slides/slide2.xml": strToU8(
			`<p:sld ${NS}><p:cSld><p:spTree><p:grpSp><p:grpSpPr><a:xfrm><a:off x="1000" y="1000"/><a:ext cx="2000" cy="2000"/><a:chOff x="0" y="0"/><a:chExt cx="1000" cy="1000"/></a:xfrm></p:grpSpPr>
<p:sp><p:nvSpPr><p:cNvPr id="4" name="Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="100" y="100"/><a:ext cx="500" cy="500"/></a:xfrm><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr><p:txBody><a:bodyPr anchor="b"/><a:p><a:r><a:t>둘째</a:t></a:r><a:br/><a:r><a:t>장</a:t></a:r></a:p></p:txBody></p:sp>
</p:grpSp></p:spTree></p:cSld></p:sld>`,
		),
		"ppt/slides/_rels/slide2.xml.rels": strToU8(
			rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]]),
		),
		"ppt/slideLayouts/slideLayout1.xml": strToU8(
			`<p:sldLayout ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="228600"/><a:ext cx="8229600" cy="857250"/></a:xfrm></p:spPr></p:sp></p:spTree></p:cSld></p:sldLayout>`,
		),
		"ppt/slideLayouts/_rels/slideLayout1.xml.rels": strToU8(
			rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
		),
		"ppt/slideMasters/slideMaster1.xml": strToU8(
			`<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FAFAFA"/></a:solidFill></p:bgPr></p:bg><p:spTree/></p:cSld></p:sldMaster>`,
		),
		"ppt/notesSlides/notesSlide1.xml": strToU8(
			`<p:notes ${NS}><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Img"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>  첫 장 발표 대본  </a:t></a:r></a:p><a:p><a:r><a:t>두 번째 줄</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="4" name="Num"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:notes>`,
		),
		"ppt/media/image1.png": PNG_1PX,
	};
	return zipSync(files);
}

describe("R27 browser PPTX reader", () => {
	it("R27 reads slide order, size, inherited title frame, picture and background", () => {
		const deck = parsePptx(samplePptx());
		expect(deck.widthEmu).toBe(9144000);
		expect(deck.heightEmu).toBe(5143500);
		expect(deck.slides).toHaveLength(2);
		const [first, second] = deck.slides;
		expect(first.background).toEqual({ color: "#102030" });
		expect(first.shapes[0]).toMatchObject({
			kind: "text",
			rect: { x: 457200, y: 228600, cx: 8229600, cy: 857250 },
			anchor: "middle",
			paragraphs: [
				{
					align: "center",
					runs: [
						{ text: "R27 발표 제목", sizePt: 36, bold: true, color: "#FFCC00" },
					],
				},
			],
		});
		expect(first.shapes[1]).toEqual({
			kind: "image",
			rect: { x: 100, y: 200, cx: 300, cy: 400 },
			media: "ppt/media/image1.png",
		});
		expect(deck.media.get("ppt/media/image1.png")).toEqual(PNG_1PX);
		expect(first.text).toBe("R27 발표 제목");
		// Slide 2 has no own background: the master colour is inherited.
		expect(second.background).toEqual({ color: "#FAFAFA" });
		expect(second.shapes[0]).toMatchObject({
			kind: "text",
			rect: { x: 1200, y: 1200, cx: 1000, cy: 1000 },
			fill: "#4472c4",
			anchor: "bottom",
		});
		expect(second.text).toBe("둘째\n장");
	});

	it("R27 turns speaker notes into the desktop ## NN. script format", () => {
		const deck = parsePptx(samplePptx());
		expect(deck.slides.map((s) => s.notes)).toEqual([
			"첫 장 발표 대본\n두 번째 줄",
			null,
		]);
		expect(pptxScriptMarkdown(deck.slides.map((s) => s.notes))).toBe(
			"## 01.\n첫 장 발표 대본\n두 번째 줄\n## 02.\n",
		);
		expect(pptxScriptMarkdown([null, null])).toBeNull();
	});

	it("R27 rejects files that are not a readable presentation", () => {
		expect(() => parsePptx(strToU8("%PDF-1.4"))).toThrow(INVALID_PPTX);
		expect(() =>
			parsePptx(zipSync({ "word/document.xml": strToU8("<w/>") })),
		).toThrow(INVALID_PPTX);
		expect(() =>
			parsePptx(
				zipSync({
					"ppt/presentation.xml": strToU8(
						`<p:presentation ${NS}><p:sldIdLst/></p:presentation>`,
					),
				}),
			),
		).toThrow(INVALID_PPTX);
	});

	it("R27 resolves relationship targets and refuses to escape the package", () => {
		expect(resolvePartPath("ppt/slides/slide1.xml", "../media/a.png")).toBe(
			"ppt/media/a.png",
		);
		expect(resolvePartPath("ppt/slides/slide1.xml", "/ppt/x.xml")).toBe(
			"ppt/x.xml",
		);
		expect(resolvePartPath("ppt/a.xml", "../../../etc/passwd")).toBeNull();
	});

	it("R27 recognises PPTX files by name or type", () => {
		expect(isPptxFile({ name: "Deck.PPTX", type: "" })).toBe(true);
		expect(
			isPptxFile({
				name: "deck",
				type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
			}),
		).toBe(true);
		expect(isPptxFile({ name: "deck.pdf", type: "application/pdf" })).toBe(
			false,
		);
	});
});

describe("R27 image PDF writer", () => {
	it("R27 writes one JPEG page per slide with a valid xref table", () => {
		const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
		const pdf = writeImagePdf([
			{ jpeg, pixelWidth: 16, pixelHeight: 9, width: 720, height: 405 },
			{ jpeg, pixelWidth: 16, pixelHeight: 9, width: 720, height: 405 },
		]);
		const text = new TextDecoder("latin1").decode(pdf);
		expect(text.startsWith("%PDF-1.4")).toBe(true);
		expect(text).toContain("/Type /Pages /Count 2 /Kids [3 0 R 6 0 R]");
		expect(text).toContain("/MediaBox [0 0 720 405]");
		expect(text.match(/\/Filter \/DCTDecode/g)).toHaveLength(2);
		const startxref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
		expect(text.slice(startxref, startxref + 4)).toBe("xref");
		// Every xref offset points at its "N 0 obj" header.
		const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
			Number(m[1]),
		);
		expect(offsets).toHaveLength(8);
		offsets.forEach((offset, i) => {
			expect(text.slice(offset).startsWith(`${i + 1} 0 obj`)).toBe(true);
		});
		expect(() => writeImagePdf([])).toThrow(INVALID_PPTX);
	});
});
