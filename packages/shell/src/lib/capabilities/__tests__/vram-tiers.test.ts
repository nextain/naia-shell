import { describe, expect, it } from "vitest";
import {
	VRAM_TIERS,
	type VramTierId,
	fitLocalCapabilitiesToVram,
	normalizeLocal8gFocus,
	normalizeTierId,
	normalizeTierSetting,
	resolveActiveTier,
	resolveLocalCapabilities,
	selectVramTier,
	tierFitsBoth,
	tierProvidedCapabilities,
} from "../vram-tiers";

describe("selectVramTier (2026-07-08 monotonic tiers)", () => {
	it("returns null below the lowest tier (external/cloud only)", () => {
		expect(selectVramTier(4)).toBeNull();
		expect(selectVramTier(0)).toBeNull();
	});

	it("picks the 6G avatar-only tier between 6 and 8", () => {
		expect(selectVramTier(6)?.id).toBe("avatar-6g");
		expect(selectVramTier(7)?.id).toBe("avatar-6g");
	});

	it("picks the 8G local-LLM+avatar tier between 8 and 12", () => {
		expect(selectVramTier(8)?.id).toBe("local-llm-avatar-8g");
		expect(selectVramTier(11)?.id).toBe("local-llm-avatar-8g");
	});

	it("picks the richest eligible tier", () => {
		expect(selectVramTier(12)?.id).toBe("local-voice-12g");
		expect(selectVramTier(16)?.id).toBe("local-voice-12g");
		expect(selectVramTier(24)?.id).toBe("full-realtime-24g");
		expect(selectVramTier(48)?.id).toBe("full-realtime-24g");
	});
});

describe("monotonic local capabilities (avatar → +llm → +voice)", () => {
	it("6G: avatar local only; LLM + voice = cloud", () => {
		const t = selectVramTier(6)!;
		expect(t.llm).toBe("external");
		expect(t.localCapabilities).toEqual(["avatar"]);
		expect(tierFitsBoth(t)).toBe(false);
	});

	it("8G: exclusive tier — llm + avatar candidates; voice = cloud (no tts)", () => {
		const t = selectVramTier(8)!;
		expect(t.llm).toBe("own"); // ★ brain privacy — LLM can run locally on 8G
		expect(t.exclusiveLocal).toBe(true); // 3-mode focus: llm / avatar / both
		expect(t.localCapabilities).toEqual(["llm", "avatar"]);
		expect(t.localCapabilities).not.toContain("tts");
		expect(tierFitsBoth(t)).toBe(false); // no local voice on 8G
	});

	it("12G (4070+): adds local voice → LLM + avatar + tts", () => {
		const t = selectVramTier(12)!;
		expect(t.llm).toBe("own");
		expect(t.localCapabilities).toEqual(["llm", "avatar", "tts"]);
		expect(tierFitsBoth(t)).toBe(true);
	});

	it("24G: full local (same caps as 12G; realtime is the added axis)", () => {
		const t = selectVramTier(24)!;
		expect(t.llm).toBe("own");
		expect(t.localCapabilities).toEqual(["llm", "avatar", "tts"]);
	});

	it("8G focus resolves exclusively — llm / avatar / both", () => {
		const t8 = selectVramTier(8)!;
		expect(resolveLocalCapabilities(t8, "llm")).toEqual(["llm"]);
		expect(resolveLocalCapabilities(t8, "avatar")).toEqual(["avatar"]);
		expect(resolveLocalCapabilities(t8, "both")).toEqual(["llm", "avatar"]);
		// 미지정 → 기본 "llm"(프라이버시-우선·최안전)
		expect(resolveLocalCapabilities(t8, undefined)).toEqual(["llm"]);
	});

	it("non-exclusive tiers (12G+) ignore focus → all caps", () => {
		const t12 = selectVramTier(12)!;
		expect(resolveLocalCapabilities(t12, "llm")).toEqual([
			"llm",
			"avatar",
			"tts",
		]);
		expect(resolveLocalCapabilities(t12, "avatar")).toEqual([
			"llm",
			"avatar",
			"tts",
		]);
	});

	it("null tier → no local capabilities", () => {
		expect(resolveLocalCapabilities(null, "avatar")).toEqual([]);
		expect(tierFitsBoth(null)).toBe(false);
	});
});

describe("normalizeLocal8gFocus (validator + legacy migration)", () => {
	it("신 값 그대로", () => {
		expect(normalizeLocal8gFocus("llm")).toBe("llm");
		expect(normalizeLocal8gFocus("avatar")).toBe("avatar");
		expect(normalizeLocal8gFocus("both")).toBe("both");
	});
	it("구 축 'voice' → 'avatar' 마이그레이션", () => {
		expect(normalizeLocal8gFocus("voice")).toBe("avatar");
	});
	it("미지/빈값 → 기본 'llm'(프라이버시-우선)", () => {
		expect(normalizeLocal8gFocus(undefined)).toBe("llm");
		expect(normalizeLocal8gFocus(null)).toBe("llm");
		expect(normalizeLocal8gFocus("bogus")).toBe("llm");
	});
});

