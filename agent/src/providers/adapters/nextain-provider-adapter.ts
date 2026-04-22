/**
 * Nextain provider adapter — wraps `@nextain/agent-providers`' `AnthropicClient`
 * (which implements `@nextain/agent-types` `LLMClient`) behind naia-os'
 * local `LLMProvider` shape.
 *
 * Phase 2 X1 integration point. Behind an opt-in env flag so the
 * existing native `./anthropic.ts` path stays default during the
 * Strangler Fig observation window (plan A.9 / docs/migration/X1-providers.md).
 *
 * Direction of conversion:
 *
 *   naia-os ChatMessage[]  →  @nextain LLMRequest  →  Anthropic SDK
 *   Anthropic SDK stream   →  @nextain LLMStreamChunk  →  naia-os StreamChunk
 *
 * Only the shapes that naia-os actually uses today are mapped; if
 * @nextain emits a block type that naia-os cannot render (e.g. image
 * blocks in the response), it is dropped at this boundary with a warn.
 */

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicClient } from "@nextain/agent-providers/anthropic";
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

/** Factory matching the naia-os registry contract. */
export function createNextainAnthropicProvider(
	apiKey: string,
	model: string,
): LLMProvider {
	const sdk = new Anthropic({ apiKey });
	const client = new AnthropicClient(sdk, { defaultModel: model });

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

			// State for reassembling streaming content into naia-os' chunk
			// vocabulary. @nextain emits content_block_* events; naia-os
			// wants a flat stream of text/thinking/tool_use/usage/finish.
			const toolUseById = new Map<
				string,
				{ id: string; name: string; argsJson: string }
			>();
			const blockKindByIndex = new Map<number, LLMContentBlock["type"]>();

			for await (const chunk of client.stream(request)) {
				const naiaChunk = convertStreamChunk(chunk, toolUseById, blockKindByIndex);
				if (naiaChunk) yield naiaChunk;
			}

			// The stream ended; surface a `finish` so downstream sees
			// closure symmetry with native providers.
			yield { type: "finish" };
		},
	};
}

/** @internal — exported for unit tests. */
export function toNextainMessage(msg: ChatMessage): LLMMessage {
	// naia-os ChatMessage has tool calls attached to an assistant turn via
	// `toolCalls`, and tool results via a role="tool" + toolCallId. Map
	// both into @nextain's LLMContentBlock representation.
	if (msg.toolCalls && msg.toolCalls.length > 0) {
		const content: LLMContentBlock[] = msg.toolCalls.map((tc) => ({
			type: "tool_use",
			id: tc.id,
			name: tc.name,
			input: tc.args,
		}));
		if (msg.content) content.unshift({ type: "text", text: msg.content });
		return { role: "assistant", content };
	}
	if (msg.role === "tool") {
		const toolCallId = msg.toolCallId ?? "";
		const m: LLMMessage = {
			role: "tool",
			content: [{ type: "tool_result", toolCallId, content: msg.content }],
			toolCallId,
		};
		return m;
	}
	return { role: msg.role, content: msg.content };
}

function toNextainTool(tool: ToolDefinition): NextainToolDefinition {
	const def: NextainToolDefinition = {
		name: tool.name,
		inputSchema: tool.parameters,
	};
	if (tool.description) def.description = tool.description;
	return def;
}

/**
 * Translate one @nextain LLMStreamChunk into a naia-os StreamChunk.
 * Maintains reassembly state across calls via the injected maps.
 * Returns `null` when the chunk is informational-only (e.g.
 * content_block_start that is accumulated but not directly yielded).
 */
/** @internal — exported for unit tests. */
export function convertStreamChunk(
	chunk: LLMStreamChunk,
	toolUseById: Map<string, { id: string; name: string; argsJson: string }>,
	blockKindByIndex: Map<number, LLMContentBlock["type"]>,
): Awaited<ReturnType<AgentStream["next"]>>["value"] | null {
	switch (chunk.type) {
		case "start":
			return null;
		case "content_block_start": {
			blockKindByIndex.set(chunk.index, chunk.block.type);
			if (chunk.block.type === "tool_use") {
				toolUseById.set(String(chunk.index), {
					id: chunk.block.id,
					name: chunk.block.name,
					argsJson: "",
				});
			}
			return null;
		}
		case "content_block_delta": {
			const kind = blockKindByIndex.get(chunk.index);
			if (chunk.delta.type === "text_delta" && kind === "text") {
				return { type: "text", text: chunk.delta.text };
			}
			if (chunk.delta.type === "thinking_delta" && kind === "thinking") {
				return { type: "thinking", text: chunk.delta.thinking };
			}
			if (chunk.delta.type === "input_json_delta" && kind === "tool_use") {
				const tu = toolUseById.get(String(chunk.index));
				if (tu) tu.argsJson += chunk.delta.partialJson;
			}
			return null;
		}
		case "content_block_stop": {
			const kind = blockKindByIndex.get(chunk.index);
			if (kind === "tool_use") {
				const tu = toolUseById.get(String(chunk.index));
				if (tu) {
					let parsed: Record<string, unknown> = {};
					try {
						parsed = tu.argsJson ? JSON.parse(tu.argsJson) : {};
					} catch {
						// Leave parsed = {} and let the agent loop report a tool error.
					}
					toolUseById.delete(String(chunk.index));
					return { type: "tool_use", id: tu.id, name: tu.name, args: parsed };
				}
			}
			return null;
		}
		case "usage": {
			if (chunk.usage.inputTokens !== undefined && chunk.usage.outputTokens !== undefined) {
				return {
					type: "usage",
					inputTokens: chunk.usage.inputTokens,
					outputTokens: chunk.usage.outputTokens,
				};
			}
			return null;
		}
		case "end": {
			return {
				type: "usage",
				inputTokens: chunk.usage.inputTokens,
				outputTokens: chunk.usage.outputTokens,
			};
		}
		default:
			return null;
	}
}
