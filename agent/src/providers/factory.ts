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
	create: (apiKey, model) => createAnthropicProvider(apiKey, model),
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

// ── Factory ──

export function buildProvider(config: ProviderConfig): LLMProvider {
	// Lab proxy mode: route through any-llm Gateway
	if (config.naiaKey) {
		const labProxy = getLlmProviderDef("lab-proxy");
		if (!labProxy) throw new Error("Lab proxy provider not registered.");
		return labProxy.create(config.naiaKey, config.model, { labGatewayUrl: config.labGatewayUrl });
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
