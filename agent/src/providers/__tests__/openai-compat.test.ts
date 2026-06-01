import { describe, expect, it } from "vitest";
import { sniffTextToolCall, toOpenAIMessages, toOpenAITools } from "../openai-compat.js";
import type { ChatMessage, ToolDefinition } from "../types.js";

describe("openai-compat", () => {
	describe("toOpenAIMessages", () => {
		it("prepends system prompt", () => {
			const result = toOpenAIMessages([], "You are a helper");

			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({
				role: "system",
				content: "You are a helper",
			});
		});

		it("maps user and assistant messages", () => {
			const messages: ChatMessage[] = [
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "Hi there" },
			];
			const result = toOpenAIMessages(messages, "sys");

			expect(result).toHaveLength(3);
			expect(result[1]).toEqual({ role: "user", content: "Hello" });
			expect(result[2]).toEqual({ role: "assistant", content: "Hi there" });
		});

		it("maps tool call messages with function format", () => {
			const messages: ChatMessage[] = [
				{
					role: "assistant",
					content: "",
					toolCalls: [
						{ id: "call_1", name: "get_time", args: { format: "iso" } },
					],
				},
			];
			const result = toOpenAIMessages(messages, "sys");

			expect(result[1]).toEqual({
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: {
							name: "get_time",
							arguments: '{"format":"iso"}',
						},
					},
				],
			});
		});

		it("maps tool result messages", () => {
			const messages: ChatMessage[] = [
				{
					role: "tool",
					content: "2026-02-19T12:00:00Z",
					toolCallId: "call_1",
				},
			];
			const result = toOpenAIMessages(messages, "sys");

			expect(result[1]).toEqual({
				role: "tool",
				tool_call_id: "call_1",
				content: "2026-02-19T12:00:00Z",
			});
		});

		it("handles multiple tool calls in one message", () => {
			const messages: ChatMessage[] = [
				{
					role: "assistant",
					content: "Let me check",
					toolCalls: [
						{ id: "c1", name: "time", args: {} },
						{ id: "c2", name: "weather", args: { city: "Seoul" } },
					],
				},
			];
			const result = toOpenAIMessages(messages, "sys");

			expect(result[1].role).toBe("assistant");
			const toolCalls = (result[1] as { tool_calls: unknown[] }).tool_calls;
			expect(toolCalls).toHaveLength(2);
		});
	});

	describe("toOpenAITools", () => {
		it("maps tool definitions to OpenAI format", () => {
			const tools: ToolDefinition[] = [
				{
					name: "get_time",
					description: "Get the current time",
					parameters: {
						type: "object",
						properties: { format: { type: "string" } },
					},
				},
			];
			const result = toOpenAITools(tools);

			expect(result).toEqual([
				{
					type: "function",
					function: {
						name: "get_time",
						description: "Get the current time",
						parameters: {
							type: "object",
							properties: { format: { type: "string" } },
						},
					},
				},
			]);
		});

		it("handles empty tools array", () => {
			expect(toOpenAITools([])).toEqual([]);
		});

		it("preserves all tool fields", () => {
			const tools: ToolDefinition[] = [
				{
					name: "search",
					description: "Search files",
					parameters: {
						type: "object",
						properties: {
							query: { type: "string" },
							limit: { type: "number" },
						},
						required: ["query"],
					},
				},
			];
			const result = toOpenAITools(tools);

			expect(result[0].function.parameters).toEqual(tools[0].parameters);
		});
	});

	describe("sniffTextToolCall", () => {
		const YOUTUBE: ToolDefinition = {
			name: "skill_youtube_bgm",
			description: "Play YouTube BGM",
			parameters: {
				type: "object",
				properties: {
					action: { type: "string" },
					query: { type: "string" },
					videoId: { type: "string" },
				},
				required: ["action"],
			},
		};
		const WEATHER: ToolDefinition = {
			name: "skill_weather",
			description: "Get weather",
			parameters: {
				type: "object",
				properties: { city: { type: "string" } },
				required: ["city"],
			},
		};

		it("Shape A — explicit name + arguments", () => {
			const out = sniffTextToolCall(
				'{"name":"skill_youtube_bgm","arguments":{"action":"search","query":"lofi"}}',
				[YOUTUBE, WEATHER],
			);
			expect(out).toEqual({
				id: "call_recovered_skill_youtube_bgm",
				name: "skill_youtube_bgm",
				args: { action: "search", query: "lofi" },
			});
		});

		it("Shape A — accepts stringified arguments and `parameters` alias", () => {
			const out = sniffTextToolCall(
				'{"name":"skill_weather","parameters":"{\\"city\\":\\"Seoul\\"}"}',
				[YOUTUBE, WEATHER],
			);
			expect(out).toEqual({
				id: "call_recovered_skill_weather",
				name: "skill_weather",
				args: { city: "Seoul" },
			});
		});

		it("Shape B — single tool-named key (the reproduced screen case)", () => {
			const out = sniffTextToolCall(
				'{"skill_youtube_bgm":{"action":"search","query":"music"}}',
				[YOUTUBE, WEATHER],
			);
			expect(out).toEqual({
				id: "call_recovered_skill_youtube_bgm",
				name: "skill_youtube_bgm",
				args: { action: "search", query: "music" },
			});
		});

		it("Shape C — bare args promoted to the unique matching tool", () => {
			const out = sniffTextToolCall(
				'{\n  "action": "search",\n  "query": "lofi hip hop beats"\n}',
				[YOUTUBE, WEATHER],
			);
			expect(out).toEqual({
				id: "call_recovered_skill_youtube_bgm",
				name: "skill_youtube_bgm",
				args: { action: "search", query: "lofi hip hop beats" },
			});
		});

		it("strips a ```json fenced block", () => {
			const out = sniffTextToolCall(
				'```json\n{"skill_weather":{"city":"Busan"}}\n```',
				[YOUTUBE, WEATHER],
			);
			expect(out?.name).toBe("skill_weather");
		});

		it("returns null when bare args match more than one tool (ambiguous)", () => {
			const A: ToolDefinition = {
				name: "tool_a",
				description: "",
				parameters: { type: "object", properties: { q: { type: "string" } } },
			};
			const B: ToolDefinition = {
				name: "tool_b",
				description: "",
				parameters: { type: "object", properties: { q: { type: "string" } } },
			};
			expect(sniffTextToolCall('{"q":"x"}', [A, B])).toBeNull();
		});

		it("returns null for an unknown tool name", () => {
			expect(
				sniffTextToolCall('{"name":"nonexistent","arguments":{}}', [YOUTUBE]),
			).toBeNull();
		});

		it("returns null for plain prose / non-JSON", () => {
			expect(sniffTextToolCall("안녕하세요! 무엇을 도와드릴까요?", [YOUTUBE])).toBeNull();
		});

		it("returns null when no tools are provided", () => {
			expect(sniffTextToolCall('{"action":"search"}', [])).toBeNull();
		});

		it("returns null for bare args with an unknown key", () => {
			// `foo` is not a property of any tool → no unique match
			expect(sniffTextToolCall('{"foo":"bar"}', [YOUTUBE, WEATHER])).toBeNull();
		});
	});
});
