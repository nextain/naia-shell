/**
 * Lab Proxy Provider — routes LLM calls through any-llm Gateway (GCP).
 * Uses OpenAI-compatible chat completions API with X-AnyLLM-Key auth.
 */
import {
	type OpenAICompatMessage,
	type OpenAICompatTool,
	toOpenAIMessages,
	toOpenAITools,
} from "./openai-compat.js";
import type { AgentStream, LLMProvider, StreamChunk } from "./types.js";

export const PROD_GATEWAY_URL =
	"https://naia-gateway-181404717065.asia-northeast3.run.app";
const LAB_PROXY_MAX_TOKENS = 4096;

/** Resolved gateway URL from environment or default prod URL */
export const GATEWAY_URL = process.env.NAIA_GATEWAY_URL || PROD_GATEWAY_URL;

/** Map local model names to gateway format (provider:model) */
function toGatewayModel(model: string): string {
	// Live API models are WebSocket-only — fall back to the equivalent text model for SSE chat.
	if (model === "gemini-2.5-flash-live") return "vertexai:gemini-2.5-flash";
	// gemini-3.1-flash-live-preview previously fell back to vertexai:gemini-3-flash-preview,
	// but the gateway's GCP project does not have access to any gemini-3.x model (#248).
	// Route this live model to the same SSE fallback as gemini-2.5-flash-live.
	if (model === "gemini-3.1-flash-live-preview")
		return "vertexai:gemini-2.5-flash";
	// Gateway uses Vertex AI service account (not GEMINI_API_KEY) — must use vertexai: prefix.
	if (model.startsWith("gemini")) return `vertexai:${model}`;
	if (model.startsWith("grok")) return `xai:${model}`;
	if (model.startsWith("claude")) return `anthropic:${model}`;
	return model;
}

type PendingToolCall = { id: string; name: string; args: string };

interface BufferedLabStream {
	chunks: StreamChunk[];
	bytesReceived: number;
	sawDone: boolean;
	inputTokens: number;
	outputTokens: number;
	finishReasons: string[];
	pendingToolCalls: Map<number, PendingToolCall>;
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

			const baseMessages = toOpenAIMessages(messages, systemPrompt);
			const gatewayModel = toGatewayModel(model);
			const gatewayTools =
				tools && tools.length > 0 ? toOpenAITools(tools) : undefined;

			const streamBody: Record<string, unknown> = {
				model: gatewayModel,
				messages: baseMessages,
				max_tokens: LAB_PROXY_MAX_TOKENS,
				stream: true,
				stream_options: { include_usage: true },
			};
			if (gatewayTools) streamBody.tools = gatewayTools;

			const first = await fetchBufferedStream(
				resolvedGatewayUrl,
				naiaKey,
				streamBody,
				signal,
			);

			if (first.bytesReceived === 0) {
				throw new Error(
					`Lab proxy: gateway returned 0 bytes for model "${model}". This typically means the gateway's GCP project lacks Vertex AI access to that model. Try a gemini-2.5-* model on the Naia provider, or switch to the "Google Gemini" provider (direct API key) for gemini-3.x access.`,
				);
			}

			const completed =
				first.sawDone && !isIncompleteCompletion(first)
					? first
					: (await recoverClosedStream(
							resolvedGatewayUrl,
							naiaKey,
							gatewayModel,
							baseMessages,
							gatewayTools,
							signal,
						)) || (hasUsableOutput(first) ? first : null);

			if (!completed) {
				throw new Error(
					"Lab proxy: stream ended before [DONE]. The response may have been truncated.",
				);
			}

			for (const chunk of completed.chunks) {
				yield chunk;
			}

			// Emit accumulated tool calls (skip incomplete entries missing id or name)
			for (const tc of completed.pendingToolCalls.values()) {
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

			if (completed.inputTokens > 0 || completed.outputTokens > 0) {
				yield {
					type: "usage",
					inputTokens: completed.inputTokens,
					outputTokens: completed.outputTokens,
				} satisfies StreamChunk;
			}

			yield { type: "finish" } satisfies StreamChunk;
		},
	};
}

