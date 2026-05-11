/**
 * Nextain OpenAI-compatible provider adapter — wraps `@nextain/agent-providers`'
 * `OpenAICompatClient` behind naia-os' local `LLMProvider` shape.
 *
 * R4 Phase 4.1 Day 4.3.1 — Strangler Fig horizontal expansion (OpenAI family).
 * Covers OpenAI / zai (Zhipu GLM) / xai (xAI) / Ollama / vLLM (non-omni).
 *
 * Behind the same opt-in env flag as `nextain-provider-adapter.ts`:
 *   `NEXTAIN_AGENT_PROVIDERS=1`
 *
 * Direction of conversion (mirrors anthropic adapter pattern):
 *   naia-os ChatMessage[]   →  @nextain LLMRequest    →  OpenAI HTTP API
 *   @nextain LLMStreamChunk →  naia-os StreamChunk    (yielded)
 *
 * vllm-omni (MiniCPM-o audio inline) is **NOT** routed here — native
 * `createOpenAIProvider` retains audio handling per Day 1.1 §3.7 (Phase 5+
 * D43 deferred). vLLM (non-omni) routes through this adapter.
 *
 * Streaming note: `OpenAICompatClient` is currently non-streaming (single
 * generate() then fake-streamed). True SSE is a Phase 4.2+ enhancement.
 * naia-os UX accepts this for the transition window — chat appears as a
 * single chunk rather than progressive tokens. Document explicitly.
 */

// Subpath import — avoids resolving @nextain/agent-providers/index.js,
// which transitively loads anthropic-vertex.js (peerDep @anthropic-ai/vertex-sdk
// not installed in naia-os agent). subpath = surgical, sideEffects-safe.
import { OpenAICompatClient } from "@nextain/agent-providers/openai-compat";
import type {
	LLMContentBlock,
	LLMMessage,
	LLMRequest,
	LLMStreamChunk,
	ToolDefinition as NextainToolDefinition,
} from "@nextain/agent-types";

import type {
	AgentStream,
	ChatMessage,
	LLMProvider,
	ToolDefinition,
} from "../types.js";
import {
	convertStreamChunk,
	toNextainMessage,
} from "./nextain-provider-adapter.js";

/** Family-specific baseUrl resolver. */
function resolveBaseUrl(
	family: "openai" | "zai" | "xai" | "ollama" | "vllm" | "gemini",
	override?: string,
): string {
	const trimmed = (override ?? "").replace(/\/+$/, "");
	switch (family) {
		case "openai":
			return trimmed || "https://api.openai.com/v1";
		case "zai":
			// open.bigmodel.cn — Zhipu GLM OpenAI-compat endpoint.
			return trimmed || "https://open.bigmodel.cn/api/paas/v4";
		case "xai":
			return trimmed || "https://api.x.ai/v1";
		case "ollama":
			return `${override?.replace(/\/+$/, "") || "http://localhost:11434"}/v1`;
		case "vllm":
			return `${override?.replace(/\/+$/, "") || "http://localhost:8000"}/v1`;
		case "gemini":
			// Day 4.3.2 — Google AI Studio OpenAI-compat endpoint (since 2024-12).
			// Limitation: `thoughtSignature` (Gemini 3 thinking metadata) is NOT
			// surfaced via this path. Gemini 3 thinking-tool calling parity
			// requires the native @google/genai SDK route — Phase 4.2 will add
			// a dedicated GeminiClient (LLMContentBlock signature 확장 후).
			return trimmed || "https://generativelanguage.googleapis.com/v1beta/openai";
	}
}

export interface NextainOpenAIProviderOptions {
	/** Family — determines baseUrl + auth header expectations. */
	family: "openai" | "zai" | "xai" | "ollama" | "vllm" | "gemini";
	/** Override baseUrl. For ollama/vllm: hostname-only (no /v1). For others: full URL. */
	baseUrlOverride?: string;
}

/**
 * Factory matching naia-os registry contract.
 * Wraps OpenAICompatClient behind LLMProvider interface.
 */
export function createNextainOpenAIProvider(
	apiKey: string,
	model: string,
	opts: NextainOpenAIProviderOptions,
): LLMProvider {
	// Cross-review (Day 4.3 Paranoid P1-5 fix) — explicit warning when Gemini
	// is routed via OpenAI-compat. thoughtSignature is dropped here, which
	// degrades Gemini 3 thinking-tool calling accuracy. Phase 4.2 will add
	// a dedicated GeminiClient (LLMContentBlock signature 확장 후).
	if (opts.family === "gemini") {
		console.warn(
			"[nextain-openai-adapter] Gemini family via OpenAI-compat: thoughtSignature dropped. " +
				"Gemini 3 + tool_use accuracy may degrade. For full parity, leave " +
				"NEXTAIN_AGENT_PROVIDERS unset → native createGeminiProvider (@google/genai SDK).",
		);
	}
	const baseUrl = resolveBaseUrl(opts.family, opts.baseUrlOverride);
	const client = new OpenAICompatClient({
		apiKey: apiKey || (opts.family === "ollama" ? "ollama" : opts.family === "vllm" ? "vllm" : ""),
		baseUrl,
		model,
	});

	return {
		async *stream(
			messages: ChatMessage[],
			systemPrompt: string,
			tools: ToolDefinition[] | undefined,
			signal?: AbortSignal,
		): AgentStream {
			const request: LLMRequest = {
				messages: messages.map(toNextainMessage),
				model,
			};
			if (systemPrompt) request.system = systemPrompt;
			if (tools && tools.length > 0) request.tools = tools.map(toNextainTool);
			if (signal) request.signal = signal;

			// Reuse adapter's reassembly state pattern (anthropic adapter).
			const toolUseById = new Map<
				string,
				{ id: string; name: string; argsJson: string }
			>();
			const blockKindByIndex = new Map<number, LLMContentBlock["type"]>();

			for await (const chunk of client.stream(request)) {
				const naiaChunk = convertStreamChunk(chunk, toolUseById, blockKindByIndex);
				if (naiaChunk) yield naiaChunk;
			}

			// Synthetic finish — mirror anthropic adapter behaviour for downstream
			// closure symmetry (naia-os agent loop expects `finish` chunk).
			yield { type: "finish" };
		},
	};
}

/** Convert naia-os ToolDefinition → @nextain ToolDefinition. */
function toNextainTool(tool: ToolDefinition): NextainToolDefinition {
	const def: NextainToolDefinition = {
		name: tool.name,
		inputSchema: tool.parameters,
	};
	if (tool.description) def.description = tool.description;
	return def;
}
