/**
 * Shared OpenAI-compatible message/tool conversion utilities.
 * Used by xai.ts, openai.ts, zai.ts, and lab-proxy.ts.
 */
import type { ChatMessage, ToolDefinition } from "./types.js";

/** OpenAI chat completion message (minimal type for cross-provider use) */
export interface OpenAICompatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
}

/** OpenAI chat completion tool definition */
export interface OpenAICompatTool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

/** Convert ChatMessage[] to OpenAI-compatible message format */
export function toOpenAIMessages(
	messages: ChatMessage[],
	systemPrompt: string,
): OpenAICompatMessage[] {
	const result: OpenAICompatMessage[] = [
		{ role: "system", content: systemPrompt },
	];
	for (const m of messages) {
		if (m.toolCalls && m.toolCalls.length > 0) {
			result.push({
				role: "assistant",
				content: m.content || null,
				tool_calls: m.toolCalls.map((tc) => ({
					id: tc.id,
					type: "function" as const,
					function: {
						name: tc.name,
						arguments: JSON.stringify(tc.args),
					},
				})),
			});
		} else if (m.role === "tool") {
			// Strip base64 image data — OpenAI tool results don't support inline images here
			const content = m.content.startsWith("data:image/")
				? "[screenshot captured — vision not available for this provider]"
				: m.content;
			result.push({
				role: "tool",
				tool_call_id: m.toolCallId!,
				content,
			});
		} else {
			result.push({
				role: m.role as "user" | "assistant",
				content: m.content,
			});
		}
	}
	return result;
}

/** Convert ToolDefinition[] to OpenAI-compatible tool format */
export function toOpenAITools(tools: ToolDefinition[]): OpenAICompatTool[] {
	return tools.map((t) => ({
		type: "function" as const,
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters as Record<string, unknown>,
		},
	}));
}
