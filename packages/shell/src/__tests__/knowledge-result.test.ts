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
	entitySourcesFromKbJson,
	MAX_GRAPH_NODES,
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

	describe("entitySourcesFromKbJson (노드 → 출처 문서, 근거→원문)", () => {
		const kbJson = (kb: unknown) => JSON.stringify({ version: 1, kb });

		it("Topic 엔티티(name=카드 title) → 카드 sourceUris 직접", () => {
			const src = entitySourcesFromKbJson(
				kbJson({
					cards: [{ title: "전입신고", sourceUris: ["file:///ws/a.md"] }],
					entities: [{ id: "e1", name: "전입신고", type: "Topic" }],
					relations: [],
				}),
			);
			expect(src.e1).toEqual(["file:///ws/a.md"]);
		});

		it("Concept 엔티티 → mentions 관계로 출처 전파", () => {
			const src = entitySourcesFromKbJson(
				kbJson({
					cards: [{ title: "전입신고", sourceUris: ["file:///ws/a.md"] }],
					entities: [
						{ id: "e1", name: "전입신고", type: "Topic" },
						{ id: "e2", name: "신분증", type: "Concept" },
					],
					relations: [{ from: "e1", to: "e2", type: "mentions" }],
				}),
			);
			expect(src.e2).toEqual(["file:///ws/a.md"]); // 전파됨
		});

		it("출처 없는 엔티티 → 키 부재", () => {
			const src = entitySourcesFromKbJson(
				kbJson({
					cards: [],
					entities: [{ id: "e1", name: "고아", type: "Concept" }],
					relations: [],
				}),
			);
			expect(src.e1).toBeUndefined();
		});

		it("빈/깨짐 → 빈 객체", () => {
			expect(entitySourcesFromKbJson("")).toEqual({});
			expect(entitySourcesFromKbJson("{bad")).toEqual({});
		});

		// ── 적대리뷰 회귀 잠금 ──
		it("mentions/references 외 관계(co_occurs)는 출처 전파 안 함(틀린 근거 방지)", () => {
			const src = entitySourcesFromKbJson(
				kbJson({
					cards: [{ title: "A", sourceUris: ["file:///a.md"] }],
					entities: [
						{ id: "e1", name: "A", type: "Topic" },
						{ id: "e2", name: "X", type: "Concept" },
					],
					relations: [{ from: "e1", to: "e2", type: "co_occurs" }],
				}),
			);
			expect(src.e1).toEqual(["file:///a.md"]);
			expect(src.e2).toBeUndefined(); // co_occurs 는 출처 상속 안 함
		});

		it("깊은 체인(depth 4) — 관계 배열 역순서여도 fixpoint 로 말단까지 전파", () => {
			const src = entitySourcesFromKbJson(
				kbJson({
					cards: [{ title: "T", sourceUris: ["file:///t.md"] }],
					entities: [
						{ id: "t", name: "T" },
						{ id: "c1", name: "C1" },
						{ id: "c2", name: "C2" },
						{ id: "c3", name: "C3" },
					],
					// 역순 배열(고정 3패스면 c3 누락, fixpoint 면 도달)
					relations: [
						{ from: "c2", to: "c3", type: "mentions" },
						{ from: "c1", to: "c2", type: "mentions" },
						{ from: "t", to: "c1", type: "mentions" },
					],
				}),
			);
			expect(src.c3).toEqual(["file:///t.md"]);
		});

		it("id=__proto__ 엔티티 출처 보존(소실/오염 없음)", () => {
			const src = entitySourcesFromKbJson(
				kbJson({
					cards: [{ title: "P", sourceUris: ["file:///p.md"] }],
					entities: [{ id: "__proto__", name: "P" }],
					relations: [],
				}),
			);
			expect(Object.keys(src)).toContain("__proto__");
			expect(src["__proto__"]).toEqual(["file:///p.md"]);
		});
	});

	describe("graphFromKbJson — 노드 상한(적대리뷰 회귀 잠금)", () => {
		const kbJson = (kb: unknown) => JSON.stringify({ version: 1, kb });
		it("노드 상한 초과 → degree 상위 MAX_GRAPH_NODES 만 유지(허브 보존·엣지 정합)", () => {
			const N = MAX_GRAPH_NODES + 50;
			const entities = Array.from({ length: N }, (_, i) => ({
				id: `e${i}`,
				name: `n${i}`,
			}));
			// e0 = 허브(다수 연결) → degree 상위라 반드시 유지
			const relations = Array.from({ length: 40 }, (_, i) => ({
				from: "e0",
				to: `e${i + 1}`,
				type: "mentions",
			}));
			const g = graphFromKbJson(kbJson({ cards: [], entities, relations }));
			expect(g).not.toBeNull();
			if (!g) return;
			expect(g.nodes.length).toBe(MAX_GRAPH_NODES);
			expect(g.nodes.some((n) => n.id === "e0")).toBe(true);
			const ids = new Set(g.nodes.map((n) => n.id));
			expect(g.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
		});
	});
});
