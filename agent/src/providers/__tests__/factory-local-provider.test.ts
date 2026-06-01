/**
 * naia-os#356 — explicit local providers (ollama/vllm) must NOT be hijacked by
 * lab-proxy while the user is logged in (naiaKey set).
 *
 * Bug: buildProvider routed EVERYTHING to lab-proxy when naiaKey was present,
 * except claude-code-cli and naia-*-live. So selecting ollama/vllm with a local
 * model sent that model name to the gateway, which has no local models -> 500.
 *
 * Fix: cloud providers (openai/anthropic/gemini/xai/zai) still relay via
 * lab-proxy (Naia credit), but ollama/vllm stay local.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProvider, setAgentNaiaKey } from "../factory.js";
import { getLlmProviderDef } from "../registry.js";
import type { LLMProvider } from "../types.js";

// Stub provider — we only assert *which* registry def.create() gets called
// (routing), not the real client construction (separate concern).
const fakeProvider: LLMProvider = {
	// biome-ignore lint/correctness/useYield: empty stub stream for routing test
	async *stream() {},
};

describe("naia-os#356 local provider routing with naiaKey", () => {
	afterEach(() => {
		setAgentNaiaKey("");
		vi.restoreAllMocks();
	});

	it("ollama stays LOCAL (lab-proxy NOT called) even with naiaKey", () => {
		setAgentNaiaKey("gw-test-naia-key");
		const labProxyDef = getLlmProviderDef("lab-proxy");
		const ollamaDef = getLlmProviderDef("ollama");
		if (!labProxyDef || !ollamaDef) throw new Error("provider defs missing");
		const labSpy = vi.spyOn(labProxyDef, "create");
		const ollamaSpy = vi.spyOn(ollamaDef, "create");

		const provider = buildProvider({
			provider: "ollama",
			model: "gemma4-e4b-q8_0",
			ollamaHost: "http://localhost:11434",
		});

		expect(provider).toBeDefined();
		expect(labSpy).not.toHaveBeenCalled();
		expect(ollamaSpy).toHaveBeenCalledOnce();
	});

	it("vllm stays LOCAL (lab-proxy NOT called) even with naiaKey", () => {
		setAgentNaiaKey("gw-test-naia-key");
		const labProxyDef = getLlmProviderDef("lab-proxy");
		const vllmDef = getLlmProviderDef("vllm");
		if (!labProxyDef || !vllmDef) throw new Error("provider defs missing");
		const labSpy = vi.spyOn(labProxyDef, "create");
		const vllmSpy = vi.spyOn(vllmDef, "create");

		const provider = buildProvider({
			provider: "vllm",
			model: "qwen2-7b",
			vllmHost: "http://localhost:8000",
		});

		expect(provider).toBeDefined();
		expect(labSpy).not.toHaveBeenCalled();
		expect(vllmSpy).toHaveBeenCalledOnce();
	});

	it("REGRESSION: cloud provider (anthropic) STILL routes to lab-proxy", () => {
		setAgentNaiaKey("gw-test-naia-key");
		const labProxyDef = getLlmProviderDef("lab-proxy");
		if (!labProxyDef) throw new Error("lab-proxy def missing");
		// Stub the real lab-proxy client construction; assert routing only.
		const labSpy = vi
			.spyOn(labProxyDef, "create")
			.mockReturnValue(fakeProvider);

		const provider = buildProvider({
			provider: "anthropic",
			model: "claude-opus-4-7",
		});

		expect(provider).toBeDefined();
		expect(labSpy).toHaveBeenCalledOnce();
	});

	it("ollama with NO naiaKey also stays local (baseline)", () => {
		setAgentNaiaKey("");
		const labProxyDef = getLlmProviderDef("lab-proxy");
		const ollamaDef = getLlmProviderDef("ollama");
		if (!labProxyDef || !ollamaDef) throw new Error("provider defs missing");
		const labSpy = vi.spyOn(labProxyDef, "create");
		const ollamaSpy = vi.spyOn(ollamaDef, "create");

		const provider = buildProvider({
			provider: "ollama",
			model: "gemma4-e4b-q8_0",
			ollamaHost: "http://localhost:11434",
		});

		expect(provider).toBeDefined();
		expect(labSpy).not.toHaveBeenCalled();
		expect(ollamaSpy).toHaveBeenCalledOnce();
	});
});
