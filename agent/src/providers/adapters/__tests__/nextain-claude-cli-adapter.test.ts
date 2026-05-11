import { describe, expect, it } from "vitest";

import { createNextainClaudeCliProvider } from "../nextain-claude-cli-adapter.js";

/**
 * Day 4.3.3 — nextain-claude-cli-adapter.
 * Pin construction shape only. Live subprocess spawn is exercised in
 * `llm-provider-live.test.ts` (manual, requires `claude` binary).
 */
describe("createNextainClaudeCliProvider", () => {
	it("returns LLMProvider with stream()", () => {
		const provider = createNextainClaudeCliProvider("claude-opus-4-7");
		expect(provider).toBeDefined();
		expect(typeof provider.stream).toBe("function");
	});

	it("constructs for different model strings", () => {
		const a = createNextainClaudeCliProvider("claude-sonnet-4-6");
		const b = createNextainClaudeCliProvider("claude-haiku-4-5");
		expect(a).toBeDefined();
		expect(b).toBeDefined();
	});
});