describe("fitLocalCapabilitiesToVram (VRAM preflight → cloud LLM fallback)", () => {
	it("fits available VRAM → unchanged, no fallback", () => {
		// llm 4.0 + avatar 2.6 = 6.6 ≤ (8 - 1) = 7 → fits
		const r = fitLocalCapabilitiesToVram(["llm", "avatar"], 8, 1.0);
		expect(r.llmFallbackToCloud).toBe(false);
		expect(r.caps).toEqual(["llm", "avatar"]);
		expect(r.requiredGb).toBeCloseTo(6.6, 5);
	});

	it("tight VRAM → drop LLM to cloud, keep avatar", () => {
		// 6.6 > (6 - 1) = 5 → llm 강등
		const r = fitLocalCapabilitiesToVram(["llm", "avatar"], 6, 1.0);
		expect(r.llmFallbackToCloud).toBe(true);
		expect(r.caps).toEqual(["avatar"]);
	});

	it("no llm in caps → never flags fallback even if over budget", () => {
		const r = fitLocalCapabilitiesToVram(["avatar"], 2, 1.0);
		expect(r.llmFallbackToCloud).toBe(false);
		expect(r.caps).toEqual(["avatar"]);
	});

	it("unknown VRAM (null) → pass through, no probe", () => {
		const r = fitLocalCapabilitiesToVram(["llm", "avatar"], null);
		expect(r.llmFallbackToCloud).toBe(false);
		expect(r.caps).toEqual(["llm", "avatar"]);
		expect(r.availableGb).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("tier capability bridge", () => {
	it("8G tier owns the LLM locally (brain privacy)", () => {
		const t = selectVramTier(8)!;
		expect(t.llm).toBe("own");
		expect(tierProvidedCapabilities(t)).toContain("llm");
	});

	it("12G tier serves avatar + voice locally too", () => {
		const t = selectVramTier(12)!;
		expect(tierProvidedCapabilities(t)).toEqual(["llm", "avatar", "tts"]);
	});
});

describe("resolveActiveTier (config setting × detected VRAM)", () => {
	it("off / undefined → null (safe default, no slot change)", () => {
		expect(resolveActiveTier("off", 24)).toBeNull();
		expect(resolveActiveTier(undefined, 24)).toBeNull();
	});

	it("auto → tier from detected VRAM, null when undetected", () => {
		expect(resolveActiveTier("auto", 12)?.id).toBe("local-voice-12g");
		expect(resolveActiveTier("auto", 4)).toBeNull(); // below lowest tier
		expect(resolveActiveTier("auto", null)).toBeNull(); // VRAM unknown
	});

	it("explicit tier id → that tier regardless of detected VRAM", () => {
		expect(resolveActiveTier("full-realtime-24g", null)?.id).toBe(
			"full-realtime-24g",
		);
		expect(resolveActiveTier("local-voice-12g", 6)?.id).toBe("local-voice-12g");
	});

	it("legacy tier ids migrate to new ids (saved config back-compat)", () => {
		const legacy = (id: string) =>
			resolveActiveTier(id as VramTierId, null)?.id;
		expect(legacy("external-llm-6g")).toBe("avatar-6g");
		expect(legacy("avatar-or-voice-8g")).toBe("local-llm-avatar-8g");
		expect(legacy("avatar-voice-12g")).toBe("local-voice-12g");
		expect(legacy("full-local-24g")).toBe("full-realtime-24g");
	});
});

describe("normalizeTierId / normalizeTierSetting (id ingestion boundary)", () => {
	it("normalizeTierId: 구 id → 신 id, 신 id 그대로, 미지/빈값 → null", () => {
		expect(normalizeTierId("external-llm-6g")).toBe("avatar-6g");
		expect(normalizeTierId("avatar-or-voice-8g")).toBe("local-llm-avatar-8g");
		expect(normalizeTierId("avatar-voice-12g")).toBe("local-voice-12g");
		expect(normalizeTierId("full-local-24g")).toBe("full-realtime-24g");
		expect(normalizeTierId("local-llm-avatar-8g")).toBe("local-llm-avatar-8g");
		expect(normalizeTierId("bogus")).toBeNull();
		expect(normalizeTierId(undefined)).toBeNull();
		expect(normalizeTierId(null)).toBeNull();
	});

	it("normalizeTierSetting: auto/off 통과, 구 id → 신 id, 미지 → off", () => {
		expect(normalizeTierSetting("auto")).toBe("auto");
		expect(normalizeTierSetting("off")).toBe("off");
		expect(normalizeTierSetting(undefined)).toBe("off");
		expect(normalizeTierSetting("avatar-or-voice-8g")).toBe(
			"local-llm-avatar-8g",
		);
		expect(normalizeTierSetting("bogus")).toBe("off");
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
