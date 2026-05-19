import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../providers/factory.js", () => ({
	buildProvider: vi.fn(),
	setAgentNaiaKey: vi.fn(),
	getAgentNaiaKey: vi.fn().mockReturnValue(undefined),
	setProviderApiKey: vi.fn(),
	getProviderApiKey: vi.fn().mockReturnValue(undefined),
	setTtsApiKey: vi.fn(),
	getTtsApiKey: vi.fn().mockReturnValue(undefined),
	setGatewayToken: vi.fn(),
	getGatewayToken: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../tts/index.js", () => ({
	synthesize: vi.fn(),
}));

vi.mock("../providers/cost.js", () => ({
	calculateCost: vi.fn().mockReturnValue(0.001),
}));

// Gateway connection FAILS
vi.mock("../gateway/client.js", () => ({
	GatewayClient: class MockGatewayClient {
		connect = vi.fn().mockRejectedValue(new Error("Connection refused"));
		isConnected = vi.fn().mockReturnValue(false);
		request = vi.fn();
		close = vi.fn();
		onEvent = vi.fn();
	},
}));

vi.mock("../gateway/tool-tiers.js", () => ({
	needsApproval: vi.fn().mockReturnValue(false),
	getToolTier: vi.fn().mockReturnValue(0),
	getToolDescription: vi.fn().mockReturnValue("test"),
}));

describe("Gateway graceful degradation", () => {
	let outputs: unknown[];
	let writeSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		outputs = [];
		vi.clearAllMocks();
		writeSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((data: string | Uint8Array) => {
				if (typeof data === "string") {
					for (const line of data.trim().split("\n")) {
						try {
							outputs.push(JSON.parse(line));
						} catch {}
					}
				}
				return true;
			});
	});

	afterEach(() => {
		writeSpy.mockRestore();
	});

	it("chat works when Gateway connection fails (non-gateway skills still available)", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { handleChatRequest } = await import("../index.js");

		vi.mocked(buildProvider).mockReturnValue({
			stream: async function* (_msgs, systemPrompt) {
				// Verify system prompt contains gateway failure notice
				expect(systemPrompt).toContain("Gateway 연결 실패");
				yield { type: "text" as const, text: "안녕하세요!" };
				yield {
					type: "usage" as const,
					inputTokens: 10,
					outputTokens: 5,
				};
				yield { type: "finish" as const };
			},
		});

		await handleChatRequest({
			type: "chat_request",
			requestId: "req-gw-fail",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "test-key",
			},
			messages: [{ role: "user", content: "안녕" }],
			enableTools: true,
			gatewayUrl: "ws://127.0.0.1:18789",
		});

		// Should get text response, not error
		const textOutputs = outputs.filter((o: any) => o.type === "text");
		expect(textOutputs.length).toBeGreaterThan(0);
		expect((textOutputs[0] as any).text).toBe("안녕하세요!");

		// Should NOT have error output
		const errors = outputs.filter((o: any) => o.type === "error");
		expect(errors).toHaveLength(0);

		// Should have finish
		const finishes = outputs.filter((o: any) => o.type === "finish");
		expect(finishes).toHaveLength(1);
	});

	it("system prompt shows tool status when tools disabled", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { handleChatRequest } = await import("../index.js");

		let capturedSystemPrompt = "";
		vi.mocked(buildProvider).mockReturnValue({
			stream: async function* (_msgs, systemPrompt) {
				capturedSystemPrompt = systemPrompt ?? "";
				yield { type: "text" as const, text: "OK" };
				yield { type: "finish" as const };
			},
		});

		await handleChatRequest({
			type: "chat_request",
			requestId: "req-no-tools",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "test-key",
			},
			messages: [{ role: "user", content: "hi" }],
			enableTools: false,
		});

		expect(capturedSystemPrompt).toContain("도구 사용이 비활성화");
	});
});
