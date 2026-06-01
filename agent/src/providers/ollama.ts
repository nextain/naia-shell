/**
 * Native Ollama provider — talks to `/api/chat` instead of the OpenAI-compatible
 * `/v1/chat/completions` endpoint.
 *
 * Why a separate path: Ollama's OpenAI-compat endpoint IGNORES `num_ctx` (both
 * top-level and inside `options`), so it always loads the model at the runtime
 * default of 4096 tokens. That silently truncates multi-turn history (the model
 * "forgets" earlier turns). Only the native `/api/chat` `options.num_ctx`
 * actually resizes the context window. This provider also normalizes Ollama's
 * `message.thinking` (reasoning) and object-valued `tool_calls.arguments` into
 * the shared StreamChunk shape.
 *
 * Designed to be self-contained so it can move to naia-agent with the rest of
 * the conversation runtime later.
 */
import { sniffTextToolCall } from "./openai-compat.js";
import type { AgentStream, ChatMessage, LLMProvider, ToolDefinition } from "./types.js";

/**
 * Default context window for the native path. Ollama's own default (4096) is too
 * small for multi-turn chat once the (large) system prompt + tool guides are
 * included. 32K fits comfortably for the 4B/8B local models we ship and stays
 * well within their real capacity (qwen3.5:4b = 262K, gemma4 = 131K).
 */
const DEFAULT_NUM_CTX = 32_768;

interface OllamaMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
	tool_name?: string;
}

/** Convert ChatMessage[] to Ollama native /api/chat message format. */
export function toOllamaMessages(
	messages: ChatMessage[],
	systemPrompt: string,
): OllamaMessage[] {
	const result: OllamaMessage[] = [{ role: "system", content: systemPrompt }];
	for (const m of messages) {
		if (m.toolCalls && m.toolCalls.length > 0) {
			result.push({
				role: "assistant",
				content: m.content || "",
				// Native /api/chat expects arguments as an object (not a JSON string).
				tool_calls: m.toolCalls.map((tc) => ({
					function: { name: tc.name, arguments: tc.args },
				})),
			});
		} else if (m.role === "tool") {
			// Strip base64 image data — native tool results are text here.
			const content = m.content.startsWith("data:image/")
				? "[screenshot captured — vision not available for this provider]"
				: m.content;
			result.push({ role: "tool", content, tool_name: m.name });
		} else {
			result.push({ role: m.role as "user" | "assistant", content: m.content });
		}
	}
	return result;
}

/** Convert ToolDefinition[] to Ollama native tool format. */
export function toOllamaTools(tools: ToolDefinition[]) {
	return tools.map((t) => ({
		type: "function" as const,
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		},
	}));
}

interface OllamaChatChunk {
	message?: {
		content?: string;
		thinking?: string;
		tool_calls?: Array<{
			function?: { name?: string; arguments?: Record<string, unknown> | string };
		}>;
	};
	done?: boolean;
	prompt_eval_count?: number;
	eval_count?: number;
}

export function createOllamaProvider(
	model: string,
	localHost?: string,
	enableThinking?: boolean,
	numCtx?: number,
): LLMProvider {
	const baseUrl = (localHost || "http://localhost:11434").replace(/\/+$/, "");

	return {
		async *stream(messages, systemPrompt, tools, signal): AgentStream {
			const body: Record<string, unknown> = {
				model,
				messages: toOllamaMessages(messages, systemPrompt),
				stream: true,
				options: {
					temperature: 0.7,
					num_ctx: numCtx ?? DEFAULT_NUM_CTX,
				},
			};
			// Only send `think` when explicitly set — passing it to a model that
			// doesn't support thinking can error on some Ollama versions.
			if (enableThinking !== undefined) body.think = enableThinking;
			if (tools && tools.length > 0) body.tools = toOllamaTools(tools);

			const resp = await fetch(`${baseUrl}/api/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: signal ?? undefined,
			});
			if (!resp.ok || !resp.body) {
				throw new Error(
					`Ollama /api/chat failed: ${resp.status} ${resp.statusText}`,
				);
			}

			const reader = resp.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let textBuffer = "";
			let thinkingBuffer = "";
			const pendingToolCalls: {
				id: string;
				name: string;
				args: Record<string, unknown>;
			}[] = [];
			let inputTokens = 0;
			let outputTokens = 0;
			let toolCallSeq = 0;

			const handleLine = (line: string): void => {
				const trimmed = line.trim();
				if (!trimmed) return;
				let evt: OllamaChatChunk;
				try {
					evt = JSON.parse(trimmed) as OllamaChatChunk;
				} catch {
					return; // skip malformed NDJSON line
				}
				const msg = evt.message;
				if (msg?.content) textBuffer += msg.content;
				if (msg?.thinking) thinkingBuffer += msg.thinking;
				if (msg?.tool_calls) {
					for (const tc of msg.tool_calls) {
						const fn = tc.function;
						if (!fn?.name) continue;
						let args: Record<string, unknown> = {};
						if (typeof fn.arguments === "string") {
							try {
								args = JSON.parse(fn.arguments || "{}");
							} catch {
								args = {};
							}
						} else if (fn.arguments) {
							args = fn.arguments;
						}
						pendingToolCalls.push({
							id: `call_ollama_${toolCallSeq++}`,
							name: fn.name,
							args,
						});
					}
				}
				if (evt.done) {
					inputTokens = evt.prompt_eval_count ?? 0;
					outputTokens = evt.eval_count ?? 0;
				}
			};

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let nl: number;
				// biome-ignore lint/suspicious/noAssignInExpressions: standard NDJSON split
				while ((nl = buffer.indexOf("\n")) !== -1) {
					handleLine(buffer.slice(0, nl));
					buffer = buffer.slice(nl + 1);
				}
			}
			if (buffer) handleLine(buffer); // trailing line without newline

			// Strip <eos> tokens leaked by some Ollama/Gemma models.
			textBuffer = textBuffer.replace(/<eos>/g, "");

			// Recovery net: small models sometimes emit the tool call as plain
			// text instead of a native tool_calls field. Only when none were
			// parsed; suppress the JSON text if it is promoted to a tool_use.
			const recovered =
				pendingToolCalls.length === 0 && tools && tools.length > 0
					? sniffTextToolCall(textBuffer, tools)
					: null;

			if (thinkingBuffer) {
				yield { type: "thinking", text: thinkingBuffer };
			}
			if (textBuffer && !recovered) {
				yield { type: "text", text: textBuffer };
			}
			for (const tc of pendingToolCalls) {
				yield { type: "tool_use", id: tc.id, name: tc.name, args: tc.args };
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
