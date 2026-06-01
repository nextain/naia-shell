import { createNextainClaudeCliProvider } from "./adapters/nextain-claude-cli-adapter.js";
import { createNextainGeminiProvider } from "./adapters/nextain-gemini-adapter.js";
import { createNextainLabProxyLiveProvider } from "./adapters/nextain-lab-proxy-live-adapter.js";
import { createNextainLabProxyProvider } from "./adapters/nextain-lab-proxy-adapter.js";
import { createNextainOpenAIProvider } from "./adapters/nextain-openai-adapter.js";
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

// X1+ Strangler Fig (Phase 4.2 Day 5.1 per-provider granularity):
//   NEXTAIN_AGENT_PROVIDERS=1   → ALL providers route via @nextain adapter
//   NEXTAIN_<PROVIDER>=1        → only that provider external (per-provider override)
//     e.g. NEXTAIN_ANTHROPIC=1 / NEXTAIN_OPENAI=1 / NEXTAIN_GEMINI=1 / NEXTAIN_LAB_PROXY=1
// Truthy values accepted: 1 / true / yes / on (case-insensitive, Day 4.3 Paranoid P2-2).

function isTruthyEnv(value: string | undefined): boolean {
	if (!value) return false;
	const v = value.toLowerCase().trim();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

function useNextainAdapter(): boolean {
	return isTruthyEnv(process.env["NEXTAIN_AGENT_PROVIDERS"]);
}

/**
 * Per-provider strangler fig toggle. Returns true if either the global flag
 * OR the per-provider flag is set. Provider id is normalized:
 *   "claude-code-cli" → NEXTAIN_CLAUDE_CODE_CLI
 *   "lab-proxy"       → NEXTAIN_LAB_PROXY
 */
export function useNextainAdapterFor(providerId: string): boolean {
	if (useNextainAdapter()) return true;
	const envKey = `NEXTAIN_${providerId.toUpperCase().replace(/-/g, "_")}`;
	return isTruthyEnv(process.env[envKey]);
}

/**
 * Detect vllm-omni models (audio-inline). Exported so tests can assert the
 * exact regex production code uses (no duplicated test-side mirror).
 *
 * Matches:
 *   - {minicpm,nanocpm,nano-cpm,gpt,qwen2-vl,intern-vl}-o / -omni / -omnimodal
 *   - anything with -omni in the name
 *   - gpt-4o / gpt-4o-mini / gpt-4o-realtime etc.
 * Does NOT match:
 *   - claude-opus-4-o, gemma-4-o, generic *-o suffix (#272 P0-1 fix)
 */
export function isOmni(model: string): boolean {
	return (
		/(?:minicpm|nanocpm|nano-cpm|gpt|qwen2?-?vl|intern-?vl)[-_]?o(?:mnimodal|mni)?(?:[-_]|$)/i.test(model) ||
		/[-_]omni(?:[-_]|$)/i.test(model) ||
		/gpt-4o(?:-|$)/i.test(model)
	);
}

/**
 * Detect Lab-proxy live API models (WebSocket adapter).
 * Pattern covers -live / -live-preview / -live-stream / -live-realtime.
 */
export function isLive(model: string): boolean {
	return /[-_]live(?:[-_][a-z0-9]+)*$/i.test(model);
}

// ── Provider registrations ──

registerLlmProvider({
	id: "gemini",
	name: "Google Gemini",
	envVar: "GEMINI_API_KEY",
	create: (apiKey, model) => {
		// Strangler Fig priority (Phase 5 Day 7.1 — full thoughtSignature parity):
		//   NEXTAIN_GEMINI=openai-compat → OpenAI-compat path (thoughtSignature dropped, lighter dep)
		//   NEXTAIN_GEMINI=1 or NEXTAIN_AGENT_PROVIDERS=1 → full GeminiClient (parity 우선)
		//   unset → native createGeminiProvider (existing behavior, default)
		const geminiMode = (process.env["NEXTAIN_GEMINI"] ?? "").toLowerCase().trim();
		if (geminiMode === "openai-compat") {
			return createNextainOpenAIProvider(apiKey, model, { family: "gemini" });
		}
		if (useNextainAdapterFor("gemini")) {
			return createNextainGeminiProvider(apiKey, model);
		}
		return createGeminiProvider(apiKey, model);
	},
});

registerLlmProvider({
	id: "openai",
	name: "OpenAI",
	envVar: "OPENAI_API_KEY",
	create: (apiKey, model, opts) => {
		if (useNextainAdapterFor("openai")) {
			return createNextainOpenAIProvider(apiKey, model, { family: "openai" });
		}
		return createOpenAIProvider(apiKey, model, opts?.ollamaHost);
	},
});

registerLlmProvider({
	id: "anthropic",
	name: "Anthropic",
	envVar: "ANTHROPIC_API_KEY",
	create: (apiKey, model) => {
		if (useNextainAdapterFor("anthropic")) {
			return createNextainAnthropicProvider(apiKey, model);
		}
		return createAnthropicProvider(apiKey, model);
	},
});

registerLlmProvider({
	id: "xai",
	name: "xAI",
	envVar: "XAI_API_KEY",
	create: (apiKey, model) => {
		if (useNextainAdapterFor("xai")) {
			return createNextainOpenAIProvider(apiKey, model, { family: "xai" });
		}
		return createXAIProvider(apiKey, model);
	},
});

registerLlmProvider({
	id: "zai",
	name: "Zhipu AI",
	envVar: "ZHIPU_API_KEY",
	create: (apiKey, model) => {
		if (useNextainAdapterFor("zai")) {
			return createNextainOpenAIProvider(apiKey, model, { family: "zai" });
		}
		return createZAIProvider(apiKey, model);
	},
});

registerLlmProvider({
	id: "claude-code-cli",
	name: "Claude Code CLI",
	create: (_apiKey, model) => {
		// Phase 4.1 strangler-fig limitations on the @nextain path:
		//   - No Flatpak/Windows-specific subprocess wrappers
		//   - No partial-JSON recovery
		//   - Short prompts only (no system-prompt-file fallback >64KB)
		// In those environments leave NEXTAIN_CLAUDE_CODE_CLI unset → native.
		if (useNextainAdapterFor("claude-code-cli")) {
			return createNextainClaudeCliProvider(model);
		}
		return createClaudeCodeCliProvider(model);
	},
});

registerLlmProvider({
	id: "ollama",
	name: "Ollama",
	create: (_apiKey, model, opts) => {
		if (useNextainAdapterFor("ollama")) {
			return createNextainOpenAIProvider("", model, {
				family: "ollama",
				baseUrlOverride: opts?.ollamaHost ?? "",
			});
		}
		return createOpenAIProvider("ollama", model, opts?.ollamaHost);
	},
});

registerLlmProvider({
	id: "vllm",
	name: "vLLM",
	create: (_apiKey, model, opts) => {
		// vllm-omni models return audio inline — must stay on native (Day 1.1 §3.7).
		// Use the exported isOmni() helper so tests assert the same regex production uses.
		// #272 reconcile dropped the over-broad `/[-_]o\b/i` fallback (false-matched
		// claude-opus-4-o, gemma-4-o etc.) and preserved gpt-prefix coverage.
		if (useNextainAdapterFor("vllm") && !isOmni(model)) {
			return createNextainOpenAIProvider("", model, {
				family: "vllm",
				baseUrlOverride: opts?.vllmHost ?? "",
			});
		}
		return createOpenAIProvider("vllm", model, opts?.vllmHost);
	},
});

registerLlmProvider({
	id: "lab-proxy",
	name: "Naia Lab Proxy",
	create: (naiaKey, model, opts) => {
		// Phase 5 Day 7.2 — *-live suffix → LabProxyLiveClient (WebSocket).
		// Use the exported isLive() helper so tests share the same regex.
		if (useNextainAdapterFor("lab-proxy")) {
			if (isLive(model)) {
				return createNextainLabProxyLiveProvider(naiaKey, model);
			}
			return createNextainLabProxyProvider(naiaKey, model, opts?.labGatewayUrl);
		}
		return createLabProxyProvider(naiaKey, model, opts?.labGatewayUrl);
	},
});

// ── Agent credential store ──
// naiaKey is owned by the agent (backend). Shell sends auth_update once; never per-request.
// Reconcile #272: main's auth_update flow preserved while phase4's strangler-fig
// adapters integrate above. memorySystem rebuild on auth_update is handled in index.ts.

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

// ── Per-provider API key cache (post-#260 follow-up) ──
// Same pattern as _agentNaiaKey: shell sends `creds_update` once at startup
// and on every settings save; the agent caches keys per-provider. buildProvider
// reads from the cache first, falls back to per-request `config.apiKey` for
// backwards compatibility with older shells that haven't migrated, then to
// the provider's envVar. This keeps API keys out of every chat_request stdio
// frame — the credential leak vector closed for naiaKey (auth_update) and
// webhook URLs (notify_config) extended to LLM API keys.

const _providerApiKeys = new Map<string, string>();

/**
 * Set the cached API key for one provider. Empty string clears the entry
 * (explicit unset — user erased the textbox).
 */
export function setProviderApiKey(providerId: string, apiKey: string): void {
	if (!providerId) return;
	if (!apiKey) {
		_providerApiKeys.delete(providerId);
		return;
	}
	_providerApiKeys.set(providerId, apiKey);
}

export function getProviderApiKey(providerId: string): string | undefined {
	return _providerApiKeys.get(providerId);
}

/** Test helper: clear all cached provider API keys. Not used in prod. */
export function _clearProviderApiKeys(): void {
	_providerApiKeys.clear();
}

// ── Per-TTS-provider API key cache (creds_update.ttsKeys) ──
// Same shape as _providerApiKeys but keyed by TTS provider id
// ("google" / "openai" / "elevenlabs" / "edge" / "nextain").

const _ttsApiKeys = new Map<string, string>();

export function setTtsApiKey(providerId: string, apiKey: string): void {
	if (!providerId) return;
	if (!apiKey) {
		_ttsApiKeys.delete(providerId);
		return;
	}
	_ttsApiKeys.set(providerId, apiKey);
}

export function getTtsApiKey(providerId: string): string | undefined {
	return _ttsApiKeys.get(providerId);
}

export function _clearTtsApiKeys(): void {
	_ttsApiKeys.clear();
}

// ── Gateway WebSocket auth token (creds_update.gatewayToken) ──
// Single value (not per-provider). One Naia Gateway per session.

let _gatewayToken: string | undefined;

export function setGatewayToken(token: string): void {
	_gatewayToken = token ? token : undefined;
}

export function getGatewayToken(): string | undefined {
	return _gatewayToken;
}

export function _clearGatewayToken(): void {
	_gatewayToken = undefined;
}

// ── Factory ──

/** Which route a config takes. Resolved once (pure), then dispatched by switch. */
type ProviderRoute = "claude-cli" | "local-live" | "lab-proxy" | "nextain-error" | "native";

/**
 * Decide a config's route — pure and side-effect-free (easy to unit test).
 * Order mirrors the original buildProvider precedence exactly:
 *   1. claude-code-cli → always the local CLI (Naia key grants no Anthropic access).
 *   2. naia-*-live + NAIA_LIVE_HOST → local voice wrapper bypass.
 *   3. logged in (naiaKey) + cloud provider → lab-proxy (Naia account credit relays it).
 *      ollama/vllm stay local even while logged in — the gateway has no knowledge of
 *      the user's local models, so routing them through lab-proxy 500s (naia-os#356).
 *   4. nextain pseudo-provider WITHOUT login → error. (With login it already took the
 *      lab-proxy route at step 3, since nextain is not an explicit-local provider.)
 *   5. otherwise → the provider's own native/adapter impl.
 */
function resolveProviderRoute(
	config: ProviderConfig,
	naiaKey: string | undefined,
	liveHost: string,
): ProviderRoute {
	if (config.provider === "claude-code-cli") return "claude-cli";
	if (naiaKey && liveHost && /^naia-\d+[gt]-live$/i.test(config.model)) {
		return "local-live";
	}
	const isExplicitLocalProvider =
		config.provider === "ollama" || config.provider === "vllm";
	if (naiaKey && !isExplicitLocalProvider) return "lab-proxy";
	if (config.provider === "nextain") return "nextain-error";
	return "native";
}

function requireProviderDef(id: string) {
	const def = getLlmProviderDef(id);
	if (!def) throw new Error(`${id} provider not registered.`);
	return def;
}

/**
 * Create the provider's own native/adapter impl, resolving its API key by priority:
 *   1. cached key from `creds_update` (#260 follow-up)
 *   2. per-request `config.apiKey` (backwards compat — older shells)
 *   3. envVar (CI / dev override)
 */
function createNativeProvider(config: ProviderConfig): LLMProvider {
	const def = getLlmProviderDef(config.provider);
	if (!def) throw new Error(`Unknown provider: ${config.provider}`);
	const apiKey =
		_providerApiKeys.get(config.provider) ||
		config.apiKey ||
		(def.envVar ? process.env[def.envVar] || "" : "");
	return def.create(apiKey, config.model, {
		ollamaHost: config.ollamaHost,
		vllmHost: config.vllmHost,
	});
}

export function buildProvider(config: ProviderConfig): LLMProvider {
	// naiaKey is owned by the agent (auth_update) — never read from per-request config.
	const naiaKey = _agentNaiaKey;
	const liveHost = process.env["NAIA_LIVE_HOST"] || "";

	switch (resolveProviderRoute(config, naiaKey, liveHost)) {
		case "claude-cli":
			return requireProviderDef("claude-code-cli").create("", config.model);
		case "local-live":
			return createOpenAIProvider("vllm", config.model, liveHost);
		case "lab-proxy":
			return requireProviderDef("lab-proxy").create(naiaKey as string, config.model, {
				labGatewayUrl: config.labGatewayUrl,
			});
		case "nextain-error":
			throw new Error("Naia provider requires Naia account login.");
		case "native":
			return createNativeProvider(config);
	}
}
