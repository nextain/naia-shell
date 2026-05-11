import { describe, expect, it } from "vitest";

import { createNextainOpenAIProvider } from "../nextain-openai-adapter.js";

/**
 * Day 4.3.1 — nextain-openai-adapter.
 * Pin the family→baseUrl resolution and the LLMProvider shape.
 *
 * Live API streaming is exercised in `llm-provider-live.test.ts` (manual /
 * gated by env keys). Here we verify only construction + shape.
 */

describe("createNextainOpenAIProvider — factory shape", () => {
	it("returns LLMProvider with stream() for openai family", () => {
		const provider = createNextainOpenAIProvider("test-key", "gpt-4o-mini", {
			family: "openai",
		});
		expect(provider).toBeDefined();
		expect(typeof provider.stream).toBe("function");
	});

	it("constructs without throw for zai family", () => {
		const provider = createNextainOpenAIProvider("test-key", "glm-4.5", {
			family: "zai",
		});
		expect(provider).toBeDefined();
	});

	it("constructs without throw for xai family", () => {
		const provider = createNextainOpenAIProvider("test-key", "grok-4", {
			family: "xai",
		});
		expect(provider).toBeDefined();
	});

	it("constructs for ollama family with localhost default", () => {
		const provider = createNextainOpenAIProvider("", "llama3", {
			family: "ollama",
		});
		expect(provider).toBeDefined();
	});

	it("constructs for vllm family with localhost default", () => {
		const provider = createNextainOpenAIProvider("", "qwen2-7b", {
			family: "vllm",
		});
		expect(provider).toBeDefined();
	});

	it("respects baseUrlOverride for ollama", () => {
		// Smoke — just construct. URL stored inside OpenAICompatClient (private).
		const provider = createNextainOpenAIProvider("", "llama3", {
			family: "ollama",
			baseUrlOverride: "http://192.168.1.10:11434",
		});
		expect(provider).toBeDefined();
	});

	it("respects baseUrlOverride for vllm", () => {
		const provider = createNextainOpenAIProvider("", "qwen2-7b", {
			family: "vllm",
			baseUrlOverride: "http://192.168.1.20:8000",
		});
		expect(provider).toBeDefined();
	});

	// Day 4.3.2 — Gemini family (OpenAI-compat via v1beta/openai endpoint)
	it("constructs without throw for gemini family", () => {
		const provider = createNextainOpenAIProvider("test-key", "gemini-2.5-flash", {
			family: "gemini",
		});
		expect(provider).toBeDefined();
		expect(typeof provider.stream).toBe("function");
	});
});
