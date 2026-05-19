import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGatewayRequest, mockGatewayClose } = vi.hoisted(() => ({
	mockGatewayRequest: vi.fn(),
	mockGatewayClose: vi.fn(),
}));

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

vi.mock("../gateway/client.js", () => ({
	GatewayClient: class MockGatewayClient {
		connect = vi.fn().mockResolvedValue(undefined);
		isConnected = vi.fn().mockReturnValue(true);
		request = mockGatewayRequest;
		close = mockGatewayClose;
		onEvent = vi.fn();
	},
}));

// Disable approval for this e2e test
vi.mock("../gateway/tool-tiers.js", () => ({
	needsApproval: vi.fn().mockReturnValue(false),
	getToolTier: vi.fn().mockReturnValue(0),
	getToolDescription: vi.fn().mockReturnValue("test"),
}));

describe("sessions_spawn e2e", () => {
	let writeSpy: ReturnType<typeof vi.spyOn>;
	let outputs: unknown[];

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

	it("LLM calls sessions_spawn → tool-bridge → Gateway RPCs → result back to LLM", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { handleChatRequest } = await import("../index.js");

		// Mock Gateway to respond to the 3-step RPC sequence
		const rpcCalls: string[] = [];
		mockGatewayRequest.mockImplementation(
			async (method: string, params: unknown) => {
				rpcCalls.push(method);
				switch (method) {
					case "sessions.spawn":
						return {
							runId: "run-e2e-1",
							sessionKey: "subagent:e2e-session",
						};
					case "agent.wait":
						return { status: "completed" };
					case "sessions.transcript":
						return {
							messages: [
								{
									role: "assistant",
									content: "분석 완료: 로그에서 3건의 에러를 발견했습니다.",
								},
							],
						};
					default:
						throw new Error(`Unexpected RPC: ${method}`);
				}
			},
		);

		let callCount = 0;
		vi.mocked(buildProvider).mockReturnValue({
			stream: async function* () {
				callCount++;
				if (callCount === 1) {
					// LLM decides to spawn a sub-agent
					yield {
						type: "tool_use" as const,
						id: "tc-spawn-1",
						name: "sessions_spawn",
						args: {
							task: "로그 파일을 분석해서 에러를 찾아줘",
							label: "log-analysis",
						},
					};
					yield {
						type: "usage" as const,
						inputTokens: 50,
						outputTokens: 30,
					};
					yield { type: "finish" as const };
				} else {
					// LLM receives sub-agent result and responds
					yield {
						type: "text" as const,
						text: "서브 에이전트가 분석한 결과입니다.",
					};
					yield {
						type: "usage" as const,
						inputTokens: 80,
						outputTokens: 20,
					};
					yield { type: "finish" as const };
				}
			},
		});

		await handleChatRequest({
			type: "chat_request",
			requestId: "req-spawn-e2e",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "test-key",
			},
			messages: [{ role: "user", content: "로그 분석해줘" }],
			enableTools: true,
			gatewayUrl: "ws://127.0.0.1:18789",
		});

		// Verify full flow
		const types = outputs
			.filter((o: any) => o.type !== "ready")
			.map((o: any) => o.type);

		// tool_use → tool_result → text → finish
		expect(types).toContain("tool_use");
		expect(types).toContain("tool_result");
		expect(types).toContain("text");
		expect(types).toContain("finish");

		// Verify tool_use output
		const toolUse = outputs.find((o: any) => o.type === "tool_use") as any;
		expect(toolUse.toolName).toBe("sessions_spawn");
		expect(toolUse.toolCallId).toBe("tc-spawn-1");

		// Verify tool_result contains sub-agent output
		const toolResult = outputs.find(
			(o: any) => o.type === "tool_result",
		) as any;
		expect(toolResult.success).toBe(true);
		expect(toolResult.toolCallId).toBe("tc-spawn-1");
		expect(toolResult.output).toContain("3건의 에러");

		// Verify Gateway RPCs were called in correct order
		expect(rpcCalls).toEqual([
			"sessions.spawn",
			"agent.wait",
			"sessions.transcript",
		]);

		// Verify LLM was re-invoked after getting tool result
		expect(callCount).toBe(2);
	});

	it("runs multiple sessions_spawn calls in parallel", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { handleChatRequest } = await import("../index.js");

		// Track timing to verify parallelism
		const startTimes: number[] = [];
		const endTimes: number[] = [];

		mockGatewayRequest.mockImplementation(
			async (method: string, params: unknown) => {
				switch (method) {
					case "sessions.spawn": {
						const p = params as { task: string };
						return {
							runId: `run-${p.task.slice(0, 5)}`,
							sessionKey: `subagent:${p.task.slice(0, 5)}`,
						};
					}
					case "agent.wait": {
						startTimes.push(Date.now());
						// Simulate 50ms work
						await new Promise((r) => setTimeout(r, 50));
						endTimes.push(Date.now());
						return { status: "completed" };
					}
					case "sessions.transcript":
						return {
							messages: [{ role: "assistant", content: "Result done" }],
						};
					default:
						throw new Error(`Unexpected: ${method}`);
				}
			},
		);

		let callCount = 0;
		vi.mocked(buildProvider).mockReturnValue({
			stream: async function* () {
				callCount++;
				if (callCount === 1) {
					// LLM spawns 3 sub-agents at once
					yield {
						type: "tool_use" as const,
						id: "tc-a",
						name: "sessions_spawn",
						args: { task: "task-alpha" },
					};
					yield {
						type: "tool_use" as const,
						id: "tc-b",
						name: "sessions_spawn",
						args: { task: "task-bravo" },
					};
					yield {
						type: "tool_use" as const,
						id: "tc-c",
						name: "sessions_spawn",
						args: { task: "task-charlie" },
					};
					yield { type: "finish" as const };
				} else {
					yield { type: "text" as const, text: "All done" };
					yield { type: "finish" as const };
				}
			},
		});

		await handleChatRequest({
			type: "chat_request",
			requestId: "req-parallel",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "test-key",
			},
			messages: [{ role: "user", content: "3개 작업 동시에" }],
			enableTools: true,
			gatewayUrl: "ws://127.0.0.1:18789",
		});

		// All 3 tool_results should be present
		const toolResults = outputs.filter((o: any) => o.type === "tool_result");
		expect(toolResults).toHaveLength(3);
		expect(toolResults.every((r: any) => r.success)).toBe(true);

		// Verify parallelism: if sequential, total time ≥ 150ms (3×50ms)
		// If parallel, total time should be ~50ms (overlapping)
		// Check that at least 2 agent.wait calls overlapped
		expect(startTimes).toHaveLength(3);
		const totalElapsed = Math.max(...endTimes) - Math.min(...startTimes);
		// Parallel: ~50-80ms. Sequential: ~150ms+.
		// Use 120ms as threshold (allows some slack but catches sequential)
		expect(totalElapsed).toBeLessThan(120);
	});

	it("handles sub-agent failure gracefully in e2e flow", async () => {
		const { buildProvider } = await import("../providers/factory.js");
		const { handleChatRequest } = await import("../index.js");

		// Gateway returns error on agent.wait
		mockGatewayRequest.mockImplementation(async (method: string) => {
			switch (method) {
				case "sessions.spawn":
					return {
						runId: "run-fail",
						sessionKey: "subagent:fail-session",
					};
				case "agent.wait":
					throw new Error("Agent run timed out");
				default:
					throw new Error(`Unexpected: ${method}`);
			}
		});

		let callCount = 0;
		vi.mocked(buildProvider).mockReturnValue({
			stream: async function* () {
				callCount++;
				if (callCount === 1) {
					yield {
						type: "tool_use" as const,
						id: "tc-fail",
						name: "sessions_spawn",
						args: { task: "Very long task" },
					};
					yield { type: "finish" as const };
				} else {
					yield {
						type: "text" as const,
						text: "서브 에이전트가 실패했어요.",
					};
					yield { type: "finish" as const };
				}
			},
		});

		await handleChatRequest({
			type: "chat_request",
			requestId: "req-spawn-fail",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "test-key",
			},
			messages: [{ role: "user", content: "오래 걸리는 작업" }],
			enableTools: true,
			gatewayUrl: "ws://127.0.0.1:18789",
		});

		// tool_result should indicate failure
		const toolResult = outputs.find(
			(o: any) => o.type === "tool_result",
		) as any;
		expect(toolResult).toBeDefined();
		expect(toolResult.success).toBe(false);
		expect(toolResult.output).toContain("timed out");

		// LLM should still be re-invoked with error result
		expect(callCount).toBe(2);
	});
});
