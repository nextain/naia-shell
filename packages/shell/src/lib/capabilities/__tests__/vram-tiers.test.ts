import { describe, expect, it } from "vitest";
import {
	VRAM_TIERS,
	resolveActiveTier,
	selectVramTier,
	tierProvidedCapabilities,
} from "../vram-tiers";

describe("selectVramTier", () => {
	it("returns null below the lowest tier (external/cloud only)", () => {
		expect(selectVramTier(4)).toBeNull();
		expect(selectVramTier(0)).toBeNull();
	});

	it("picks the 6G tier between 6 and 12", () => {
		expect(selectVramTier(6)?.id).toBe("external-llm-6g");
		expect(selectVramTier(8)?.id).toBe("external-llm-6g");
	});

	it("picks the richest eligible tier", () => {
		expect(selectVramTier(12)?.id).toBe("avatar-voice-12g");
		expect(selectVramTier(16)?.id).toBe("avatar-voice-12g");
		expect(selectVramTier(24)?.id).toBe("full-local-24g");
		expect(selectVramTier(48)?.id).toBe("full-local-24g");
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
