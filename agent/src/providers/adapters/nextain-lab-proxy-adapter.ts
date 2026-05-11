/**
 * Nextain Lab-Proxy provider adapter — wraps `@nextain/agent-providers`'
 * `LabProxyClient` (Naia Lab Gateway / any-llm proxy) behind naia-os'
 * local `LLMProvider` shape.
 *
 * R4 Phase 4.1 Day 4.3.4 — Strangler Fig horizontal expansion (Lab-Proxy family).
 *
 * Behind the same opt-in env flag:
 *   `NEXTAIN_AGENT_PROVIDERS=1`
 *
 * Auth: naiaKey → X-AnyLLM-Key Bearer header (HTTPS-enforced by client).
 *
 * Wire format: OpenAI-compat /v1/chat/completions SSE — true streaming
 * (LabProxyClient progressively yields content_block_delta chunks, unlike
 * OpenAICompatClient's non-streaming fake-stream).
 *
 * Reuses convertStreamChunk + toNextainMessage from anthropic adapter for
 * LLMStreamChunk → naia-os StreamChunk reassembly.
 */

import {
	LabProxyClient,
	LAB_PROXY_DEFAULT_GATEWAY_URL,
} from "@nextain/agent-providers/lab-proxy";
import type {
	LLMContentBlock,
	LLMRequest,
} from "@nextain/agent-types";

import type { AgentStream, ChatMessage, LLMProvider, ToolDefinition } from "../types.js";
import {
	convertStreamChunk,
	toNextainMessage,
} from "./nextain-provider-adapter.js";

export function createNextainLabProxyProvider(
	naiaKey: string,
	model: string,
	gatewayUrl?: string,
): LLMProvider {
	const resolvedUrl = gatewayUrl ?? LAB_PROXY_DEFAULT_GATEWAY_URL;
	const client = new LabProxyClient({
		naiaKey,
		gatewayUrl: resolvedUrl,
		defaultModel: model,
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
			if (tools && tools.length > 0) {
				request.tools = tools.map((t) => {
					const def: { name: string; description?: string; inputSchema: Record<string, unknown> } = {
						name: t.name,
						inputSchema: t.parameters,
					};
					if (t.description) def.description = t.description;
					return def;
				});
			}
			if (signal) request.signal = signal;

			const toolUseById = new Map<
				string,
				{ id: string; name: string; argsJson: string }
			>();
			const blockKindByIndex = new Map<number, LLMContentBlock["type"]>();

			for await (const chunk of client.stream(request)) {
				const naiaChunk = convertStreamChunk(chunk, toolUseById, blockKindByIndex);
				if (naiaChunk) yield naiaChunk;
			}

			yield { type: "finish" };
		},
	};
}
