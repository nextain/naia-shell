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
	it("Naia (gateway) provider does NOT list any gemini-3.x model", async () => {
		const { getLlmProvider } = await import("../registry.js");
		const naia = getLlmProvider("nextain");
		expect(naia).toBeTruthy();
		const ids = naia!.models.map((m) => m.id);
		for (const id of ids) {
			expect(id).not.toMatch(/^gemini-3(\.|-)/);
		}
	});

	it("Naia provider keeps the gemini-2.5-* family (verified working via gateway)", async () => {
		const { getLlmProvider } = await import("../registry.js");
		const naia = getLlmProvider("nextain");
		const ids = naia!.models.map((m) => m.id);
		expect(ids).toContain("gemini-2.5-pro");
		expect(ids).toContain("gemini-2.5-flash");
		expect(ids).toContain("gemini-2.5-flash-lite");
		expect(ids).toContain("gemini-2.5-flash-live");
	});

	it("Direct Google Gemini provider keeps gemini-3.x (Google AI Studio works for these)", async () => {
		const { getLlmProvider } = await import("../registry.js");
		const direct = getLlmProvider("gemini");
		expect(direct).toBeTruthy();
		const ids = direct!.models.map((m) => m.id);
		// At least one gemini-3.x should remain on the direct route.
		const has3x = ids.some((id) => /^gemini-3(\.|-)/.test(id));
		expect(has3x).toBe(true);
	});

	it("Naia default model is gemini-2.5-pro (verified working)", async () => {
		const { getLlmProvider } = await import("../registry.js");
		const naia = getLlmProvider("nextain");
		expect(naia!.defaultModel).toBe("gemini-2.5-pro");
	});
});

describe("shouldMigrateNextainModel (#248 follow-up migration)", () => {
	it("migrates removed gemini-3.x models on nextain provider", async () => {
		const { shouldMigrateNextainModel } = await import("../registry.js");
		for (const stale of [
			"gemini-3.1-pro-preview",
			"gemini-3.1-flash-lite-preview",
			"gemini-3-flash-preview",
		]) {
			const d = shouldMigrateNextainModel("nextain", stale);
			expect(d.migrate).toBe(true);
			if (d.migrate) expect(d.to).toBe("gemini-2.5-pro");
		}
	});

	it("does NOT migrate valid models on nextain provider", async () => {
		const { shouldMigrateNextainModel } = await import("../registry.js");
		for (const valid of [
			"gemini-2.5-pro",
			"gemini-2.5-flash",
			"gemini-2.5-flash-lite",
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
