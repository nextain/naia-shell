/**
 * Test: Naia-account (nextain) picker lineup (#670).
 *
 * The Naia-account / nextain provider picker keeps only the four cheap chat
 * models. Codex ChatGPT models stay on the codex provider. This trim does not
 * change gateway 403 behavior.
 *
 * Run:
 *   pnpm exec vitest run src/lib/llm/__tests__/registry-gateway-models.test.ts
 */
import { describe, expect, it } from "vitest";

const NEXTAIN_ACCOUNT_PICKER_IDS = [
	"deepseek-v4-flash",
	"solar-pro4",
	"solar-mini",
	"gpt-5.6-luna",
] as const;

describe("LLM registry — Naia-account picker (#670)", () => {
	it("Naia (gateway) provider exposes only the four cheap chat models in order", async () => {
		const { getLlmProvider } = await import("../registry.js");
		const naia = getLlmProvider("nextain");
		expect(naia).toBeTruthy();
		const ids = naia!.models.map((m) => m.id);
		expect(ids).toEqual([...NEXTAIN_ACCOUNT_PICKER_IDS]);
		expect(naia!.models.map((m) => m.label)).toEqual([
			"DeepSeek V4 Flash",
			"Solar Pro 4",
			"Solar Mini",
			"Naia Luna",
		]);
	});

	it("does not list the dropped Naia-account models", async () => {
		const { getLlmProvider } = await import("../registry.js");
		const ids = getLlmProvider("nextain")!.models.map((m) => m.id);
		for (const dropped of [
			"gemini-3.1-flash-lite",
			"grok-4.3",
			"deepseek-v4-pro",
			"HCX-007",
			"HCX-DASH-002",
			"gpt-5.6-sol",
			"claude-opus-5",
			"gemini-3.5-flash",
			"gemini-2.5-flash-live",
			"azure-realtime",
			"naia-0.9-omni-24g",
		]) {
			expect(ids).not.toContain(dropped);
		}
	});

	it("Naia-account picker has no omni or comingSoon entries", async () => {
		const { getLlmProvider } = await import("../registry.js");
		const naia = getLlmProvider("nextain");
		expect(naia!.models.filter((m) => m.capabilities.includes("omni"))).toEqual(
			[],
		);
		expect(naia!.models.filter((m) => m.comingSoon)).toEqual([]);
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
		expect(tagged).not.toBe(base);
		expect(tagged.startsWith(base)).toBe(true);
		expect(tagged.length).toBeGreaterThan(base.length);
	});

	it("#602: the direct Google Gemini provider is gone", async () => {
		const { getLlmProvider } = await import("../registry.js");
		expect(getLlmProvider("gemini")).toBeUndefined();
	});

	it("Naia default model is deepseek-v4-flash", async () => {
		const { getLlmProvider } = await import("../registry.js");
		const naia = getLlmProvider("nextain");
		expect(naia!.defaultModel).toBe("deepseek-v4-flash");
	});

	it("does not remove Codex ChatGPT models", async () => {
		const { getLlmProvider } = await import("../registry.js");
		const codex = getLlmProvider("codex");
		expect(codex!.models.map((m) => m.id)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
			"gpt-5.5",
		]);
	});
});

describe("shouldMigrateNextainModel (#248 follow-up migration)", () => {
	it("migrates unknown models on nextain provider to default", async () => {
		const { shouldMigrateNextainModel } = await import("../registry.js");
		const d = shouldMigrateNextainModel("nextain", "some-deprecated-model");
		expect(d.migrate).toBe(true);
		if (d.migrate) expect(d.to).toBe("deepseek-v4-flash");
	});

	it("does NOT migrate the four remaining Naia-account models", async () => {
		const { shouldMigrateNextainModel } = await import("../registry.js");
		for (const valid of NEXTAIN_ACCOUNT_PICKER_IDS) {
			expect(shouldMigrateNextainModel("nextain", valid).migrate).toBe(false);
		}
	});

	it("migrates dropped Naia-account models to the default", async () => {
		const { shouldMigrateNextainModel } = await import("../registry.js");
		for (const dropped of [
			"gemini-3.1-flash-lite",
			"grok-4.3",
			"gpt-5.6-sol",
			"azure-realtime",
			"naia-0.9-omni-24g",
		]) {
			const d = shouldMigrateNextainModel("nextain", dropped);
			expect(d.migrate).toBe(true);
			if (d.migrate) expect(d.to).toBe("deepseek-v4-flash");
		}
	});

	it("does NOT migrate non-nextain providers (scoped to nextain only)", async () => {
		const { shouldMigrateNextainModel } = await import("../registry.js");
		expect(shouldMigrateNextainModel("codex", "gpt-5.6-sol").migrate).toBe(
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
