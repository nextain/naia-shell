/**
 * VRAM-tier → capability data + selection (local GPU profile).
 *
 * Maps a detected GPU VRAM to which local capabilities a
 * tier can serve, as a *footprint-fit* projection built from private
 * footprint measurements; the tier thresholds come from a private deployment
 * draft.
 *
 * STATUS — wired into the settings UI (opt-in, default off). SettingsTab
 * detects GPU VRAM (`detectGpuVramGb` → Rust `detect_gpu_vram`) and shows
 * which local services are budget candidates. It must not hide external slots
 * until a runtime manager reports actual readiness.
 *
 * BOUNDARIES (do not violate):
 * - Consumer/UI view only — declares *which capabilities a tier could serve*,
 *   not how. The canonical tier/deploy *serving-supply* manifest (which
 *   models/engines to fetch) lives in private infra notes; the actual fetch/launch
 *   loader lives in naia-omni-windows-manager and is gated on real device RTF
 *   measurement. Neither the loader nor local serving is implemented here.
 * - Hard rule F1 (windows-manager): real-time (RTF<1) is a measured gate per
 *   GPU — NEVER claimed here. `realtime` is always "measurement-gated"; this
 *   module asserts only what *fits* in VRAM by footprint, not that it runs in
 *   real time.
 */

import type { ModelCapability } from "../types";

export type VramTierId =
	| "external-llm-6g"
	| "avatar-or-voice-8g"
	| "avatar-voice-12g"
	| "full-local-24g";

/**
 * 로컬 집중(우선순위) — VRAM 이 아바타+음성을 **동시에** 못 올리는 배타 티어에서
 * GPU 프로파일이 무엇을 로컬로 돌릴지 고른다.
 * - "avatar" → Ditto 립싱크 로컬(음성은 클라우드 TTS 로).
 * - "voice"  → VoxCPM2 음성 로컬(아바타는 립싱크 없이 정적 NVA/VRM).
 * 둘 다 들어가는 티어(12G+)에서는 무시된다.
 */
export type AvatarVoiceFocus = "avatar" | "voice";

/** capability → VRAM footprint(GB). windows-manager capabilities.py 실측과 동형(SoT는 wm). */
const CAPABILITY_VRAM_COST_GB: Partial<Record<ModelCapability, number>> = {
	tts: 6.9, // VoxCPM2 로컬 음성(실측).
	avatar: 2.6, // Ditto TRT 립싱크(실측).
	llm: 5.0, // 로컬 메인 LLM(모델 의존, 추정).
	embedding: 0.5,
	stt: 2.5,
};

export interface VramTier {
	id: VramTierId;
	label: string;
	/** Minimum detected VRAM (GB) for this tier to be eligible. */
	minVramGb: number;
	/** Whether the LLM runs locally ("own") or via an external provider. */
	llm: "external" | "own";
	/**
	 * Local capabilities the tier can serve by VRAM footprint.
	 * NOT a real-time guarantee — see F1.
	 * `exclusiveLocal` 티어에서는 이 목록이 **동시 구동**이 아니라 **후보(택1)** 다.
	 */
	localCapabilities: ModelCapability[];
	/**
	 * 배타 티어 — `localCapabilities` 를 동시에 다 못 올린다(VRAM 부족). GPU 프로파일의
	 * avatar/voice focus 로 하나를 골라야 한다. 없으면(=false/미지정) 전부 동시 구동.
	 */
	exclusiveLocal?: boolean;
	/** Approx summed VRAM of the local components (private measured). */
	approxLocalVramGb: number;
	/** Real-time (RTF<1) is a measured gate per GPU — never asserted (F1). */
	realtime: "measurement-gated";
	note: string;
}

/**
 * Tiers — user draft (private deployment draft) × private measured footprints.
 * Ordered ascending by minVramGb.
 */
