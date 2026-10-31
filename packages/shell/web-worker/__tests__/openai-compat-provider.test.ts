import { describe, expect, it, vi } from "vitest";
import { makeOpenAICompatProvider } from "../openai-compat-provider";

describe("browser gateway provider", () => {
	it.each(["gpt-6.1-terra", "gpt-5.6-luna"])("sends xhigh to the gateway for %s", async (model) => {
		const fetcher = vi.fn().mockImplementation(async () => ({ ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close(); } }) }));
		const provider = makeOpenAICompatProvider({ baseUrl: "https://gateway.test/v1", apiKey: "test-key", auth: "x-anyllm", supportsThinkingLevel: true, fetch: fetcher });
		for await (const _ of provider.chat({ provider: "nextain", model }, [], {})) { /* consume */ }
		expect(JSON.parse(fetcher.mock.calls[0][1].body).reasoning_effort).toBe("xhigh");
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
});
