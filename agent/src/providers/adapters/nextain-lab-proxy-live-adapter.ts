/**
 * Nextain Lab-Proxy Live API adapter — wraps `@nextain/agent-providers`'
 * `LabProxyLiveClient` (Naia Lab Gateway WebSocket).
 *
 * R4 Phase 5 Day 7.2 — Lab-proxy live API wire.
 *
 * Coexistence policy (Phase 4.4 spec LOCK):
 *   - **gemini_live.rs** (Tauri Rust direct, Phase 5 production) = native path
 *   - **LabProxyLiveClient** (Gateway 경유, Phase 5 P2) = strangler path
 *   - 사용자 config로 어느 경로 선택 (provider id `lab-proxy-live` vs `gemini-live`)
 *
 * Limitations (Phase 5 Day 7.2 minimal):
 *   - text-only (audio_delta는 Phase 5+ D43 audio provider abstraction)
 *   - tool_calls bidirectional 미구현
 *   - reconnect 1회 retry only
 */

import {
	LabProxyLiveClient,
	LAB_PROXY_LIVE_DEFAULT_GATEWAY_WS_URL,
} from "@nextain/agent-providers/lab-proxy-live";
import type {
	LLMContentBlock,
	LLMRequest,
} from "@nextain/agent-types";

import type { AgentStream, ChatMessage, LLMProvider } from "../types.js";
import {
	convertStreamChunk,
	toNextainMessage,
} from "./nextain-provider-adapter.js";

export function createNextainLabProxyLiveProvider(
	naiaKey: string,
	model: string,
	gatewayWsUrl?: string,
): LLMProvider {
	const resolvedUrl = gatewayWsUrl ?? LAB_PROXY_LIVE_DEFAULT_GATEWAY_WS_URL;
	const client = new LabProxyLiveClient({
		naiaKey,
		gatewayWsUrl: resolvedUrl,
		defaultModel: model,
	});

	return {
		async *stream(
			messages: ChatMessage[],
			systemPrompt: string,
			_tools: unknown,
			signal?: AbortSignal,
		): AgentStream {
			// Tool calls는 minimal 단계에서 미지원 — drop arg.
			const request: LLMRequest = {
				messages: messages.map(toNextainMessage),
				model,
			};
			if (systemPrompt) request.system = systemPrompt;
			if (signal) request.signal = signal;

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