async function fetchBufferedStream(
	resolvedGatewayUrl: string,
	naiaKey: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<BufferedLabStream> {
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
		throw new Error(`Lab proxy error ${res.status}: ${errText.slice(0, 200)}`);
	}

	if (!res.body) {
		throw new Error("Lab proxy: no response body");
	}

	const result: BufferedLabStream = {
		chunks: [],
		bytesReceived: 0,
		sawDone: false,
		inputTokens: 0,
		outputTokens: 0,
		finishReasons: [],
		pendingToolCalls: new Map(),
	};
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const processData = (data: string) => {
		if (data === "[DONE]") {
			result.sawDone = true;
			return;
		}

		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(data);
		} catch {
			return;
		}

		// Usage may arrive on an SSE event without a delta payload.
		const usage = parsed.usage as
			| {
					prompt_tokens?: number;
					completion_tokens?: number;
			  }
			| undefined;
		if (usage) {
			result.inputTokens = usage.prompt_tokens ?? result.inputTokens;
			result.outputTokens = usage.completion_tokens ?? result.outputTokens;
		}

		const choices = parsed.choices as
			| { delta?: Record<string, unknown>; finish_reason?: unknown }[]
			| undefined;
		for (const choice of choices ?? []) {
			if (typeof choice.finish_reason === "string") {
				result.finishReasons.push(choice.finish_reason);
			}
		}
		const delta = choices?.[0]?.delta;
		if (!delta) return;

		if (delta.content && typeof delta.content === "string") {
			result.chunks.push({ type: "text", text: delta.content });
		}

		const toolCalls = delta.tool_calls as
			| {
					index: number;
					id?: string;
					function?: { name?: string; arguments?: string };
			  }[]
			| undefined;
		if (toolCalls) {
			for (const tc of toolCalls) {
				const existing = result.pendingToolCalls.get(tc.index);
				if (!existing) {
					// First chunk for this index: register immediately with whatever fields arrived.
					// id/name may be absent and arrive in later chunks (see #218).
					result.pendingToolCalls.set(tc.index, {
						id: tc.id ?? "",
						name: tc.function?.name ?? "",
						args: tc.function?.arguments ?? "",
					});
				} else {
					// Continuation chunk — patch fields only if not yet populated
					// (id/name: first-write-wins to guard against malformed duplicate indexes)
					if (tc.id && !existing.id) existing.id = tc.id;
					if (tc.function?.name && !existing.name)
						existing.name = tc.function.name;
					if (tc.function?.arguments) existing.args += tc.function.arguments;
				}
			}
		}
	};

	function processLine(line: string) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data: ")) return;
		processData(trimmed.slice(6));
	}

	try {
		outer: while (true) {
			const { done, value } = await reader.read();
			if (done) {
				buffer += decoder.decode();
				break;
			}

			result.bytesReceived += value.byteLength;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				processLine(line);
				// Break out of the outer read loop — gateway may keep HTTP connection
				// open after [DONE], causing reader.read() to hang indefinitely.
				if (result.sawDone) break outer;
			}
		}
	} finally {
		reader.releaseLock();
	}

	// Some gateways close the body after a final `data:` line without a
	// trailing newline. Process that residual line so the last event is not
	// silently dropped mid-word.
	if (!result.sawDone && buffer.trim()) {
		for (const line of buffer.split("\n")) {
			processLine(line);
			if (result.sawDone) break;
		}
	}

	return result;
}

async function recoverClosedStream(
	resolvedGatewayUrl: string,
	naiaKey: string,
	gatewayModel: string,
	baseMessages: OpenAICompatMessage[],
	gatewayTools: OpenAICompatTool[] | undefined,
	signal?: AbortSignal,
): Promise<BufferedLabStream | null> {
	const nonStreaming = await fetchNonStreamingCompletion(
		resolvedGatewayUrl,
		naiaKey,
		gatewayModel,
		baseMessages,
		gatewayTools,
		signal,
	);
	if (nonStreaming) return nonStreaming;

	const retryBody: Record<string, unknown> = {
		model: gatewayModel,
		messages: baseMessages,
		max_tokens: LAB_PROXY_MAX_TOKENS,
		stream: true,
		stream_options: { include_usage: true },
	};
	if (gatewayTools) retryBody.tools = gatewayTools;

	const retry = await fetchBufferedStream(
		resolvedGatewayUrl,
		naiaKey,
		retryBody,
		signal,
	);
	if (retry.sawDone && !isIncompleteCompletion(retry)) return retry;
	return hasUsableOutput(retry) ? retry : null;
}

async function fetchNonStreamingCompletion(
	resolvedGatewayUrl: string,
	naiaKey: string,
	gatewayModel: string,
	baseMessages: OpenAICompatMessage[],
	gatewayTools: OpenAICompatTool[] | undefined,
	signal?: AbortSignal,
): Promise<BufferedLabStream | null> {
	const body: Record<string, unknown> = {
		model: gatewayModel,
		messages: baseMessages,
		max_tokens: LAB_PROXY_MAX_TOKENS,
		stream: false,
	};
	if (gatewayTools) body.tools = gatewayTools;

	const res = await fetch(`${resolvedGatewayUrl}/v1/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-AnyLLM-Key": `Bearer ${naiaKey}`,
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!res.ok) return null;
	const parsed = (await res.json().catch(() => null)) as {
		choices?: Array<{
			message?: {
				content?: unknown;
				tool_calls?: Array<{
					index?: number;
					id?: string;
					function?: { name?: string; arguments?: string };
				}>;
			};
		}>;
		usage?: { prompt_tokens?: number; completion_tokens?: number };
	} | null;
	const message = parsed?.choices?.[0]?.message;
	if (!message) return null;

	const result: BufferedLabStream = {
		chunks: [],
		bytesReceived: 1,
		sawDone: true,
		inputTokens: parsed?.usage?.prompt_tokens ?? 0,
		outputTokens: parsed?.usage?.completion_tokens ?? 0,
		finishReasons: [],
		pendingToolCalls: new Map(),
	};

	const content = extractTextContent(message.content);
	if (content) result.chunks.push({ type: "text", text: content });

	for (const tc of message.tool_calls ?? []) {
		const index = tc.index ?? result.pendingToolCalls.size;
		result.pendingToolCalls.set(index, {
			id: tc.id ?? "",
			name: tc.function?.name ?? "",
			args: tc.function?.arguments ?? "",
		});
	}

	if (result.chunks.length === 0 && result.pendingToolCalls.size === 0)
		return null;
	return result;
}

function isIncompleteCompletion(result: BufferedLabStream): boolean {
	return result.finishReasons.some((reason) =>
		["length", "max_tokens", "content_filter"].includes(reason),
	);
}

function hasUsableOutput(result: BufferedLabStream): boolean {
	if (
		result.chunks.some((chunk) => chunk.type === "text" && chunk.text.trim())
	) {
		return true;
	}
	for (const tc of result.pendingToolCalls.values()) {
		if (tc.id && tc.name) return true;
	}
	return false;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (!part || typeof part !== "object") return "";
			const maybeText = (part as { text?: unknown }).text;
			return typeof maybeText === "string" ? maybeText : "";
		})
		.join("");
}
