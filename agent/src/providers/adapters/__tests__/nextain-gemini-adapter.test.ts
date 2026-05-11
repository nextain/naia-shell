import { describe, expect, it } from "vitest";

import { createNextainGeminiProvider } from "../nextain-gemini-adapter.js";

/**
 * Day 7.1 — nextain-gemini-adapter (full @google/genai SDK + thoughtSignature parity).
 *
 * Live API streaming gated by GEMINI_API_KEY in llm-provider-live.test.ts (manual).
 * Here: construct shape only.
 */
describe("createNextainGeminiProvider — Day 7.1 thoughtSignature parity", () => {
	it("returns LLMProvider with stream()", () => {
		const provider = createNextainGeminiProvider("test-key", "gemini-2.5-flash");
		expect(provider).toBeDefined();
		expect(typeof provider.stream).toBe("function");
	});

	it("constructs for Gemini 3 thinking model", () => {
		const provider = createNextainGeminiProvider("test-key", "gemini-3-pro");
		expect(provider).toBeDefined();
	});

	it("constructs for various Gemini families (flash/pro/lite)", () => {
		expect(createNextainGeminiProvider("k", "gemini-2.5-flash")).toBeDefined();
		expect(createNextainGeminiProvider("k", "gemini-2.5-pro")).toBeDefined();
		expect(createNextainGeminiProvider("k", "gemini-2.5-flash-lite")).toBeDefined();
	});
});
