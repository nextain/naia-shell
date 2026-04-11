import OpenAI from "openai";
import { toOpenAIMessages, toOpenAITools } from "./openai-compat.js";
import type { AgentStream, LLMProvider } from "./types.js";

export function createZAIProvider(apiKey: string, model: string): LLMProvider {
	const client = new OpenAI({
		baseURL: "https://api.z.ai/api/coding/paas/v4",
		apiKey,
	});

	return {
		async *stream(messages, systemPrompt, tools, signal): AgentStream {
			const body: OpenAI.ChatCompletionCreateParamsStreaming = {
				model,
				temperature: 0.7,
				messages: toOpenAIMessages(
					messages,
					systemPrompt,
				) as OpenAI.ChatCompletionMessageParam[],
				stream: true,
				stream_options: { include_usage: true },
			};
			if (tools && tools.length > 0) {
				body.tools = toOpenAITools(tools) as OpenAI.ChatCompletionTool[];
			}

			const stream = await client.chat.completions.create(body, {
				signal: signal ?? undefined,
			});

			let inputTokens = 0;
			let outputTokens = 0;

			// Accumulate tool call arguments across multiple delta chunks
			const pendingToolCalls = new Map<
				number,
				{ id: string; name: string; args: string }
			>();

			for await (const chunk of stream) {
				const delta = chunk.choices[0]?.delta;
				if (delta?.content) {
					yield { type: "text", text: delta.content };
				}

				// Tool calls — accumulate arguments across chunks
				const toolCalls = delta?.tool_calls;
				if (toolCalls) {
					for (const tc of toolCalls) {
						const existing = pendingToolCalls.get(tc.index);
						if (tc.id && tc.function?.name) {
							pendingToolCalls.set(tc.index, {
								id: tc.id,
								name: tc.function.name,
								args: tc.function.arguments ?? "",
							});
						} else if (existing && tc.function?.arguments) {
							existing.args += tc.function.arguments;
						}
					}
				}

				if (chunk.usage) {
					inputTokens = chunk.usage.prompt_tokens ?? 0;
					outputTokens = chunk.usage.completion_tokens ?? 0;
				}
			}

			// Emit accumulated tool calls
			for (const tc of pendingToolCalls.values()) {
				let args: Record<string, unknown> = {};
				try {
					args = JSON.parse(tc.args || "{}");
				} catch {
					// malformed JSON — emit empty args
				}
				yield { type: "tool_use", id: tc.id, name: tc.name, args };
			}

			if (inputTokens > 0 || outputTokens > 0) {
				yield { type: "usage", inputTokens, outputTokens };
			}
			yield { type: "finish" };
		},
	};
}
