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
	// 2026-06-03: naia-0.9-omni-24g not yet live → comingSoon flag, moved LAST.
	// 2026-09-12: #585 added azure-realtime (Azure 실시간 음성) — omni, listed
	// right after gemini-2.5-flash-live and before the comingSoon entry.
	it("Naia (gateway) provider exposes the confirmed model lineup in order", async () => {
		const { getLlmProvider } = await import("../registry.js");
		const naia = getLlmProvider("nextain");
		expect(naia).toBeTruthy();
		const ids = naia!.models.map((m) => m.id);
		expect(ids).toEqual([
			"gemini-3.1-flash-lite",
			"grok-4.3",
			"deepseek-v4-pro",
			"deepseek-v4-flash",
			"solar-pro4",
			"solar-mini",
			"HCX-007",
			"HCX-DASH-002",
			"gpt-5.6-sol",
			"gpt-5.6-luna",
			"claude-opus-5",
			"gemini-3.5-flash",
			"gemini-2.5-flash-live",
			"azure-realtime",
			"naia-0.9-omni-24g",
		]);
		expect(naia!.models.map((m) => m.label)).toEqual([
			"Gemini 3.1 Flash Lite",
			"Grok 4.3",
			"DeepSeek V4 Pro",
			"DeepSeek V4 Flash",
			"Solar Pro 4",
			"Solar Mini",
			"HyperCLOVA X HCX-007",
			"HyperCLOVA X DASH",
			"GPT-5.6 Sol",
			"GPT-5.6 Luna",
			"Claude Opus 5",
			"Gemini 3.5 Flash",
			"Gemini 2.5 Flash Live",
			"Azure Realtime (SunHi)",
			"Naia 0.9 Omni 24G",
		]);
	});

	it("Naia provider includes the realtime-voice models (omni)", async () => {
		const { getLlmProvider } = await import("../registry.js");
		const naia = getLlmProvider("nextain");
		const omni = naia!.models.filter((m) => m.capabilities.includes("omni"));
		expect(omni.map((m) => m.id)).toEqual([
			"gemini-2.5-flash-live",
			"azure-realtime",
			"naia-0.9-omni-24g",
		]);
	});

	it("naia-0.9-omni-24g is flagged comingSoon and listed last", async () => {
		const { getLlmProvider } = await import("../registry.js");
		const naia = getLlmProvider("nextain")!;
		const last = naia.models[naia.models.length - 1];
		expect(last.id).toBe("naia-0.9-omni-24g");
		expect(last.comingSoon).toBe(true);
	});

	it("formatModelLabel appends a tag for comingSoon models (language-agnostic)", async () => {
		const { formatModelLabel } = await import("../registry.js");
		const base = formatModelLabel({
			id: "x",
			label: "X",
			capabilities: ["llm"],
		});
		const tagged = formatModelLabel({
			id: "x",
			label: "X",
			capabilities: ["llm"],
			comingSoon: true,
		});
		// A tag is appended regardless of the active UI language.
		expect(tagged).not.toBe(base);
		expect(tagged.startsWith(base)).toBe(true);
		expect(tagged.length).toBeGreaterThan(base.length);
	});

	it("Direct Google Gemini provider lists gemini-2.5-* family", async () => {
		const { getLlmProvider } = await import("../registry.js");
		const direct = getLlmProvider("gemini");
		expect(direct).toBeTruthy();
		const ids = direct!.models.map((m) => m.id);
		expect(ids).toContain("gemini-2.5-pro");
		expect(ids).toContain("gemini-2.5-flash");
	});

	it("Naia default model is deepseek-v4-flash", async () => {
		const { getLlmProvider } = await import("../registry.js");
		const naia = getLlmProvider("nextain");
		expect(naia!.defaultModel).toBe("deepseek-v4-flash");
	});
});

describe("shouldMigrateNextainModel (#248 follow-up migration)", () => {
	it("migrates unknown models on nextain provider to default", async () => {
		const { shouldMigrateNextainModel } = await import("../registry.js");
		const d = shouldMigrateNextainModel("nextain", "some-deprecated-model");
		expect(d.migrate).toBe(true);
		if (d.migrate) expect(d.to).toBe("deepseek-v4-flash");
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
		expect(shouldMigrateNextainModel("gemini", "any-model").migrate).toBe(
			false,
		);
		expect(shouldMigrateNextainModel("ollama", "qwen3:14b").migrate).toBe(
			false,
		);
	});

	it("does NOT migrate unknown providers", async () => {
		const { shouldMigrateNextainModel } = await import("../registry.js");
		expect(shouldMigrateNextainModel("nonexistent", "any").migrate).toBe(false);
	});
});
