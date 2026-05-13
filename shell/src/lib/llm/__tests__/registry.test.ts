import { describe, expect, it, vi } from "vitest";
import {
	fetchNaiaPricing,
	formatModelLabel,
	getDefaultLlmModel,
	getLlmModel,
	getLlmProvider,
	isApiKeyOptional,
	isOmniModel,
	listLlmProviders,
	modelHasCapability,
} from "../registry";

describe("registry — provider registration", () => {
	it("lists all expected providers", () => {
		const ids = listLlmProviders().map((p) => p.id);
		expect(ids).toContain("nextain");
		expect(ids).toContain("gemini");
		expect(ids).toContain("openai");
		expect(ids).toContain("anthropic");
		expect(ids).toContain("xai");
		expect(ids).toContain("zai");
		expect(ids).toContain("claude-code-cli");
		expect(ids).toContain("ollama");
		expect(ids).toContain("vllm");
	});

	it("getLlmProvider returns undefined for unknown id", () => {
		expect(getLlmProvider("unknown-xyz")).toBeUndefined();
	});
});

describe("registry — Naia (nextain) provider pricing (+10% margin)", () => {
	it("Gemini 3.1 Pro pricing includes 10% margin (public $2.00/$12.00 + 10%)", () => {
		const model = getLlmModel("nextain", "gemini-3.1-pro-preview");
		expect(model).toBeDefined();
		expect(model?.pricing).toEqual([2.20, 13.20]);
	});

	it("Gemini 3.1 Flash Lite pricing includes 10% margin (public $0.25/$1.50 + 10%)", () => {
		const model = getLlmModel("nextain", "gemini-3.1-flash-lite-preview");
		expect(model).toBeDefined();
		expect(model?.pricing).toEqual([0.275, 1.65]);
	});

	it("Gemini 3.0 Flash pricing includes 10% margin (public $0.50/$3.00 + 10%)", () => {
		const model = getLlmModel("nextain", "gemini-3-flash-preview");
		expect(model).toBeDefined();
		expect(model?.pricing).toEqual([0.55, 3.30]);
	});

	it("Gemini 2.5 Pro pricing includes 10% margin", () => {
		const model = getLlmModel("nextain", "gemini-2.5-pro");
		expect(model).toBeDefined();
		expect(model?.pricing).toEqual([1.375, 11.0]);
	});

	it("Gemini 2.5 Flash pricing includes 10% margin (public $0.30/$2.50 + 10%)", () => {
		const model = getLlmModel("nextain", "gemini-2.5-flash");
		expect(model).toBeDefined();
		expect(model?.pricing).toEqual([0.33, 2.75]);
	});

	it("Gemini 2.5 Flash Lite pricing includes 10% margin (public $0.10/$0.40 + 10%)", () => {
		const model = getLlmModel("nextain", "gemini-2.5-flash-lite");
		expect(model).toBeDefined();
		expect(model?.pricing).toEqual([0.11, 0.44]);
	});

	it("Gemini 2.5 Flash Live pricing includes 10% margin (public $0.50/$2.00 text + 10%)", () => {
		const model = getLlmModel("nextain", "gemini-2.5-flash-live");
		expect(model).toBeDefined();
		expect(model?.pricing).toEqual([0.55, 2.20]);
	});

	it("Gemini 2.5 Flash Live has no (실시간) suffix in label", () => {
		const model = getLlmModel("nextain", "gemini-2.5-flash-live");
		expect(model).toBeDefined();
		expect(model?.label).not.toContain("실시간");
		expect(model?.label).toBe("Gemini 2.5 Flash Live");
	});

	it("Gemini 2.5 Flash Live is omni capable", () => {
		expect(isOmniModel("nextain", "gemini-2.5-flash-live")).toBe(true);
	});

	it("nextain provider does not require API key", () => {
		expect(isApiKeyOptional("nextain")).toBe(false); // requiresNaiaKey=true → not fully optional
		const p = getLlmProvider("nextain");
		expect(p?.requiresApiKey).toBe(false);
		expect(p?.requiresNaiaKey).toBe(true);
	});

	it("default model is gemini-2.5-pro", () => {
		expect(getDefaultLlmModel("nextain")).toBe("gemini-2.5-pro");
	});
});

describe("registry — Z.AI (zai) provider", () => {
	it("zai provider exists and requires API key", () => {
		const p = getLlmProvider("zai");
		expect(p).toBeDefined();
		expect(p?.requiresApiKey).toBe(true);
		expect(p?.name).toBe("Z.AI");
	});

	it("zai default model is glm-5.1", () => {
		expect(getDefaultLlmModel("zai")).toBe("glm-5.1");
	});

	it("zai has GLM models registered", () => {
		const models = getLlmProvider("zai")?.models ?? [];
		const ids = models.map((m) => m.id);
		expect(ids).toContain("glm-5.1");
		expect(ids).toContain("glm-5-turbo");
		expect(ids).toContain("glm-4.7");
		expect(ids).toContain("glm-4.5-air");
	});

	it("zai models have llm capability", () => {
		expect(modelHasCapability("zai", "glm-5.1", "llm")).toBe(true);
	});
});

