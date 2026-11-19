import { describe, expect, it, vi } from "vitest";
import { makeOpenAICompatProvider } from "../openai-compat-provider";

function bodyOf(text: string) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (text) controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

describe("browser gateway provider", () => {
	it.each(["gpt-6.1-terra", "gpt-5.6-luna"])("sends high (gateway-accepted, not xhigh) for %s", async (model) => {
		const fetcher = vi.fn().mockResolvedValue({
			ok: true,
			body: bodyOf('data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),
		});
		const provider = makeOpenAICompatProvider({ baseUrl: "https://gateway.test/v1", apiKey: "test-key", auth: "x-anyllm", supportsThinkingLevel: true, fetch: fetcher });
		for await (const _ of provider.chat({ provider: "nextain", model }, [], {})) { /* consume */ }
		expect(JSON.parse(fetcher.mock.calls[0][1].body).reasoning_effort).toBe("high");
	});
	it("sends authenticated server model requests and streams text without a local engine", async () => {
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
					),
				);
				controller.close();
			},
		});
		const fetcher = vi.fn().mockResolvedValue({ ok: true, body: stream });
		const provider = makeOpenAICompatProvider({
			baseUrl: "https://gateway.test/v1",
			apiKey: "test-key",
			auth: "x-anyllm",
			fetch: fetcher,
		});
		const chunks = [];
		for await (const chunk of provider.chat(
			{ provider: "nextain", model: "deepseek-test" },
			[{ role: "user", content: "hi" }],
			{},
		))
			chunks.push(chunk);
		expect(fetcher).toHaveBeenCalledWith(
			"https://gateway.test/v1/chat/completions",
			expect.objectContaining({
				headers: expect.objectContaining({ "X-AnyLLM-Key": "Bearer test-key" }),
				body: expect.stringContaining('"model":"deepseek-test"'),
			}),
		);
		expect(chunks).toContainEqual({ kind: "text", text: "hello" });
		expect(chunks).toContainEqual({
			kind: "usage",
			inputTokens: 4,
			outputTokens: 2,
		});
		expect(chunks.at(-1)).toEqual({ kind: "finish" });
	});
	it("reports authentication failure instead of falling back to a local model", async () => {
		const provider = makeOpenAICompatProvider({
			baseUrl: "https://gateway.test/v1",
			apiKey: "invalid",
			auth: "x-anyllm",
			fetch: vi
				.fn()
				.mockResolvedValue({
					ok: false,
					status: 401,
					statusText: "Unauthorized",
					body: null,
				}),
		});
		await expect(async () => {
			for await (const _ of provider.chat(
				{ provider: "nextain", model: "deepseek-test" },
				[],
				{},
			)) {
			}
		}).rejects.toThrow("401");
	});
	const terraProvider = (body: ReadableStream<Uint8Array> | null) =>
		makeOpenAICompatProvider({
			baseUrl: "https://gateway.test/v1",
			apiKey: "test-key",
			auth: "x-anyllm",
			supportsThinkingLevel: true,
			echoReasoningContent: true,
			fetch: vi.fn().mockResolvedValue({ ok: true, status: 200, body }),
		});
	it.each([
		["a 0-byte body", ""],
		["only blank lines", "\n\n\n"],
		["only the end marker", "data: [DONE]\n\n"],
		["a missing body", null],
	] as const)("R33 treats a 200 stream with %s as a provider error", async (_label, text) => {
		await expect(async () => {
			for await (const _ of terraProvider(text === null ? null : bodyOf(text)).chat(
				{ provider: "nextain", model: "gpt-6.1-terra" },
				[{ role: "user", content: "안녕" }],
				{},
			)) {
			}
		}).rejects.toThrow("without sending any answer");
	});
	it("R33 still streams terra reasoning plus a final answer (gateway reasoning.content shape)", async () => {
		const chunks = [];
		for await (const c of terraProvider(
			bodyOf(
				'data: {"choices":[{"delta":{"reasoning":{"content":"thinking"}}}]}\n\n' +
					'data: {"choices":[{"delta":{"content":"안녕하세요"}}]}\n\n' +
					'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n',
			),
		).chat({ provider: "nextain", model: "gpt-6.1-terra" }, [{ role: "user", content: "안녕" }], {}))
			chunks.push(c);
		expect(chunks).toContainEqual({ kind: "thinking", text: "thinking" });
		expect(chunks).toContainEqual({ kind: "text", text: "안녕하세요" });
		expect(chunks.at(-1)).toEqual({ kind: "finish" });
	});
});
