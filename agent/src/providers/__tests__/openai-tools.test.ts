import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk, ToolDefinition } from "../types.js";

const { mockCreate } = vi.hoisted(() => ({
	mockCreate: vi.fn(),
}));

vi.mock("openai", () => {
	return {
		default: class MockOpenAI {
			chat = { completions: { create: mockCreate } };
		},
	};
});

const SAMPLE_TOOLS: ToolDefinition[] = [
	{
		name: "skill_time",
		description: "Get current time",
		parameters: {
			type: "object",
			properties: { format: { type: "string" } },
		},
	},
];

describe("openai provider — tool calling", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("passes tools and parses tool_calls delta", async () => {
		mockCreate.mockReturnValue(
			(async function* () {
				yield {
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_oai_1",
										function: {
											name: "skill_time",
											arguments: '{"format":"iso"}',
										},
									},
								],
							},
						},
					],
					usage: null,
				};
				yield {
					choices: [{ delta: {} }],
					usage: { prompt_tokens: 8, completion_tokens: 12 },
				};
			})(),
		);

		const { createOpenAIProvider } = await import("../openai.js");
		const provider = createOpenAIProvider("test-key", "gpt-4o");

		const chunks: StreamChunk[] = [];
		for await (const chunk of provider.stream([], "system", SAMPLE_TOOLS)) {
			chunks.push(chunk);
		}

		// Verify tools were passed
		const [createArgs] = mockCreate.mock.calls[0];
		expect(createArgs.tools).toBeDefined();
		expect(createArgs.tools[0].type).toBe("function");
		expect(createArgs.tools[0].function.name).toBe("skill_time");

		// Verify tool_use chunk
		const toolUse = chunks.find((c) => c.type === "tool_use");
		expect(toolUse).toEqual({
			type: "tool_use",
			id: "call_oai_1",
			name: "skill_time",
			args: { format: "iso" },
		});
	});

	it("accumulates fragmented tool_calls arguments", async () => {
		mockCreate.mockReturnValue(
			(async function* () {
				yield {
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_frag",
										function: { name: "skill_time", arguments: '{"fo' },
									},
								],
							},
						},
					],
					usage: null,
				};
				yield {
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										function: { arguments: 'rmat"' },
									},
								],
							},
						},
					],
					usage: null,
				};
				yield {
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										function: { arguments: ':"unix"}' },
									},
								],
							},
						},
					],
					usage: null,
				};
			})(),
		);

		const { createOpenAIProvider } = await import("../openai.js");
		const provider = createOpenAIProvider("test-key", "gpt-4o");

		const chunks: StreamChunk[] = [];
		for await (const chunk of provider.stream([], "system", SAMPLE_TOOLS)) {
			chunks.push(chunk);
		}

		const toolUse = chunks.find((c) => c.type === "tool_use");
		expect(toolUse).toEqual({
			type: "tool_use",
			id: "call_frag",
			name: "skill_time",
			args: { format: "unix" },
		});
	});

	it("separates Ollama `reasoning` delta into a thinking chunk", async () => {
		mockCreate.mockReturnValue(
			(async function* () {
				yield {
					choices: [{ delta: { content: "", reasoning: "Let me " } }],
					usage: null,
				};
				yield {
					choices: [{ delta: { content: "", reasoning: "think." } }],
					usage: null,
				};
				yield {
					choices: [{ delta: { content: "Answer." } }],
					usage: null,
				};
			})(),
		);

		const { createOpenAIProvider } = await import("../openai.js");
		// apiKey "ollama" routes to the Ollama-compatible path
		const provider = createOpenAIProvider("ollama", "qwen3.5:4b");

		const chunks: StreamChunk[] = [];
		for await (const chunk of provider.stream([], "system", SAMPLE_TOOLS)) {
			chunks.push(chunk);
		}

		const thinking = chunks.find((c) => c.type === "thinking");
		expect(thinking).toEqual({ type: "thinking", text: "Let me think." });
		const text = chunks.find((c) => c.type === "text");
		expect(text).toEqual({ type: "text", text: "Answer." });
	});

	it("still separates vLLM `reasoning_content` delta (no regression)", async () => {
		mockCreate.mockReturnValue(
			(async function* () {
				yield {
					choices: [{ delta: { reasoning_content: "Reasoning…" } }],
					usage: null,
				};
				yield {
					choices: [{ delta: { content: "Final." } }],
					usage: null,
				};
			})(),
		);

		const { createOpenAIProvider } = await import("../openai.js");
		const provider = createOpenAIProvider("vllm", "some-model");

		const chunks: StreamChunk[] = [];
		for await (const chunk of provider.stream([], "system", SAMPLE_TOOLS)) {
			chunks.push(chunk);
		}

		const thinking = chunks.find((c) => c.type === "thinking");
		expect(thinking).toEqual({ type: "thinking", text: "Reasoning…" });
	});

	it("recovers a text-emitted tool call and suppresses the JSON text", async () => {
		// Small local models sometimes emit the tool call as plain content
		// instead of a native tool_calls delta.
		mockCreate.mockReturnValue(
			(async function* () {
				yield {
					choices: [
						{
							delta: {
								content:
									'{"skill_time": {"format": "iso"}}',
							},
						},
					],
					usage: null,
				};
			})(),
		);

		const { createOpenAIProvider } = await import("../openai.js");
		const provider = createOpenAIProvider("ollama", "qwen3.5:4b");

		const chunks: StreamChunk[] = [];
		for await (const chunk of provider.stream([], "system", SAMPLE_TOOLS)) {
			chunks.push(chunk);
		}

		// JSON must NOT be shown to the user as text
		expect(chunks.find((c) => c.type === "text")).toBeUndefined();
		// It must be promoted to a tool_use
		const toolUse = chunks.find((c) => c.type === "tool_use");
		expect(toolUse).toMatchObject({
			type: "tool_use",
			name: "skill_time",
			args: { format: "iso" },
		});
	});

	it("does not recover when a native tool_call is already present", async () => {
		mockCreate.mockReturnValue(
			(async function* () {
				yield {
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_native",
										function: { name: "skill_time", arguments: "{}" },
									},
								],
							},
						},
					],
					usage: null,
				};
			})(),
		);

		const { createOpenAIProvider } = await import("../openai.js");
		const provider = createOpenAIProvider("ollama", "qwen3.5:4b");

		const chunks: StreamChunk[] = [];
		for await (const chunk of provider.stream([], "system", SAMPLE_TOOLS)) {
			chunks.push(chunk);
		}

		const toolUses = chunks.filter((c) => c.type === "tool_use");
		expect(toolUses).toHaveLength(1);
		expect(toolUses[0]).toMatchObject({ id: "call_native" });
	});

	it("leaves a normal text answer untouched", async () => {
		mockCreate.mockReturnValue(
			(async function* () {
				yield {
					choices: [{ delta: { content: "안녕하세요! 무엇을 도와드릴까요?" } }],
					usage: null,
				};
			})(),
		);

		const { createOpenAIProvider } = await import("../openai.js");
		const provider = createOpenAIProvider("ollama", "qwen3.5:4b");

		const chunks: StreamChunk[] = [];
		for await (const chunk of provider.stream([], "system", SAMPLE_TOOLS)) {
			chunks.push(chunk);
		}

		expect(chunks.find((c) => c.type === "text")).toEqual({
			type: "text",
			text: "안녕하세요! 무엇을 도와드릴까요?",
		});
		expect(chunks.find((c) => c.type === "tool_use")).toBeUndefined();
	});

	it("includes tool result messages in conversation", async () => {
		mockCreate.mockReturnValue(
			(async function* () {
				yield {
					choices: [{ delta: { content: "Done." } }],
					usage: null,
				};
			})(),
		);

		const { createOpenAIProvider } = await import("../openai.js");
		const provider = createOpenAIProvider("test-key", "gpt-4o");

		const messages = [
			{ role: "user" as const, content: "time?" },
			{
				role: "assistant" as const,
				content: "",
				toolCalls: [{ id: "c1", name: "skill_time", args: { format: "iso" } }],
			},
			{
				role: "tool" as const,
				content: "2026-02-19T12:00:00Z",
				toolCallId: "c1",
				name: "skill_time",
			},
		];

		for await (const _ of provider.stream(messages, "sys", SAMPLE_TOOLS)) {
			// consume
		}

		const [createArgs] = mockCreate.mock.calls[0];
		const sent = createArgs.messages;

		// Should include tool message (not filtered out)
		const toolMsg = sent.find(
			(m: Record<string, unknown>) => m.role === "tool",
		);
		expect(toolMsg).toBeDefined();
		expect(toolMsg.tool_call_id).toBe("c1");
		expect(toolMsg.content).toBe("2026-02-19T12:00:00Z");
	});
});
