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

	// W2 — naia-agent 의존성 제외 (사용자 명시 2026-05-29)
	// stdio invoke 가 throw 해도 fire-and-forget 함수들은 main flow 안 깸.
	// sendChatMessage 만 caller (= ChatPanel) "naia 계정 chat 사용 불가" UI 표시
	// 가능하도록 throw 유지.
	describe("W2 — naia-agent unavailable swallow", () => {
		it("sendAuthUpdate naia-agent 없어도 throw 안 함", async () => {
			mockInvoke.mockRejectedValue(new Error("agent-core died"));
			const { sendAuthUpdate } = await import("../chat-service");
			await expect(sendAuthUpdate("gw-test-key")).resolves.toBeUndefined();
		});

		it("sendNotifyConfig naia-agent 없어도 throw 안 함", async () => {
			mockInvoke.mockRejectedValue(new Error("agent-core died"));
			const { sendNotifyConfig } = await import("../chat-service");
			await expect(
				sendNotifyConfig({ slackWebhookUrl: "https://example.com" }),
			).resolves.toBeUndefined();
		});

		it("sendCredsUpdate naia-agent 없어도 throw 안 함", async () => {
			// W2.review P1-1 fix: 옛 test 는 mockRejectedValue 누락 → happy path
			// 만 검증. swallow 경로 직접 실행.
			mockInvoke.mockRejectedValue(new Error("agent-core died"));
			const { sendCredsUpdate } = await import("../chat-service");
			await expect(
				sendCredsUpdate({ keys: { anthropic: "sk-ant-xyz" } }),
			).resolves.toBeUndefined();
		});

		// W2.review P1-2 — listener 연동 3 함수의 `if (!sent)` 브랜치 미커버.
		// 실패 시 timeout cleanup + rejectPromise / silent resolve 검증.

		it("directToolCall naia-agent 없으면 rejectPromise + listener cleanup", async () => {
			mockInvoke.mockRejectedValue(new Error("agent-core died"));
			const { directToolCall } = await import("../chat-service");

			await expect(
				directToolCall({
					toolName: "skill_time",
					arguments: {},
					requestId: "req-dt-1",
				}),
			).rejects.toThrow(/naia-agent unavailable/);

			// listener cleanup 검증 — mockUnlisten 1회 호출
			expect(mockUnlisten).toHaveBeenCalled();
		});

		it("fetchAgentSkills naia-agent 없으면 rejectPromise + listener cleanup", async () => {
			mockInvoke.mockRejectedValue(new Error("agent-core died"));
			const { fetchAgentSkills } = await import("../chat-service");

			await expect(fetchAgentSkills()).rejects.toThrow(
				/naia-agent unavailable/,
			);
			expect(mockUnlisten).toHaveBeenCalled();
		});

		it("requestTts naia-agent 없으면 silent resolve + listener cleanup (onAudio never called)", async () => {
			mockInvoke.mockRejectedValue(new Error("agent-core died"));
			const onAudio = vi.fn();
			const { requestTts } = await import("../chat-service");

			await expect(
				requestTts({
					text: "hello",
					ttsProvider: "edge",
					requestId: "req-tts-1",
					onAudio,
				}),
			).resolves.toBeUndefined();

			expect(onAudio).not.toHaveBeenCalled();
			expect(mockUnlisten).toHaveBeenCalled();
		});

		it("sendEmbeddingPrefetch naia-agent 없어도 throw 안 함", async () => {
			mockInvoke.mockRejectedValue(new Error("agent-core died"));
			const { sendEmbeddingPrefetch } = await import("../chat-service");
			await expect(
				sendEmbeddingPrefetch("all-MiniLM-L6-v2"),
			).resolves.toBeUndefined();
		});

		it("sendPanelSkills / sendPanelSkillsClear / sendPanelInstall / sendPanelToolResult naia-agent 없어도 throw 안 함", async () => {
			mockInvoke.mockRejectedValue(new Error("agent-core died"));
			const {
				sendPanelSkills,
				sendPanelSkillsClear,
				sendPanelInstall,
				sendPanelToolResult,
			} = await import("../chat-service");
			await expect(sendPanelSkills("p1", [])).resolves.toBeUndefined();
			await expect(sendPanelSkillsClear("p1")).resolves.toBeUndefined();
			await expect(
				sendPanelInstall("https://github.com/x/y"),
			).resolves.toBeUndefined();
			await expect(
				sendPanelToolResult("r1", "c1", "ok", true),
			).resolves.toBeUndefined();
		});

		it("cancelChat naia-agent 없어도 throw 안 함 (별 cancel_stream 명령도 swallow)", async () => {
			mockInvoke.mockRejectedValue(new Error("agent-core died"));
			const { cancelChat } = await import("../chat-service");
			await expect(cancelChat("req-1")).resolves.toBeUndefined();
		});

		it("sendChatMessage 는 caller UX 위해 throw 유지", async () => {
			mockInvoke.mockRejectedValue(new Error("agent-core died"));
			const { sendChatMessage } = await import("../chat-service");
			await expect(
				sendChatMessage({
					message: "hi",
					provider: { id: "nextain" } as any,
					history: [],
					onChunk: () => {},
					requestId: "req-x",
				}),
			).rejects.toThrow(/agent-core died/);
		});
	});
});
