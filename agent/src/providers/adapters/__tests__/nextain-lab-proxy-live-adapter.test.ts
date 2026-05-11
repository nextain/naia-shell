import { describe, expect, it } from "vitest";

import { createNextainLabProxyLiveProvider } from "../nextain-lab-proxy-live-adapter.js";

/**
 * Day 7.2 — nextain-lab-proxy-live-adapter (LabProxyLiveClient WebSocket wrap).
 *
 * Live WebSocket connection은 integration test 범주. Here: 구성 shape + URL guard.
 */
describe("createNextainLabProxyLiveProvider — Day 7.2 WebSocket wire", () => {
	it("returns LLMProvider with stream() (default gateway WS URL)", () => {
		const provider = createNextainLabProxyLiveProvider("test-naia-key", "gemini-2.5-flash-live");
		expect(provider).toBeDefined();
		expect(typeof provider.stream).toBe("function");
	});

	it("constructs with custom WSS URL override", () => {
		const provider = createNextainLabProxyLiveProvider(
			"test-naia-key",
			"gemini-3-flash-preview",
			"wss://custom-gateway.example.com/v1/live",
		);
		expect(provider).toBeDefined();
	});

	it("rejects ws:// (non-secure) gateway URL — credential leak guard", () => {
		expect(() =>
			createNextainLabProxyLiveProvider("test", "gemini-live", "ws://insecure.example.com/live"),
		).toThrow(/WSS/);
	});

	it("rejects http(s)://  (non-WebSocket) gateway URL", () => {
		expect(() =>
			createNextainLabProxyLiveProvider("test", "gemini-live", "https://example.com/live"),
		).toThrow(/WSS/);
	});
});
