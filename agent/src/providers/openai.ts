import OpenAI from "openai";
import { sniffTextToolCall, toOpenAIMessages, toOpenAITools } from "./openai-compat.js";
import type { AgentStream, LLMProvider } from "./types.js";

export function createOpenAIProvider(
	apiKey: string,
	model: string,
	localHost?: string,
	enableThinking?: boolean,
): LLMProvider {
	const isOllama = apiKey === "ollama";
	const isVllm = apiKey === "vllm";
	// vllm-omni omni model: MiniCPM-o returns audio in choices[1].message.audio.data
	const isOmni = isVllm && /minicpm[-_]?o/i.test(model);
	const client = new OpenAI({
		apiKey: isOllama ? "ollama" : isVllm ? "vllm" : apiKey,
		baseURL: isOllama
			? `${(localHost || "http://localhost:11434").replace(/\/+$/, "")}/v1`
			: isVllm
				? `${(localHost || "http://localhost:8000").replace(/\/+$/, "")}/v1`
				: undefined,
	});

	return {
		async *stream(messages, systemPrompt, tools, signal): AgentStream {
			// vllm-omni: non-streaming, audio comes in choices[1].message.audio.data
			if (isOmni) {
				const baseUrl = (localHost || "http://localhost:8000").replace(
					/\/+$/,
					"",
				);
				const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: "Bearer vllm",
					},
					body: JSON.stringify({
						model,
						temperature: 0.7,
						messages: toOpenAIMessages(messages, systemPrompt),
						chat_template_kwargs: { use_tts_template: true },
					}),
					signal: signal ?? undefined,
				});
				const data = (await resp.json()) as {
					choices?: Array<{
						message?: { content?: string; audio?: { data?: string } };
					}>;
					usage?: { prompt_tokens?: number; completion_tokens?: number };
				};
				const text = data.choices?.[0]?.message?.content ?? "";
				if (text) yield { type: "text", text };
				const audioData = data.choices?.[1]?.message?.audio?.data;
				if (audioData) yield { type: "audio", data: audioData };
				if (data.usage) {
					yield {
						type: "usage",
						inputTokens: data.usage.prompt_tokens ?? 0,
						outputTokens: data.usage.completion_tokens ?? 0,
					};
				}
				yield { type: "finish" };
				return;
			}
			const body: OpenAI.ChatCompletionCreateParamsStreaming & { think?: boolean } = {
				model,
				temperature: 0.7,
				messages: toOpenAIMessages(
					messages,
					systemPrompt,
				) as OpenAI.ChatCompletionMessageParam[],
				stream: true,
				stream_options: { include_usage: true },
			};
			if (isOllama && enableThinking !== undefined) {
				body.think = enableThinking;
			}
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

		let textBuffer = "";
			let thinkingBuffer = "";

			for await (const chunk of stream) {
				const delta = chunk.choices[0]?.delta as OpenAI.ChatCompletionChunk.Choice.Delta & {
					reasoning_content?: string;
					reasoning?: string;
				};
				if (delta?.content) {
					textBuffer += delta.content;
				}
				// Reasoning field name differs by backend: vLLM/DeepSeek emit
				// `reasoning_content`, Ollama emits `reasoning`. Accept either so
				// thinking is separated instead of leaking into the visible answer.
				const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning;
				if (reasoningDelta) {
					thinkingBuffer += reasoningDelta;
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

			// Strip <eos> tokens leaked by Ollama/Gemma models
			if (isOllama) {
				textBuffer = textBuffer.replace(/<eos>/g, "");
			}
			// Recovery net: small local models (e.g. Ollama qwen3.5:4b) sometimes
			// emit a tool call as plain text instead of a native tool_calls delta.
			// Only consulted when there are no native tool calls; suppresses the
			// JSON from the visible answer when it is promoted to a tool_use.
			const recovered =
				pendingToolCalls.size === 0 && tools && tools.length > 0
					? sniffTextToolCall(textBuffer, tools)
					: null;

			if (thinkingBuffer) {
				yield { type: "thinking", text: thinkingBuffer };
			}
			if (textBuffer && !recovered) {
				yield { type: "text", text: textBuffer };
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

			if (recovered) {
				yield {
					type: "tool_use",
					id: recovered.id,
					name: recovered.name,
					args: recovered.args,
				};
			}

			if (inputTokens > 0 || outputTokens > 0) {
				yield { type: "usage", inputTokens, outputTokens };
			}
			yield { type: "finish" };
		},
	};
}
