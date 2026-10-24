import { describe, expect, it, vi } from "vitest";
import {
	type ChatCompletionRequestWithExtraBody,
	type EngineWithChatCompletionsLike,
	resolveWebChatTurnEnableThinking,
	wrapEngineWithEnableThinking,
} from "../agent-port-relay";

interface FakeWebLLMRequest extends ChatCompletionRequestWithExtraBody {
	model: string;
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
	stream: true;
}

function makeRecordingEngine() {
	const calls: FakeWebLLMRequest[] = [];
	const create = vi.fn(async (req: FakeWebLLMRequest) => {
		calls.push(req);
		async function* stream() {
			yield {
				choices: [{ delta: { content: "답변" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 5, completion_tokens: 2 },
			};
		}
		return stream();
	});
	const engine: EngineWithChatCompletionsLike<FakeWebLLMRequest> = {
		chat: {
			completions: {
				create,
			},
		},
		interruptGenerate: vi.fn(async () => {}),
	};
	return { engine, calls, create };
}

describe("WebLLM Qwen3 thinking on/off (D39 — item E)", () => {
	it("resolves enable_thinking boolean from chat_request and config.json, treating legacy low/high as true (on)", () => {
		expect(
			resolveWebChatTurnEnableThinking(
				JSON.stringify({ thinking: { level: "off" } }),
				JSON.stringify({ thinkingLevel: "high" }),
			),
		).toBe(false);
		expect(
			resolveWebChatTurnEnableThinking(
				JSON.stringify({ thinking: { level: "low" } }),
				null,
			),
		).toBe(true);
		expect(
			resolveWebChatTurnEnableThinking(
				JSON.stringify({ thinking: { level: "high" } }),
				null,
			),
		).toBe(true);
		expect(
			resolveWebChatTurnEnableThinking(
				JSON.stringify({}),
				JSON.stringify({ thinkingLevel: "low" }),
			),
		).toBe(true);
		expect(
			resolveWebChatTurnEnableThinking(
				JSON.stringify({}),
				JSON.stringify({ thinkingLevel: "high" }),
			),
		).toBe(true);
		expect(
			resolveWebChatTurnEnableThinking(
				JSON.stringify({}),
				JSON.stringify({ enableThinking: true }),
			),
		).toBe(true);
		expect(resolveWebChatTurnEnableThinking(null, null)).toBe(false);
	});

	it("passes extra_body.enable_thinking=false when off and extra_body.enable_thinking=true when on (including legacy low/high) to engine.chat.completions.create without system prompt injection", async () => {
		const { engine, calls } = makeRecordingEngine();
		let activeEnableThinking = false;
		const wrappedEngine = wrapEngineWithEnableThinking(
			engine,
			() => activeEnableThinking,
		);

		const baseRequest: FakeWebLLMRequest = {
			model: "Qwen3-4B-q4f16_1-MLC",
			messages: [
				{ role: "system", content: "You are Naia." },
				{ role: "user", content: "안녕" },
			],
			stream: true,
		};

		// 1. Off -> enable_thinking: false
		activeEnableThinking = resolveWebChatTurnEnableThinking(
			JSON.stringify({ thinking: { level: "off" }, enableThinking: false }),
			null,
		);
		await wrappedEngine.chat.completions.create(baseRequest);
		expect(calls).toHaveLength(1);
		expect(calls[0].extra_body).toEqual({ enable_thinking: false });
		expect(calls[0].messages[0].content).toBe("You are Naia.");
		expect(calls[0].messages[0].content).not.toContain("[Thinking budget");

		// 2. On (via legacy "low") -> enable_thinking: true
		activeEnableThinking = resolveWebChatTurnEnableThinking(
			null,
			JSON.stringify({ thinkingLevel: "low" }),
		);
		await wrappedEngine.chat.completions.create(baseRequest);
		expect(calls).toHaveLength(2);
		expect(calls[1].extra_body).toEqual({ enable_thinking: true });
		expect(calls[1].messages[0].content).toBe("You are Naia.");
		expect(calls[1].messages[0].content).not.toContain("[Thinking budget");

		// 3. On (via "high" / "on") -> enable_thinking: true
		activeEnableThinking = resolveWebChatTurnEnableThinking(
			JSON.stringify({ thinking: { level: "high" } }),
			null,
		);
		await wrappedEngine.chat.completions.create(baseRequest);
		expect(calls).toHaveLength(3);
		expect(calls[2].extra_body).toEqual({ enable_thinking: true });
		expect(calls[2].messages[0].content).toBe("You are Naia.");
	});
});
