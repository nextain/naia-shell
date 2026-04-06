import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLabProxyProvider } from "../providers/lab-proxy.js";
import type { LLMProvider } from "../providers/types.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function createSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}

describe("Lab Proxy Provider", () => {
	let provider: LLMProvider;

	beforeEach(() => {
		provider = createLabProxyProvider("test-lab-key", "gemini-2.5-flash");
		mockFetch.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends correct request to gateway", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			body: createSSEStream(["data: [DONE]\n\n"]),
		});

		const gen = provider.stream(
			[{ role: "user", content: "Hello" }],
			"You are Naia.",
		);

		const chunks = [];
		for await (const chunk of gen) {
			chunks.push(chunk);
		}

		expect(mockFetch).toHaveBeenCalledOnce();
		const [url, options] = mockFetch.mock.calls[0];
		expect(url).toContain("/v1/chat/completions");
		expect(options.method).toBe("POST");
		expect(options.headers["X-AnyLLM-Key"]).toBe("Bearer test-lab-key");

		const body = JSON.parse(options.body);
		expect(body.model).toBe("vertexai:gemini-2.5-flash");
		expect(body.stream).toBe(true);
		expect(body.messages[0]).toEqual({
			role: "system",
			content: "You are Naia.",
		});
		expect(body.messages[1]).toEqual({ role: "user", content: "Hello" });
	});

	it("maps model names to gateway format", async () => {
		// Test xAI model
		const xaiProvider = createLabProxyProvider("key", "grok-3-mini");
		mockFetch.mockResolvedValue({
			ok: true,
			body: createSSEStream(["data: [DONE]\n\n"]),
		});

		const gen = xaiProvider.stream([{ role: "user", content: "Hi" }], "sys");
		for await (const _ of gen) {
			/* consume */
		}

		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.model).toBe("xai:grok-3-mini");
	});

	it("maps claude model names correctly", async () => {
		const claudeProvider = createLabProxyProvider(
			"key",
			"claude-sonnet-4-5-20250929",
		);
		mockFetch.mockResolvedValue({
			ok: true,
			body: createSSEStream(["data: [DONE]\n\n"]),
		});

		const gen = claudeProvider.stream([{ role: "user", content: "Hi" }], "sys");
		for await (const _ of gen) {
			/* consume */
		}

		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.model).toBe("anthropic:claude-sonnet-4-5-20250929");
	});

	it("yields text chunks from SSE stream", async () => {
		const sseData = [
			'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
			"data: [DONE]\n\n",
		];

		mockFetch.mockResolvedValue({
			ok: true,
			body: createSSEStream(sseData),
		});

		const gen = provider.stream([{ role: "user", content: "Hi" }], "sys");

		const chunks = [];
		for await (const chunk of gen) {
			chunks.push(chunk);
		}

		expect(chunks[0]).toEqual({ type: "text", text: "Hello" });
		expect(chunks[1]).toEqual({ type: "text", text: " world" });
		expect(chunks[chunks.length - 1]).toEqual({ type: "finish" });
	});

	it("yields tool_use chunks from SSE stream", async () => {
		const sseData = [
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc-1","function":{"name":"read_file","arguments":"{\\"path\\":\\"/tmp/x\\"}"}}]}}]}\n\n',
			"data: [DONE]\n\n",
		];

		mockFetch.mockResolvedValue({
			ok: true,
			body: createSSEStream(sseData),
		});

		const gen = provider.stream(
			[{ role: "user", content: "Read a file" }],
			"sys",
			[
				{
					name: "read_file",
					description: "Read file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
					},
				},
			],
		);

		const chunks = [];
		for await (const chunk of gen) {
			chunks.push(chunk);
		}

		const toolUse = chunks.find((c) => c.type === "tool_use");
		expect(toolUse).toEqual({
			type: "tool_use",
			id: "tc-1",
			name: "read_file",
			args: { path: "/tmp/x" },
		});
	});

	it("accumulates tool call arguments across multiple SSE chunks", async () => {
		const sseData = [
			// First chunk: id + name + partial args
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc-2","function":{"name":"write_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
			// Second chunk: continuation of arguments
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"/tmp/out\\","}}]}}]}\n\n',
			// Third chunk: final part of arguments
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"content\\":\\"hello\\"}"}}]}}]}\n\n',
			"data: [DONE]\n\n",
		];

		mockFetch.mockResolvedValue({
			ok: true,
			body: createSSEStream(sseData),
		});

		const gen = provider.stream(
			[{ role: "user", content: "Write a file" }],
			"sys",
			[
				{
					name: "write_file",
					description: "Write file",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string" },
							content: { type: "string" },
						},
					},
				},
			],
		);

		const chunks = [];
		for await (const chunk of gen) {
			chunks.push(chunk);
		}

		const toolUse = chunks.find((c) => c.type === "tool_use");
		expect(toolUse).toEqual({
			type: "tool_use",
			id: "tc-2",
			name: "write_file",
			args: { path: "/tmp/out", content: "hello" },
		});
	});

	it("yields usage when present", async () => {
		const sseData = [
			'data: {"choices":[{"delta":{"content":"Hi"}}],"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\n',
			"data: [DONE]\n\n",
		];

		mockFetch.mockResolvedValue({
			ok: true,
			body: createSSEStream(sseData),
		});

		const gen = provider.stream([{ role: "user", content: "Hi" }], "sys");

		const chunks = [];
		for await (const chunk of gen) {
			chunks.push(chunk);
		}

		const usage = chunks.find((c) => c.type === "usage");
		expect(usage).toEqual({
			type: "usage",
			inputTokens: 100,
			outputTokens: 20,
		});
	});

	it("throws on non-ok response", async () => {
		mockFetch.mockResolvedValue({
			ok: false,
			status: 402,
			text: async () => "Insufficient credits",
		});

		const gen = provider.stream([{ role: "user", content: "Hi" }], "sys");

		await expect(async () => {
			for await (const _ of gen) {
				/* consume */
			}
		}).rejects.toThrow("Lab proxy error 402");
	});

	it("sends tools in OpenAI format", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			body: createSSEStream(["data: [DONE]\n\n"]),
		});

		const tools = [
			{
				name: "read_file",
				description: "Read file",
				parameters: {
					type: "object",
					properties: { path: { type: "string" } },
				},
			},
		];

		const gen = provider.stream(
			[{ role: "user", content: "Hi" }],
			"sys",
			tools,
		);
		for await (const _ of gen) {
			/* consume */
		}

		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.tools).toHaveLength(1);
		expect(body.tools[0].type).toBe("function");
		expect(body.tools[0].function.name).toBe("read_file");
	});

	it("terminates on [DONE] even when HTTP connection stays open", async () => {
		// Simulate a gateway that sends [DONE] but never closes the HTTP connection.
		// Without `break outer`, reader.read() would hang indefinitely.
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n',
					),
				);
				// Deliberately NOT calling controller.close() — simulates keep-alive HTTP
			},
		});

		mockFetch.mockResolvedValue({ ok: true, body: stream });

		const gen = provider.stream([{ role: "user", content: "test" }], "sys");
		const chunks = [];
		for await (const chunk of gen) {
			chunks.push(chunk);
		}

		// Generator must terminate (not hang) and content before [DONE] must be emitted
		expect(chunks.find((c) => c.type === "text")).toEqual({
			type: "text",
			text: "Hi",
		});
		expect(chunks[chunks.length - 1]).toEqual({ type: "finish" });
	});

	it("silently drops empty and non-content SSE events", async () => {
		const sseData = [
			"data: \n\n", // empty data field
			"data: {}\n\n", // valid JSON but no choices
			'data: {"choices":[]}\n\n', // empty choices array
			'data: {"choices":[{"delta":{}}]}\n\n', // delta with no content/tool_calls
			'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', // valid content
			"data: [DONE]\n\n",
		];

		mockFetch.mockResolvedValue({
			ok: true,
			body: createSSEStream(sseData),
		});

		const gen = provider.stream([{ role: "user", content: "test" }], "sys");
		const chunks = [];
		for await (const chunk of gen) {
			chunks.push(chunk);
		}

		// Only "ok" text + finish should be emitted — all empty events silently dropped
		const textChunks = chunks.filter((c) => c.type === "text");
		expect(textChunks).toHaveLength(1);
		expect(textChunks[0]).toEqual({ type: "text", text: "ok" });
		expect(chunks[chunks.length - 1]).toEqual({ type: "finish" });
	});

	it("converts tool call messages correctly", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			body: createSSEStream(["data: [DONE]\n\n"]),
		});

		const gen = provider.stream(
			[
				{ role: "user", content: "Read /tmp/test" },
				{
					role: "assistant",
					content: "",
					toolCalls: [
						{ id: "tc-1", name: "read_file", args: { path: "/tmp/test" } },
					],
				},
				{
					role: "tool",
					content: "file contents here",
					toolCallId: "tc-1",
					name: "read_file",
				},
			],
			"sys",
		);
		for await (const _ of gen) {
			/* consume */
		}

		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		// system + 3 messages = 4
		expect(body.messages).toHaveLength(4);
		// assistant with tool_calls
		expect(body.messages[2].tool_calls[0].id).toBe("tc-1");
		// tool result
		expect(body.messages[3].role).toBe("tool");
		expect(body.messages[3].tool_call_id).toBe("tc-1");
	});
});

