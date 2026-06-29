import { describe, it, expect } from "vitest";
import {
	parseKnowledgeResult,
	classifySourceUri,
	toFilePath,
	isKnowledgeTool,
} from "../lib/knowledge-result";

describe("knowledge-result — parseKnowledgeResult (지식 tool-result JSON 파싱)", () => {
	it("ask: {abstained, answer, sources} 파싱 + sourceUris 보존", () => {
		const out = JSON.stringify({ abstained: false, answer: "신분증", sources: [{ title: "전입신고", sourceUris: ["file:///ws/x.md"] }] });
		const p = parseKnowledgeResult("skill_knowledge_ask", out);
		expect(p).not.toBeNull();
		expect(p?.kind).toBe("ask");
		if (p?.kind === "ask") {
			expect(p.abstained).toBe(false);
			expect(p.answer).toBe("신분증");
			expect(p.sources[0].sourceUris).toContain("file:///ws/x.md");
		}
	});

	it("ask: 기권(abstained=true, sources=[])", () => {
		const out = JSON.stringify({ abstained: true, answer: "관련 근거를 찾지 못했습니다.", sources: [] });
		const p = parseKnowledgeResult("skill_knowledge_ask", out);
		expect(p?.kind === "ask" && p.abstained).toBe(true);
	});

	it("search: {hits:[{title,snippet,score,sourceUris}]} 파싱", () => {
		const out = JSON.stringify({ hits: [{ title: "여권", snippet: "수수료 53000원", score: 0.8, sourceUris: ["https://gov.kr/passport"] }] });
		const p = parseKnowledgeResult("skill_knowledge_search", out);
		expect(p?.kind).toBe("search");
		if (p?.kind === "search") {
			expect(p.hits[0].title).toBe("여권");
			expect(p.hits[0].sourceUris[0]).toBe("https://gov.kr/passport");
		}
	});

	it("비지식 도구/빈 output/잘못된 JSON/형태불일치 → null(기본 렌더 폴백)", () => {
		expect(parseKnowledgeResult("read_file", "{}")).toBeNull();
		expect(parseKnowledgeResult("skill_knowledge_ask", undefined)).toBeNull();
		expect(parseKnowledgeResult("skill_knowledge_ask", "not json")).toBeNull();
		expect(parseKnowledgeResult("skill_knowledge_ask", JSON.stringify({ answer: "x" }))).toBeNull(); // abstained/sources 누락
		expect(parseKnowledgeResult("skill_knowledge_search", JSON.stringify({ hits: [{ title: "x" }] }))).toBeNull(); // 필드 누락
	});

	it("isKnowledgeTool", () => {
		expect(isKnowledgeTool("skill_knowledge_ask")).toBe(true);
		expect(isKnowledgeTool("skill_knowledge_search")).toBe(true);
		expect(isKnowledgeTool("read_file")).toBe(false);
	});
});

describe("knowledge-result — 출처 분류(근거→원문 라우팅)", () => {
	it("classifySourceUri: http(s)=url, 그 외=file", () => {
		expect(classifySourceUri("https://gov.kr/x")).toBe("url");
		expect(classifySourceUri("http://x.com")).toBe("url");
		expect(classifySourceUri("/ws/doc.md")).toBe("file");
		expect(classifySourceUri("file:///ws/doc.md")).toBe("file");
	});
	it("toFilePath: file:// 접두 제거", () => {
		expect(toFilePath("file:///ws/doc.md")).toBe("/ws/doc.md");
		expect(toFilePath("/ws/doc.md")).toBe("/ws/doc.md");
	});
});
