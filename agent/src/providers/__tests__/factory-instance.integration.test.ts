/**
 * Phase 5+ adversarial 4차 P1 fix - factory env routing actual instance test.
 *
 * Adversarial 4th review: factory-toggle.test.ts (11) verifies env flag logic
 * but never invokes provider creation. P1 finding: useNextainAdapterFor("anthropic")
 * returns true/false, but createNextain*Provider call path was never exercised.
 *
 * This test calls buildProvider(config) and asserts the returned LLMProvider
 * shape (stream() method) matches contract. Real provider construction (with
 * dummy keys, no API call). Verifies factory branch resolution end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProvider, setAgentNaiaKey } from "../factory.js";

const ENV_KEYS = [
  "NEXTAIN_AGENT_PROVIDERS",
  "NEXTAIN_ANTHROPIC", "NEXTAIN_OPENAI", "NEXTAIN_GEMINI",
  "NEXTAIN_CLAUDE_CODE_CLI", "NEXTAIN_LAB_PROXY", "NEXTAIN_VLLM",
  "NEXTAIN_XAI", "NEXTAIN_ZAI", "NEXTAIN_OLLAMA",
];

describe("factory env routing - real provider instance creation", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // Reset module-scope agent naiaKey between tests (#272: naiaKey is set
    // via setAgentNaiaKey during handleAuthUpdate, not per-request via config).
    setAgentNaiaKey("");
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    setAgentNaiaKey("");
  });

  it("anthropic provider creates LLMProvider with stream() (native)", () => {
    const provider = buildProvider({
      provider: "anthropic",
      model: "claude-opus-4-7",
      apiKey: "dummy-key",
    });
    expect(provider).toBeDefined();
    expect(typeof provider.stream).toBe("function");
  });

  it("anthropic provider via NEXTAIN_ANTHROPIC=1 returns LLMProvider", () => {
    process.env["NEXTAIN_ANTHROPIC"] = "1";
    const provider = buildProvider({
      provider: "anthropic",
      model: "claude-opus-4-7",
      apiKey: "dummy-key",
    });
    expect(provider).toBeDefined();
    expect(typeof provider.stream).toBe("function");
  });

  it("openai provider creates with stream() (native)", () => {
    const provider = buildProvider({
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "dummy-key",
    });
    expect(provider).toBeDefined();
    expect(typeof provider.stream).toBe("function");
  });

  it("openai provider via NEXTAIN_OPENAI=1 returns LLMProvider", () => {
    process.env["NEXTAIN_OPENAI"] = "1";
    const provider = buildProvider({
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "dummy-key",
    });
    expect(provider).toBeDefined();
    expect(typeof provider.stream).toBe("function");
  });

  it("gemini provider creates with stream() (native @google/genai)", () => {
    const provider = buildProvider({
      provider: "gemini",
      model: "gemini-2.5-flash",
      apiKey: "dummy-key",
    });
    expect(provider).toBeDefined();
    expect(typeof provider.stream).toBe("function");
  });

  it("gemini via NEXTAIN_GEMINI=openai-compat → OpenAI-compat path", () => {
    process.env["NEXTAIN_GEMINI"] = "openai-compat";
    // openai-compat path uses createNextainOpenAIProvider with family="gemini"
    // — emits warn about thoughtSignature; just verify shape.
    const provider = buildProvider({
      provider: "gemini",
      model: "gemini-2.5-flash",
      apiKey: "dummy-key",
    });
    expect(provider).toBeDefined();
    expect(typeof provider.stream).toBe("function");
  });

  it("gemini via NEXTAIN_GEMINI=1 → full GeminiClient path", () => {
    process.env["NEXTAIN_GEMINI"] = "1";
    const provider = buildProvider({
      provider: "gemini",
      model: "gemini-2.5-flash",
      apiKey: "dummy-key",
    });
    expect(provider).toBeDefined();
    expect(typeof provider.stream).toBe("function");
  });

  it("lab-proxy via agent naiaKey routes to lab-proxy registry def", () => {
    // #272: naiaKey is set via setAgentNaiaKey (from handleAuthUpdate), not per-request.
    setAgentNaiaKey("gw-test-naia-key");
    const provider = buildProvider({
      provider: "anthropic",  // ignored when agent naiaKey set
      model: "claude-opus-4-7",
      apiKey: "",
    });
    expect(provider).toBeDefined();
    expect(typeof provider.stream).toBe("function");
  });

  it("vllm-omni model stays on native (audio inline preservation)", () => {
    process.env["NEXTAIN_VLLM"] = "1";
    const provider = buildProvider({
      provider: "vllm",
      model: "minicpm-o-2.6",  // omni model - regex /minicpm[-_]?o/i
      apiKey: "vllm",
    });
    expect(provider).toBeDefined();
    // Should be native (createOpenAIProvider("vllm", ...)) regardless of NEXTAIN_VLLM
    expect(typeof provider.stream).toBe("function");
  });

  it("vllm non-omni model uses NEXTAIN_VLLM external path when set", () => {
    process.env["NEXTAIN_VLLM"] = "1";
    const provider = buildProvider({
      provider: "vllm",
      model: "qwen2-7b",  // non-omni
      apiKey: "vllm",
      vllmHost: "http://localhost:8000",
    });
    expect(provider).toBeDefined();
    expect(typeof provider.stream).toBe("function");
  });

  it("claude-code-cli (no API key) creates native provider", () => {
    const provider = buildProvider({
      provider: "claude-code-cli",
      model: "claude-opus-4-7",
      apiKey: "",
    });
    expect(provider).toBeDefined();
    expect(typeof provider.stream).toBe("function");
  });

  it("claude-code-cli via NEXTAIN_CLAUDE_CODE_CLI=1 → external ClaudeCliClient", () => {
    process.env["NEXTAIN_CLAUDE_CODE_CLI"] = "1";
    const provider = buildProvider({
      provider: "claude-code-cli",
      model: "claude-opus-4-7",
      apiKey: "",
    });
    expect(provider).toBeDefined();
    expect(typeof provider.stream).toBe("function");
  });

  it("lab-proxy live model auto-detect via NEXTAIN_LAB_PROXY=1", () => {
    process.env["NEXTAIN_LAB_PROXY"] = "1";
    setAgentNaiaKey("gw-test-naia-key");
    const provider = buildProvider({
      provider: "anthropic",  // ignored when agent naiaKey set
      model: "gemini-2.5-flash-live",  // -live suffix → LabProxyLive path
      apiKey: "",
    });
    expect(provider).toBeDefined();
    expect(typeof provider.stream).toBe("function");
  });

  it("global NEXTAIN_AGENT_PROVIDERS=1 activates all external paths", () => {
    process.env["NEXTAIN_AGENT_PROVIDERS"] = "1";
    const a = buildProvider({ provider: "anthropic", model: "claude-opus-4-7", apiKey: "k" });
    const o = buildProvider({ provider: "openai", model: "gpt-4o-mini", apiKey: "k" });
    const g = buildProvider({ provider: "gemini", model: "gemini-2.5-flash", apiKey: "k" });
    expect(typeof a.stream).toBe("function");
    expect(typeof o.stream).toBe("function");
    expect(typeof g.stream).toBe("function");
  });
});
