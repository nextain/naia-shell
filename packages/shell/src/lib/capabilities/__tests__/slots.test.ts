import { describe, expect, it } from "vitest";
import type { ModelCapability } from "../../types";
import { deriveSettingsSlots } from "../slots";

describe("deriveSettingsSlots", () => {
	it("text-only model needs both external voice slots", () => {
		const plan = deriveSettingsSlots(["llm"]);
		expect(plan.coversVoiceInput).toBe(false);
		expect(plan.coversVoiceOutput).toBe(false);
		expect(plan.needsExternalStt).toBe(true);
		expect(plan.needsExternalTts).toBe(true);
		expect(plan.showVoiceSection).toBe(true);
	});

	it("omni model covers voice in+out — voice section hidden", () => {
		const plan = deriveSettingsSlots(["llm", "omni"]);
		expect(plan.coversVoiceInput).toBe(true);
		expect(plan.coversVoiceOutput).toBe(true);
		expect(plan.needsExternalStt).toBe(false);
		expect(plan.needsExternalTts).toBe(false);
		expect(plan.showVoiceSection).toBe(false);
	});

	it("asr model covers voice input only — still needs external TTS", () => {
		const plan = deriveSettingsSlots(["asr"]);
		expect(plan.coversVoiceInput).toBe(true);
		expect(plan.needsExternalStt).toBe(false);
		expect(plan.needsExternalTts).toBe(true);
		expect(plan.showVoiceSection).toBe(true); // because TTS still external
	});

	it("standalone tts capability covers voice output only", () => {
		const plan = deriveSettingsSlots(["tts"]);
		expect(plan.needsExternalTts).toBe(false);
		expect(plan.needsExternalStt).toBe(true);
		expect(plan.showVoiceSection).toBe(true);
	});

	it("vlm sets coversVision", () => {
		expect(deriveSettingsSlots(["llm", "vlm"]).coversVision).toBe(true);
		expect(deriveSettingsSlots(["llm"]).coversVision).toBe(false);
	});

	it("supplements = generative caps the model lacks", () => {
		expect(deriveSettingsSlots(["llm"]).supplements).toEqual([
			"image",
			"video",
			"avatar",
		]);
		expect(deriveSettingsSlots(["llm", "image"]).supplements).toEqual([
			"video",
			"avatar",
		]);
		const full: ModelCapability[] = ["image", "video", "avatar"];
		expect(deriveSettingsSlots(full).supplements).toEqual([]);
	});

	it("empty capabilities behaves like text-only (safe default)", () => {
		const plan = deriveSettingsSlots([]);
		expect(plan.showVoiceSection).toBe(true);
		expect(plan.needsExternalStt).toBe(true);
		expect(plan.needsExternalTts).toBe(true);
	});
});
