import { describe, expect, it } from "vitest";
import { VRAM_TIERS, selectVramTier } from "../vram-tiers";
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

	it("6GB(external-llm-6g) → tts 슬롯만 로컬 추천, llm/avatar 없음", () => {
		const tier = selectVramTier(6);
		expect(tier?.id).toBe("external-llm-6g");
		const recs = tierRecommendedSlots(tier);
		expect(recs).toHaveLength(1);
		expect(recs[0]).toMatchObject({
			slot: "tts",
			capability: "tts",
			localValue: "naia-local-voice",
		});
	});

	it("8GB(배타) → focus 로 아바타 XOR 음성 하나만 추천", () => {
		const tier = selectVramTier(8);
		expect(tier?.id).toBe("avatar-or-voice-8g");
		// focus=voice(기본) → tts 슬롯만
		expect(tierRecommendedSlots(tier, "voice").map((r) => r.slot)).toEqual([
			"tts",
		]);
		expect(slotRecommendation(tier, "avatar", "voice")).toBeNull();
		expect(
			isRecommendedLocalValue(tier, "tts", "naia-local-voice", "voice"),
		).toBe(true);
		// focus=avatar → avatar 슬롯만
		expect(tierRecommendedSlots(tier, "avatar").map((r) => r.slot)).toEqual([
			"avatar",
		]);
		expect(slotRecommendation(tier, "tts", "avatar")).toBeNull();
		expect(
			isRecommendedLocalValue(tier, "avatar", "naia-video-avatar", "avatar"),
		).toBe(true);
		// 두 focus 어느 쪽도 main(llm)은 추천 안 함
		expect(slotRecommendation(tier, "main", "avatar")).toBeNull();
	});

	it("12GB(avatar-voice-12g) → tts + avatar 로컬 추천", () => {
		const tier = selectVramTier(12);
		expect(tier?.id).toBe("avatar-voice-12g");
		const slots = tierRecommendedSlots(tier).map((r) => r.slot);
		expect(slots).toContain("tts");
		expect(slots).toContain("avatar");
		expect(slots).not.toContain("main");
		expect(
			isRecommendedLocalValue(tier, "avatar", "naia-video-avatar"),
		).toBe(true);
		expect(isRecommendedLocalValue(tier, "tts", "naia-local-voice")).toBe(
			true,
		);
	});

	it("24GB(full-local-24g) → main(llm) + tts + avatar 모두 로컬 추천", () => {
		const tier = selectVramTier(24);
		expect(tier?.id).toBe("full-local-24g");
		const slots = tierRecommendedSlots(tier).map((r) => r.slot);
		expect(slots).toContain("main");
		expect(slots).toContain("tts");
		expect(slots).toContain("avatar");
		expect(isRecommendedLocalValue(tier, "main", "ollama")).toBe(true);
	});

	it("추천값 불일치 시 배지 false (예: tts=edge 선택)", () => {
		const tier = selectVramTier(12);
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