describe("gatewayUrl parameter", () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	it("uses custom gatewayUrl when provided", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			body: createSSEStream(["data: [DONE]\n\n"]),
		});

		const provider = createLabProxyProvider(
			"test-key",
			"gemini-2.5-flash",
			"https://naia-gateway-dev-123.run.app",
		);
		const gen = provider.stream([{ role: "user", content: "Hi" }], "sys");
		for await (const _ of gen) {
			/* consume */
		}

		const [url] = mockFetch.mock.calls[0];
		expect(url).toContain("naia-gateway-dev-123");
		expect(url).toContain("/v1/chat/completions");
	});

	it("throws when gatewayUrl is not HTTPS", async () => {
		const provider = createLabProxyProvider(
			"test-key",
			"gemini-2.5-flash",
			"http://evil.example.com",
		);
		const gen = provider.stream([{ role: "user", content: "Hi" }], "sys");
		await expect(async () => {
			for await (const _ of gen) {
				/* consume */
			}
		}).rejects.toThrow("rejecting non-HTTPS gateway URL");
		expect(mockFetch).not.toHaveBeenCalled();
	});
});

describe("buildProvider with naiaKey", () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	it("returns lab proxy that calls gateway URL when naiaKey is set", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			body: createSSEStream(["data: [DONE]\n\n"]),
		});

		const { buildProvider } = await import("../providers/factory.js");
		const provider = buildProvider({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "ignored",
			naiaKey: "lab-key-123",
		});

		const gen = provider.stream([{ role: "user", content: "test" }], "sys");
		for await (const _ of gen) {
			/* consume */
		}

		// Verify it called the gateway URL with lab key auth
		expect(mockFetch).toHaveBeenCalledOnce();
		const [url, options] = mockFetch.mock.calls[0];
		expect(url).toContain("naia-gateway");
		expect(url).toContain("/v1/chat/completions");
		expect(options.headers["X-AnyLLM-Key"]).toBe("Bearer lab-key-123");
	});

	it("passes labGatewayUrl to lab-proxy when naiaKey is set", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			body: createSSEStream(["data: [DONE]\n\n"]),
		});

		const { buildProvider } = await import("../providers/factory.js");
		const provider = buildProvider({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "ignored",
			naiaKey: "lab-key-xyz",
			labGatewayUrl: "https://naia-gateway-dev-456.run.app",
		});

		const gen = provider.stream([{ role: "user", content: "test" }], "sys");
		for await (const _ of gen) {
			/* consume */
		}

		const [url] = mockFetch.mock.calls[0];
		expect(url).toContain("naia-gateway-dev-456");
	});

	it("returns direct provider when naiaKey is not set", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const provider = buildProvider({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "fake-key",
		});
		expect(provider).toBeDefined();
		expect(provider.stream).toBeDefined();
		// Should NOT have called fetch (direct provider, not proxy)
		expect(mockFetch).not.toHaveBeenCalled();
	});
});
