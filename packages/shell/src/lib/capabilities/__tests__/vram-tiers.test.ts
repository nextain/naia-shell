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

	// 2026-07-15 재계약: auto/추천은 **검증된(hidden 아님) 티어만** 고른다 — 미검증 티어를
	// 자동으로 고르면 프로파일 의도를 배반(실증: 16GB auto 가 숨긴 12g 를 골라 NVA 를 심음).
	it("8GB+ auto selects the validated 4060 laptop profile until 16GB", () => {
		expect(selectVramTier(6)).toBeNull();
		expect(selectVramTier(8)?.id).toBe("laptop-4060-8g");
		expect(selectVramTier(12)?.id).toBe("laptop-4060-8g");
	});

	it("16GB+ auto = local-llm-voice-16g (유일한 검증 티어, 3080 Ti 실측 2026-07-15)", () => {
		expect(selectVramTier(16)?.id).toBe("local-llm-voice-16g");
		expect(selectVramTier(24)?.id).toBe("local-llm-voice-16g");
		expect(selectVramTier(48)?.id).toBe("local-llm-voice-16g");
	});

	it("local-llm-voice-16g: LLM+음성 티어 데이터 계약", () => {
		// 아바타 GPU 를 음성에 양보하는 가지(branch) 티어: VRM/클라우드 아바타 + 로컬 LLM+TTS.
		const t = VRAM_TIERS.find((x) => x.id === "local-llm-voice-16g");
		expect(t).toBeDefined();
		expect(t?.localCapabilities).toEqual(["llm", "tts"]);
		expect(t?.llm).toBe("own");
		expect(t?.exclusiveLocal).toBeFalsy(); // 동시 구동 (실측 11.4G/16.4G)
		expect(t?.hidden).toBeFalsy(); // 유일한 노출(검증) 티어
	});

	it("laptop-4060-8g maps to the windows-manager loader profile", () => {
		const t = VRAM_TIERS.find((x) => x.id === "laptop-4060-8g");
		expect(t).toBeDefined();
		expect(t?.llm).toBe("external");
		expect(t?.localCapabilities).toEqual(["tts", "avatar"]);
		expect(t?.approxLocalVramGb).toBeCloseTo(6.07, 2);
		expect(t?.loaderProfile).toBe("laptop_4060_8g");
		expect(t?.exclusiveLocal).toBeFalsy();
		expect(t?.hidden).toBeFalsy();
	});
});

