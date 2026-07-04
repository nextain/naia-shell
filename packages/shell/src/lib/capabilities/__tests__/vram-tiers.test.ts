import { describe, expect, it } from "vitest";
import {
	VRAM_TIERS,
	resolveActiveTier,
	resolveLocalCapabilities,
	selectVramTier,
	tierFitsBoth,
	tierProvidedCapabilities,
} from "../vram-tiers";

describe("selectVramTier", () => {
	it("returns null below the lowest tier (external/cloud only)", () => {
		expect(selectVramTier(4)).toBeNull();
		expect(selectVramTier(0)).toBeNull();
	});

	it("picks the 6G tier between 6 and 8", () => {
		expect(selectVramTier(6)?.id).toBe("external-llm-6g");
		expect(selectVramTier(7)?.id).toBe("external-llm-6g");
	});

	it("picks the 8G exclusive tier between 8 and 12", () => {
		expect(selectVramTier(8)?.id).toBe("avatar-or-voice-8g");
		expect(selectVramTier(11)?.id).toBe("avatar-or-voice-8g");
	});

	it("picks the richest eligible tier", () => {
		expect(selectVramTier(12)?.id).toBe("avatar-voice-12g");
		expect(selectVramTier(16)?.id).toBe("avatar-voice-12g");
		expect(selectVramTier(24)?.id).toBe("full-local-24g");
		expect(selectVramTier(48)?.id).toBe("full-local-24g");
	});
});

describe("avatar/voice focus (exclusive 8G tier)", () => {
	const tier8 = selectVramTier(8)!;

	it("8G tier is exclusive with both avatar+voice as candidates", () => {
		expect(tier8.exclusiveLocal).toBe(true);
		expect(tier8.localCapabilities).toEqual(["tts", "avatar"]);
		expect(tierFitsBoth(tier8)).toBe(false);
	});

	it("focus=avatar → only avatar runs locally (voice → cloud)", () => {
		expect(resolveLocalCapabilities(tier8, "avatar")).toEqual(["avatar"]);
	});

	it("focus=voice → only local voice (avatar → static)", () => {
		expect(resolveLocalCapabilities(tier8, "voice")).toEqual(["tts"]);
	});

	it("focus undefined → defaults to voice (parity with wm 8g default)", () => {
		expect(resolveLocalCapabilities(tier8, undefined)).toEqual(["tts"]);
	});

	it("focus=both → audio+video run together locally (8G int8 6.07G)", () => {
		// ★8G 오디오+비디오: VoxCPM2 int8(3.47)+Ditto(2.6)=6.07 ≤ 8 → 둘 다 로컬(마스크 video 립싱크).
		expect(resolveLocalCapabilities(tier8, "both")).toEqual(["tts", "avatar"]);
	});

	it("12G+ fits both → focus ignored, both run together", () => {
		const tier12 = selectVramTier(12)!;
		expect(tierFitsBoth(tier12)).toBe(true);
		expect(resolveLocalCapabilities(tier12, "avatar")).toEqual([
			"tts",
			"avatar",
		]);
		expect(resolveLocalCapabilities(tier12, "voice")).toEqual([
			"tts",
			"avatar",
		]);
	});

	it("null tier → no local capabilities", () => {
		expect(resolveLocalCapabilities(null, "avatar")).toEqual([]);
		expect(tierFitsBoth(null)).toBe(false);
	});
});

describe("tier capability bridge (#365)", () => {
	it("12G tier serves avatar + voice locally; LLM stays external", () => {
		const tier = selectVramTier(12)!;
		expect(tierProvidedCapabilities(tier)).toEqual(["tts", "avatar"]);
		expect(tier.llm).toBe("external");
	});

	it("24G+ tier owns the LLM locally too", () => {
		const tier = selectVramTier(24)!;
		expect(tier.llm).toBe("own");
		expect(tierProvidedCapabilities(tier)).toContain("llm");
	});
});

describe("resolveActiveTier (config setting × detected VRAM)", () => {
	it("off / undefined → null (safe default, no slot change)", () => {
		expect(resolveActiveTier("off", 24)).toBeNull();
		expect(resolveActiveTier(undefined, 24)).toBeNull();
	});

	it("auto → tier from detected VRAM, null when undetected", () => {
		expect(resolveActiveTier("auto", 12)?.id).toBe("avatar-voice-12g");
		expect(resolveActiveTier("auto", 4)).toBeNull(); // below lowest tier
		expect(resolveActiveTier("auto", null)).toBeNull(); // VRAM unknown
	});

	it("explicit tier id → that tier regardless of detected VRAM", () => {
		expect(resolveActiveTier("full-local-24g", null)?.id).toBe(
			"full-local-24g",
		);
		expect(resolveActiveTier("avatar-voice-12g", 6)?.id).toBe(
			"avatar-voice-12g",
		);
	});
});

describe("F1 — no real-time claims", () => {
	it("every tier marks realtime as measurement-gated (never asserts RTF)", () => {
		for (const tier of VRAM_TIERS) {
			expect(tier.realtime).toBe("measurement-gated");
		}
	});

	it("tiers are ordered ascending by minVramGb", () => {
		const mins = VRAM_TIERS.map((t) => t.minVramGb);
		expect([...mins].sort((a, b) => a - b)).toEqual(mins);
	});
});