export const VRAM_TIERS: readonly VramTier[] = [
	{
		id: "external-llm-6g",
		label: "6GB — 외부 LLM + 음성/아바타 (제한)",
		minVramGb: 6,
		llm: "external",
		// 6GB is constrained. The user draft offers a 택1 (avatar,
		// OR stt, OR voice-only). Modelled conservatively as voice-only here —
		// `localCapabilities` represents ONE concrete option, not the full 택1
		// set; an avatar-instead choice would be resolved by the loader and is
		// deliberately not encoded in this capability list.
		localCapabilities: ["tts"],
		approxLocalVramGb: 6,
		realtime: "measurement-gated",
		note: "LLM 외부(claude-code/codex/glm). local TTS model may exceed this tier; smaller/quantized model needed(미측정). 모델링=voice-only 1택; avatar·stt 대안은 로더가 택1(이 capability 리스트엔 미반영).",
	},
	{
		id: "avatar-or-voice-8g",
		label: "8GB — 아바타 또는 음성 (택1)",
		minVramGb: 8,
		llm: "external",
		// 8GB 는 아바타(2.6G)+음성(6.9G)=9.5G > 8G 라 **동시 불가**. 둘 다 후보이되
		// GPU 프로파일의 focus 로 하나를 로컬 구동(나머지는 클라우드/정적). windows-manager
		// TIER_DEFAULT_PROFILE["8g"] = tts_only "또는 avatar_only" 와 동형.
		localCapabilities: ["tts", "avatar"],
		exclusiveLocal: true,
		approxLocalVramGb: 6.9, // focus 에 따라 ≤ 6.9G(voice) 또는 2.6G(avatar).
		realtime: "measurement-gated",
		note: "8GB: 아바타(2.6G) 또는 음성(6.9G) 택1 — 동시 9.5G>8G 불가. LLM 외부. GPU 프로파일에서 집중 선택.",
	},
	{
		id: "avatar-voice-12g",
		label: "12GB+ — 아바타 + 음성 (로컬)",
		minVramGb: 12,
		llm: "external",
		localCapabilities: ["tts", "avatar"],
		approxLocalVramGb: 10,
		realtime: "measurement-gated",
		note: "Avatar+voice model footprint fits this tier. RTF<1 = 측정 게이트.",
	},
	{
		id: "full-local-24g",
		label: "24/32GB+ — LLM 포함 자체 소유",
		minVramGb: 24,
		llm: "own",
		localCapabilities: ["llm", "tts", "avatar"],
		approxLocalVramGb: 10, // + local LLM (model-dependent, not summed here)
		realtime: "measurement-gated",
		note: "아바타+음성 + 로컬 LLM. LLM VRAM은 모델 의존(미산정).",
	},
];

/**
 * Pick the richest tier whose `minVramGb` the detected VRAM satisfies.
 * Returns null when VRAM is below the lowest tier (→ external-only / cloud).
 */
export function selectVramTier(vramGb: number): VramTier | null {
	let chosen: VramTier | null = null;
	for (const tier of VRAM_TIERS) {
		if (vramGb >= tier.minVramGb) chosen = tier;
	}
	return chosen;
}

/**
 * Resolve the active local tier from the config setting + detected VRAM.
 * - "off" / undefined → null (local profile disabled; safe default → no slot change)
 * - "auto" → tier derived from detected VRAM (null if VRAM unknown)
 * - explicit tier id → that tier (manual override)
 */
export function resolveActiveTier(
	setting: VramTierId | "auto" | "off" | undefined,
	detectedVramGb: number | null,
): VramTier | null {
	if (!setting || setting === "off") return null;
	if (setting === "auto") {
		return detectedVramGb != null ? selectVramTier(detectedVramGb) : null;
	}
	return VRAM_TIERS.find((t) => t.id === setting) ?? null;
}

/**
 * Capabilities a tier could serve locally by VRAM footprint. This is a budget
 * candidate list, not a readiness signal.
 */
export function tierProvidedCapabilities(tier: VramTier): ModelCapability[] {
	return [...tier.localCapabilities];
}

const DEFAULT_FOCUS: AvatarVoiceFocus = "voice";

/**
 * 배타 티어에서 focus 를 실제 로컬 capability 로 해소한다.
 * - 비배타 티어 → 후보 전부 동시 구동(focus 무시).
 * - 배타 티어  → focus="avatar" 면 ["avatar"], "voice" 면 ["tts"] (후보 중 택1).
 *   focus 미지정 → DEFAULT_FOCUS("voice", wm 8g 기본과 동형).
 * 후보에 없는 focus(예: avatar 후보 없는 티어)는 무시하고 다른 후보로 폴백.
 */
export function resolveLocalCapabilities(
	tier: VramTier | null,
	focus: AvatarVoiceFocus | undefined,
): ModelCapability[] {
	if (!tier) return [];
	if (!tier.exclusiveLocal) return [...tier.localCapabilities];
	const want: ModelCapability = (focus ?? DEFAULT_FOCUS) === "avatar" ? "avatar" : "tts";
	if (tier.localCapabilities.includes(want)) return [want];
	// focus 후보가 이 티어에 없으면 남은 후보 중 아바타/음성 우선으로 하나.
	const fallback = tier.localCapabilities.find((c) => c === "avatar" || c === "tts");
	return fallback ? [fallback] : [];
}

/** 이 티어가 아바타+음성을 **동시에** 로컬 구동할 수 있는가(배타 아님). */
export function tierFitsBoth(tier: VramTier | null): boolean {
	if (!tier) return false;
	const hasAvatar = tier.localCapabilities.includes("avatar");
	const hasVoice = tier.localCapabilities.includes("tts");
	return hasAvatar && hasVoice && !tier.exclusiveLocal;
}

/** capability footprint(GB) — 미등록이면 0. 예산 판정/표시용. */
export function capabilityVramCostGb(cap: ModelCapability): number {
	return CAPABILITY_VRAM_COST_GB[cap] ?? 0;
}
