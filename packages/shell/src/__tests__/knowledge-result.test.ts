import { describe, it, expect } from "vitest";
import {
	parseKnowledgeResult,
	classifySourceUri,
	toFilePath,
	isKnowledgeTool,
	parseKnowledgeGraph,
	isKnowledgeGraphTool,
	communityColor,
	graphFromKbJson,
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

describe("knowledge-result — parseKnowledgeGraph (K3 그래프 데이터)", () => {
	it("정상 그래프 파싱(nodes/edges/communityCount)", () => {
		const out = JSON.stringify({
			nodes: [{ id: "a", label: "전입신고", type: "Service", deg: 1, community: 0 }],
			edges: [{ from: "a", to: "b", type: "handled_by", weight: 2 }],
			communityCount: 1,
		});
		const g = parseKnowledgeGraph("skill_knowledge_graph", out);
		expect(g).not.toBeNull();
		expect(g?.nodes[0].label).toBe("전입신고");
		expect(g?.edges[0].weight).toBe(2);
		expect(g?.communityCount).toBe(1);
	});

	it("비그래프 도구/잘못된 JSON/형태불일치 → null", () => {
		expect(parseKnowledgeGraph("skill_knowledge_ask", "{}")).toBeNull();
		expect(parseKnowledgeGraph("skill_knowledge_graph", "not json")).toBeNull();
		expect(parseKnowledgeGraph("skill_knowledge_graph", JSON.stringify({ nodes: "x" }))).toBeNull();
	});

	it("isKnowledgeGraphTool", () => {
		expect(isKnowledgeGraphTool("skill_knowledge_graph")).toBe(true);
		expect(isKnowledgeGraphTool("skill_knowledge_ask")).toBe(false);
	});

	it("communityColor: 결정론·순환(음수/초과 안전)", () => {
		expect(communityColor(0)).toBe(communityColor(0));
		expect(typeof communityColor(99)).toBe("string");
		expect(typeof communityColor(-3)).toBe("string");
	});

	// ── K4: kb.json → 그래프(설정 지식 탭 직접 렌더용, 엔진 toGraphData 포팅) ──
	describe("graphFromKbJson (kb.json envelope → 2D/3D 그래프 데이터)", () => {
		const kbJson = (kb: unknown) => JSON.stringify({ version: 1, kb });

		it("빈/깨짐/비-envelope/엔티티0 → null", () => {
			expect(graphFromKbJson("")).toBeNull();
			expect(graphFromKbJson("{bad")).toBeNull();
			expect(graphFromKbJson(JSON.stringify({ version: 1 }))).toBeNull();
			expect(graphFromKbJson(kbJson({ entities: [], relations: [] }))).toBeNull();
		});

		it("엔티티·관계 → nodes/edges + degree + 군집", () => {
			const g = graphFromKbJson(
				kbJson({
					entities: [
						{ id: "e1", name: "전입신고", type: "Topic" },
						{ id: "e2", name: "신분증", type: "Concept" },
						{ id: "e3", name: "외딴섬", type: "Concept" },
					],
					relations: [{ from: "e1", type: "mentions", to: "e2", weight: 2 }],
				}),
			);
			expect(g).not.toBeNull();
			if (!g) return;
			expect(g.nodes.map((n) => n.label).sort()).toEqual(["신분증", "외딴섬", "전입신고"]);
			expect(g.edges).toHaveLength(1);
			// degree: e1·e2=1, e3=0
			const deg = Object.fromEntries(g.nodes.map((n) => [n.id, n.deg]));
			expect(deg.e1).toBe(1);
			expect(deg.e2).toBe(1);
			expect(deg.e3).toBe(0);
			expect(g.communityCount).toBeGreaterThanOrEqual(1);
		});

		it("댕글링 관계(미존재 엔티티) 제외", () => {
			const g = graphFromKbJson(
				kbJson({
					entities: [{ id: "e1", name: "A" }],
					relations: [{ from: "e1", to: "ghost", type: "x" }],
				}),
			);
			expect(g?.edges).toHaveLength(0); // ghost 미존재 → 엣지 제외
		});
	});
});
