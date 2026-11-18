// @vitest-environment jsdom
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
	Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { buildPptxBytes } from "../../apps/ieumoffice/zip-ooxml-engine";
import {
	buildPptxPresentation,
	parsePptxPresentation,
	validatePptxBytes,
	writePptxZipEntries,
} from "../pptx-ooxml";

// Minimal valid 1x1 transparent PNG
const ONE_PIXEL_PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
	0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
	0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function hasSofficeBinary(): boolean {
	const check = spawnSync("which", ["soffice"], { encoding: "utf8" });
	return check.status === 0 && check.stdout.trim().length > 0;
}

describe("pptx-ooxml pure-browser OOXML engine & validity regression", () => {
	it("generates ECMA-376 compliant .pptx with master, layout, theme, embedded media, tables, and speaker notes", async () => {
		const pptxBytes = buildPptxPresentation({
			title: "나이아 슬라이드 & PPTX 복구 검증",
			creator: "Naia Regression Suite",
			slides: [
				{
					title: "1. 슬라이드 개요 <AI & Web>",
					subtitle: "브라우저 단독 실행 및 데스크톱 호환",
					bullets: [
						{ text: "외부 오피스 설치 없이 즉시 열기", level: 0 },
						{ text: "발표자 노트 자동 연결 & 수정", level: 1 },
					],
					backgroundHex: "#F8FAFC",
					images: [
						{
							mimeType: "image/png",
							extension: "png",
							bytes: ONE_PIXEL_PNG,
							alt: "Naia Diagram",
							xPct: 60,
							yPct: 24,
							wPct: 32,
							hPct: 48,
						},
					],
					notes: "첫 번째 장 발표자 대본입니다.\n특수문자 <A & B> \"인용\" 포함.",
				},
				{
					title: "2. 지표 요약 표",
					bullets: ["정량 검증 결과"],
					tables: [
						{
							rows: [
								["항목", "상태"],
								["PPTX 불러오기", "통과"],
								["PPTX 내보내기", "통과"],
							],
						},
					],
					notes: "",
				},
				{
					title: "3. 마무리",
					bullets: ["웹 앱스토어 즉시 구동"],
					notes: "마지막 세 번째 장 대본입니다.",
				},
			],
		});

		const report = await validatePptxBytes(pptxBytes);
		expect(report).toEqual({
			valid: true,
			slideCount: 3,
			hasMaster: true,
			hasLayout: true,
			hasTheme: true,
			notesCount: 2,
			errors: [],
		});

		const parsed = await parsePptxPresentation(pptxBytes);
		expect(parsed.slides).toHaveLength(3);
		expect(parsed.slides[0].title).toBe("1. 슬라이드 개요 <AI & Web>");
		expect(parsed.slides[0].subtitle).toBe("브라우저 단독 실행 및 데스크톱 호환");
		expect(parsed.slides[0].bullets).toEqual([
			{ text: "외부 오피스 설치 없이 즉시 열기", level: 0 },
			{ text: "발표자 노트 자동 연결 & 수정", level: 1 },
		]);
		expect(parsed.slides[0].backgroundHex).toBe("#F8FAFC");
		expect(parsed.slides[0].images).toHaveLength(1);
		expect(parsed.slides[0].images[0].alt).toBe("Naia Diagram");
		expect(parsed.slides[0].images[0].dataUrl.startsWith("data:image/png;base64,")).toBe(true);
		// Verify slide-number placeholder ("1") was NOT concatenated into speaker notes
		expect(parsed.speakerNotes.get(1)).toBe(
			"첫 번째 장 발표자 대본입니다.\n특수문자 <A & B> \"인용\" 포함.",
		);
		expect(parsed.speakerNotes.has(2)).toBe(false);
		expect(parsed.speakerNotes.get(3)).toBe("마지막 세 번째 장 대본입니다.");
		expect(parsed.slides[1].tables).toEqual([
			{
				rows: [
					["항목", "상태"],
					["PPTX 불러오기", "통과"],
					["PPTX 내보내기", "통과"],
				],
			},
		]);
		expect(parsed.scriptMarkdown).toContain("## 1\n첫 번째 장 발표자 대본입니다.");
		expect(parsed.scriptMarkdown).toContain("## 3\n마지막 세 번째 장 대본입니다.");
	});

	it("preserves presentation.xml <p:sldIdLst> order even when slide filenames are reversed", async () => {
		const reorderedArchive = writePptxZipEntries([
			{
				name: "[Content_Types].xml",
				data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`,
			},
			{
				name: "ppt/presentation.xml",
				data: `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rIdSecond"/><p:sldId id="257" r:id="rIdFirst"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
			},
			{
				name: "ppt/_rels/presentation.xml.rels",
				data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdSecond" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/><Relationship Id="rIdFirst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
			},
			{
				name: "ppt/slides/slide1.xml",
				data: `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>LATER SLIDE</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
			},
			{
				name: "ppt/slides/slide2.xml",
				data: `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>OPENING SLIDE</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
			},
		]);

		const parsed = await parsePptxPresentation(reorderedArchive);
		expect(parsed.slides.map((s) => s.title)).toEqual([
			"OPENING SLIDE",
			"LATER SLIDE",
		]);
	});

	it("rejects non-ZIP payloads, path traversal entries, and external slide relationships", async () => {
		await expect(
			parsePptxPresentation(new TextEncoder().encode("not a zip file")),
		).rejects.toThrow("invalid_pptx");

		const traversalZip = writePptxZipEntries([
			{ name: "../escape.xml", data: "<root/>" },
		]);
		await expect(parsePptxPresentation(traversalZip)).rejects.toThrow(
			"invalid_pptx",
		);

		const externalRelZip = writePptxZipEntries([
			{
				name: "ppt/presentation.xml",
				data: `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
			},
			{
				name: "ppt/_rels/presentation.xml.rels",
				data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="https://example.invalid/slide1.xml" TargetMode="External"/></Relationships>`,
			},
		]);
		await expect(parsePptxPresentation(externalRelZip)).rejects.toThrow(
			"invalid_pptx",
		);
	});

	it.skipIf(!hasSofficeBinary())(
		"converts generated Slides and IeumOffice .pptx files cleanly through real LibreOffice Impress",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "naia-pptx-soffice-"));
			try {
				const profileUri = `file://${join(dir, "lo-profile")}`;

				const slidesPptx = buildPptxPresentation({
					title: "LibreOffice Real Conversion Proof",
					slides: [
						{
							title: "Cover Slide",
							subtitle: "Verified with headless Impress",
							bullets: ["Bullet one", "Bullet two"],
							notes: "Speaker note 1",
						},
						{
							title: "Second Slide",
							bullets: ["Data point A", "Data point B"],
							notes: "Speaker note 2",
						},
					],
				});
				const slidesPath = join(dir, "naia-slides.pptx");
				writeFileSync(slidesPath, slidesPptx);
				execFileSync(
					"soffice",
					[
						`-env:UserInstallation=${profileUri}`,
						"--headless",
						"--convert-to",
						"pdf",
						"--outdir",
						dir,
						slidesPath,
					],
					{ stdio: "pipe", timeout: 45_000 },
				);
				const slidesPdfPath = join(dir, "naia-slides.pdf");
				expect(existsSync(slidesPdfPath)).toBe(true);
				const pdfBytes = readFileSync(slidesPdfPath);
				expect(pdfBytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");

				const ieumPptx = buildPptxBytes(
					[
						{
							id: "s1",
							title: "IeumOffice Deck",
							bullets: ["Browser-native presentation"],
							notes: "IeumOffice speaker note",
						},
					],
					"IeumOffice Test",
				);
				const ieumPath = join(dir, "ieum-office.pptx");
				writeFileSync(ieumPath, ieumPptx);
				execFileSync(
					"soffice",
					[
						`-env:UserInstallation=${profileUri}`,
						"--headless",
						"--convert-to",
						"pdf",
						"--outdir",
						dir,
						ieumPath,
					],
					{ stdio: "pipe", timeout: 45_000 },
				);
				const ieumPdfPath = join(dir, "ieum-office.pptx".replace(/\.pptx$/, ".pdf"));
				expect(existsSync(ieumPdfPath)).toBe(true);
				expect(readFileSync(ieumPdfPath).subarray(0, 5).toString("ascii")).toBe(
					"%PDF-",
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		60_000,
	);
});
