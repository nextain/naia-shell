import Anthropic from "@anthropic-ai/sdk";
import type {
	AgentStream,
	ChatMessage,
	LLMProvider,
	ToolDefinition,
} from "./types.js";

function toAnthropicMessages(
	messages: ChatMessage[],
): Anthropic.MessageParam[] {
	const result: Anthropic.MessageParam[] = [];
	for (const m of messages) {
		if (m.toolCalls && m.toolCalls.length > 0) {
			result.push({
				role: "assistant",
				content: m.toolCalls.map((tc) => ({
					type: "tool_use" as const,
					id: tc.id,
					name: tc.name,
					input: tc.args,
				})),
			});
		} else if (m.role === "tool") {
			// Detect base64 image result (from skill_tab_screenshot vision)
			const isImage = m.content.startsWith("data:image/");
			const toolContent: Anthropic.Messages.ToolResultBlockParam["content"] =
				isImage
					? [
							{
								type: "image" as const,
								source: {
									type: "base64" as const,
									media_type: m.content.startsWith("data:image/png")
										? ("image/png" as const)
										: ("image/jpeg" as const),
									data: m.content.replace(/^data:[^;]+;base64,/, ""),
								},
							},
						]
					: m.content;
			result.push({
				role: "user",
				content: [
					{
						type: "tool_result" as const,
						tool_use_id: m.toolCallId!,
						content: toolContent,
					},
				],
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

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Messages.Tool[] {
	return tools.map((t) => ({
		name: t.name,
		description: t.description,
		input_schema: t.parameters as Anthropic.Messages.Tool.InputSchema,
	}));
}

export function createAnthropicProvider(
	apiKey: string,
	model: string,
): LLMProvider {
	const client = new Anthropic({ apiKey });

	return {
		async *stream(messages, systemPrompt, tools, signal): AgentStream {
			const params: Anthropic.MessageCreateParamsStreaming = {
				model,
				max_tokens: 4096,
				temperature: 0.7,
				system: systemPrompt,
				messages: toAnthropicMessages(messages),
				stream: true,
			};
			if (tools && tools.length > 0) {
				params.tools = toAnthropicTools(tools);
			}

			const stream = await client.messages.create(params, {
				signal: signal ?? undefined,
			});

			let inputTokens = 0;
			let outputTokens = 0;
			let currentToolUse: {
				id: string;
				name: string;
				args: string;
			} | null = null;

			for await (const event of stream) {
				// Tool use block start
				if (
					event.type === "content_block_start" &&
					event.content_block.type === "tool_use"
				) {
					currentToolUse = {
						id: event.content_block.id,
						name: event.content_block.name,
						args: "",
					};
				}
				// Tool use input JSON delta
				else if (
					event.type === "content_block_delta" &&
					event.delta.type === "input_json_delta"
				) {
					if (currentToolUse) {
						currentToolUse.args += event.delta.partial_json;
					}
				}
				// Block stop — emit accumulated tool_use
				else if (event.type === "content_block_stop") {
					if (currentToolUse) {
						let args: Record<string, unknown> = {};
						try {
							args = JSON.parse(currentToolUse.args || "{}");
						} catch {
							// malformed JSON — emit empty args
						}
						yield {
							type: "tool_use",
							id: currentToolUse.id,
							name: currentToolUse.name,
							args,
						};
						currentToolUse = null;
					}
				}
				// Text delta
				else if (
					event.type === "content_block_delta" &&
					event.delta.type === "text_delta"
				) {
					yield { type: "text", text: event.delta.text };
				}
				// Usage tracking
				else if (event.type === "message_start" && event.message?.usage) {
					inputTokens = event.message.usage.input_tokens ?? 0;
				} else if (event.type === "message_delta" && event.usage) {
					outputTokens =
						(event.usage as { output_tokens?: number }).output_tokens ?? 0;
				}
			}

			if (inputTokens > 0 || outputTokens > 0) {
				yield { type: "usage", inputTokens, outputTokens };
			}
			yield { type: "finish" };
		},
	};
}
