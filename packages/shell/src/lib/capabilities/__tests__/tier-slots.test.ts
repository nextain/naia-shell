import { describe, expect, it } from "vitest";
import { VRAM_TIERS } from "../vram-tiers";
import {
	isRecommendedLocalValue,
	slotRecommendation,
	tierRecommendedSlots,
} from "../tier-slots";

describe("tier-slots — VRAM tier → 슬롯 로컬 추천 (FR-VRAM.4)", () => {
	it("tier=null(로컬 off/VRAM 미달) → 추천 없음", () => {
		expect(tierRecommendedSlots(null)).toEqual([]);
		expect(slotRecommendation(null, "tts")).toBeNull();
		expect(isRecommendedLocalValue(null, "tts", "naia-local-voice")).toBe(
			false,
		);
	});

	it("6GB(avatar-6g) → avatar 슬롯만 로컬 추천, llm/tts 없음", () => {
		const tier = VRAM_TIERS.find((x) => x.id === "avatar-6g") ?? null;
		expect(tier?.id).toBe("avatar-6g");
		const recs = tierRecommendedSlots(tier);
		expect(recs).toHaveLength(1);
		expect(recs[0]).toMatchObject({
			slot: "avatar",
			capability: "avatar",
			localValue: "naia-video-avatar",
		});
	});

	it("8GB(local-llm-avatar-8g) 배타 → focus 로 main(llm)/avatar/둘다 추천, tts 없음", () => {
		const tier = VRAM_TIERS.find((x) => x.id === "local-llm-avatar-8g") ?? null;
		expect(tier?.id).toBe("local-llm-avatar-8g");
		// 기본(미지정) → llm(브레인 로컬 = 프라이버시-우선) → main 만
		expect(tierRecommendedSlots(tier).map((r) => r.slot)).toEqual(["main"]);
		// both → main + avatar
		const both = tierRecommendedSlots(tier, "both").map((r) => r.slot);
		expect(both).toContain("main"); // ★ 로컬 LLM = 브레인 프라이버시
		expect(both).toContain("avatar");
		expect(both).not.toContain("tts"); // 음성 = 클라우드
		// focus=llm → main 만
		expect(tierRecommendedSlots(tier, "llm").map((r) => r.slot)).toEqual([
			"main",
		]);
		// focus=avatar → avatar 만
		expect(tierRecommendedSlots(tier, "avatar").map((r) => r.slot)).toEqual([
			"avatar",
		]);
		expect(isRecommendedLocalValue(tier, "main", "ollama", "llm")).toBe(true);
		expect(
			isRecommendedLocalValue(tier, "avatar", "naia-video-avatar", "avatar"),
		).toBe(true);
	});

	it("12GB(local-voice-12g) → main + tts + avatar 로컬 추천", () => {
		const tier = VRAM_TIERS.find((x) => x.id === "local-voice-12g") ?? null;
		expect(tier?.id).toBe("local-voice-12g");
		const slots = tierRecommendedSlots(tier).map((r) => r.slot);
		expect(slots).toContain("main");
		expect(slots).toContain("tts");
		expect(slots).toContain("avatar");
		expect(isRecommendedLocalValue(tier, "avatar", "naia-video-avatar")).toBe(
			true,
		);
		expect(isRecommendedLocalValue(tier, "tts", "naia-local-voice")).toBe(true);
	});

	it("24GB(full-realtime-24g) → main(llm) + tts + avatar 모두 로컬 추천", () => {
		const tier = VRAM_TIERS.find((x) => x.id === "full-realtime-24g") ?? null;
		expect(tier?.id).toBe("full-realtime-24g");
		const slots = tierRecommendedSlots(tier).map((r) => r.slot);
		expect(slots).toContain("main");
		expect(slots).toContain("tts");
		expect(slots).toContain("avatar");
		expect(isRecommendedLocalValue(tier, "main", "ollama")).toBe(true);
	});

	it("추천값 불일치 시 배지 false (예: tts=edge 선택)", () => {
		const tier = VRAM_TIERS.find((x) => x.id === "local-voice-12g") ?? null;
		expect(isRecommendedLocalValue(tier, "tts", "edge")).toBe(false);
		expect(isRecommendedLocalValue(tier, "tts", undefined)).toBe(false);
	});

	it("모든 tier 의 추천 슬롯은 6슬롯 화이트리스트 내", () => {
		const valid = new Set([
			"main",
			"sub",
			"embedding",
			"stt",
			"tts",
			"avatar",
		]);
		for (const tier of VRAM_TIERS) {
			for (const rec of tierRecommendedSlots(tier)) {
				expect(valid.has(rec.slot)).toBe(true);
			}
		}
	});
});
