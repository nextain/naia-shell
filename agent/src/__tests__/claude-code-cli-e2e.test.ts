import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks to avoid TDZ issues
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

// Mock cost (claude-code-cli skips cost, but we need the mock)
vi.mock("../providers/cost.js", () => ({
	calculateCost: vi.fn().mockReturnValue(0),
}));

// Mock Gateway client
vi.mock("../gateway/client.js", () => ({
	GatewayClient: class MockGatewayClient {
		connect = vi.fn().mockResolvedValue(undefined);
		isConnected = vi.fn().mockReturnValue(true);
		request = mockGatewayRequest;
		close = mockGatewayClose;
		onEvent = vi.fn();
	},
}));

// Disable approval for E2E tests
vi.mock("../gateway/tool-tiers.js", () => ({
	needsApproval: vi.fn().mockReturnValue(false),
	getToolTier: vi.fn().mockReturnValue(0),
	getToolDescription: vi.fn().mockReturnValue("test"),
}));

describe("claude-code-cli E2E (tool-loop)", () => {
	let writeSpy: ReturnType<typeof vi.spyOn>;
	let outputs: unknown[];

	beforeEach(() => {
		outputs = [];
		vi.clearAllMocks();
		mockGatewayRequest.mockResolvedValue({
			stdout: "command output",
			exitCode: 0,
		});
		writeSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((data: string | Uint8Array) => {
				if (typeof data === "string") {
					for (const line of data.trim().split("\n")) {
						try {
							outputs.push(JSON.parse(line));
						} catch {
							// ignore non-JSON
						}
					}
				}
				return true;
			});
	});

	afterEach(() => {
		writeSpy.mockRestore();
	});

	it("Claude CLI → tool execution → re-invoke → text response", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { handleChatRequest } = await import("../index.js");

		let callCount = 0;
		vi.mocked(buildProvider).mockReturnValue({
			stream: async function* () {
				callCount++;
				if (callCount === 1) {
					// Claude CLI responds with a tool_use
					yield {
						type: "tool_use" as const,
						id: "cli-tool-1",
						name: "execute_command",
						args: { command: "echo hello from claude" },
					};
					yield {
						type: "usage" as const,
						inputTokens: 100,
						outputTokens: 50,
					};
					yield { type: "finish" as const };
				} else {
					// After tool result, Claude CLI responds with text
					yield {
						type: "text" as const,
						text: "명령 실행이 완료되었습니다.",
					};
					yield {
						type: "usage" as const,
						inputTokens: 150,
						outputTokens: 30,
					};
					yield { type: "finish" as const };
				}
			},
		});

		await handleChatRequest({
			type: "chat_request",
			requestId: "req-cli-e2e",
			provider: {
				provider: "claude-code-cli",
				model: "claude-sonnet-4-5-20250929",
				apiKey: "",
			},
			messages: [{ role: "user", content: "echo hello 실행해줘" }],
			enableTools: true,
			gatewayUrl: "ws://127.0.0.1:18789",
		});

		const types = outputs
			.filter((o: any) => o.type !== "ready")
			.map((o: any) => o.type);

		// Full flow: tool_use → tool_result → text → finish
		expect(types).toContain("tool_use");
		expect(types).toContain("tool_result");
		expect(types).toContain("text");
		expect(types).toContain("finish");

		// Verify tool_use
		const toolUse = outputs.find((o: any) => o.type === "tool_use") as any;
		expect(toolUse.toolCallId).toBe("cli-tool-1");
		expect(toolUse.toolName).toBe("execute_command");

		// Verify tool_result
		const toolResult = outputs.find(
			(o: any) => o.type === "tool_result",
		) as any;
		expect(toolResult.success).toBe(true);

		// LLM was re-invoked after tool result
		expect(callCount).toBe(2);

		// Verify no cost was emitted (skipCost for claude-code-cli)
		const usageOutputs = outputs.filter((o: any) => o.type === "usage");
		expect(usageOutputs).toHaveLength(0);
	});

	it("works without Gateway (graceful degradation)", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { handleChatRequest } = await import("../index.js");

		vi.mocked(buildProvider).mockReturnValue({
			stream: async function* () {
				yield {
					type: "text" as const,
					text: "Gateway 없이도 대답할 수 있어요.",
				};
				yield {
					type: "usage" as const,
					inputTokens: 50,
					outputTokens: 20,
				};
				yield { type: "finish" as const };
			},
		});

		await handleChatRequest({
			type: "chat_request",
			requestId: "req-no-gw",
			provider: {
				provider: "claude-code-cli",
				model: "claude-sonnet-4-5-20250929",
				apiKey: "",
			},
			messages: [{ role: "user", content: "안녕" }],
			enableTools: false,
			// No gatewayUrl
		});

		const types = outputs
			.filter((o: any) => o.type !== "ready")
			.map((o: any) => o.type);

		expect(types).toContain("text");
		expect(types).toContain("finish");
		expect(types).not.toContain("tool_use");
		expect(mockGatewayClose).not.toHaveBeenCalled();
	});

	it("handles multiple tool_use in a single response", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { handleChatRequest } = await import("../index.js");

		let callCount = 0;
		vi.mocked(buildProvider).mockReturnValue({
			stream: async function* () {
				callCount++;
				if (callCount === 1) {
					yield {
						type: "tool_use" as const,
						id: "tc-a",
						name: "read_file",
						args: { path: "/tmp/a.txt" },
					};
					yield {
						type: "tool_use" as const,
						id: "tc-b",
						name: "read_file",
						args: { path: "/tmp/b.txt" },
					};
					yield { type: "finish" as const };
				} else {
					yield {
						type: "text" as const,
						text: "두 파일을 모두 읽었습니다.",
					};
					yield { type: "finish" as const };
				}
			},
		});

		await handleChatRequest({
			type: "chat_request",
			requestId: "req-multi-tool",
			provider: {
				provider: "claude-code-cli",
				model: "claude-sonnet-4-5-20250929",
				apiKey: "",
			},
			messages: [{ role: "user", content: "두 파일 읽어줘" }],
			enableTools: true,
			gatewayUrl: "ws://127.0.0.1:18789",
		});

		const toolUses = outputs.filter((o: any) => o.type === "tool_use");
		const toolResults = outputs.filter((o: any) => o.type === "tool_result");

		expect(toolUses).toHaveLength(2);
		expect(toolResults).toHaveLength(2);
		expect(callCount).toBe(2);
	});

	it("propagates provider error to Shell", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { handleChatRequest } = await import("../index.js");

		vi.mocked(buildProvider).mockReturnValue({
			// biome-ignore lint/correctness/useYield: intentionally throws before yielding
			stream: async function* () {
				throw new Error(
					"Claude Code CLI not found. Install `claude` or set CLAUDE_CODE_PATH.",
				);
			},
		});

		await handleChatRequest({
			type: "chat_request",
			requestId: "req-error",
			provider: {
				provider: "claude-code-cli",
				model: "claude-sonnet-4-5-20250929",
				apiKey: "",
			},
			messages: [{ role: "user", content: "test" }],
		});

		const errorMsg = outputs.find((o: any) => o.type === "error") as any;
		expect(errorMsg).toBeDefined();
		expect(errorMsg.message).toContain("Claude Code CLI not found");
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
						id: "tc-1",
						name: "execute_command",
						args: { command: "whoami" },
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
			requestId: "req-gw-close",
			provider: {
				provider: "claude-code-cli",
				model: "claude-sonnet-4-5-20250929",
				apiKey: "",
			},
			messages: [{ role: "user", content: "who am i" }],
			enableTools: true,
			gatewayUrl: "ws://127.0.0.1:18789",
		});

		expect(mockGatewayClose).toHaveBeenCalled();
	});
});