describe("registry — Claude Code CLI provider", () => {
	it("claude-code-cli does not require API key", () => {
		const p = getLlmProvider("claude-code-cli");
		expect(p?.requiresApiKey).toBe(false);
	});

	it("claude-code-cli default model is claude-sonnet-4-6", () => {
		expect(getDefaultLlmModel("claude-code-cli")).toBe("claude-sonnet-4-6");
	});

	it("claude-code-cli has Opus, Sonnet, Haiku models", () => {
		const models = getLlmProvider("claude-code-cli")?.models ?? [];
		const ids = models.map((m) => m.id);
		expect(ids).toContain("claude-opus-4-6");
		expect(ids).toContain("claude-sonnet-4-6");
		expect(ids).toContain("claude-haiku-4-5-20251001");
	});
});

describe("registry — isApiKeyOptional", () => {
	it("ollama is key-optional (no API key, no Naia key)", () => {
		expect(isApiKeyOptional("ollama")).toBe(true);
	});

	it("vllm is key-optional", () => {
		expect(isApiKeyOptional("vllm")).toBe(true);
	});

	it("gemini is not key-optional", () => {
		expect(isApiKeyOptional("gemini")).toBe(false);
	});

	it("unknown provider is not key-optional", () => {
		expect(isApiKeyOptional("nonexistent")).toBe(false);
	});
});

describe("registry — fetchNaiaPricing", () => {
	it("returns null on network failure", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));
		const result = await fetchNaiaPricing("https://unreachable.example");
		expect(result).toBeNull();
		vi.restoreAllMocks();
	});

	it("returns null on non-ok response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(null, { status: 503 }),
		);
		const result = await fetchNaiaPricing("https://example.com");
		expect(result).toBeNull();
		vi.restoreAllMocks();
	});

	it("overlays gateway pricing onto Naia model list", async () => {
		const gatewayResponse = [
			{ model_key: "vertexai:gemini-2.5-flash", input_price_per_million: 0.165, output_price_per_million: 0.66, cached_price_per_million: 0.044 },
			{ model_key: "vertexai:gemini-2.5-pro", input_price_per_million: 1.375, output_price_per_million: 11.0, cached_price_per_million: null },
			{ model_key: "openai:gpt-4o", input_price_per_million: 2.5, output_price_per_million: 10.0, cached_price_per_million: null },
		];
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify(gatewayResponse), { status: 200 }),
		);
		const models = await fetchNaiaPricing("https://example.com");
		expect(models).not.toBeNull();

		const flash = models!.find((m) => m.id === "gemini-2.5-flash");
		expect(flash?.pricing).toEqual([0.165, 0.66]);

		const pro = models!.find((m) => m.id === "gemini-2.5-pro");
		expect(pro?.pricing).toEqual([1.375, 11.0]);

		// openai model should not appear in Naia model list
		const gpt4o = models!.find((m) => m.id === "gpt-4o");
		expect(gpt4o).toBeUndefined();

		vi.restoreAllMocks();
	});

	it("keeps static pricing for models not in gateway response", async () => {
		// Gateway returns only gemini-2.5-flash — other models keep static price
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify([
				{ model_key: "vertexai:gemini-2.5-flash", input_price_per_million: 0.999, output_price_per_million: 9.999, cached_price_per_million: null },
			]), { status: 200 }),
		);
		const models = await fetchNaiaPricing("https://example.com");
		expect(models).not.toBeNull();

		// gemini-2.5-pro should keep static pricing [1.375, 11.0]
		const pro = models!.find((m) => m.id === "gemini-2.5-pro");
		expect(pro?.pricing).toEqual([1.375, 11.0]);

		vi.restoreAllMocks();
	});

	it("does not mutate original provider models (returns new objects)", async () => {
		const staticPro = getLlmModel("nextain", "gemini-2.5-pro");
		const staticPriceBefore = staticPro?.pricing ? [...staticPro.pricing] : null;

		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify([
				{ model_key: "vertexai:gemini-2.5-pro", input_price_per_million: 99.0, output_price_per_million: 99.0, cached_price_per_million: null },
			]), { status: 200 }),
		);
		await fetchNaiaPricing("https://example.com");

		// Static registry should be unchanged
		const staticProAfter = getLlmModel("nextain", "gemini-2.5-pro");
		expect(staticProAfter?.pricing).toEqual(staticPriceBefore);

		vi.restoreAllMocks();
	});
});

describe("registry — formatModelLabel", () => {
	it("formats model with pricing correctly", () => {
		const model = getLlmModel("nextain", "gemini-2.5-pro")!;
		const label = formatModelLabel(model);
		expect(label).toContain("Gemini 2.5 Pro");
		expect(label).toContain("$1.375");
		expect(label).toContain("$11.000");
	});

	it("returns base label when no pricing", () => {
		const model = getLlmModel("zai", "glm-5.1")!;
		const label = formatModelLabel(model);
		expect(label).toBe("GLM 5.1");
	});
});
