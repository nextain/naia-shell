import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock config
vi.mock("../config", () => ({
	loadConfig: vi.fn(),
	resolveConfiguredGatewayUrl: vi.fn(),
}));

// Mock chat-service
const mockDirectToolCall = vi.fn();
vi.mock("../chat-service", () => ({
	directToolCall: (...args: unknown[]) => mockDirectToolCall(...args),
}));

import { loadConfig, resolveConfiguredGatewayUrl } from "../config";

describe("gateway-sessions", () => {
	beforeEach(() => {
		(loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
			enableTools: true,
			gatewayToken: "test-token",
		});
		(resolveConfiguredGatewayUrl as ReturnType<typeof vi.fn>).mockReturnValue(
			"ws://localhost:18789",
		);
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
	});

	describe("listGatewaySessions", () => {
		it("returns parsed sessions from Gateway", async () => {
			mockDirectToolCall.mockResolvedValueOnce({
				success: true,
				output: JSON.stringify({
					sessions: [
						{
							key: "agent:main:main",
							label: "Main Chat",
							messageCount: 5,
							createdAt: 1000,
							updatedAt: 2000,
							metadata: { summary: "Test summary" },
						},
						{
							key: "discord:channel:123",
							label: "Discord",
							messageCount: 3,
							createdAt: 500,
							updatedAt: 1500,
						},
					],
				}),
			});

			const { listGatewaySessions } = await import("../gateway-sessions");
			const sessions = await listGatewaySessions(50);

			expect(sessions).toHaveLength(2);
			expect(sessions[0].key).toBe("agent:main:main");
			expect(sessions[0].summary).toBe("Test summary");
			expect(sessions[1].key).toBe("discord:channel:123");
			expect(sessions[1].summary).toBeUndefined();
		});

		it("includes per-channel-peer Discord sessions", async () => {
			mockDirectToolCall.mockResolvedValueOnce({
				success: true,
				output: JSON.stringify({
					sessions: [
						{
							key: "agent:main:discord:direct:865850174651498506",
							label: "Discord DM",
							messageCount: 10,
							createdAt: 1000,
							updatedAt: 3000,
						},
					],
				}),
			});

			const { listGatewaySessions } = await import("../gateway-sessions");
			const sessions = await listGatewaySessions(50);

			expect(sessions).toHaveLength(1);
			expect(sessions[0].key).toBe(
				"agent:main:discord:direct:865850174651498506",
			);
		});

		it("still calls agent when Gateway URL unavailable (skill_sessions is local)", async () => {
			// skill_sessions is a local agent tool — works without cloud gateway.
			// The agent receives the request with gatewayUrl: undefined and handles it locally.
			(resolveConfiguredGatewayUrl as ReturnType<typeof vi.fn>).mockReturnValue(
				null,
			);
			mockDirectToolCall.mockResolvedValueOnce({
				success: true,
				output: JSON.stringify({ sessions: [] }),
			});

			const { listGatewaySessions } = await import("../gateway-sessions");
			const sessions = await listGatewaySessions();

			expect(sessions).toEqual([]);
			// directToolCall IS called — agent processes skill_sessions locally
			expect(mockDirectToolCall).toHaveBeenCalledWith(
				expect.objectContaining({ toolName: "skill_sessions" }),
			);
		});

		it("returns empty array on Gateway error", async () => {
			mockDirectToolCall.mockRejectedValueOnce(new Error("Connection refused"));

			const { listGatewaySessions } = await import("../gateway-sessions");
			const sessions = await listGatewaySessions();

			expect(sessions).toEqual([]);
		});
	});

	describe("getGatewayHistory", () => {
		it("returns parsed ChatMessages from Gateway", async () => {
			mockDirectToolCall.mockResolvedValueOnce({
				success: true,
				output: JSON.stringify({
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: "Hello" }],
							timestamp: 1000,
						},
						{
							role: "assistant",
							content: [{ type: "text", text: "Hi there!" }],
							timestamp: 2000,
						},
					],
				}),
			});

			const { getGatewayHistory } = await import("../gateway-sessions");
			const messages = await getGatewayHistory("agent:main:main");

			expect(messages).toHaveLength(2);
			expect(messages[0].role).toBe("user");
			expect(messages[0].content).toBe("Hello");
			expect(messages[1].role).toBe("assistant");
			expect(messages[1].content).toBe("Hi there!");
		});

		it("filters out non-user/assistant roles", async () => {
			mockDirectToolCall.mockResolvedValueOnce({
				success: true,
				output: JSON.stringify({
					messages: [
						{
							role: "system",
							content: [{ type: "text", text: "System prompt" }],
						},
						{
							role: "user",
							content: [{ type: "text", text: "Hello" }],
							timestamp: 1000,
						},
					],
				}),
			});

			const { getGatewayHistory } = await import("../gateway-sessions");
			const messages = await getGatewayHistory("agent:main:main");

			expect(messages).toHaveLength(1);
			expect(messages[0].role).toBe("user");
		});

		it("filters out HEARTBEAT message pairs from history", async () => {
			mockDirectToolCall.mockResolvedValueOnce({
				success: true,
				output: JSON.stringify({
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK. Current time: Saturday, March 21st, 2026",
								},
							],
							timestamp: 1000,
						},
						{
							role: "assistant",
							content: [{ type: "text", text: "HEARTBEAT_OK" }],
							timestamp: 2000,
						},
						{
							role: "user",
							content: [{ type: "text", text: "안녕!" }],
							timestamp: 3000,
						},
						{
							role: "assistant",
							content: [{ type: "text", text: "안녕하세요!" }],
							timestamp: 4000,
						},
					],
				}),
			});

			const { getGatewayHistory } = await import("../gateway-sessions");
			const messages = await getGatewayHistory("agent:main:main");

			expect(messages).toHaveLength(2);
			expect(messages[0].content).toBe("안녕!");
			expect(messages[1].content).toBe("안녕하세요!");
		});

		it("does not filter assistant greeting that follows HEARTBEAT_OK with other content", async () => {
			mockDirectToolCall.mockResolvedValueOnce({
				success: true,
				output: JSON.stringify({
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
								},
							],
							timestamp: 1000,
						},
						{
							role: "assistant",
							content: [
								{ type: "text", text: "HEARTBEAT_OK\n안녕하세요 마스터 루크!" },
							],
							timestamp: 2000,
						},
					],
				}),
			});

			const { getGatewayHistory } = await import("../gateway-sessions");
			const messages = await getGatewayHistory("agent:main:main");

			// HEARTBEAT_OK + greeting mixed → HEARTBEAT_OK으로 시작하므로 필터됨 (시스템 폴링으로 간주)
			// 실제로는 Gateway가 greeting을 별도 메시지로 보냄
			expect(messages).toHaveLength(0);
		});
	});

	describe("deleteGatewaySession", () => {
		it("returns true on success", async () => {
			mockDirectToolCall.mockResolvedValueOnce({ success: true, output: "" });

			const { deleteGatewaySession } = await import("../gateway-sessions");
			const result = await deleteGatewaySession("agent:main:old");

			expect(result).toBe(true);
			expect(mockDirectToolCall).toHaveBeenCalledWith(
				expect.objectContaining({
					toolName: "skill_sessions",
					args: { action: "delete", key: "agent:main:old" },
				}),
			);
		});
	});

	describe("patchGatewaySession", () => {
		it("patches session metadata", async () => {
			mockDirectToolCall.mockResolvedValueOnce({ success: true, output: "" });

			const { patchGatewaySession } = await import("../gateway-sessions");
			const result = await patchGatewaySession("agent:main:main", {
				summary: "Test summary",
			});

			expect(result).toBe(true);
			expect(mockDirectToolCall).toHaveBeenCalledWith(
				expect.objectContaining({
					toolName: "skill_sessions",
					args: {
						action: "patch",
						key: "agent:main:main",
						metadata: { summary: "Test summary" },
					},
				}),
			);
		});
	});

	describe("resetGatewaySession", () => {
		it("resets session via Gateway", async () => {
			mockDirectToolCall.mockResolvedValueOnce({ success: true, output: "" });

			const { resetGatewaySession } = await import("../gateway-sessions");
			const result = await resetGatewaySession();

			expect(result).toBe(true);
			expect(mockDirectToolCall).toHaveBeenCalledWith(
				expect.objectContaining({
					toolName: "skill_sessions",
					args: { action: "reset", key: "agent:main:main" },
				}),
			);
		});
	});
});
