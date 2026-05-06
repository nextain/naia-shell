/**
 * auth-update.test.ts — real module tests (no factory mock)
 * Tests: parseRequest + setAgentNaiaKey/getAgentNaiaKey + buildProvider routing
 */
import { afterEach, describe, expect, it } from "vitest";
import { parseRequest } from "../protocol.js";

// ── parseRequest: auth_update ─────────────────────────────────────────────

describe("parseRequest — auth_update", () => {
	it("parses valid auth_update message", () => {
		const input = JSON.stringify({ type: "auth_update", naiaKey: "gw-test-key" });
		const result = parseRequest(input);
		expect(result).not.toBeNull();
		expect(result?.type).toBe("auth_update");
		if (result?.type === "auth_update") {
			expect(result.naiaKey).toBe("gw-test-key");
		}
	});

	it("returns null for typo variant — not whitelisted", () => {
		expect(parseRequest(JSON.stringify({ type: "auth_update_TYPO", naiaKey: "key" }))).toBeNull();
	});

	it("parses auth_update with no naiaKey field (type gating only)", () => {
		// parseRequest only checks type; field validation is caller's responsibility
		const result = parseRequest(JSON.stringify({ type: "auth_update" }));
		expect(result).not.toBeNull();
		expect(result?.type).toBe("auth_update");
	});
});

// ── factory: module-level naiaKey state (real module) ────────────────────

describe("factory — setAgentNaiaKey / getAgentNaiaKey", () => {
	afterEach(async () => {
		// Reset module state between tests so each starts clean
		const { vi } = await import("vitest");
		vi.resetModules();
	});

	it("getAgentNaiaKey returns undefined before any set", async () => {
		const { getAgentNaiaKey } = await import("../providers/factory.js");
		expect(getAgentNaiaKey()).toBeUndefined();
	});

	it("setAgentNaiaKey stores key, getAgentNaiaKey retrieves it", async () => {
		const { setAgentNaiaKey, getAgentNaiaKey } = await import("../providers/factory.js");
		setAgentNaiaKey("gw-abc123");
		expect(getAgentNaiaKey()).toBe("gw-abc123");
	});

	it("setAgentNaiaKey overwrites previous key", async () => {
		const { setAgentNaiaKey, getAgentNaiaKey } = await import("../providers/factory.js");
		setAgentNaiaKey("gw-first-key");
		setAgentNaiaKey("gw-second-key");
		expect(getAgentNaiaKey()).toBe("gw-second-key");
	});
});

// ── factory: buildProvider uses module-level naiaKey ──────────────────────

describe("factory — buildProvider routes via module-level naiaKey", () => {
	afterEach(async () => {
		const { vi } = await import("vitest");
		vi.resetModules();
	});

	it("routes to lab-proxy when agent naiaKey is set — no naiaKey in config needed", async () => {
		const { setAgentNaiaKey, buildProvider } = await import("../providers/factory.js");
		setAgentNaiaKey("gw-module-key");

		// provider config has NO naiaKey; module-level state drives routing
		// lab-proxy creator is called, which internally creates a real provider
		// We verify by NOT getting the "Naia provider requires" error
		let threwNaiaError = false;
		try {
			buildProvider({ provider: "nextain" as const, model: "gemini-3-flash" });
		} catch (err) {
			if (err instanceof Error && err.message.includes("Naia provider requires")) {
				threwNaiaError = true;
			}
		}
		expect(threwNaiaError).toBe(false);
	});

	it("falls through to 'nextain requires login' error when module naiaKey is unset", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		// No setAgentNaiaKey — fresh module after resetModules
		expect(() =>
			buildProvider({ provider: "nextain" as const, model: "gemini-3-flash" }),
		).toThrow("Naia provider requires Naia account login");
	});

	it("config.naiaKey is ignored — only module-level naiaKey drives lab-proxy routing", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		// naiaKey present in config but NOT in module state — should still throw
		expect(() =>
			buildProvider({
				provider: "nextain" as const,
				model: "gemini-3-flash",
				naiaKey: "config-level-key",
			}),
		).toThrow("Naia provider requires Naia account login");
	});
});
