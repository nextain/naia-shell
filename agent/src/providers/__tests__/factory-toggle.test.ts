import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useNextainAdapterFor } from "../factory.js";

/**
 * Day 5.1 — per-provider strangler fig toggle tests.
 *
 * Cross-review (Day 4.3 Paranoid P0-2 fix) — verify global + per-provider
 * env flag behavior is correct.
 */

const ENV_KEYS = [
	"NEXTAIN_AGENT_PROVIDERS",
	"NEXTAIN_ANTHROPIC",
	"NEXTAIN_OPENAI",
	"NEXTAIN_GEMINI",
	"NEXTAIN_CLAUDE_CODE_CLI",
	"NEXTAIN_LAB_PROXY",
	"NEXTAIN_VLLM",
];

describe("useNextainAdapterFor — per-provider strangler fig toggle (Day 5.1)", () => {
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		saved = {};
		for (const k of ENV_KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
	});

	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it("returns false when no flag set", () => {
		expect(useNextainAdapterFor("anthropic")).toBe(false);
		expect(useNextainAdapterFor("openai")).toBe(false);
	});

	it("global toggle activates ALL providers", () => {
		process.env["NEXTAIN_AGENT_PROVIDERS"] = "1";
		expect(useNextainAdapterFor("anthropic")).toBe(true);
		expect(useNextainAdapterFor("openai")).toBe(true);
		expect(useNextainAdapterFor("gemini")).toBe(true);
		expect(useNextainAdapterFor("lab-proxy")).toBe(true);
		expect(useNextainAdapterFor("claude-code-cli")).toBe(true);
	});

	it("per-provider toggle activates only that provider", () => {
		process.env["NEXTAIN_ANTHROPIC"] = "1";
		expect(useNextainAdapterFor("anthropic")).toBe(true);
		expect(useNextainAdapterFor("openai")).toBe(false);
		expect(useNextainAdapterFor("gemini")).toBe(false);
	});

	it("hyphen normalization (claude-code-cli → CLAUDE_CODE_CLI)", () => {
		process.env["NEXTAIN_CLAUDE_CODE_CLI"] = "1";
		expect(useNextainAdapterFor("claude-code-cli")).toBe(true);
		expect(useNextainAdapterFor("anthropic")).toBe(false);
	});

	it("hyphen normalization (lab-proxy → LAB_PROXY)", () => {
		process.env["NEXTAIN_LAB_PROXY"] = "1";
		expect(useNextainAdapterFor("lab-proxy")).toBe(true);
	});

	it("case-insensitive env values (true/yes/on/1)", () => {
		process.env["NEXTAIN_OPENAI"] = "TRUE";
		expect(useNextainAdapterFor("openai")).toBe(true);
		process.env["NEXTAIN_OPENAI"] = "yes";
		expect(useNextainAdapterFor("openai")).toBe(true);
		process.env["NEXTAIN_OPENAI"] = "on";
		expect(useNextainAdapterFor("openai")).toBe(true);
		process.env["NEXTAIN_OPENAI"] = "1";
		expect(useNextainAdapterFor("openai")).toBe(true);
	});

	it("falsy env values (0/false/no/off/empty)", () => {
		process.env["NEXTAIN_OPENAI"] = "0";
		expect(useNextainAdapterFor("openai")).toBe(false);
		process.env["NEXTAIN_OPENAI"] = "false";
		expect(useNextainAdapterFor("openai")).toBe(false);
		process.env["NEXTAIN_OPENAI"] = "no";
		expect(useNextainAdapterFor("openai")).toBe(false);
		process.env["NEXTAIN_OPENAI"] = "";
		expect(useNextainAdapterFor("openai")).toBe(false);
	});

	it("global flag wins over per-provider falsy (or-logic)", () => {
		process.env["NEXTAIN_AGENT_PROVIDERS"] = "1";
		process.env["NEXTAIN_OPENAI"] = "0";  // ignored — global on
		expect(useNextainAdapterFor("openai")).toBe(true);
	});

	it("global falsy + per-provider true → per-provider wins", () => {
		process.env["NEXTAIN_AGENT_PROVIDERS"] = "0";
		process.env["NEXTAIN_GEMINI"] = "1";
		expect(useNextainAdapterFor("gemini")).toBe(true);
		expect(useNextainAdapterFor("openai")).toBe(false);
	});

	it("multiple per-provider toggles independent", () => {
		process.env["NEXTAIN_ANTHROPIC"] = "1";
		process.env["NEXTAIN_LAB_PROXY"] = "1";
		expect(useNextainAdapterFor("anthropic")).toBe(true);
		expect(useNextainAdapterFor("lab-proxy")).toBe(true);
		expect(useNextainAdapterFor("openai")).toBe(false);
		expect(useNextainAdapterFor("gemini")).toBe(false);
	});

	it("whitespace trimmed", () => {
		process.env["NEXTAIN_OPENAI"] = "  1  ";
		expect(useNextainAdapterFor("openai")).toBe(true);
		process.env["NEXTAIN_OPENAI"] = " yes ";
		expect(useNextainAdapterFor("openai")).toBe(true);
	});
});
