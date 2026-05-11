/**
 * Nextain Claude-CLI provider adapter — wraps `@nextain/agent-providers`'
 * `ClaudeCliClient` (subprocess spawn) behind naia-os' local `LLMProvider` shape.
 *
 * R4 Phase 4.1 Day 4.3.3 — Strangler Fig horizontal expansion (Claude-CLI family).
 *
 * Behind the same opt-in env flag:
 *   `NEXTAIN_AGENT_PROVIDERS=1`
 *
 * Limitations (Day 4.3.3 minimal):
 *   - No Flatpak `flatpak-spawn --host` wrap (use native fallback in Flatpak)
 *   - No Windows .cmd shim resolution
 *   - No partial-JSON recovery across chunk boundaries
 *   - System-prompt-file fallback (>64KB) deferred — short prompts only
 * For full feature parity, leave NEXTAIN_AGENT_PROVIDERS unset → native
 * createClaudeCodeCliProvider (460 LOC).
 */

import { ClaudeCliClient } from "@nextain/agent-providers/claude-cli";
import type {
	LLMContentBlock,
	LLMMessage,
	LLMRequest,
	LLMStreamChunk,
} from "@nextain/agent-types";

import type { AgentStream, ChatMessage, LLMProvider } from "../types.js";
import {
	convertStreamChunk,
	toNextainMessage,
} from "./nextain-provider-adapter.js";

export function createNextainClaudeCliProvider(model: string): LLMProvider {
	const client = new ClaudeCliClient({ defaultModel: model });

	return {
		async *stream(
			messages: ChatMessage[],
			systemPrompt: string,
			_tools: unknown,
			signal?: AbortSignal,
		): AgentStream {
			// Note: Claude Code CLI does not accept caller-supplied tools list
			// (uses --disallowedTools to suppress its own). LLMRequest.tools is
			// dropped here — naia-os tool execution remains via its own dispatch.
			const request: LLMRequest = {
				messages: messages.map(toNextainMessage),
				model,
			};
			if (systemPrompt) request.system = systemPrompt;
			if (signal) request.signal = signal;

			// Reuse adapter reassembly state (matches anthropic adapter pattern).
			const toolUseById = new Map<
				string,
				{ id: string; name: string; argsJson: string }
			>();
			const blockKindByIndex = new Map<number, LLMContentBlock["type"]>();

			for await (const chunk of client.stream(request)) {
				const naiaChunk = convertStreamChunk(chunk, toolUseById, blockKindByIndex);
				if (naiaChunk) yield naiaChunk;
			}

			yield { type: "finish" };
		},
	};
}
