import { describe, expect, it } from "vitest";
import {
	addSource,
	DEFAULT_KNOWLEDGE_SCOPE,
	emptyKnowledgeConfig,
	normalizeSourcePath,
	parseKbStats,
	parseKnowledgeConfig,
	removeSource,
	serializeKnowledgeConfig,
	sourceLabel,
} from "../lib/knowledge-config";

describe("knowledge-config (FR-KB-OS.5~7 — 소스 관리 순수 로직)", () => {
	describe("parseKnowledgeConfig", () => {
		it("빈/널 → 기본 config(스코프 default, 소스 0)", () => {
			for (const v of ["", "   ", null, undefined]) {
				const c = parseKnowledgeConfig(v);
				expect(c.scope).toBe(DEFAULT_KNOWLEDGE_SCOPE);
				expect(c.sources).toEqual([]);
			}
		});

		it("깨진 JSON → 기본 config(throw 안 함)", () => {
			expect(parseKnowledgeConfig("{not json")).toEqual(emptyKnowledgeConfig());
		});

		it("유효 JSON → 파싱 + 로드 중 정규화 dedup", () => {
			const json = JSON.stringify({
				version: 1,
				scope: "proj-a",
				sources: [
					{ path: "/docs/a" },
					{ path: "/docs/a/" }, // 정규화하면 중복
					{ path: "/docs/b", label: "B" },
				],
			});
			const c = parseKnowledgeConfig(json);
			expect(c.scope).toBe("proj-a");
			expect(c.sources).toHaveLength(2);
			expect(c.sources[0].path).toBe("/docs/a");
			expect(c.sources[1].label).toBe("B");
		});

		it("스코프 누락/공백 → default", () => {
			expect(parseKnowledgeConfig(JSON.stringify({ sources: [] })).scope).toBe(
				DEFAULT_KNOWLEDGE_SCOPE,
			);
		});
	});

	describe("normalizeSourcePath", () => {
		it("역슬래시→슬래시, 말미 슬래시 제거, trim", () => {
			expect(normalizeSourcePath("C:\\docs\\a\\")).toBe("C:/docs/a");
			expect(normalizeSourcePath("  /docs/b/  ")).toBe("/docs/b");
			expect(normalizeSourcePath("/")).toBe("/");
		});
	});

	describe("addSource / removeSource", () => {
		it("추가 + 정규화 dedup(이미 있으면 무변)", () => {
			let c = emptyKnowledgeConfig();
			c = addSource(c, "/docs/a");
			c = addSource(c, "/docs/a/"); // 중복 → 무시
			c = addSource(c, "C:\\docs\\a"); // 다른 경로(대소문자/드라이브)
			expect(c.sources.map((s) => s.path)).toEqual(["/docs/a", "C:\\docs\\a"]);
		});

		it("빈 경로 추가 무시", () => {
			const c = addSource(emptyKnowledgeConfig(), "   ");
			expect(c.sources).toEqual([]);
		});

		it("제거 — 정규화 매칭", () => {
			let c = addSource(emptyKnowledgeConfig(), "/docs/a");
			c = addSource(c, "/docs/b");
			c = removeSource(c, "/docs/a/"); // 정규화 매칭
			expect(c.sources.map((s) => s.path)).toEqual(["/docs/b"]);
		});
	});

	describe("serialize roundtrip", () => {
		it("직렬화→파싱 = 동일 스코프/소스", () => {
			let c = emptyKnowledgeConfig();
			c.scope = "proj-x";
			c = addSource(c, "/docs/a", "A");
			const round = parseKnowledgeConfig(serializeKnowledgeConfig(c));
			expect(round.scope).toBe("proj-x");
			expect(round.sources).toEqual([{ path: "/docs/a", label: "A" }]);
		});
	});

	describe("sourceLabel", () => {
		it("label 우선, 없으면 마지막 세그먼트", () => {
			expect(sourceLabel({ path: "/docs/gov", label: "정부자료" })).toBe(
				"정부자료",
			);
			expect(sourceLabel({ path: "/docs/gov/" })).toBe("gov");
			expect(sourceLabel({ path: "C:\\a\\b" })).toBe("b");
		});
	});

	describe("parseKbStats (FR-KB-OS.7 — kb.json 통계)", () => {
		it("빈/깨짐/비-envelope → null(미컴파일)", () => {
			expect(parseKbStats("")).toBeNull();
			expect(parseKbStats("{bad")).toBeNull();
			expect(parseKbStats(JSON.stringify({ version: 1 }))).toBeNull();
			expect(parseKbStats(JSON.stringify({ kb: { cards: 1 } }))).toBeNull();
		});

		it("유효 envelope → 카드/엔티티/관계/accepted 수", () => {
			const json = JSON.stringify({
				version: 1,
				kb: {
					cards: [
						{ id: "c1", status: "accepted" },
						{ id: "c2", status: "draft" },
						{ id: "c3", status: "accepted" },
					],
					entities: [{ id: "e1" }, { id: "e2" }],
					relations: [{ from: "e1", type: "x", to: "e2" }],
				},
			});
			expect(parseKbStats(json)).toEqual({
				cards: 3,
				entities: 2,
				relations: 1,
				accepted: 2,
			});
		});
	});
});
