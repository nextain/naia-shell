import { describe, expect, it } from "vitest";
import {
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
	it("Gemini 3.1 Pro pricing includes 10% margin", () => {
		const model = getLlmModel("nextain", "gemini-3.1-pro-preview");
		expect(model).toBeDefined();
		expect(model?.pricing).toEqual([1.375, 5.5]);
	});

	it("Gemini 3.1 Flash Lite pricing includes 10% margin", () => {
		const model = getLlmModel("nextain", "gemini-3.1-flash-lite-preview");
		expect(model).toBeDefined();
		expect(model?.pricing).toEqual([0.083, 0.33]);
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

	it("Gemini 2.5 Flash pricing includes 10% margin", () => {
		const model = getLlmModel("nextain", "gemini-2.5-flash");
		expect(model).toBeDefined();
		expect(model?.pricing).toEqual([0.165, 0.66]);
	});

	it("Gemini 2.5 Flash Lite pricing includes 10% margin", () => {
		const model = getLlmModel("nextain", "gemini-2.5-flash-lite");
		expect(model).toBeDefined();
		expect(model?.pricing).toEqual([0.083, 0.33]);
	});

	it("Gemini 2.5 Flash Live pricing includes 10% margin", () => {
		const model = getLlmModel("nextain", "gemini-2.5-flash-live");
		expect(model).toBeDefined();
		expect(model?.pricing).toEqual([0.165, 0.66]);
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
