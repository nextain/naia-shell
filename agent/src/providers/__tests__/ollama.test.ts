import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOllamaProvider, toOllamaMessages, toOllamaTools } from "../ollama.js";
import type { ChatMessage, StreamChunk, ToolDefinition } from "../types.js";

const TOOLS: ToolDefinition[] = [
	{
		name: "skill_time",
		description: "Get current time",
		parameters: { type: "object", properties: { format: { type: "string" } } },
	},
];

/** Build a Response whose body streams the given raw string chunks as NDJSON. */
function streamResponse(rawChunks: string[]): Response {
	const enc = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const c of rawChunks) controller.enqueue(enc.encode(c));
			controller.close();
		},
	});
	return new Response(body, { status: 200 });
}

/** One JSON object per line (the normal case). */
function ndjson(lines: object[]): Response {
	return streamResponse(lines.map((l) => `${JSON.stringify(l)}\n`));
}

const fetchMock = vi.fn();

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
	const out: StreamChunk[] = [];
	for await (const c of stream) out.push(c);
	return out;
}

describe("ollama native provider", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockReset();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("calls /api/chat with num_ctx, think, and native tools; parses all chunk types", async () => {
		fetchMock.mockResolvedValue(
			ndjson([
				{ message: { content: "", thinking: "Let me think" } },
				{ message: { content: "Hello" } },
				{
					message: {
						tool_calls: [
							{ function: { name: "skill_time", arguments: { format: "iso" } } },
						],
					},
				},
				{ done: true, prompt_eval_count: 100, eval_count: 20 },
			]),
		);

		const provider = createOllamaProvider("qwen3.5:4b", "http://localhost:11434", true, 16384);
		const chunks = await collect(provider.stream([{ role: "user", content: "hi" }], "sys", TOOLS));

		// Request shape
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("http://localhost:11434/api/chat");
		const sent = JSON.parse((init as RequestInit).body as string);
		expect(sent.options.num_ctx).toBe(16384);
		expect(sent.think).toBe(true);
		expect(sent.tools[0].function.name).toBe("skill_time");
		expect(sent.messages[0]).toEqual({ role: "system", content: "sys" });

		// Emitted chunks
		expect(chunks).toContainEqual({ type: "thinking", text: "Let me think" });
		expect(chunks).toContainEqual({ type: "text", text: "Hello" });
		expect(chunks.find((c) => c.type === "tool_use")).toMatchObject({
			type: "tool_use",
			name: "skill_time",
			args: { format: "iso" },
		});
		expect(chunks).toContainEqual({ type: "usage", inputTokens: 100, outputTokens: 20 });
		expect(chunks.at(-1)).toEqual({ type: "finish" });
	});

	it("defaults num_ctx to 32768 and omits think when not provided", async () => {
		fetchMock.mockResolvedValue(ndjson([{ message: { content: "ok" } }, { done: true }]));

		const provider = createOllamaProvider("qwen3.5:4b");
		await collect(provider.stream([], "sys"));

		const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
		expect(sent.options.num_ctx).toBe(32_768);
		expect("think" in sent).toBe(false);
		expect("tools" in sent).toBe(false);
	});

	it("parses stringified tool_calls arguments", async () => {
		fetchMock.mockResolvedValue(
			ndjson([
				{
					message: {
						tool_calls: [
							{ function: { name: "skill_time", arguments: '{"format":"unix"}' } },
						],
					},
				},
				{ done: true },
			]),
		);

		const provider = createOllamaProvider("qwen3.5:4b");
		const chunks = await collect(provider.stream([], "sys", TOOLS));

		expect(chunks.find((c) => c.type === "tool_use")).toMatchObject({
			name: "skill_time",
			args: { format: "unix" },
		});
	});

	it("handles NDJSON split across stream read boundaries", async () => {
		// A single JSON object delivered in two raw chunks (no newline until the 2nd)
		const obj = JSON.stringify({ message: { content: "spanned" } });
		const half = Math.floor(obj.length / 2);
		fetchMock.mockResolvedValue(
			streamResponse([obj.slice(0, half), `${obj.slice(half)}\n${JSON.stringify({ done: true })}\n`]),
		);

		const provider = createOllamaProvider("qwen3.5:4b");
		const chunks = await collect(provider.stream([], "sys"));

		expect(chunks).toContainEqual({ type: "text", text: "spanned" });
	});

	it("recovers a text-emitted tool call and suppresses the JSON text", async () => {
		fetchMock.mockResolvedValue(
			ndjson([{ message: { content: '{"skill_time":{"format":"iso"}}' } }, { done: true }]),
		);

		const provider = createOllamaProvider("qwen3.5:4b");
		const chunks = await collect(provider.stream([], "sys", TOOLS));

		expect(chunks.find((c) => c.type === "text")).toBeUndefined();
		expect(chunks.find((c) => c.type === "tool_use")).toMatchObject({
			name: "skill_time",
			args: { format: "iso" },
		});
	});

	it("does not recover when a native tool_call is present", async () => {
		fetchMock.mockResolvedValue(
			ndjson([
				{ message: { tool_calls: [{ function: { name: "skill_time", arguments: {} } }] } },
				{ done: true },
			]),
		);

		const provider = createOllamaProvider("qwen3.5:4b");
		const chunks = await collect(provider.stream([], "sys", TOOLS));

		expect(chunks.filter((c) => c.type === "tool_use")).toHaveLength(1);
	});

	it("throws on non-OK response", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 500, statusText: "err" }));
		const provider = createOllamaProvider("qwen3.5:4b");
		await expect(collect(provider.stream([], "sys"))).rejects.toThrow(/Ollama \/api\/chat failed/);
	});

	describe("toOllamaMessages", () => {
		it("maps tool calls with object arguments (not JSON string)", () => {
			const messages: ChatMessage[] = [
				{
					role: "assistant",
					content: "",
					toolCalls: [{ id: "c1", name: "skill_time", args: { format: "iso" } }],
				},
			];
			const out = toOllamaMessages(messages, "sys");
			expect(out[1]).toEqual({
				role: "assistant",
				content: "",
				tool_calls: [{ function: { name: "skill_time", arguments: { format: "iso" } } }],
			});
		});

		it("maps tool result messages and strips base64 images", () => {
			const messages: ChatMessage[] = [
				{ role: "tool", content: "data:image/png;base64,AAAA", toolCallId: "c1", name: "skill_browser" },
			];
			const out = toOllamaMessages(messages, "sys");
			expect(out[1].role).toBe("tool");
			expect(out[1].content).toContain("screenshot captured");
		});
	});

	describe("toOllamaTools", () => {
		it("wraps definitions in native function format", () => {
			expect(toOllamaTools(TOOLS)).toEqual([
				{
					type: "function",
					function: {
						name: "skill_time",
						description: "Get current time",
						parameters: { type: "object", properties: { format: { type: "string" } } },
					},
				},
			]);
		});
	});
});
