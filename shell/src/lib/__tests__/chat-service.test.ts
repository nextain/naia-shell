import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock Tauri APIs
const mockInvoke = vi.fn();
const mockListen = vi.fn();
let mockUnlisten: ReturnType<typeof vi.fn>;

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: (...args: unknown[]) => mockListen(...args),
}));

describe("chat-service", () => {
	beforeEach(() => {
		mockUnlisten = vi.fn();
		mockInvoke.mockResolvedValue(undefined);
		mockListen.mockResolvedValue(mockUnlisten);
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
	});

	it("sendChatMessage invokes Tauri command and listens for events", async () => {
		const { sendChatMessage } = await import("../chat-service");

		const onChunk = vi.fn();

		// Simulate: after listen is called, we call the handler with some chunks
		mockListen.mockImplementation(
			async (_event: string, handler: (event: { payload: string }) => void) => {
				// Simulate agent responses
				setTimeout(() => {
					handler({
						payload: JSON.stringify({
							type: "text",
							requestId: "req-1",
							text: "Hello",
						}),
					});
					handler({
						payload: JSON.stringify({
							type: "usage",
							requestId: "req-1",
							inputTokens: 100,
							outputTokens: 50,
							cost: 0.001,
							model: "gemini-2.5-flash",
						}),
					});
					handler({
						payload: JSON.stringify({
							type: "finish",
							requestId: "req-1",
						}),
					});
				}, 10);
				return mockUnlisten;
			},
		);

		await sendChatMessage({
			message: "Hi",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "test-key",
			},
			history: [],
			onChunk,
			requestId: "req-1",
		});

		// Should have invoked send_to_agent_command
		expect(mockInvoke).toHaveBeenCalledWith("send_to_agent_command", {
			message: expect.stringContaining("chat_request"),
		});

		// Wait for async handlers
		await new Promise((r) => setTimeout(r, 50));

		// onChunk should have been called for text and usage
		expect(onChunk).toHaveBeenCalled();
		const textCalls = onChunk.mock.calls.filter(
			(c: any[]) => c[0].type === "text",
		);
		expect(textCalls).toHaveLength(1);
		expect(textCalls[0][0].text).toBe("Hello");
	});

	it("cancelChat invokes cancel_stream command", async () => {
		const { cancelChat } = await import("../chat-service");
		await cancelChat("req-1");
		expect(mockInvoke).toHaveBeenCalledWith("cancel_stream", {
			requestId: "req-1",
		});
	});

	it("cleans up listener when invoke throws", async () => {
		const { sendChatMessage } = await import("../chat-service");
		mockInvoke.mockRejectedValueOnce(new Error("backend crash"));

		const onChunk = vi.fn();

		await expect(
			sendChatMessage({
				message: "Hi",
				provider: {
					provider: "gemini",
					model: "gemini-2.5-flash",
					apiKey: "test-key",
				},
				history: [],
				onChunk,
				requestId: "req-fail",
			}),
		).rejects.toThrow("backend crash");

		// Listener must be cleaned up
		expect(mockUnlisten).toHaveBeenCalled();
	});

	it("includes enableTools: false in request when explicitly set", async () => {
		const { sendChatMessage } = await import("../chat-service");

		mockListen.mockImplementation(
			async (_event: string, handler: (event: { payload: string }) => void) => {
				setTimeout(() => {
					handler({
						payload: JSON.stringify({
							type: "finish",
							requestId: "req-tools",
						}),
					});
				}, 10);
				return mockUnlisten;
			},
		);

		await sendChatMessage({
			message: "test",
			provider: {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "key",
			},
			history: [],
			onChunk: vi.fn(),
			requestId: "req-tools",
			enableTools: false,
		});

		const sentMessage = mockInvoke.mock.calls[0][1].message;
		const parsed = JSON.parse(sentMessage);
		expect(parsed.enableTools).toBe(false);
	});

	it("includes ttsEngine in request when provided", async () => {
		const { sendChatMessage } = await import("../chat-service");

		mockListen.mockImplementation(
			async (_event: string, handler: (event: { payload: string }) => void) => {
				setTimeout(() => {
					handler({
						payload: JSON.stringify({
							type: "finish",
							requestId: "req-tts-engine",
						}),
					});
				}, 10);
				return mockUnlisten;
			},
		);

		await sendChatMessage({
			message: "test",
			provider: {
				provider: "nextain",
				model: "gemini-3-flash-preview",
				apiKey: "",
			},
			history: [],
			onChunk: vi.fn(),
			requestId: "req-tts-engine",
			ttsEngine: "gateway",
		});

		const sentMessage = mockInvoke.mock.calls[0][1].message;
		const parsed = JSON.parse(sentMessage);
		expect(parsed.ttsEngine).toBe("gateway");
	});

	it("does NOT include naiaKey in chat_request payload", async () => {
		const { sendChatMessage } = await import("../chat-service");

		mockListen.mockImplementation(
			async (_event: string, handler: (event: { payload: string }) => void) => {
				setTimeout(() => {
					handler({
						payload: JSON.stringify({
							type: "finish",
							requestId: "req-no-naiakey",
						}),
					});
				}, 10);
				return mockUnlisten;
			},
		);

		await sendChatMessage({
			message: "test",
			provider: { provider: "nextain", model: "gemini-3-flash", apiKey: "" },
			history: [],
			onChunk: vi.fn(),
			requestId: "req-no-naiakey",
		});

		const parsed = JSON.parse(mockInvoke.mock.calls[0][1].message);
		expect(parsed.naiaKey).toBeUndefined();
		expect(parsed.provider?.naiaKey).toBeUndefined();
	});

	it("sendAuthUpdate sends auth_update message to agent", async () => {
		const { sendAuthUpdate } = await import("../chat-service");
		await sendAuthUpdate("gw-test-key");
		expect(mockInvoke).toHaveBeenCalledWith("send_to_agent_command", {
			message: JSON.stringify({ type: "auth_update", naiaKey: "gw-test-key" }),
		});
	});

	it("requestTts does NOT include naiaKey in tts_request payload", async () => {
		const { requestTts } = await import("../chat-service");

		mockListen.mockImplementation(
			async (_event: string, handler: (event: { payload: string }) => void) => {
				setTimeout(() => {
					handler({
						payload: JSON.stringify({
							type: "finish",
							requestId: "req-tts-no-key",
						}),
					});
				}, 10);
				return mockUnlisten;
			},
		);

		await requestTts({
			text: "Hello",
			voice: "ko-KR-Neural2-A",
			ttsProvider: "edge",
			requestId: "req-tts-no-key",
			onAudio: vi.fn(),
		});

		const parsed = JSON.parse(mockInvoke.mock.calls[0][1].message);
		expect(parsed.type).toBe("tts_request");
		expect(parsed.naiaKey).toBeUndefined();
	});

	it("does NOT forward webhook URLs in chat_request (#260)", async () => {
		const { sendChatMessage } = await import("../chat-service");

		mockListen.mockImplementation(
			async (_event: string, handler: (event: { payload: string }) => void) => {
				setTimeout(() => {
					handler({
						payload: JSON.stringify({
							type: "finish",
							requestId: "req-webhooks",
						}),
					});
				}, 10);
				return mockUnlisten;
			},
		);

		await sendChatMessage({
			message: "test",
			provider: {
				provider: "nextain",
				model: "gemini-3-flash-preview",
				apiKey: "",
			},
			history: [],
			onChunk: vi.fn(),
			requestId: "req-webhooks",
		});

		const sentMessage = mockInvoke.mock.calls[0][1].message;
		const parsed = JSON.parse(sentMessage);
		// All webhook + Discord credential fields MUST be absent from per-request
		// frames. They are pushed once via sendNotifyConfig at startup / on save.
		expect(parsed.slackWebhookUrl).toBeUndefined();
		expect(parsed.discordWebhookUrl).toBeUndefined();
		expect(parsed.googleChatWebhookUrl).toBeUndefined();
		expect(parsed.discordDefaultUserId).toBeUndefined();
		expect(parsed.discordDefaultTarget).toBeUndefined();
		expect(parsed.discordDmChannelId).toBeUndefined();
	});

	it("sendNotifyConfig emits a notify_config request with all webhook fields", async () => {
		const { sendNotifyConfig } = await import("../chat-service");

		await sendNotifyConfig({
			slackWebhookUrl: "https://hooks.slack.com/services/test",
			discordWebhookUrl: "https://discord.com/api/webhooks/123/abc",
			googleChatWebhookUrl: "",
			discordDefaultUserId: "user-1",
			discordDefaultTarget: "dm",
			discordDmChannelId: "channel-1",
		});

		const sentMessage = mockInvoke.mock.calls[0][1].message;
		const parsed = JSON.parse(sentMessage);
		expect(parsed.type).toBe("notify_config");
		expect(parsed.slackWebhookUrl).toContain("hooks.slack.com");
		expect(parsed.discordWebhookUrl).toContain("discord.com/api/webhooks");
		expect(parsed.googleChatWebhookUrl).toBe("");
		expect(parsed.discordDefaultUserId).toBe("user-1");
		expect(parsed.discordDefaultTarget).toBe("dm");
		expect(parsed.discordDmChannelId).toBe("channel-1");
	});

	it("sendCredsUpdate emits creds_update with LLM + TTS keys + gatewayToken (#260 follow-up)", async () => {
		const { sendCredsUpdate } = await import("../chat-service");

		await sendCredsUpdate({
			keys: {
				anthropic: "sk-ant-xyz",
				openai: "sk-openai-abc",
				gemini: "",
			},
			ttsKeys: {
				google: "AIzaTTS",
				openai: "",
			},
			gatewayToken: "gw-token-xyz",
		});

		const sentMessage = mockInvoke.mock.calls[0][1].message;
		const parsed = JSON.parse(sentMessage);
		expect(parsed.type).toBe("creds_update");
		expect(parsed.keys.anthropic).toBe("sk-ant-xyz");
		expect(parsed.keys.openai).toBe("sk-openai-abc");
		expect(parsed.keys.gemini).toBe("");
		expect(parsed.ttsKeys.google).toBe("AIzaTTS");
		expect(parsed.ttsKeys.openai).toBe("");
		expect(parsed.gatewayToken).toBe("gw-token-xyz");
	});

	it("sendCredsUpdate omits ttsKeys/gatewayToken when undefined", async () => {
		const { sendCredsUpdate } = await import("../chat-service");

		await sendCredsUpdate({ keys: { anthropic: "sk-ant-xyz" } });

		const parsed = JSON.parse(mockInvoke.mock.calls[0][1].message);
		expect(parsed.type).toBe("creds_update");
		expect(parsed.keys.anthropic).toBe("sk-ant-xyz");
		expect("ttsKeys" in parsed).toBe(false);
		expect("gatewayToken" in parsed).toBe(false);
	});
});
