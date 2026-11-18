// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
	buildCsvText,
	buildDocxBytes,
	buildHwpxBytes,
	buildPptxBytes,
	buildXlsxBytes,
	buildXmindBytes,
	evaluateSheetCell,
	mindmapToDocxBlocks,
	mindmapToSlides,
	parseDocxBytes,
	parseHwpxBytes,
	parsePptxBytes,
	parseXlsxBytes,
	parseXmindBytes,
} from "../zip-ooxml-engine";

describe("zip-ooxml-engine browser roundtrips", () => {
	it("roundtrips .docx blocks with headings, paragraphs, and bullets", async () => {
		const bytes = buildDocxBytes([
			{ id: "1", kind: "heading1", text: "연간 업무 보고" },
			{ id: "2", kind: "heading2", text: "1. 주요 성과" },
			{ id: "3", kind: "paragraph", text: "문서 자동화 체계를 구축했습니다." },
			{ id: "4", kind: "bullet", text: "검토 시간 40% 단축" },
		]);
		const parsed = await parseDocxBytes(bytes);
		expect(parsed.map((b) => ({ kind: b.kind, text: b.text }))).toEqual([
			{ kind: "heading1", text: "연간 업무 보고" },
			{ kind: "heading2", text: "1. 주요 성과" },
			{ kind: "paragraph", text: "문서 자동화 체계를 구축했습니다." },
			{ kind: "bullet", text: "• 검토 시간 40% 단축" },
		]);
	});

	it("evaluates spreadsheet formulas and roundtrips .xlsx & .csv", async () => {
		const sheet = {
			name: "Budget",
			rows: [
				["항목", "상반기", "하반기", "합계"],
				["교육", "100", "150", "=B2+C2"],
				["운영", "200", "250", "=B3+C3"],
				["총계", "=SUM(B2:B3)", "=AVERAGE(C2:C3)", "=SUM(D2:D3)"],
			],
		};
		expect(evaluateSheetCell(sheet.rows, 1, 3)).toBe("250");
		expect(evaluateSheetCell(sheet.rows, 3, 1)).toBe("300");
		expect(evaluateSheetCell(sheet.rows, 3, 2)).toBe("200");
		expect(evaluateSheetCell(sheet.rows, 3, 3)).toBe("700");

		const cycleRows = [["=B1", "=A1"]];
		expect(evaluateSheetCell(cycleRows, 0, 0)).toBe("#CYCLE!");

		const xlsxBytes = buildXlsxBytes(sheet);
		const parsed = await parseXlsxBytes(xlsxBytes);
		expect(parsed.rows[1][0]).toBe("교육");
		expect(parsed.rows[3][1]).toBe("=SUM(B2:B3)");

		const csv = buildCsvText(sheet);
		expect(csv).toContain("총계,300,200,700");
	});

	it("roundtrips .pptx slides with titles, bullet points, and speaker notes", async () => {
		const slides = [
			{
				id: "s1",
				title: "이음오피스 소개",
				bullets: ["오픈소스 오피스", "나이아 MCP 연동"],
				notes: "1장 발표자 노트 원문 보존",
			},
			{
				id: "s2",
				title: "기대 효과",
				bullets: ["원본 형식 유지"],
				notes: "2장 발표자 노트 원문 보존",
			},
		];
		const bytes = buildPptxBytes(slides, "이음오피스 발표");
		const parsed = await parsePptxBytes(bytes);
		expect(parsed).toHaveLength(2);
		expect(parsed[0].title).toBe("이음오피스 소개");
		expect(parsed[0].bullets).toEqual(["오픈소스 오피스", "나이아 MCP 연동"]);
		expect(parsed[0].notes).toBe("1장 발표자 노트 원문 보존");
		expect(parsed[1].title).toBe("기대 효과");
		expect(parsed[1].notes).toBe("2장 발표자 노트 원문 보존");
	});

	it("roundtrips open-standard Hangul .hwpx paragraphs", async () => {
		const lines = [
			"[기안문] 부서 AI 문서 협업 도입안",
			"1. 공개 자료만 입력하고 사람이 최종 승인합니다.",
		];
		const bytes = buildHwpxBytes(lines, "기안문");
		const parsed = await parseHwpxBytes(bytes);
		expect(parsed).toEqual(lines);
	});

	it("roundtrips .xmind topic trees and converts mindmap to slides & docx", async () => {
		const root = {
			id: "root",
			title: "공공 AX 문서 혁신",
			children: [
				{
					id: "c1",
					title: "자료 수집",
					children: [{ id: "c1-1", title: "개정 조문 원문", children: [] }],
				},
				{
					id: "c2",
					title: "사람 검토",
					children: [{ id: "c2-1", title: "출처 대조 승인", children: [] }],
				},
			],
		};
		const bytes = buildXmindBytes(root);
		const parsed = await parseXmindBytes(bytes);
		expect(parsed.title).toBe("공공 AX 문서 혁신");
		expect(parsed.children).toHaveLength(2);
		expect(parsed.children[0].children[0].title).toBe("개정 조문 원문");

		const slides = mindmapToSlides(parsed);
		expect(slides).toHaveLength(3);
		expect(slides[1].title).toBe("자료 수집");
		expect(slides[1].bullets).toEqual(["개정 조문 원문"]);

		const docx = mindmapToDocxBlocks(parsed);
		expect(docx[0]).toEqual({
			id: "mm-title",
			kind: "heading1",
			text: "공공 AX 문서 혁신",
		});
		expect(docx.some((b) => b.kind === "bullet" && b.text === "출처 대조 승인")).toBe(
			true,
		);
	});
});
