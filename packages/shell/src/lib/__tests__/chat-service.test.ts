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
		// 이 스위트는 *옛(legacy) 경로*의 invoke/listen 계약(cancel_stream·ttsEngine·리스너 정리)을
		// 검증한다 — 새 코어(UC1 텍스트)는 tts/cancel-invoke 를 미지원(UC2 후속, chat-service.ts:188).
		// 로컬 .env(VITE_NAIA_NEW_CORE=1)가 vitest 에 누출되면 isNewCore()=true 로 새 코어 분기를 타
		// 옛-경로 단언이 깨진다 → 명시적으로 비워 .env 유무와 무관하게 결정적으로 옛 경로를 검증(CI 동형).
		vi.stubEnv("VITE_NAIA_NEW_CORE", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
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

	it("S4: carries environmentSegments and omits systemPrompt when only segments are sent", async () => {
		const { sendChatMessage } = await import("../chat-service");

		mockListen.mockImplementation(
			async (_event: string, handler: (event: { payload: string }) => void) => {
				setTimeout(() => {
					handler({ payload: JSON.stringify({ type: "finish", requestId: "req-seg" }) });
				}, 10);
				return mockUnlisten;
			},
		);

		await sendChatMessage({
			message: "test",
			provider: { provider: "gemini", model: "gemini-3-flash", apiKey: "k" },
			history: [],
			onChunk: vi.fn(),
			requestId: "req-seg",
			environmentSegments: [
				{ kind: "avatarEmotion" },
				{ kind: "panel", entries: [{ type: "bgm", data: { track: "lofi" } }] },
			],
		});

		const parsed = JSON.parse(mockInvoke.mock.calls[0][1].message);
		// 두벌 제거: persona 를 굽지 않으므로 systemPrompt 미전송, 환경 세그먼트만 운반.
		expect(parsed.systemPrompt).toBeUndefined();
		expect(parsed.environmentSegments).toEqual([
			{ kind: "avatarEmotion" },
			{ kind: "panel", entries: [{ type: "bgm", data: { track: "lofi" } }] },
		]);
	});

	it("S4: voice pipeline carries responseStyle:brief segment, NOT a raw systemPrompt override", async () => {
		// 음성 persona 회귀 닫기: 음성 STT→채팅 경로는 더는 raw systemPrompt(brevity)로 persona 를 덮지 않고
		// responseStyle:brief 세그먼트로 보낸다(코어가 persona+간결성 둘 다 조립).
		const { sendChatMessage } = await import("../chat-service");

		mockListen.mockImplementation(
			async (_event: string, handler: (event: { payload: string }) => void) => {
				setTimeout(() => {
					handler({ payload: JSON.stringify({ type: "finish", requestId: "req-voice" }) });
				}, 10);
				return mockUnlisten;
			},
		);

		await sendChatMessage({
			message: "test",
			provider: { provider: "gemini", model: "gemini-3-flash", apiKey: "k" },
			history: [],
			onChunk: vi.fn(),
			requestId: "req-voice",
			environmentSegments: [
				{ kind: "avatarEmotion" },
				{ kind: "responseStyle", style: "brief" },
			],
		});

		const parsed = JSON.parse(mockInvoke.mock.calls[0][1].message);
		// persona 를 덮지 않으므로 systemPrompt 미전송 — 간결성은 구조화 세그먼트로만.
		expect(parsed.systemPrompt).toBeUndefined();
		expect(parsed.environmentSegments).toEqual([
			{ kind: "avatarEmotion" },
			{ kind: "responseStyle", style: "brief" },
		]);
	});

	it("S4: empty environmentSegments array is omitted from payload", async () => {
		const { sendChatMessage } = await import("../chat-service");

		mockListen.mockImplementation(
			async (_event: string, handler: (event: { payload: string }) => void) => {
				setTimeout(() => {
					handler({ payload: JSON.stringify({ type: "finish", requestId: "req-seg-empty" }) });
				}, 10);
				return mockUnlisten;
			},
		);

		await sendChatMessage({
			message: "test",
			provider: { provider: "gemini", model: "gemini-3-flash", apiKey: "k" },
			history: [],
			onChunk: vi.fn(),
			requestId: "req-seg-empty",
			environmentSegments: [],
		});

		const parsed = JSON.parse(mockInvoke.mock.calls[0][1].message);
		expect(parsed.environmentSegments).toBeUndefined();
	});

	it("sendAuthUpdate sends auth_update message to agent", async () => {
		const { sendAuthUpdate } = await import("../chat-service");
		await sendAuthUpdate("gw-test-key");
		expect(mockInvoke).toHaveBeenCalledWith("send_to_agent_command", {
			message: JSON.stringify({ type: "auth_update", naiaKey: "gw-test-key" }),
		});
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

	// new-core graft (UC-012 온보딩 나이아 계정 — creds/auth 런타임 push).
	// 셸 keys-map → core 구조화 객체(provider+apiKey/naiaKey) creds_update 채널로 routing.
	// drift-gate: 새 agent 가 소비하는 {provider,apiKey,naiaKey} 만 전송, ttsKeys/gatewayToken(미소비)은 드롭.
	describe("new-core graft — creds/auth → 구조화 creds_update", () => {
		beforeEach(() => {
			vi.stubEnv("VITE_NAIA_NEW_CORE", "1");
		});

		it("sendCredsUpdate: keys-map → {provider,apiKey} 객체, ttsKeys/gatewayToken 드롭(새 agent 미소비)", async () => {
			const { sendCredsUpdate } = await import("../chat-service");
			await sendCredsUpdate({
				keys: { openai: "sk-openai" },
				ttsKeys: { google: "AIzaTTS" },
				gatewayToken: "gw-token",
			});
			const credsCall = mockInvoke.mock.calls.find(
				(c) =>
					c[0] === "send_to_agent_command" &&
					String((c[1] as { message?: string })?.message).includes("creds_update"),
			);
			expect(credsCall).toBeTruthy();
			const parsed = JSON.parse((credsCall![1] as { message: string }).message);
			expect(parsed.type).toBe("creds_update");
			expect(parsed.provider).toBe("openai");
			expect(parsed.apiKey).toBe("sk-openai");
			// 새 아키텍처 미소비(TTS=os측·gateway=naiaKey경유) → 전송 안 함(드리프트 아님)
			expect("ttsKeys" in parsed).toBe(false);
			expect("gatewayToken" in parsed).toBe(false);
			expect("keys" in parsed).toBe(false);
		});

		it("빈 apiKey 도 전송 = 명시 unset(agent keychain 이 빈=권위적 unset 으로 옛키 차단)", async () => {
			const { sendCredsUpdate } = await import("../chat-service");
			await sendCredsUpdate({ keys: { openai: "" } });
			const credsCall = mockInvoke.mock.calls.find(
				(c) =>
					c[0] === "send_to_agent_command" &&
					String((c[1] as { message?: string })?.message).includes("creds_update"),
			);
			expect(credsCall).toBeTruthy(); // 빈 키도 전송(old-baseline unset 시맨틱)
			const parsed = JSON.parse((credsCall![1] as { message: string }).message);
			expect(parsed.provider).toBe("openai");
			expect(parsed.apiKey).toBe("");
		});

		it("sendAuthUpdate: naiaKey → creds_update(provider=nextain, naiaKey) — old auth_update 채널 대체", async () => {
			const { sendAuthUpdate } = await import("../chat-service");
			await sendAuthUpdate("naia-key-xyz");
			const credsCall = mockInvoke.mock.calls.find(
				(c) =>
					c[0] === "send_to_agent_command" &&
					String((c[1] as { message?: string })?.message).includes("creds_update"),
			);
			expect(credsCall).toBeTruthy();
			const parsed = JSON.parse((credsCall![1] as { message: string }).message);
			expect(parsed.type).toBe("creds_update");
			expect(parsed.provider).toBe("nextain");
			expect(parsed.naiaKey).toBe("naia-key-xyz");
			expect("auth_update").not.toBe(parsed.type);
		});
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
					args: {},
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