describe("monotonic local capabilities (avatar → +llm → +voice) — 데이터 계약(auto 무관)", () => {
	// hidden 티어도 데이터/하위호환 로직은 유지된다 — 조회는 find (auto 는 못 고름).
	const byId = (id: string) => VRAM_TIERS.find((x) => x.id === id)!;

	it("6G: avatar local only; LLM + voice = cloud", () => {
		const t = byId("avatar-6g");
		expect(t.llm).toBe("external");
		expect(t.localCapabilities).toEqual(["avatar"]);
		expect(tierFitsBoth(t)).toBe(false);
	});

	it("8G: exclusive tier — llm + avatar candidates; voice = cloud (no tts)", () => {
		const t = byId("local-llm-avatar-8g");
		expect(t.llm).toBe("own"); // ★ brain privacy — LLM can run locally on 8G
		expect(t.exclusiveLocal).toBe(true); // 3-mode focus: llm / avatar / both
		expect(t.localCapabilities).toEqual(["llm", "avatar"]);
		expect(t.localCapabilities).not.toContain("tts");
		expect(tierFitsBoth(t)).toBe(false); // no local voice on 8G
	});

	it("8G laptop profile: local int8 voice + avatar, LLM/STT external", () => {
		const t = byId("laptop-4060-8g");
		expect(t.llm).toBe("external");
		expect(t.localCapabilities).toEqual(["tts", "avatar"]);
		expect(tierFitsBoth(t)).toBe(true);
		expect(resolveLocalCapabilities(t, "llm")).toEqual(["tts", "avatar"]);
	});

	it("12G (4070+): adds local voice → LLM + avatar + tts", () => {
		const t = byId("local-voice-12g");
		expect(t.llm).toBe("own");
		expect(t.localCapabilities).toEqual(["llm", "avatar", "tts"]);
		expect(tierFitsBoth(t)).toBe(true);
	});

	it("24G: full local (same caps as 12G; realtime is the added axis)", () => {
		const t = byId("full-realtime-24g");
		expect(t.llm).toBe("own");
		expect(t.localCapabilities).toEqual(["llm", "avatar", "tts"]);
	});

	it("8G focus resolves exclusively — llm / avatar / both", () => {
		const t8 = byId("local-llm-avatar-8g");
		expect(resolveLocalCapabilities(t8, "llm")).toEqual(["llm"]);
		expect(resolveLocalCapabilities(t8, "avatar")).toEqual(["avatar"]);
		expect(resolveLocalCapabilities(t8, "both")).toEqual(["llm", "avatar"]);
		// 미지정 → 기본 "llm"(프라이버시-우선·최안전)
		expect(resolveLocalCapabilities(t8, undefined)).toEqual(["llm"]);
	});

	it("non-exclusive tiers (12G+) ignore focus → all caps", () => {
		const t12 = byId("local-voice-12g");
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

	it("8G both at PRODUCTION margin(1.5) → LLM falls back (fidelity, 적대리뷰 2026-07-09)", () => {
		// ★ SettingsTab 은 margin 1.5 로 호출(프리플라이트 실호출 경로). 실 8GB 카드에서
		//   both(llm 4.0 + avatar 2.6 = 6.6) > budget(8 - 1.5 = 6.5) → **LLM 클라우드 강등**.
		//   즉 8G "둘 다 로컬" 선택해도 실측 numbers 상 **아바타만 로컬 + LLM 클라우드**가 된다.
		//   (위 margin=1.0 케이스는 순수 함수 검증용. 이 케이스가 프로덕션 실동작 fidelity.)
		//   실 fit 여부는 measurement-gated(F1) — cost 추정치가 바뀌면 이 경계도 바뀜.
		const r = fitLocalCapabilitiesToVram(["llm", "avatar"], 8, 1.5);
		expect(r.llmFallbackToCloud).toBe(true);
		expect(r.caps).toEqual(["avatar"]);
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
	const byId = (id: string) => VRAM_TIERS.find((x) => x.id === id)!;

	it("8G tier owns the LLM locally (brain privacy)", () => {
		const t = byId("local-llm-avatar-8g");
		expect(t.llm).toBe("own");
		expect(tierProvidedCapabilities(t)).toContain("llm");
	});

	it("12G tier serves avatar + voice locally too", () => {
		const t = byId("local-voice-12g");
		expect(tierProvidedCapabilities(t)).toEqual(["llm", "avatar", "tts"]);
	});
});

describe("resolveActiveTier (config setting × detected VRAM)", () => {
	it("off / undefined → null (safe default, no slot change)", () => {
		expect(resolveActiveTier("off", 24)).toBeNull();
		expect(resolveActiveTier(undefined, 24)).toBeNull();
	});

	it("auto resolves only validated visible tiers", () => {
		// UI 에서 auto 옵션은 제거됨(2026-07-15) — 저장돼 있던 auto 값의 하위호환 해석만 유지.
		expect(resolveActiveTier("auto", 16)?.id).toBe("local-llm-voice-16g");
		expect(resolveActiveTier("auto", 12)?.id).toBe("laptop-4060-8g");
		expect(resolveActiveTier("auto", 8)?.id).toBe("laptop-4060-8g");
		expect(resolveActiveTier("auto", 4)).toBeNull();
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
		expect(normalizeTierId("laptop-4060-8g")).toBe("laptop-4060-8g");
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
		expect(normalizeTierSetting("laptop-4060-8g")).toBe("laptop-4060-8g");
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
