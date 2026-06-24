/**
 * Capability-driven settings slots (#365).
 *
 * The settings UI used to branch on an ad-hoc `isSelectedOmni` boolean plus
 * scattered `capabilities.includes(...)` checks. This module is the single
 * place that turns a model's declared capabilities (the gateway catalog is the
 * SoT — see project-any-llm `model_catalog.py`) into a *slot plan*: which
 * built-in capabilities the model already covers vs. which external-supplement
 * slots the UI must offer.
 *
 * Principle (from the issue): a model exposes its built-in capabilities as
 * locked/hidden slots, and only the capabilities it *lacks* surface as external
 * supplement slots. An omni model covers voice in+out (no separate STT/TTS); a
 * cascade / text-only model needs both external.
 */

import type { ModelCapability } from "../types";

export interface SettingsSlotPlan {
	/** Model has built-in speech input (omni / asr / stt) — no external STT slot. */
	coversVoiceInput: boolean;
	/** Model has built-in speech output (omni / tts) — no external TTS slot. */
	coversVoiceOutput: boolean;
	/** Model understands images (vlm) — no external vision slot needed. */
	coversVision: boolean;
	/** An external STT provider slot must be offered. */
	needsExternalStt: boolean;
	/** An external TTS provider slot must be offered. */
	needsExternalTts: boolean;
	/** Render the external voice (STT/TTS) settings section at all. */
	showVoiceSection: boolean;
	/**
	 * Capabilities the model lacks that the UI may offer as external-supplement
	 * slots (image / video / avatar). Foundation for future slot expansion.
	 */
	supplements: ModelCapability[];
}

// Generative / rendering capabilities that can be supplemented by an external
// provider when the chosen model doesn't have them built in.
const SUPPLEMENT_CAPS: ModelCapability[] = ["image", "video", "avatar"];

/** Derive the settings slot plan from a model's declared capabilities. */
export function deriveSettingsSlots(
	caps: readonly ModelCapability[],
): SettingsSlotPlan {
	const has = (c: ModelCapability) => caps.includes(c);
	const omni = has("omni");

	const coversVoiceInput = omni || has("asr") || has("stt");
	const coversVoiceOutput = omni || has("tts");
	const coversVision = has("vlm");

	const needsExternalStt = !coversVoiceInput;
	const needsExternalTts = !coversVoiceOutput;

	return {
		coversVoiceInput,
		coversVoiceOutput,
		coversVision,
		needsExternalStt,
		needsExternalTts,
		showVoiceSection: needsExternalStt || needsExternalTts,
		supplements: SUPPLEMENT_CAPS.filter((c) => !has(c)),
	};
}
