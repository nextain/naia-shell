import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../config";
import {
	NAIA_SMALL_LLM_DEFAULT,
	SURFACING_LEVEL_THRESHOLDS,
	describeSurfacingState,
	normalizeOpenAiCompatBaseUrl,
	readSmallLlmSelection,
	readSurfacingLevel,
	writeSmallLlmSelection,
	writeSurfacingLevel,
} from "../surfacing";

const baseConfig = (): AppConfig => ({
	provider: "nextain",
	model: "deepseek-v4-flash",
	apiKey: "",
	memoryEmbeddingProvider: "offline",
});

describe("readSmallLlmSelection", () => {
	it("reads explicit nextain memory role", () => {
		const config: AppConfig = {
			...baseConfig(),
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		};
		const sel = readSmallLlmSelection(config);
		expect(sel).toEqual({
			choice: "naia",
			provider: "nextain",
			model: "gpt-5.4-nano",
			baseUrl: undefined,
			inherited: false,
			surfacingOff: false,
		});
	});

	it("normalizes legacy naia provider to nextain", () => {
		const config: AppConfig = {
			...baseConfig(),
			llmRoles: {
				memory: { provider: "naia", model: "gpt-5.4-nano" },
			},
		};
		const sel = readSmallLlmSelection(config);
		expect(sel.choice).toBe("naia");
		expect(sel.provider).toBe("nextain");
		expect(sel.model).toBe("gpt-5.4-nano");
		expect(sel.inherited).toBe(false);
	});

	it("follows inherit from memory to sub naia", () => {
		const config: AppConfig = {
			...baseConfig(),
			llmRoles: {
				memory: { inherit: "sub" },
				sub: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		};
		const sel = readSmallLlmSelection(config);
		expect(sel.choice).toBe("naia");
		expect(sel.provider).toBe("nextain");
		expect(sel.model).toBe("gpt-5.4-nano");
		expect(sel.inherited).toBe(true);
	});

	it("follows inherit to main openai as other and inherited", () => {
		const config: AppConfig = {
			...baseConfig(),
			llmRoles: {
				memory: { inherit: "sub" },
				sub: { inherit: "main" },
				main: { provider: "openai", model: "gpt-4o" },
			},
		};
		const sel = readSmallLlmSelection(config);
		expect(sel.choice).toBe("other");
		expect(sel.provider).toBe("openai");
		expect(sel.model).toBe("gpt-4o");
		expect(sel.inherited).toBe(true);
	});

	it("stops on cycle and returns choice none", () => {
		const config: AppConfig = {
			...baseConfig(),
			llmRoles: {
				memory: { inherit: "sub" },
				sub: { inherit: "memory" },
			},
		};
		const sel = readSmallLlmSelection(config);
		expect(sel.choice).toBe("none");
	});

	it("returns none when model is missing", () => {
		const config: AppConfig = {
			...baseConfig(),
			llmRoles: {
				memory: { provider: "nextain" },
			},
		};
		const sel = readSmallLlmSelection(config);
		expect(sel.choice).toBe("none");
	});

	it("respects surfacingOff flag", () => {
		const config: AppConfig = {
			...baseConfig(),
			memorySurfacing: "off",
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		};
		const sel = readSmallLlmSelection(config);
		expect(sel.surfacingOff).toBe(true);
	});

	it("handles null or undefined config", () => {
		expect(readSmallLlmSelection(null)).toEqual({
			choice: "none",
			inherited: false,
			surfacingOff: false,
		});
		expect(readSmallLlmSelection(undefined)).toEqual({
			choice: "none",
			inherited: false,
			surfacingOff: false,
		});
	});
});

describe("normalizeOpenAiCompatBaseUrl", () => {
	it("appends /v1 when missing", () => {
		expect(normalizeOpenAiCompatBaseUrl("http://localhost:11434")).toBe(
			"http://localhost:11434/v1",
		);
	});

	it("removes trailing slash and preserves /v1", () => {
		expect(normalizeOpenAiCompatBaseUrl("http://h:8000/v1/")).toBe(
			"http://h:8000/v1",
		);
	});

	it("leaves empty string as empty", () => {
		expect(normalizeOpenAiCompatBaseUrl("")).toBe("");
		expect(normalizeOpenAiCompatBaseUrl("   ")).toBe("");
	});
});

describe("writeSmallLlmSelection", () => {
	it("writes naia choice with nextain/gpt-5.4-nano and mirrors memoryLlmProvider", () => {
		const original = baseConfig();
		const updated = writeSmallLlmSelection(original, { choice: "naia" });

		expect(updated.llmRoles?.memory).toEqual({
			provider: "nextain",
			model: NAIA_SMALL_LLM_DEFAULT.model,
		});
		expect(updated.memoryLlmProvider).toBe("nextain");
		expect(updated.memoryLlmModel).toBe(NAIA_SMALL_LLM_DEFAULT.model);
		expect(updated.memorySurfacing).toBe("on");
		expect(updated.memorySurfacingJudge).toBe("llm");
		// input not mutated
		expect(original.llmRoles?.memory).toBeUndefined();
	});

	it("normalizes baseUrl and trims model for ollama", () => {
		const original = baseConfig();
		const updated = writeSmallLlmSelection(original, {
			choice: "ollama",
			baseUrl: "http://localhost:11434/",
			model: "  qwen3:4b  ",
		});

		expect(updated.llmRoles?.memory).toEqual({
			provider: "ollama",
			model: "qwen3:4b",
			baseUrl: "http://localhost:11434/v1",
		});
		expect(updated.memoryLlmProvider).toBe("ollama");
		expect(updated.memoryLlmModel).toBe("qwen3:4b");
		expect(updated.memoryLlmBaseUrl).toBe("http://localhost:11434/v1");
		expect(updated.memorySurfacing).toBe("on");
		expect(updated.memorySurfacingJudge).toBe("llm");
	});

	it("writes vllm choice and sets memorySurfacingJudge to llm", () => {
		const original = baseConfig();
		const updated = writeSmallLlmSelection(original, {
			choice: "vllm",
			baseUrl: "http://localhost:8000/",
			model: "  qwen3:4b  ",
		});

		expect(updated.llmRoles?.memory).toEqual({
			provider: "vllm",
			model: "qwen3:4b",
			baseUrl: "http://localhost:8000/v1",
		});
		expect(updated.memoryLlmProvider).toBe("vllm");
		expect(updated.memoryLlmModel).toBe("qwen3:4b");
		expect(updated.memoryLlmBaseUrl).toBe("http://localhost:8000/v1");
		expect(updated.memorySurfacing).toBe("on");
		expect(updated.memorySurfacingJudge).toBe("llm");
	});

	it("threshold choice leaves llmRoles.memory unchanged and sets both memorySurfacing and memorySurfacingJudge", () => {
		const original: AppConfig = {
			...baseConfig(),
			llmRoles: {
				memory: { provider: "ollama", model: "qwen3:4b" },
			},
			memoryLlmProvider: "ollama",
			memoryLlmModel: "qwen3:4b",
		};
		const updated = writeSmallLlmSelection(original, { choice: "threshold" });

		expect(updated.llmRoles?.memory).toEqual({
			provider: "ollama",
			model: "qwen3:4b",
		});
		expect(updated.memoryLlmProvider).toBe("ollama");
		expect(updated.memorySurfacing).toBe("on");
		expect(updated.memorySurfacingJudge).toBe("threshold");
		expect(original.memorySurfacingJudge).toBeUndefined();
	});

	it("off keeps the memory role and sets memorySurfacing to off", () => {
		const original: AppConfig = {
			...baseConfig(),
			llmRoles: {
				memory: { provider: "ollama", model: "qwen3:4b" },
			},
			memoryLlmProvider: "ollama",
			memoryLlmModel: "qwen3:4b",
		};
		const updated = writeSmallLlmSelection(original, { choice: "off" });

		expect(updated.llmRoles?.memory).toEqual({
			provider: "ollama",
			model: "qwen3:4b",
		});
		expect(updated.memoryLlmProvider).toBe("ollama");
		expect(updated.memorySurfacing).toBe("off");
		expect(original.memorySurfacing).toBeUndefined();
	});
});

describe("readSurfacingLevel", () => {
	it("returns normal by default when memorySurfacingLevel is absent", () => {
		const config = baseConfig();
		expect(readSurfacingLevel(config)).toBe("normal");
		expect(SURFACING_LEVEL_THRESHOLDS[readSurfacingLevel(config)]).toBe(0.86);
	});

	it("returns less or more when explicitly set", () => {
		expect(
			readSurfacingLevel({ ...baseConfig(), memorySurfacingLevel: "less" }),
		).toBe("less");
		expect(
			readSurfacingLevel({ ...baseConfig(), memorySurfacingLevel: "more" }),
		).toBe("more");
	});

	it("returns normal for garbage or missing config", () => {
		expect(
			readSurfacingLevel({
				...baseConfig(),
				memorySurfacingLevel: "garbage" as any,
			}),
		).toBe("normal");
		expect(readSurfacingLevel(null)).toBe("normal");
		expect(readSurfacingLevel(undefined)).toBe("normal");
	});
});

describe("writeSurfacingLevel", () => {
	it("sets memorySurfacingLevel immutably", () => {
		const original = baseConfig();
		const updated = writeSurfacingLevel(original, "more");
		expect(updated.memorySurfacingLevel).toBe("more");
		expect(original.memorySurfacingLevel).toBeUndefined();
	});

	it("falls back to normal when given an invalid level", () => {
		const original = baseConfig();
		const updated = writeSurfacingLevel(original, "garbage" as any);
		expect(updated.memorySurfacingLevel).toBe("normal");
	});
});

describe("describeSurfacingState", () => {
	it("returns off-disabled when surfacingOff is true", () => {
		const config: AppConfig = {
			...baseConfig(),
			memorySurfacing: "off",
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		};
		const state = describeSurfacingState(config, { naiaKeyPresent: true });
		expect(state).toEqual({ kind: "off-disabled" });
	});

	it("off beats embedding: returns off-disabled even if memoryEmbeddingProvider is missing or none", () => {
		const configNone: AppConfig = {
			...baseConfig(),
			memorySurfacing: "off",
			memoryEmbeddingProvider: "none",
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		};
		expect(describeSurfacingState(configNone, { naiaKeyPresent: true })).toEqual({
			kind: "off-disabled",
		});

		const configMissing: AppConfig = {
			...baseConfig(),
			memorySurfacing: "off",
			memoryEmbeddingProvider: undefined,
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		};
		expect(
			describeSurfacingState(configMissing, { naiaKeyPresent: true }),
		).toEqual({
			kind: "off-disabled",
		});
	});

	it("returns off-no-embedding when memoryEmbeddingProvider is none or missing, even when small LLM is configured", () => {
		const configNone: AppConfig = {
			...baseConfig(),
			memoryEmbeddingProvider: "none",
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		};
		expect(describeSurfacingState(configNone, { naiaKeyPresent: true })).toEqual({
			kind: "off-no-embedding",
		});

		const configMissing: AppConfig = {
			...baseConfig(),
			memoryEmbeddingProvider: undefined,
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		};
		expect(
			describeSurfacingState(configMissing, { naiaKeyPresent: true }),
		).toEqual({
			kind: "off-no-embedding",
		});
	});

	it("returns on-threshold/user-choice when memorySurfacingJudge is threshold with Naia role and key", () => {
		const config: AppConfig = {
			...baseConfig(),
			memorySurfacingJudge: "threshold",
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		};
		const state = describeSurfacingState(config, { naiaKeyPresent: true });
		expect(state).toEqual({
			kind: "on-threshold",
			reason: "user-choice",
			threshold: 0.86,
		});
	});

	it("returns off-disabled when judge is threshold but memorySurfacing is off", () => {
		const config: AppConfig = {
			...baseConfig(),
			memorySurfacing: "off",
			memorySurfacingJudge: "threshold",
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		};
		const state = describeSurfacingState(config, { naiaKeyPresent: true });
		expect(state).toEqual({ kind: "off-disabled" });
	});

	it("returns off-no-embedding when judge is threshold but memoryEmbeddingProvider is none", () => {
		const config: AppConfig = {
			...baseConfig(),
			memoryEmbeddingProvider: "none",
			memorySurfacingJudge: "threshold",
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		};
		const state = describeSurfacingState(config, { naiaKeyPresent: true });
		expect(state).toEqual({ kind: "off-no-embedding" });
	});

	it("returns on-threshold/no-small-llm when choice is none", () => {
		const config: AppConfig = {
			...baseConfig(),
			llmRoles: {
				memory: { provider: "nextain" }, // missing model
			},
		};
		const state = describeSurfacingState(config, { naiaKeyPresent: true });
		expect(state).toEqual({
			kind: "on-threshold",
			reason: "no-small-llm",
			threshold: 0.86,
		});
	});

	it("returns on-threshold/no-small-llm when naia chosen but no naiaKeyPresent", () => {
		const config: AppConfig = {
			...baseConfig(),
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		};
		const state = describeSurfacingState(config, { naiaKeyPresent: false });
		expect(state).toEqual({
			kind: "on-threshold",
			reason: "no-small-llm",
			threshold: 0.86,
		});
	});

	it("on-threshold carries threshold according to memorySurfacingLevel", () => {
		const configLess: AppConfig = {
			...baseConfig(),
			memorySurfacingLevel: "less",
			llmRoles: { memory: { provider: "nextain" } },
		};
		expect(describeSurfacingState(configLess, { naiaKeyPresent: true })).toEqual({
			kind: "on-threshold",
			reason: "no-small-llm",
			threshold: 0.88,
		});

		const configMore: AppConfig = {
			...baseConfig(),
			memorySurfacingLevel: "more",
			llmRoles: { memory: { provider: "nextain" } },
		};
		expect(describeSurfacingState(configMore, { naiaKeyPresent: true })).toEqual({
			kind: "on-threshold",
			reason: "no-small-llm",
			threshold: 0.84,
		});

		const configGarbage: AppConfig = {
			...baseConfig(),
			memorySurfacingLevel: "garbage" as any,
			llmRoles: { memory: { provider: "nextain" } },
		};
		expect(
			describeSurfacingState(configGarbage, { naiaKeyPresent: true }),
		).toEqual({
			kind: "on-threshold",
			reason: "no-small-llm",
			threshold: 0.86,
		});
	});

	it("returns on-threshold/pending-gateway when catalog is a Set lacking the model", () => {
		const config: AppConfig = {
			...baseConfig(),
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		};
		const state = describeSurfacingState(config, {
			naiaKeyPresent: true,
			gatewayModels: new Set(["deepseek-v4-flash", "solar-mini"]),
		});
		expect(state).toEqual({
			kind: "on-threshold",
			reason: "pending-gateway",
			threshold: 0.86,
			model: "gpt-5.4-nano",
		});
	});

	it("returns on/naia when catalog contains the model", () => {
		const config: AppConfig = {
			...baseConfig(),
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		};
		const state = describeSurfacingState(config, {
			naiaKeyPresent: true,
			gatewayModels: new Set(["gpt-5.4-nano", "deepseek-v4-flash"]),
		});
		expect(state).toEqual({
			kind: "on",
			billing: "naia",
			provider: "nextain",
			model: "gpt-5.4-nano",
		});
	});

	it("returns on/naia when catalog is null (unknown)", () => {
		const config: AppConfig = {
			...baseConfig(),
			llmRoles: {
				memory: { provider: "nextain", model: "gpt-5.4-nano" },
			},
		};
		const state = describeSurfacingState(config, {
			naiaKeyPresent: true,
			gatewayModels: null,
		});
		expect(state).toEqual({
			kind: "on",
			billing: "naia",
			provider: "nextain",
			model: "gpt-5.4-nano",
		});
	});

	it("returns on/local for ollama or vllm", () => {
		const config: AppConfig = {
			...baseConfig(),
			llmRoles: {
				memory: { provider: "ollama", model: "qwen3:4b" },
			},
		};
		const state = describeSurfacingState(config, { naiaKeyPresent: false });
		expect(state).toEqual({
			kind: "on",
			billing: "local",
			provider: "ollama",
			model: "qwen3:4b",
		});
	});

	it("returns on-threshold/inherited-billed for other provider reached via inherit", () => {
		const config: AppConfig = {
			...baseConfig(),
			llmRoles: {
				memory: { inherit: "sub" },
				sub: { inherit: "main" },
				main: { provider: "openai", model: "gpt-4o" },
			},
		};
		const state = describeSurfacingState(config, { naiaKeyPresent: true });
		expect(state).toEqual({
			kind: "on-threshold",
			reason: "inherited-billed",
			threshold: 0.86,
			provider: "openai",
			model: "gpt-4o",
		});
	});

	it("returns on/own for directly chosen other provider", () => {
		const config: AppConfig = {
			...baseConfig(),
			llmRoles: {
				memory: { provider: "openai", model: "gpt-4o" },
			},
		};
		const state = describeSurfacingState(config, { naiaKeyPresent: true });
		expect(state).toEqual({
			kind: "on",
			billing: "own",
			provider: "openai",
			model: "gpt-4o",
		});
	});
});
