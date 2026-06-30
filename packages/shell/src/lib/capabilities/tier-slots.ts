/**
 * VRAM tier → 슬롯별 로컬 추천 (FR-VRAM.4).
 *
 * `vram-tiers.ts` 가 "이 tier 가 VRAM 예산 내에서 로컬로 서빙 가능한 capability"
 * (llm/tts/avatar)를 선언하면, 이 모듈은 그것을 **6 슬롯**(main/sub/embedding/
 * stt/tts/avatar) 중 어디에 **추천**으로 표시할지로 번역한다.
 *
 * 경계 (FR-VRAM.2 와의 차이 — 의도적):
 * - FR-VRAM.2 의 "fold = 외부 슬롯 숨김"은 채택하지 않는다. 런타임 매니저가 실제
 *   readiness 를 보고하기 전에는 외부 슬롯을 숨기면 안 된다(windows-manager F1,
 *   measurement-gated). 따라서 이 모듈은 **숨김이 아니라 추천만** 산출한다 —
 *   사용자가 VRAM 예산 안에서 무엇을 로컬로 돌릴 수 있는지 *보고* 선택·확인하게.
 * - 순수(I/O 0). SettingsTab 배지·온보딩 슬롯 step·슬롯 개요가 동일 로직을
 *   소비(비일관 방지) — slots/model.ts·vram-tiers.ts 와 동형.
 */

import type { ModelCapability } from "../types";
import type { SlotId } from "../slots/model";
import type { VramTier } from "./vram-tiers";

export interface SlotRecommendation {
	/** 추천이 걸리는 6슬롯 중 하나. */
	slot: SlotId;
	/** 로컬 추천을 정당화하는 tier capability. */
	capability: ModelCapability;
	/** 슬롯에 추천되는 로컬 wire 값(provider id / avatar provider). */
	localValue: string;
}

/**
 * tier capability → (슬롯, 추천 로컬 wire 값).
 * - llm  → main 슬롯, 로컬 LLM = ollama (크로스플랫폼 로컬 기본; 24G+ tier 에서만 등장).
 * - tts  → tts 슬롯, 로컬 음성 = naia-local-voice.
 * - avatar → avatar 슬롯, 로컬 아바타 = naia-video-avatar.
 */
const CAP_TO_SLOT: Partial<
	Record<ModelCapability, { slot: SlotId; localValue: string }>
> = {
	llm: { slot: "main", localValue: "ollama" },
	tts: { slot: "tts", localValue: "naia-local-voice" },
	avatar: { slot: "avatar", localValue: "naia-video-avatar" },
};

/**
 * 활성 tier 가 VRAM 예산 내에서 로컬 추천할 슬롯 목록. tier 가 null(로컬 off /
 * VRAM 미달)이면 빈 배열 → 추천 없음(클라우드 기본 유지).
 */
export function tierRecommendedSlots(
	tier: VramTier | null,
): SlotRecommendation[] {
	if (!tier) return [];
	const recs: SlotRecommendation[] = [];
	for (const cap of tier.localCapabilities) {
		const m = CAP_TO_SLOT[cap];
		if (m) {
			recs.push({ slot: m.slot, capability: cap, localValue: m.localValue });
		}
	}
	return recs;
}

/** 특정 슬롯의 로컬 추천(있으면) — 없으면 null. */
export function slotRecommendation(
	tier: VramTier | null,
	slot: SlotId,
): SlotRecommendation | null {
	return tierRecommendedSlots(tier).find((r) => r.slot === slot) ?? null;
}

/** 주어진 wire 값이 이 슬롯·tier 의 로컬 추천값과 일치하는가(배지 표시용). */
export function isRecommendedLocalValue(
	tier: VramTier | null,
	slot: SlotId,
	value: string | undefined,
): boolean {
	const rec = slotRecommendation(tier, slot);
	return !!rec && !!value && rec.localValue === value;
}
