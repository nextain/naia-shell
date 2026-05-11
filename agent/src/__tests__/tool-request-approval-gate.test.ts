/**
 * Test: handleToolRequest must gate Tier 1+ tools through approval
 * (security regression — #256 ToolRequest tier bypass).
 *
 * Earlier code path: panels/shell could invoke handleToolRequest with a
 * Tier 2/3 tool name and the tool would execute with NO approval modal.
 * This test pins the fix at agent/src/index.ts handleToolRequest tier gate.
 *
 * Run:
 *   pnpm exec vitest run src/__tests__/tool-request-approval-gate.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGatewayRequest, mockGatewayClose, mockExecuteTool } = vi.hoisted(
	() => ({
		mockGatewayRequest: vi.fn(),
		mockGatewayClose: vi.fn(),
		mockExecuteTool: vi.fn(),
	}),
);

vi.mock("../gateway/client.js", () => ({
	GatewayClient: class MockGatewayClient {
		connect = vi.fn().mockResolvedValue(undefined);
		isConnected = vi.fn().mockReturnValue(true);
		request = mockGatewayRequest;
		close = mockGatewayClose;
		onEvent = vi.fn();
	},
}));

// Mock the actual tool runner so we can assert whether it was invoked.
vi.mock("../gateway/tool-bridge.js", async () => {
	const actual = await vi.importActual<
		typeof import("../gateway/tool-bridge.js")
	>("../gateway/tool-bridge.js");
	return {
		...actual,
		executeTool: mockExecuteTool,
	};
});

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

describe("handleToolRequest approval gate (#256)", () => {
	let outputs: unknown[];
	let writeSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		outputs = [];
		vi.clearAllMocks();
		mockExecuteTool.mockResolvedValue({ success: true, output: "executed" });
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

	it("blocks tier 2 tool until approval is granted", async () => {
		const { handleToolRequest, handleApprovalResponse } = await import(
			"../index.js"
		);

		const promise = handleToolRequest({
			type: "tool_request",
			requestId: "req-gate-1",
			toolName: "execute_command",
			args: { command: "ls" },
		});

		// Must emit approval_request before invoking executeTool.
		const approvalReq = (await waitForOutput(
			outputs,
			"approval_request",
		)) as any;
		expect(approvalReq.toolName).toBe("execute_command");
		expect(approvalReq.tier).toBe(2);
		expect(approvalReq.toolCallId).toBe("direct-req-gate-1");
		expect(mockExecuteTool).not.toHaveBeenCalled();

		handleApprovalResponse({
			type: "approval_response",
			requestId: "req-gate-1",
			toolCallId: "direct-req-gate-1",
			decision: "once",
		});

		await promise;

		expect(mockExecuteTool).toHaveBeenCalledTimes(1);
		const toolResult = outputs.find((o: any) => o.type === "tool_result") as any;
		expect(toolResult.success).toBe(true);
		expect(toolResult.toolCallId).toBe("direct-req-gate-1");
	});

	it("rejects without executing when decision is reject", async () => {
		const { handleToolRequest, handleApprovalResponse } = await import(
			"../index.js"
		);

		const promise = handleToolRequest({
			type: "tool_request",
			requestId: "req-gate-2",
			toolName: "execute_command",
			args: { command: "rm -rf /" },
		});

		await waitForOutput(outputs, "approval_request");

		handleApprovalResponse({
			type: "approval_response",
			requestId: "req-gate-2",
			toolCallId: "direct-req-gate-2",
			decision: "reject",
		});

		await promise;

		expect(mockExecuteTool).not.toHaveBeenCalled();
		const toolResult = outputs.find((o: any) => o.type === "tool_result") as any;
		expect(toolResult.success).toBe(false);
		expect(toolResult.output).toContain("reject");
		const finish = outputs.find((o: any) => o.type === "finish") as any;
		expect(finish).toBeDefined();
	});

	it("auto-executes tier 0 (read-only) without approval", async () => {
		const { handleToolRequest } = await import("../index.js");

		await handleToolRequest({
			type: "tool_request",
			requestId: "req-gate-3",
			toolName: "read_file",
			args: { path: "/tmp/x" },
		});

		const approvalReq = outputs.find(
			(o: any) => o.type === "approval_request",
		);
		expect(approvalReq).toBeUndefined();
		expect(mockExecuteTool).toHaveBeenCalledTimes(1);
		const toolResult = outputs.find((o: any) => o.type === "tool_result") as any;
		expect(toolResult.success).toBe(true);
	});

	it("unknown tool defaults to tier 2 (requires approval)", async () => {
		const { handleToolRequest, handleApprovalResponse } = await import(
			"../index.js"
		);

		const promise = handleToolRequest({
			type: "tool_request",
			requestId: "req-gate-4",
			toolName: "unmapped_tool_name",
			args: {},
		});

		const approvalReq = (await waitForOutput(
			outputs,
			"approval_request",
		)) as any;
		expect(approvalReq.tier).toBe(2);
		expect(mockExecuteTool).not.toHaveBeenCalled();

		handleApprovalResponse({
			type: "approval_response",
			requestId: "req-gate-4",
			toolCallId: "direct-req-gate-4",
			decision: "reject",
		});

		await promise;
		expect(mockExecuteTool).not.toHaveBeenCalled();
	});
});
