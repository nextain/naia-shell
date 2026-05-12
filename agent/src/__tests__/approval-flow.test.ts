import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// Mock gateway client
vi.mock("../gateway/client.js", () => ({
	GatewayClient: class MockGatewayClient {
		connect = vi.fn().mockResolvedValue(undefined);
		isConnected = vi.fn().mockReturnValue(true);
		request = mockGatewayRequest;
		close = mockGatewayClose;
		onEvent = vi.fn();
	},
}));

/** Wait until outputs contain a chunk with the given type */
function waitForOutput(
	outputs: unknown[],
	type: string,
	timeoutMs = 3000,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const check = () => {
			const found = outputs.find((o: any) => o.type === type);
			if (found) return resolve(found);
			if (Date.now() - start > timeoutMs)
				return reject(new Error(`Timeout waiting for ${type}`));
			setTimeout(check, 10);
		};
		check();
	});
}

describe("approval flow", () => {
	let outputs: unknown[];
	let writeSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		outputs = [];
		vi.clearAllMocks();
		mockGatewayRequest.mockResolvedValue({
			stdout: "ok",
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
							// ignore
						}
					}
				}
				return true;
			});
	});

	afterEach(() => {
		writeSpy.mockRestore();
	});

	it("emits approval_request for tier 2 tools and executes after approval", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { handleChatRequest, handleApprovalResponse } = await import(
			"../index.js"
		);

		let callCount = 0;
		vi.mocked(buildProvider).mockReturnValue({
			stream: async function* () {
				callCount++;
				if (callCount === 1) {
					yield {
						type: "tool_use" as const,
						id: "tc-exec",
						name: "execute_command",
						args: { command: "ls -la" },
					};
					yield { type: "usage" as const, inputTokens: 10, outputTokens: 20 };
				} else {
					yield { type: "text" as const, text: "Done" };
					yield { type: "usage" as const, inputTokens: 5, outputTokens: 5 };
				}
			},
		});

		// Start without awaiting — it will block on approval
		const promise = handleChatRequest({
			type: "chat_request",
			requestId: "req-approval",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "key",
			},
			messages: [{ role: "user", content: "run ls" }],
			enableTools: true,
			gatewayUrl: "ws://localhost:18789",
		});

		const approvalReq = (await waitForOutput(
			outputs,
			"approval_request",
		)) as any;
		expect(approvalReq.toolName).toBe("execute_command");
		expect(approvalReq.tier).toBe(2);
		expect(approvalReq.toolCallId).toBe("tc-exec");

		// Grant approval
		handleApprovalResponse({
			type: "approval_response",
			requestId: "req-approval",
			toolCallId: "tc-exec",
			decision: "once",
		});

		await promise;

		const toolResult = outputs.find((o: any) => o.type === "tool_result");
		expect(toolResult).toBeDefined();
		expect((toolResult as any).success).toBe(true);
	});

	it("auto-executes tier 0 tools without approval", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { handleChatRequest } = await import("../index.js");

		let callCount = 0;
		vi.mocked(buildProvider).mockReturnValue({
			stream: async function* () {
				callCount++;
				if (callCount === 1) {
					yield {
						type: "tool_use" as const,
						id: "tc-read",
						name: "read_file",
						args: { path: "/tmp/test.txt" },
					};
					yield { type: "usage" as const, inputTokens: 10, outputTokens: 20 };
				} else {
					yield { type: "text" as const, text: "Contents" };
					yield { type: "usage" as const, inputTokens: 5, outputTokens: 5 };
				}
			},
		});

		await handleChatRequest({
			type: "chat_request",
			requestId: "req-auto",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "key",
			},
			messages: [{ role: "user", content: "read file" }],
			enableTools: true,
			gatewayUrl: "ws://localhost:18789",
		});

		// No approval_request should be emitted
		const approvalReq = outputs.find((o: any) => o.type === "approval_request");
		expect(approvalReq).toBeUndefined();

		// tool_result should exist (auto-executed)
		const toolResult = outputs.find((o: any) => o.type === "tool_result");
		expect(toolResult).toBeDefined();
	});

	it("rejects tool execution when decision is reject", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { handleChatRequest, handleApprovalResponse } = await import(
			"../index.js"
		);

		let callCount = 0;
		vi.mocked(buildProvider).mockReturnValue({
			stream: async function* () {
				callCount++;
				if (callCount === 1) {
					yield {
						type: "tool_use" as const,
						id: "tc-reject",
						name: "execute_command",
						args: { command: "rm important.txt" },
					};
					yield { type: "usage" as const, inputTokens: 5, outputTokens: 10 };
				} else {
					yield { type: "text" as const, text: "Rejected" };
					yield { type: "usage" as const, inputTokens: 5, outputTokens: 5 };
				}
			},
		});

		const promise = handleChatRequest({
			type: "chat_request",
			requestId: "req-reject",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "key",
			},
			messages: [{ role: "user", content: "delete file" }],
			enableTools: true,
			gatewayUrl: "ws://localhost:18789",
		});

		await waitForOutput(outputs, "approval_request");

		handleApprovalResponse({
			type: "approval_response",
			requestId: "req-reject",
			toolCallId: "tc-reject",
			decision: "reject",
			message: "Too dangerous",
		});

		await promise;

		const toolResult = outputs.find(
			(o: any) => o.type === "tool_result",
		) as any;
		expect(toolResult).toBeDefined();
		expect(toolResult.success).toBe(false);
		expect(toolResult.output).toContain("reject");
	});

	it("approves tier 1 tools (write_file) and executes after approval", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { handleChatRequest, handleApprovalResponse } = await import(
			"../index.js"
		);

		let callCount = 0;
		vi.mocked(buildProvider).mockReturnValue({
			stream: async function* () {
				callCount++;
				if (callCount === 1) {
					yield {
						type: "tool_use" as const,
						id: "tc-write",
						name: "write_file",
						args: { path: "/tmp/x", content: "y" },
					};
					yield { type: "usage" as const, inputTokens: 5, outputTokens: 10 };
				} else {
					yield { type: "text" as const, text: "Written" };
					yield { type: "usage" as const, inputTokens: 5, outputTokens: 5 };
				}
			},
		});

		const promise = handleChatRequest({
			type: "chat_request",
			requestId: "req-write",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "key",
			},
			messages: [{ role: "user", content: "write file" }],
			enableTools: true,
			gatewayUrl: "ws://localhost:18789",
		});

		// Wait for approval_request
		await waitForOutput(outputs, "approval_request");

		const approvalReq = outputs.find(
			(o: any) => o.type === "approval_request",
		) as any;
		expect(approvalReq.tier).toBe(1);

		// Approve
		handleApprovalResponse({
			type: "approval_response",
			requestId: "req-write",
			toolCallId: "tc-write",
			decision: "once",
		});

		await promise;

		const toolResult = outputs.find(
			(o: any) => o.type === "tool_result",
		) as any;
		expect(toolResult).toBeDefined();
		expect(toolResult.success).toBe(true);
	});
});
