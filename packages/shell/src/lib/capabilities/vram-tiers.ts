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
	| "avatar-voice-12g"
	| "full-local-24g";

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
	 */
	localCapabilities: ModelCapability[];
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
