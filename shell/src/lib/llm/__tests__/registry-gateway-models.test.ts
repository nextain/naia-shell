/**
 * Test: Naia gateway provider model list excludes gemini-3.x (#248).
 *
 * The any-llm Cloud Run gateway's GCP project does not have Vertex AI
 * Publisher Model access for gemini-3.x — streaming returns 0-byte SSE,
 * non-streaming returns 404 NOT_FOUND. Until the gateway project gets
 * access, these models must NOT appear in the Naia provider's model list
 * (the user-visible dropdown). gemini-2.5-* family is verified working.
 *
 * Direct-API "gemini" provider (GEMINI_API_KEY → Google AI Studio) keeps
 * gemini-3.x since that route bypasses the gateway and works end-to-end.
 *
 * Run:
 *   pnpm exec vitest run src/lib/llm/__tests__/registry-gateway-models.test.ts
 */
import { describe, expect, it } from "vitest";

describe("LLM registry — gateway model exclusion (#248)", () => {
	// 2026-05-29: nextain provider trimmed to the user-confirmed 4-model lineup.
	it("Naia (gateway) provider exposes the confirmed 4-model lineup in order", async () => {
		const { getLlmProvider } = await import("../registry.js");
		const naia = getLlmProvider("nextain");
		expect(naia).toBeTruthy();
		const ids = naia!.models.map((m) => m.id);
		expect(ids).toEqual([
			"gemini-3.1-flash-lite",
			"naia-0.9-omni-24g",
			"gemini-3.5-flash",
			"gemini-2.5-flash-live",
		]);
	});

	it("Naia provider includes the realtime-voice models (omni)", async () => {
		const { getLlmProvider } = await import("../registry.js");
		const naia = getLlmProvider("nextain");
		const omni = naia!.models.filter((m) => m.capabilities.includes("omni"));
		expect(omni.map((m) => m.id)).toEqual([
			"naia-0.9-omni-24g",
			"gemini-2.5-flash-live",
		]);
	});

	it("Direct Google Gemini provider lists gemini-2.5-* family", async () => {
		const { getLlmProvider } = await import("../registry.js");
		const direct = getLlmProvider("gemini");
		expect(direct).toBeTruthy();
		const ids = direct!.models.map((m) => m.id);
		expect(ids).toContain("gemini-2.5-pro");
		expect(ids).toContain("gemini-2.5-flash");
	});

	it("Naia default model is gemini-3.1-flash-lite", async () => {
		const { getLlmProvider } = await import("../registry.js");
		const naia = getLlmProvider("nextain");
		expect(naia!.defaultModel).toBe("gemini-3.1-flash-lite");
	});
});

describe("shouldMigrateNextainModel (#248 follow-up migration)", () => {
	it("migrates unknown models on nextain provider to default", async () => {
		const { shouldMigrateNextainModel } = await import("../registry.js");
		const d = shouldMigrateNextainModel("nextain", "some-deprecated-model");
		expect(d.migrate).toBe(true);
		if (d.migrate) expect(d.to).toBe("gemini-3.1-flash-lite");
	});

	it("does NOT migrate valid models on nextain provider", async () => {
		const { shouldMigrateNextainModel } = await import("../registry.js");
		for (const valid of [
			"gemini-3.1-flash-lite",
			"naia-0.9-omni-24g",
			"gemini-3.5-flash",
			"gemini-2.5-flash-live",
		]) {
			expect(shouldMigrateNextainModel("nextain", valid).migrate).toBe(false);
		}
	});

	it("does NOT migrate other providers (gemini-3.x still valid on direct gemini)", async () => {
		const { shouldMigrateNextainModel } = await import("../registry.js");
		expect(
			shouldMigrateNextainModel("gemini", "gemini-3-flash-preview").migrate,
		).toBe(false);
		expect(shouldMigrateNextainModel("gemini", "any-model").migrate).toBe(false);
		expect(shouldMigrateNextainModel("ollama", "qwen3:14b").migrate).toBe(false);
	});

	it("does NOT migrate unknown providers", async () => {
		const { shouldMigrateNextainModel } = await import("../registry.js");
		expect(shouldMigrateNextainModel("nonexistent", "any").migrate).toBe(false);
	});
});
