/**
 * Nextain Gemini provider adapter — wraps `@nextain/agent-providers`'
 * `GeminiClient` (full @google/genai SDK with thoughtSignature parity).
 *
 * R4 Phase 5 Day 7.1 — Strangler Fig Gemini full parity.
 *
 * Behind opt-in env flags:
 *   - NEXTAIN_AGENT_PROVIDERS=1 (global)
 *   - NEXTAIN_GEMINI=1 (per-provider — Day 5.1)
 *
 * vs Day 4.3.2 OpenAI-compat path:
 *   - OpenAI-compat: thoughtSignature dropped → Gemini 3 thinking-tool degradation
 *   - **본 경로**: full @google/genai SDK + thoughtSignature 보존 + tool_use round-trip
 *
 * Reuses convertStreamChunk + toNextainMessage from anthropic adapter for
 * standard reassembly; thoughtSignature preserved via LLMContentBlock.tool_use.
 */

import { GoogleGenAI } from "@google/genai";
import { GeminiClient } from "@nextain/agent-providers/gemini";
import type {
	LLMContentBlock,
	LLMRequest,
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

export function createNextainGeminiProvider(
	apiKey: string,
	model: string,
): LLMProvider {
	const sdk = new GoogleGenAI({ apiKey });
	const client = new GeminiClient(sdk, { defaultModel: model });

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

			const toolUseById = new Map<
				string,
				{ id: string; name: string; argsJson: string }
			>();
			const blockKindByIndex = new Map<number, LLMContentBlock["type"]>();

			for await (const chunk of client.stream(request)) {
				const naiaChunk = convertStreamChunk(chunk, toolUseById, blockKindByIndex);
				// Day 7.1 — preserve thoughtSignature when emitting tool_use chunks.
				if (naiaChunk?.type === "tool_use" && chunk.type === "content_block_start") {
					const block = chunk.block;
					if (block.type === "tool_use") {
						const sig = (block as { thoughtSignature?: string }).thoughtSignature;
						if (typeof sig === "string") {
							naiaChunk.thoughtSignature = sig;
						}
					}
				}
				if (naiaChunk) yield naiaChunk;
			}

			yield { type: "finish" };
		},
	};
}

function toNextainTool(tool: ToolDefinition): NextainToolDefinition {
	const def: NextainToolDefinition = {
		name: tool.name,
		inputSchema: tool.parameters,
	};
	if (tool.description) def.description = tool.description;
	return def;
}
