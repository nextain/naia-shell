import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks to avoid TDZ issues with vi.mock factory hoisting
const { mockGatewayRequest, mockGatewayClose } = vi.hoisted(() => ({
	mockGatewayRequest: vi.fn(),
	mockGatewayClose: vi.fn(),
}));

// Mock provider factory
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

// Mock TTS
vi.mock("../tts/index.js", () => ({
	synthesize: vi.fn(),
}));

// Mock cost
vi.mock("../providers/cost.js", () => ({
	calculateCost: vi.fn().mockReturnValue(0.001),
}));

// Mock Gateway client — use class for proper constructor behavior
vi.mock("../gateway/client.js", () => ({
	GatewayClient: class MockGatewayClient {
		connect = vi.fn().mockResolvedValue(undefined);
		isConnected = vi.fn().mockReturnValue(true);
		request = mockGatewayRequest;
		close = mockGatewayClose;
		onEvent = vi.fn();
	},
}));

// Mock tool-tiers: disable approval for all tools in these tests
vi.mock("../gateway/tool-tiers.js", () => ({
	needsApproval: vi.fn().mockReturnValue(false),
	getToolTier: vi.fn().mockReturnValue(0),
	getToolDescription: vi.fn().mockReturnValue("test"),
}));

describe("tool call loop", () => {
	let writeSpy: ReturnType<typeof vi.spyOn>;
	let outputs: unknown[];

	beforeEach(() => {
		outputs = [];
		vi.clearAllMocks();
		mockGatewayRequest.mockResolvedValue({
			stdout: "executed: echo hello",
			exitCode: 0,
		});
		writeSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((data: string | Uint8Array) => {
				if (typeof data === "string") {
					for (const line of data.trim().split("\n")) {
						outputs.push(JSON.parse(line));
					}
				}
				return true;
			});
	});

	afterEach(() => {
		writeSpy.mockRestore();
	});

	it("executes tool calls and re-invokes LLM with results", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { handleChatRequest } = await import("../index.js");

		let callCount = 0;
		vi.mocked(buildProvider).mockReturnValue({
			stream: async function* () {
				callCount++;
				if (callCount === 1) {
					yield {
						type: "tool_use" as const,
						id: "call-1",
						name: "execute_command",
						args: { command: "echo hello" },
					};
					yield {
						type: "usage" as const,
						inputTokens: 10,
						outputTokens: 5,
					};
					yield { type: "finish" as const };
				} else {
					yield {
						type: "text" as const,
						text: "명령 실행 완료!",
					};
					yield {
						type: "usage" as const,
						inputTokens: 20,
						outputTokens: 10,
					};
					yield { type: "finish" as const };
				}
			},
		});

		await handleChatRequest({
			type: "chat_request",
			requestId: "req-tool",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "key",
			},
			messages: [{ role: "user", content: "echo hello 실행해줘" }],
			enableTools: true,
			gatewayUrl: "ws://127.0.0.1:18789",
		});

		const types = outputs
			.filter((o: any) => o.type !== "ready")
			.map((o: any) => o.type);

		expect(types).toContain("tool_use");
		expect(types).toContain("tool_result");
		expect(types).toContain("text");
		expect(types).toContain("finish");

		const toolUse = outputs.find((o: any) => o.type === "tool_use") as any;
		expect(toolUse.toolCallId).toBe("call-1");
		expect(toolUse.toolName).toBe("execute_command");

		const toolResult = outputs.find(
			(o: any) => o.type === "tool_result",
		) as any;
		expect(toolResult.success).toBe(true);
		expect(toolResult.toolCallId).toBe("call-1");
	});

	it("blocks dangerous commands and sends error result to LLM", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { handleChatRequest } = await import("../index.js");

		let callCount = 0;
		vi.mocked(buildProvider).mockReturnValue({
			stream: async function* () {
				callCount++;
				if (callCount === 1) {
					yield {
						type: "tool_use" as const,
						id: "call-danger",
						name: "execute_command",
						args: { command: "rm -rf /" },
					};
					yield { type: "finish" as const };
				} else {
					yield {
						type: "text" as const,
						text: "위험한 명령은 실행할 수 없어요.",
					};
					yield { type: "finish" as const };
				}
			},
		});

		await handleChatRequest({
			type: "chat_request",
			requestId: "req-danger",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "key",
			},
			messages: [{ role: "user", content: "rm -rf / 해줘" }],
			enableTools: true,
			gatewayUrl: "ws://127.0.0.1:18789",
		});

		const toolResult = outputs.find(
			(o: any) => o.type === "tool_result",
		) as any;
		expect(toolResult).toBeDefined();
		expect(toolResult.success).toBe(false);
		expect(toolResult.output).toContain("Blocked");
	});

	it("skips tool loop when enableTools is not set", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { handleChatRequest } = await import("../index.js");

		vi.mocked(buildProvider).mockReturnValue({
			stream: async function* () {
				yield { type: "text" as const, text: "일반 응답" };
				yield {
					type: "usage" as const,
					inputTokens: 5,
					outputTokens: 3,
				};
				yield { type: "finish" as const };
			},
		});

		await handleChatRequest({
			type: "chat_request",
			requestId: "req-no-tools",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "key",
			},
			messages: [{ role: "user", content: "Hi" }],
		});

		const types = outputs
			.filter((o: any) => o.type !== "ready")
			.map((o: any) => o.type);

		expect(types).not.toContain("tool_use");
		expect(types).not.toContain("tool_result");
		expect(types).toContain("text");
	});

	it("handles multiple tool calls in a single response", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { handleChatRequest } = await import("../index.js");

		let callCount = 0;
		vi.mocked(buildProvider).mockReturnValue({
			stream: async function* () {
				callCount++;
				if (callCount === 1) {
					yield {
						type: "tool_use" as const,
						id: "call-a",
						name: "read_file",
						args: { path: "/tmp/a.txt" },
					};
					yield {
						type: "tool_use" as const,
						id: "call-b",
						name: "read_file",
						args: { path: "/tmp/b.txt" },
					};
					yield { type: "finish" as const };
				} else {
					yield {
						type: "text" as const,
						text: "두 파일을 확인했어요.",
					};
					yield { type: "finish" as const };
				}
			},
		});

		mockGatewayRequest.mockResolvedValue({
			stdout: "file contents",
			exitCode: 0,
		});

		await handleChatRequest({
			type: "chat_request",
			requestId: "req-multi",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "key",
			},
			messages: [{ role: "user", content: "두 파일 보여줘" }],
			enableTools: true,
			gatewayUrl: "ws://127.0.0.1:18789",
		});

		const toolUses = outputs.filter((o: any) => o.type === "tool_use");
		const toolResults = outputs.filter((o: any) => o.type === "tool_result");

		expect(toolUses).toHaveLength(2);
		expect(toolResults).toHaveLength(2);
	});

	it("limits tool call iterations to prevent infinite loops", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { handleChatRequest } = await import("../index.js");

		vi.mocked(buildProvider).mockReturnValue({
			stream: async function* () {
				yield {
					type: "tool_use" as const,
					id: `call-${Math.random()}`,
					name: "execute_command",
					args: { command: "echo loop" },
				};
				yield { type: "finish" as const };
			},
		});

		await handleChatRequest({
			type: "chat_request",
			requestId: "req-loop",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "key",
			},
			messages: [{ role: "user", content: "무한루프" }],
			enableTools: true,
			gatewayUrl: "ws://127.0.0.1:18789",
		});

		const toolUses = outputs.filter((o: any) => o.type === "tool_use");
		expect(toolUses.length).toBeLessThanOrEqual(10);
		const finish = outputs.find((o: any) => o.type === "finish");
		expect(finish).toBeDefined();
	});

	it("disconnects gateway after request completes", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { handleChatRequest } = await import("../index.js");

		let callCount = 0;
		vi.mocked(buildProvider).mockReturnValue({
			stream: async function* () {
				callCount++;
				if (callCount === 1) {
					yield {
						type: "tool_use" as const,
						id: "call-1",
						name: "execute_command",
						args: { command: "echo test" },
					};
					yield { type: "finish" as const };
				} else {
					yield { type: "text" as const, text: "done" };
					yield { type: "finish" as const };
				}
			},
		});

		await handleChatRequest({
			type: "chat_request",
			requestId: "req-close",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "key",
			},
			messages: [{ role: "user", content: "test" }],
			enableTools: true,
			gatewayUrl: "ws://127.0.0.1:18789",
		});

		expect(mockGatewayClose).toHaveBeenCalled();
	});
});
