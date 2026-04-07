/**
 * Lab Proxy Provider — routes LLM calls through any-llm Gateway (GCP).
 * Uses OpenAI-compatible chat completions API with X-AnyLLM-Key auth.
 */
import { toOpenAIMessages, toOpenAITools } from "./openai-compat.js";
import type { AgentStream, LLMProvider, StreamChunk } from "./types.js";

export const PROD_GATEWAY_URL =
	"https://naia-gateway-181404717065.asia-northeast3.run.app";

/** @deprecated Use the gatewayUrl parameter instead */
export const GATEWAY_URL =
	process.env.NAIA_GATEWAY_URL ?? PROD_GATEWAY_URL;

/** Map local model names to gateway format (provider:model) */
function toGatewayModel(model: string): string {
	// Live API models are WebSocket-only — fall back to the equivalent text model for SSE chat.
	if (model === "gemini-2.5-flash-live") return "vertexai:gemini-2.5-flash";
	if (model === "gemini-3.1-flash-live-preview")
		return "vertexai:gemini-3-flash-preview";
	// Gateway uses Vertex AI service account (not GEMINI_API_KEY) — must use vertexai: prefix.
	if (model.startsWith("gemini")) return `vertexai:${model}`;
	if (model.startsWith("grok")) return `xai:${model}`;
	if (model.startsWith("claude")) return `anthropic:${model}`;
	return model;
}

export function createLabProxyProvider(
	naiaKey: string,
	model: string,
	gatewayUrl?: string,
): LLMProvider {
	const resolvedGatewayUrl = gatewayUrl ?? GATEWAY_URL;
	return {
		async *stream(messages, systemPrompt, tools, signal): AgentStream {
			if (!resolvedGatewayUrl.startsWith("https://")) {
				throw new Error(
					`Lab proxy: rejecting non-HTTPS gateway URL "${resolvedGatewayUrl}" - naiaKey credential must only be sent over HTTPS.`,
				);
			}
			const body: Record<string, unknown> = {
				model: toGatewayModel(model),
				messages: toOpenAIMessages(messages, systemPrompt),
				stream: true,
				stream_options: { include_usage: true },
			};
			if (tools && tools.length > 0) {
				body.tools = toOpenAITools(tools);
			}

			const res = await fetch(`${resolvedGatewayUrl}/v1/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AnyLLM-Key": `Bearer ${naiaKey}`,
				},
				body: JSON.stringify(body),
				signal,
			});

			if (!res.ok) {
				const errText = await res.text().catch(() => "");
				throw new Error(
					`Lab proxy error ${res.status}: ${errText.slice(0, 200)}`,
				);
			}

			if (!res.body) {
				throw new Error("Lab proxy: no response body");
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let totalInput = 0;
			let totalOutput = 0;
			let bytesReceived = 0; // detect silent gateway errors (0-byte SSE streams)

			// Accumulate tool call arguments across multiple SSE chunks
			const pendingToolCalls = new Map<
				number,
				{ id: string; name: string; args: string }
			>();

			try {
				outer: while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					bytesReceived += value.byteLength;
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed.startsWith("data: ")) continue;
						const data = trimmed.slice(6);
						// Break out of the outer read loop — gateway may keep HTTP connection
						// open after [DONE], causing reader.read() to hang indefinitely.
						if (data === "[DONE]") break outer;

						let parsed: Record<string, unknown>;
						try {
							parsed = JSON.parse(data);
						} catch {
							continue;
						}

						const choices = parsed.choices as
							| { delta?: Record<string, unknown> }[]
							| undefined;
						if (!choices?.[0]?.delta) continue;
						const delta = choices[0].delta;

						// Text content
						if (delta.content && typeof delta.content === "string") {
							yield { type: "text", text: delta.content } satisfies StreamChunk;
						}

						// Tool calls — accumulate arguments across chunks
						const toolCalls = delta.tool_calls as
							| {
									index: number;
									id?: string;
									function?: { name?: string; arguments?: string };
							  }[]
							| undefined;
						if (toolCalls) {
							for (const tc of toolCalls) {
								const existing = pendingToolCalls.get(tc.index);
								if (!existing) {
									// First chunk for this index: register immediately with whatever fields arrived.
									// id/name may be absent and arrive in later chunks (see #218).
									pendingToolCalls.set(tc.index, {
										id: tc.id ?? "",
										name: tc.function?.name ?? "",
										args: tc.function?.arguments ?? "",
									});
								} else {
									// Continuation chunk — patch fields only if not yet populated
									// (id/name: first-write-wins to guard against malformed duplicate indexes)
									if (tc.id && !existing.id) existing.id = tc.id;
									if (tc.function?.name && !existing.name) existing.name = tc.function.name;
									if (tc.function?.arguments) existing.args += tc.function.arguments;
								}
							}
						}

						// Usage info
						const usage = parsed.usage as
							| {
									prompt_tokens?: number;
									completion_tokens?: number;
							  }
							| undefined;
						if (usage) {
							totalInput = usage.prompt_tokens ?? totalInput;
							totalOutput = usage.completion_tokens ?? totalOutput;
						}
					}
				}
			} finally {
				reader.releaseLock();
			}

			// Gateway streaming bug: 200 OK with 0-byte body means a silent backend error.
			// Non-streaming returns 500 with the real error; streaming swallows it.
			if (bytesReceived === 0) {
				throw new Error(
					`Lab proxy: empty SSE stream for model "${model}" — gateway may lack credentials for this provider. Try non-Naia route instead.`,
				);
			}

			// Emit accumulated tool calls (skip incomplete entries missing id or name)
			for (const tc of pendingToolCalls.values()) {
				if (!tc.id || !tc.name) continue;
				let args: Record<string, unknown> = {};
				try {
					args = JSON.parse(tc.args || "{}");
				} catch {
					// malformed JSON — emit empty args
				}
				yield {
					type: "tool_use",
					id: tc.id,
					name: tc.name,
					args,
				} satisfies StreamChunk;
			}

			// Emit usage
			if (totalInput > 0 || totalOutput > 0) {
				yield {
					type: "usage",
					inputTokens: totalInput,
					outputTokens: totalOutput,
				} satisfies StreamChunk;
			}

			yield { type: "finish" } satisfies StreamChunk;
		},
	};
}
