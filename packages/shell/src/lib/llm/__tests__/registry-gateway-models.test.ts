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
	it("unknown id with no catalog argument yields needsCatalog", async () => {
		const { shouldMigrateNextainModel } = await import("../registry.js");
		const d = shouldMigrateNextainModel("nextain", "some-deprecated-model");
		expect(d).toEqual({ migrate: false, needsCatalog: true });
	});

	it("unknown id with catalog set not containing it migrates to default", async () => {
		const { shouldMigrateNextainModel } = await import("../registry.js");
		const d = shouldMigrateNextainModel(
			"nextain",
			"some-deprecated-model",
			new Set(["gpt-5.4-nano"]),
		);
		expect(d).toEqual({ migrate: true, to: "deepseek-v4-flash" });
	});

	it("gpt-5.4-nano with catalog set containing it does not migrate (#707)", async () => {
		const { shouldMigrateNextainModel } = await import("../registry.js");
		const d = shouldMigrateNextainModel(
			"nextain",
			"gpt-5.4-nano",
			new Set(["gpt-5.4-nano"]),
		);
		expect(d).toEqual({ migrate: false });
	});

	it("unknown id with catalog null does not migrate and needsCatalog is not true", async () => {
		const { shouldMigrateNextainModel } = await import("../registry.js");
		const d = shouldMigrateNextainModel(
			"nextain",
			"some-deprecated-model",
			null,
		);
		expect(d).toEqual({ migrate: false });
	});

	it("does NOT migrate the four remaining Naia-account models", async () => {
		const { shouldMigrateNextainModel } = await import("../registry.js");
		for (const valid of NEXTAIN_ACCOUNT_PICKER_IDS) {
			expect(shouldMigrateNextainModel("nextain", valid).migrate).toBe(false);
			expect(
				shouldMigrateNextainModel(
					"nextain",
					valid,
					new Set<string>(),
				).migrate,
			).toBe(false);
			expect(
				shouldMigrateNextainModel(
					"nextain",
					valid,
					new Set<string>([valid]),
				).migrate,
			).toBe(false);
			expect(
				shouldMigrateNextainModel("nextain", valid, null).migrate,
			).toBe(false);
		}
	});

	it("migrates dropped Naia-account models to the default", async () => {
		const { shouldMigrateNextainModel, RETIRED_NEXTAIN_MODEL_IDS } =
			await import("../registry.js");
		for (const dropped of RETIRED_NEXTAIN_MODEL_IDS) {
			const d = shouldMigrateNextainModel("nextain", dropped);
			expect(d.migrate).toBe(true);
			if (d.migrate) expect(d.to).toBe("deepseek-v4-flash");
		}
		const grokWithCatalog = shouldMigrateNextainModel(
			"nextain",
			"grok-4.3",
			new Set(["grok-4.3"]),
		);
		expect(grokWithCatalog).toEqual({
			migrate: true,
			to: "deepseek-v4-flash",
		});
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

describe("gatewayServedModelIds (#707)", () => {
	it("returns null when metadata is null", async () => {
		const { gatewayServedModelIds } = await import("../registry.js");
		expect(gatewayServedModelIds(null)).toBeNull();
	});

	it("includes models with live status or no operational status, and excludes blocked ones", async () => {
		const { gatewayServedModelIds } = await import("../registry.js");
		const metadata = new Map([
			[
				"gpt-5.4-nano",
				{
					capabilities: ["llm" as const],
					operationalStatus: "live",
				},
			],
			[
				"solar-pro4",
				{
					capabilities: ["llm" as const],
				},
			],
			[
				"claude-opus-5",
				{
					capabilities: ["llm" as const],
					operationalStatus: "quota_blocked",
				},
			],
		]);
		const served = gatewayServedModelIds(metadata);
		expect(served).toBeTruthy();
		expect(served!.has("gpt-5.4-nano")).toBe(true);
		expect(served!.has("solar-pro4")).toBe(true);
		expect(served!.has("claude-opus-5")).toBe(false);
		expect(served!.size).toBe(2);
	});
});
