import { describe, expect, it } from "vitest";

import { createNextainLabProxyProvider } from "../nextain-lab-proxy-adapter.js";

/**
 * Day 4.3.4 — nextain-lab-proxy-adapter.
 * Pin construction shape only. Live SSE streaming is covered by
 * `lab-proxy.test.ts` (mock fetch) and `llm-provider-live.test.ts`.
 */
describe("createNextainLabProxyProvider", () => {
	it("returns LLMProvider with stream() (default gateway URL)", () => {
		const provider = createNextainLabProxyProvider("test-naia-key", "claude-opus-4-7");
		expect(provider).toBeDefined();
		expect(typeof provider.stream).toBe("function");
	});

	it("constructs with custom gatewayUrl override (HTTPS)", () => {
		const provider = createNextainLabProxyProvider(
			"test-naia-key",
			"gemini-2.5-flash",
			"https://custom-gateway.example.com",
		);
		expect(provider).toBeDefined();
	});

	it("rejects HTTP (non-HTTPS) gateway URL — credential leak guard", () => {
		expect(() =>
			createNextainLabProxyProvider("test", "claude", "http://insecure.example.com"),
		).toThrow(/HTTPS/);
	});

	it("constructs for various model name prefixes (gemini/grok/claude)", () => {
		expect(createNextainLabProxyProvider("k", "gemini-2.5-flash")).toBeDefined();
		expect(createNextainLabProxyProvider("k", "grok-4")).toBeDefined();
		expect(createNextainLabProxyProvider("k", "claude-opus-4-7")).toBeDefined();
	});
});
