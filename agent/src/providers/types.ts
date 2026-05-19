/** Provider ID — extensible via registry. */
export type ProviderId = string;

export interface ProviderConfig {
	provider: ProviderId;
	model: string;
	/**
	 * @deprecated Send via `creds_update` instead (#260 follow-up).
	 * Still accepted for older shells that haven't migrated; new builds
	 * MUST NOT populate this. Will be removed once all callers migrate.
	 */
	apiKey?: string;
	/** @deprecated Use auth_update instead — see factory.ts setAgentNaiaKey. */
	naiaKey?: string;
	ollamaHost?: string;
	vllmHost?: string;
	/** Override URL for lab-proxy (Naia gateway). Passed directly from chat request. */
	labGatewayUrl?: string;
}

/** Tool call info returned by LLM function calling */
export interface ToolCallInfo {
	id: string;
	name: string;
	args: Record<string, unknown>;
	/** Gemini 3 thought signature — must be echoed back for tool calling to work */
	thoughtSignature?: string;
}

/** Chat message types including tool call/result messages */
export interface ChatMessage {
	role: "user" | "assistant" | "tool";
	content: string;
	toolCalls?: ToolCallInfo[];
	toolCallId?: string;
	name?: string;
}

/** Tool definition for LLM function calling */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** Chunk types emitted by a provider stream */
export type StreamChunk =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| {
			type: "tool_use";
			id: string;
			name: string;
			args: Record<string, unknown>;
			thoughtSignature?: string;
	  }
	| {
			type: "usage";
			inputTokens: number;
			outputTokens: number;
	  }
	| { type: "finish" }
	/** Emitted by omni providers (e.g. vllm-omni MiniCPM-o) that return audio inline */
	| { type: "audio"; data: string };

/** Async generator that yields streaming chunks */
export type AgentStream = AsyncGenerator<StreamChunk, void, undefined>;

/** Provider interface — each LLM provider implements this */
export interface LLMProvider {
	stream(
		messages: ChatMessage[],
		systemPrompt: string,
		tools?: ToolDefinition[],
		signal?: AbortSignal,
	): AgentStream;
}
