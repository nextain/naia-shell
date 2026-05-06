import { createNextainAnthropicProvider } from "./adapters/nextain-provider-adapter.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createClaudeCodeCliProvider } from "./claude-code-cli.js";
import { createGeminiProvider } from "./gemini.js";
import { createLabProxyProvider } from "./lab-proxy.js";
import { createOpenAIProvider } from "./openai.js";
import { getLlmProviderDef, registerLlmProvider } from "./registry.js";
import type { LLMProvider, ProviderConfig } from "./types.js";
import { createXAIProvider } from "./xai.js";
import { createZAIProvider } from "./zai.js";

// ── Provider registrations ──

registerLlmProvider({
	id: "gemini",
	name: "Google Gemini",
	envVar: "GEMINI_API_KEY",
	create: (apiKey, model) => createGeminiProvider(apiKey, model),
});

registerLlmProvider({
	id: "openai",
	name: "OpenAI",
	envVar: "OPENAI_API_KEY",
	create: (apiKey, model, opts) =>
		createOpenAIProvider(apiKey, model, opts?.ollamaHost),
});

registerLlmProvider({
	id: "anthropic",
	name: "Anthropic",
	envVar: "ANTHROPIC_API_KEY",
	create: (apiKey, model) => {
		// Phase 2 X1 Strangler Fig. When NEXTAIN_AGENT_PROVIDERS=1 is set,
		// route anthropic calls through the @nextain/agent-providers adapter
		// instead of the native implementation. Default stays on native
		// during the observation window (plan A.9).
		if (process.env["NEXTAIN_AGENT_PROVIDERS"] === "1") {
			return createNextainAnthropicProvider(apiKey, model);
		}
		return createAnthropicProvider(apiKey, model);
	},
});

registerLlmProvider({
	id: "xai",
	name: "xAI",
	envVar: "XAI_API_KEY",
	create: (apiKey, model) => createXAIProvider(apiKey, model),
});

registerLlmProvider({
	id: "zai",
	name: "Zhipu AI",
	envVar: "ZHIPU_API_KEY",
	create: (apiKey, model) => createZAIProvider(apiKey, model),
});

registerLlmProvider({
	id: "claude-code-cli",
	name: "Claude Code CLI",
	create: (_apiKey, model) => createClaudeCodeCliProvider(model),
});

registerLlmProvider({
	id: "ollama",
	name: "Ollama",
	create: (_apiKey, model, opts) =>
		createOpenAIProvider("ollama", model, opts?.ollamaHost),
});

registerLlmProvider({
	id: "vllm",
	name: "vLLM",
	create: (_apiKey, model, opts) =>
		createOpenAIProvider("vllm", model, opts?.vllmHost),
});

registerLlmProvider({
	id: "lab-proxy",
	name: "Naia Lab Proxy",
	create: (naiaKey, model, opts) => createLabProxyProvider(naiaKey, model, opts?.labGatewayUrl),
});

// ── Agent credential store ──
// naiaKey is owned by the agent (backend). Shell sends auth_update once; never per-request.

let _agentNaiaKey: string | undefined;

export function setAgentNaiaKey(key: string): void {
	if (!key) {
		_agentNaiaKey = undefined;
		return;
	}
	if (!key.startsWith("gw-") || key.length > 256 || !/^[A-Za-z0-9_-]+$/.test(key)) {
		console.error(`[agent] setAgentNaiaKey: invalid key format, ignored`);
		return;
	}
	_agentNaiaKey = key;
}

export function getAgentNaiaKey(): string | undefined {
	return _agentNaiaKey;
}

// ── Factory ──

export function buildProvider(config: ProviderConfig): LLMProvider {
	// Lab proxy mode: agent holds naiaKey — never read from per-request config.
	const naiaKey = _agentNaiaKey;
	if (naiaKey) {
		const labProxy = getLlmProviderDef("lab-proxy");
		if (!labProxy) throw new Error("Lab proxy provider not registered.");
		return labProxy.create(naiaKey, config.model, { labGatewayUrl: config.labGatewayUrl });
	}

	if (config.provider === "nextain") {
		throw new Error("Naia provider requires Naia account login.");
	}

	const def = getLlmProviderDef(config.provider);
	if (!def) throw new Error(`Unknown provider: ${config.provider}`);

	const apiKey =
		config.apiKey || (def.envVar ? process.env[def.envVar] || "" : "");
	return def.create(apiKey, config.model, {
		ollamaHost: config.ollamaHost,
		vllmHost: config.vllmHost,
	});
}
