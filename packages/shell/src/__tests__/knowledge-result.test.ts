import { describe, expect, it } from "vitest";
import {
	communityColor,
	entitySourcesFromKbJson,
	graphFromKbJson,
	MAX_GRAPH_NODES,
} from "../lib/knowledge-result";

describe("knowledge-result — 설정 KB 그래프 데이터", () => {
	it("communityColor: 결정론·순환(음수/초과 안전)", () => {
		expect(communityColor(0)).toBe(communityColor(0));
		expect(typeof communityColor(99)).toBe("string");
		expect(typeof communityColor(-3)).toBe("string");
	});

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
			expect(g.nodes.map((n) => n.label).sort()).toEqual([
				"신분증",
				"외딴섬",
				"전입신고",
			]);
			expect(g.edges).toHaveLength(1);
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
			expect(g?.edges).toHaveLength(0);
		});
	});

	describe("entitySourcesFromKbJson (노드 → 출처 문서)", () => {
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
			expect(src.e2).toEqual(["file:///ws/a.md"]);
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

		it("mentions/references 외 관계는 출처를 전파하지 않음", () => {
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
			expect(src.e2).toBeUndefined();
		});

		it("깊은 체인도 관계 배열 순서와 무관하게 말단까지 전파", () => {
			const src = entitySourcesFromKbJson(
				kbJson({
					cards: [{ title: "T", sourceUris: ["file:///t.md"] }],
					entities: [
						{ id: "t", name: "T" },
						{ id: "c1", name: "C1" },
						{ id: "c2", name: "C2" },
						{ id: "c3", name: "C3" },
					],
					relations: [
						{ from: "c2", to: "c3", type: "mentions" },
						{ from: "c1", to: "c2", type: "mentions" },
						{ from: "t", to: "c1", type: "mentions" },
					],
				}),
			);
			expect(src.c3).toEqual(["file:///t.md"]);
		});

		it("id=__proto__ 엔티티 출처 보존", () => {
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

	describe("graphFromKbJson — 노드 상한", () => {
		const kbJson = (kb: unknown) => JSON.stringify({ version: 1, kb });
		it("노드 상한 초과 → degree 상위 MAX_GRAPH_NODES 만 유지", () => {
			const N = MAX_GRAPH_NODES + 50;
			const entities = Array.from({ length: N }, (_, i) => ({
				id: `e${i}`,
				name: `n${i}`,
			}));
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
