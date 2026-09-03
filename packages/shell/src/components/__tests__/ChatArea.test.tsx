import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentResponseChunk } from "../../lib/types";
import { useAppStore } from "../../stores/app";
import { useAvatarStore } from "../../stores/avatar";
import { useCascadeAvatarStore } from "../../stores/cascade-avatar";
import { useChatStore } from "../../stores/chat";
import { ChatArea, isDiscordConnectionIntent } from "../ChatArea";

const ttsSyncMocks = vi.hoisted(() => ({
	synthesizeTts: vi.fn().mockResolvedValue({
		audioBase64: "default-audio",
		costUsd: 0,
	}),
	streamsAvatarPcm: vi.fn(() => false),
	enqueueOrdered: vi.fn(),
	skipOrdered: vi.fn(),
	clear: vi.fn(),
	destroy: vi.fn(),
	pauseBeforePlayback: vi.fn(),
	resumePlayback: vi.fn(),
	wavDurationSeconds: vi.fn(() => 10),
	nextSeq: 0,
	audioQueueActive: false,
	audioQueueCallbacks: null as null | {
		onPlaybackStart?: () => void;
		onPlaybackEnd?: () => void;
	},
}));
const mockSendAppSkills = vi.hoisted(() => vi.fn().mockResolvedValue(true));

vi.mock("../../lib/tts/synthesize", () => ({
	synthesizeTts: ttsSyncMocks.synthesizeTts,
	streamsAvatarPcm: ttsSyncMocks.streamsAvatarPcm,
}));

vi.mock("../../lib/voice/audio-queue", () => ({
	AudioQueue: class {
		constructor(
			callbacks: {
				onPlaybackStart?: () => void;
				onPlaybackEnd?: () => void;
			} = {},
		) {
			ttsSyncMocks.audioQueueCallbacks = callbacks;
		}
		get isActive() {
			return ttsSyncMocks.audioQueueActive;
		}
		reserveSeq() {
			const seq = ttsSyncMocks.nextSeq;
			ttsSyncMocks.nextSeq += 1;
			return seq;
		}
		enqueueOrdered(seq: number, audio: string, callbacks?: unknown) {
			ttsSyncMocks.audioQueueActive = true;
			ttsSyncMocks.enqueueOrdered(seq, audio, callbacks);
		}
		skipOrdered(seq: number) {
			ttsSyncMocks.skipOrdered(seq);
		}
		pauseBeforePlayback() {
			ttsSyncMocks.pauseBeforePlayback();
		}
		resumePlayback() {
			ttsSyncMocks.resumePlayback();
		}
		clear() {
			ttsSyncMocks.nextSeq = 0;
			ttsSyncMocks.audioQueueActive = false;
			ttsSyncMocks.clear();
		}
		destroy() {
			ttsSyncMocks.destroy();
		}
	},
	wavDurationSeconds: ttsSyncMocks.wavDurationSeconds,
}));

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

vi.mock("@tauri-apps/plugin-store", () => {
	const store = {
		get: vi.fn().mockResolvedValue(null),
		set: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
	};
	return { load: vi.fn().mockResolvedValue(store) };
});

// Mock chat-service — capture onChunk callback
let capturedOnChunk: ((chunk: AgentResponseChunk) => void) | null = null;
const capturedRequests: {
	message: string;
	history: { role: "user" | "assistant"; content: string }[];
	requestId: string;
	onChunk: (chunk: AgentResponseChunk) => void;
}[] = [];
vi.mock("../../lib/chat-service", () => ({
	sendChatMessage: vi.fn().mockImplementation(
		(opts: {
			message: string;
			history: { role: "user" | "assistant"; content: string }[];
			requestId: string;
			onChunk: (chunk: AgentResponseChunk) => void;
		}) => {
			capturedOnChunk = opts.onChunk;
			capturedRequests.push(opts);
			return Promise.resolve();
		},
	),
	cancelChat: vi.fn().mockResolvedValue(undefined),
	directToolCall: vi.fn().mockResolvedValue({ success: false }),
	fetchAgentSkills: vi.fn().mockResolvedValue([]),
	sendAppSkills: mockSendAppSkills,
	sendApprovalResponse: vi.fn().mockResolvedValue(undefined),
	sendAppToolResult: vi.fn().mockResolvedValue(undefined),
	configureSpeechProfile: vi.fn().mockResolvedValue(undefined),
	yieldSpeechActivity: vi.fn().mockResolvedValue(undefined),
	controlSpeechActivity: vi.fn().mockResolvedValue(undefined),
	stopSpeechActivity: vi.fn().mockResolvedValue(undefined),
	// 슬라이스1(isNewCore 도입) 이후 ChatArea 이 호출 — mock 누락 시 throw 로 8건 RED 였음.
	// 기본 false = 비-새-core(기존 sendChatMessage 경로) — 이 테스트들의 원래 가정 유지.
	isNewCore: vi.fn(() => false),
}));

// Mock Tauri APIs (needed by approval flow)
const mockInvoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

// Mock gateway-sessions (SoT for session loading)
vi.mock("../../lib/gateway-sessions", () => ({
	getGatewayHistory: vi.fn().mockResolvedValue([]),
	resetGatewaySession: vi.fn().mockResolvedValue(true),
	patchGatewaySession: vi.fn().mockResolvedValue(true),
	discoverAndPersistDiscordDmChannel: vi.fn().mockResolvedValue(null),
}));

// Mock Audio element (not available in jsdom)
vi.stubGlobal(
	"Audio",
	class {
		src = "";
		onended: (() => void) | null = null;
		onerror: (() => void) | null = null;
		play() {
			return Promise.resolve();
		}
	},
);

describe("ChatArea", () => {
	afterEach(() => {
		cleanup();
		capturedOnChunk = null;
		capturedRequests.length = 0;
		vi.clearAllMocks();
		mockInvoke.mockResolvedValue(undefined);
		useChatStore.setState(useChatStore.getInitialState());
		useAvatarStore.setState(useAvatarStore.getInitialState());
		useCascadeAvatarStore.setState(useCascadeAvatarStore.getInitialState());
		useAppStore.setState({ activeApp: null });
		ttsSyncMocks.nextSeq = 0;
		ttsSyncMocks.audioQueueActive = false;
		ttsSyncMocks.audioQueueCallbacks = null;
		ttsSyncMocks.streamsAvatarPcm.mockReturnValue(false);
		ttsSyncMocks.wavDurationSeconds.mockReturnValue(10);
		ttsSyncMocks.synthesizeTts.mockResolvedValue({
			audioBase64: "default-audio",
			costUsd: 0,
		});
	});

	it("renders input field and buttons", () => {
		render(<ChatArea />);
		expect(screen.getByPlaceholderText(/메시지|message/i)).toBeDefined();
		const buttons = screen.getAllByRole("button");
		expect(buttons.length).toBeGreaterThanOrEqual(2);
	});

	it("interrupts the active speech pipeline when the global TTS toggle turns off", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ ttsEnabled: true, ttsProvider: "edge" }),
		);
		useAvatarStore.getState().setSpeaking(true);
		render(<ChatArea />);

		window.dispatchEvent(
			new CustomEvent("naia:tts-enabled-change", {
				detail: { enabled: false },
			}),
		);

		await waitFor(() =>
			expect(useAvatarStore.getState().isSpeaking).toBe(false),
		);
		localStorage.removeItem("naia-config");
	});

	it("shows think while waiting and returns to neutral when a silent turn finishes", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "complex question" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		expect(useAvatarStore.getState().currentEmotion).toBe("think");
		const request = capturedRequests[0];
		request.onChunk({ type: "finish", requestId: request.requestId });
		expect(useAvatarStore.getState().currentEmotion).toBe("neutral");
		localStorage.removeItem("naia-config");
	});

	it("shows the provider error when a zero-token usage event precedes failure", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "invalid-test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "certification probe" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "usage",
			requestId: request.requestId,
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
			model: "gemini-2.5-flash",
		});
		request.onChunk({
			type: "error",
			requestId: request.requestId,
			message: "provider rejected the API key",
		});

		await waitFor(() =>
			expect(
				useChatStore.getState().messages.at(-1)?.content,
			).toContain("provider rejected the API key"),
		);
		expect(useChatStore.getState().isStreaming).toBe(false);
		localStorage.removeItem("naia-config");
	});

	it("keeps an explicit emotion until queued speech ends", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "edge",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "tell me good news" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "[HAPPY] Great news!",
		});
		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		await waitFor(() => expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalled());
		expect(useAvatarStore.getState().currentEmotion).toBe("happy");

		request.onChunk({ type: "finish", requestId: request.requestId });
		expect(useAvatarStore.getState().currentEmotion).toBe("happy");

		ttsSyncMocks.audioQueueActive = false;
		ttsSyncMocks.audioQueueCallbacks?.onPlaybackEnd?.();
		expect(useAvatarStore.getState().currentEmotion).toBe("neutral");
		localStorage.removeItem("naia-config");
	});

	it("does not send a turn when pre-turn BGM skill registration fails", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		mockSendAppSkills.mockResolvedValueOnce(false);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "radio please" } });
		fireEvent.keyDown(input, { key: "Enter" });

		expect(
			await screen.findByText(/skill_youtube_bgm_registration_failed/),
		).toBeDefined();
		expect(capturedRequests).toHaveLength(0);
	});

	it("does not overwrite hydrated avatar settings after async session migration", async () => {
		let finishReset: (() => void) | undefined;
		const resetPending = new Promise<boolean>((resolve) => {
			finishReset = () => resolve(true);
		});
		const { resetGatewaySession } = await import("../../lib/gateway-sessions");
		(resetGatewaySession as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			resetPending,
		);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ provider: "codex", model: "e2e" }),
		);

		render(<ChatArea />);
		await waitFor(() => expect(resetGatewaySession).toHaveBeenCalled());
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "codex",
				model: "e2e",
				avatarProvider: "naia-video-avatar",
				nvaModel: "naia-prebaked",
				localGpuTier: "laptop-4060-8g",
				ttsProvider: "naia-local-voice",
			}),
		);
		finishReset?.();

		await waitFor(() => {
			const saved = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
			expect(saved.discordSessionMigrated).toBe(true);
			expect(saved.avatarProvider).toBe("naia-video-avatar");
			expect(saved.nvaModel).toBe("naia-prebaked");
			expect(saved.localGpuTier).toBeUndefined();
			expect(saved.localVoiceEnabled).toBe(false);
			expect(saved.ttsProvider).toBe("naia-local-voice");
		});
	});

	it("distinguishes Discord connection setup from ordinary Discord requests", () => {
		expect(isDiscordConnectionIntent("디스코드 연결 설정해")).toBe(true);
		expect(isDiscordConnectionIntent("Configure my Discord bot token")).toBe(
			true,
		);
		expect(isDiscordConnectionIntent("Discord로 알림 보내줘")).toBe(false);
	});

	it("does not send empty message", () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		render(<ChatArea />);
		// Send button is the last button in the input bar
		const buttons = screen.getAllByRole("button");
		const sendBtn = buttons.find((b) => b.textContent === "↑")!;
		fireEvent.click(sendBtn);
		// No messages should be added
		expect(useChatStore.getState().messages).toHaveLength(0);
		localStorage.removeItem("naia-config");
	});

	it("keeps Discord connection secrets out of chat and opens Connections", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ discordSessionMigrated: true }),
		);
		const connectionTab = document.createElement("button");
		connectionTab.dataset.settingsTab = "connections";
		const clickConnectionTab = vi.fn();
		connectionTab.addEventListener("click", clickConnectionTab);
		document.body.append(connectionTab);
		const opened = vi.fn();
		window.addEventListener("naia-open-settings", opened);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, {
			target: { value: "Discord bot token secret-canary 연결 설정해" },
		});
		fireEvent.keyDown(input, { key: "Enter" });

		const action = await screen.findByRole("button", {
			name: /연결.*Discord|Connections.*Discord/i,
		});
		expect(capturedRequests).toHaveLength(0);
		expect(
			useChatStore
				.getState()
				.messages.some((message) => message.content.includes("secret-canary")),
		).toBe(false);
		expect(
			useChatStore
				.getState()
				.messages.some(
					(message) =>
						message.role === "assistant" &&
						/(보안 입력창|secure prompt)/i.test(message.content),
				),
		).toBe(true);

		fireEvent.click(action);
		expect(useAppStore.getState().activeApp).toBe("settings");
		expect(opened).toHaveBeenCalledWith(
			expect.objectContaining({ detail: { tab: "connections" } }),
		);
		await waitFor(() => expect(clickConnectionTab).toHaveBeenCalled());

		window.removeEventListener("naia-open-settings", opened);
		connectionTab.remove();
		localStorage.removeItem("naia-config");
	});

	it("ignores Discord message chunks in the private chat transcript and store", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "private baseline" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));

		const before = useChatStore.getState();
		capturedOnChunk?.({
			type: "discord_message",
			requestId: capturedRequests[0].requestId,
			from: "discord_100_200",
			content: "discord-only-canary",
			timestamp: "2026-07-21T00:00:00.000Z",
		});

		const after = useChatStore.getState();
		expect(after.messages).toEqual(before.messages);
		expect(after.streamingContent).toBe(before.streamingContent);
		expect(
			screen.queryByText("discord-only-canary", { exact: false }),
		).toBeNull();
		localStorage.removeItem("naia-config");
	});

	it("sends message on Enter", async () => {
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "안녕" } });
		fireEvent.keyDown(input, { key: "Enter" });

		// Wait for async state updates
		await new Promise((r) => setTimeout(r, 50));

		// User message + assistant error message (no API key)
		const { messages } = useChatStore.getState();
		expect(messages.length).toBeGreaterThanOrEqual(1);
		expect(messages[0].content).toBe("안녕");
		expect(messages[0].role).toBe("user");
	});

	it("displays session cost header", () => {
		useChatStore.setState({ totalSessionCost: 0.005 });
		render(<ChatArea />);
		expect(screen.getByText(/\$0\.005/)).toBeDefined();
	});

	it("shows streaming indicator when streaming", () => {
		useChatStore.setState({
			isStreaming: true,
			streamingContent: "응답 중...",
		});
		render(<ChatArea />);
		expect(screen.getByText(/응답 중/)).toBeDefined();
	});

	it("separates split think-tag text and keeps streaming reasoning collapsed", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "reason carefully" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		for (const text of [
			"<thi",
			"nk>private chain",
			"</thi",
			"nk>Final answer.",
		]) {
			request.onChunk({ type: "text", requestId: request.requestId, text });
		}

		expect(useChatStore.getState().streamingThinking).toBe("private chain");
		expect(useChatStore.getState().streamingContent).toBe("Final answer.");
		const reasoning = (
			await screen.findAllByText("private chain")
		).find((node) => node.classList.contains("thinking-inline-content"));
		expect(reasoning).toBeDefined();
		expect(reasoning?.closest("details")?.hasAttribute("open")).toBe(false);
		expect(
			reasoning?.closest("details")?.querySelector(".thinking-inline-preview-live > span")?.textContent,
		).toBe("private chain");

		request.onChunk({ type: "finish", requestId: request.requestId });
		const assistant = useChatStore
			.getState()
			.messages.find((message) => message.role === "assistant");
		expect(assistant?.thinking).toBe("private chain");
		expect(assistant?.content).toBe("Final answer.");
		localStorage.removeItem("naia-config");
	});

	it("never sends textual reasoning to sentence TTS", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "edge",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "speak final only" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		for (const text of [
			"<think>Secret sentence.",
			" Still secret.</think>",
			"Public sentence.",
		]) {
			request.onChunk({ type: "text", requestId: request.requestId, text });
		}
		request.onChunk({ type: "finish", requestId: request.requestId });

		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		expect(
			ttsSyncMocks.synthesizeTts.mock.calls.map(([input]) => input.text),
		).toEqual(["Public sentence."]);
		localStorage.removeItem("naia-config");
	});

	it("renders ToolActivity for tool_use chunk during streaming", async () => {
		// Set up API key so sendChatMessage is actually called
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "파일 읽어줘" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await new Promise((r) => setTimeout(r, 50));

		expect(capturedOnChunk).not.toBeNull();
		const requestId = capturedRequests[0].requestId;
		capturedOnChunk?.({
			type: "tool_use",
			requestId,
			toolCallId: "tc-1",
			toolName: "read_file",
			args: { path: "/test.txt" },
		});

		// Store should have the tool call
		const { streamingToolCalls } = useChatStore.getState();
		expect(streamingToolCalls).toHaveLength(1);
		expect(streamingToolCalls[0].toolName).toBe("read_file");
		expect(streamingToolCalls[0].status).toBe("running");

		localStorage.removeItem("naia-config");
	});

	it("updates tool call on tool_result chunk", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "파일 읽어줘" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await new Promise((r) => setTimeout(r, 50));

		const requestId = capturedRequests[0].requestId;
		capturedOnChunk?.({
			type: "tool_use",
			requestId,
			toolCallId: "tc-1",
			toolName: "read_file",
			args: { path: "/test.txt" },
		});

		capturedOnChunk?.({
			type: "tool_result",
			requestId,
			toolCallId: "tc-1",
			toolName: "read_file",
			output: "file contents",
			success: true,
		});

		const { streamingToolCalls } = useChatStore.getState();
		expect(streamingToolCalls[0].status).toBe("success");
		expect(streamingToolCalls[0].output).toBe("file contents");

		localStorage.removeItem("naia-config");
	});

	it("keeps UC-WIRE-V1 structured chunks visible in the chat stream", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/硫붿떆吏|message/i);
		fireEvent.change(input, { target: { value: "wire check" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests.length).toBe(1));
		const requestId = capturedRequests[0].requestId;
		capturedOnChunk?.({
			type: "grounding",
			requestId,
			status: "grounded",
			sources: [{ title: "KB", sourceUris: ["kb://workshop"] }],
		});
		capturedOnChunk?.({
			type: "artifact",
			requestId,
			artifact: {
				id: "artifact-1",
				kind: "image",
				mimeType: "image/png",
				sizeBytes: 2048,
				localRef: "img_1",
				name: "preview.png",
			},
		});
		capturedOnChunk?.({
			type: "provider_session",
			requestId,
			sessionId: "session-1",
			providerSessionRef: "opaque-provider-ref",
			state: "started",
		});
		capturedOnChunk?.({
			type: "processing_disclosure",
			requestId,
			workload: "embedding",
			destination: "external_cloud",
			decision: "allowed",
			processingProfileRef: "profile-local-cloud-001",
			provider: "openai",
			model: "gpt-4.1",
		});
		capturedOnChunk?.({ type: "finish", requestId });

		await waitFor(() => {
			const assistant = useChatStore
				.getState()
				.messages.find((msg) => msg.role === "assistant");
			expect(assistant?.content).toContain("[Grounding: grounded] KB");
			expect(assistant?.content).toContain("[Artifact: image preview.png]");
			expect(assistant?.content).toContain("id=artifact-1");
			expect(assistant?.content).toContain("localRef=img_1");
			expect(assistant?.content).toContain(
				"[Provider session: started] sessionId=session-1 providerSessionRef=opaque-provider-ref",
			);
			expect(assistant?.content).toContain(
				"[Processing: embedding -> external_cloud, allowed] processingProfileRef=profile-local-cloud-001 openai/gpt-4.1",
			);
		});

		localStorage.removeItem("naia-config");
	});

	it("renders ToolActivity for completed messages with toolCalls", () => {
		useChatStore.setState({
			messages: [
				{
					id: "msg-1",
					role: "assistant",
					content: "파일을 읽었습니다.",
					timestamp: Date.now(),
					toolCalls: [
						{
							toolCallId: "tc-1",
							toolName: "read_file",
							args: { path: "/test.txt" },
							status: "success",
							output: "contents",
						},
					],
				},
			],
		});

		render(<ChatArea />);
		// Should render the tool activity label
		expect(screen.getByText(/파일 읽기|Read File/)).toBeDefined();
	});

	it("sets pendingApproval on approval_request chunk", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "npm test 실행해" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await new Promise((r) => setTimeout(r, 50));

		expect(capturedOnChunk).not.toBeNull();
		const requestId = capturedRequests[0].requestId;
		capturedOnChunk?.({
			type: "approval_request",
			requestId,
			toolCallId: "tc-1",
			toolName: "execute_command",
			args: { command: "npm test" },
			tier: 2,
			description: "명령 실행: npm test",
		});

		const { pendingApproval } = useChatStore.getState();
		expect(pendingApproval).not.toBeNull();
		expect(pendingApproval?.toolName).toBe("execute_command");

		localStorage.removeItem("naia-config");
	});

	it("queues rapid sends until the active stream finishes", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		const { sendChatMessage } = await import("../../lib/chat-service");
		vi.mocked(sendChatMessage).mockClear();

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);

		fireEvent.change(input, { target: { value: "첫번째" } });
		fireEvent.keyDown(input, { key: "Enter" });
		fireEvent.change(input, { target: { value: "두번째" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(1));
		expect(useChatStore.getState().messageQueue).toEqual(["두번째"]);

		const first = capturedRequests[0];
		first.onChunk({
			type: "text",
			requestId: first.requestId,
			text: "첫 응답",
		});
		first.onChunk({ type: "finish", requestId: first.requestId });

		await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(2));
		expect(capturedRequests[1].message).toBe("두번째");
		expect(capturedRequests[1].history).toEqual([
			{ role: "user", content: "첫번째" },
			{ role: "assistant", content: "첫 응답" },
		]);

		localStorage.removeItem("naia-config");
	});

	it("auto-approves when tool is in allowedTools", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				allowedTools: ["execute_command"],
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "npm test 실행해" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await new Promise((r) => setTimeout(r, 50));

		expect(capturedOnChunk).not.toBeNull();
		const requestId = capturedRequests[0].requestId;
		capturedOnChunk?.({
			type: "approval_request",
			requestId,
			toolCallId: "tc-1",
			toolName: "execute_command",
			args: { command: "npm test" },
			tier: 2,
			description: "명령 실행: npm test",
		});

		// Should NOT set pendingApproval (auto-approved)
		const { pendingApproval } = useChatStore.getState();
		expect(pendingApproval).toBeNull();

		localStorage.removeItem("naia-config");
	});

	it("renders PermissionModal when pendingApproval is set", () => {
		useChatStore.setState({
			isStreaming: true,
			streamingContent: "",
			pendingApproval: {
				requestId: "req-1",
				toolCallId: "tc-1",
				toolName: "execute_command",
				args: { command: "npm test" },
				tier: 2,
				description: "명령 실행: npm test",
			},
		});

		render(<ChatArea />);
		expect(
			screen.getByText(/도구 실행 승인|Tool Execution Approval/),
		).toBeDefined();
	});

	it("sets isSpeaking and pendingAudio on audio chunk", async () => {
		// Set up API key so sendChatMessage is actually called
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "안녕" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await new Promise((r) => setTimeout(r, 50));

		// Simulate audio chunk via captured callback
		expect(capturedOnChunk).not.toBeNull();
		const requestId = capturedRequests[0].requestId;
		capturedOnChunk?.({
			type: "audio",
			requestId,
			data: "base64audio==",
		});

		// isSpeaking should be set (Audio element playback triggers this)
		expect(useAvatarStore.getState().isSpeaking).toBe(true);
		expect(useAvatarStore.getState().pendingAudio).toBe("base64audio==");

		localStorage.removeItem("naia-config");
	});

	// === Local conversation ownership ===

	it("plays authored NVA clips in order without Shell synthesis", async () => {
		const playAuthoredClip = vi.fn().mockResolvedValue(undefined);
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => true,
				playAuthoredClip,
				setSpeakingVisual: vi.fn(),
				setVoice: vi.fn().mockResolvedValue(false),
				interrupt: vi.fn(),
				stop: vi.fn(),
			} as never,
		});
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				avatarProvider: "naia-video-avatar",
				nvaModel: "naia",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "ordering test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "First sentence.",
		});
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Second sentence.",
		});
		await waitFor(() => expect(playAuthoredClip).toHaveBeenCalledTimes(2));
		expect(playAuthoredClip.mock.calls[0][0]).toBe("First sentence.");
		expect(playAuthoredClip.mock.calls[0][1]).toEqual(
			expect.objectContaining({
				onPlaybackReady: expect.any(Function),
				onPlaybackFailure: expect.any(Function),
			}),
		);
		expect(playAuthoredClip.mock.calls[1][0]).toBe("Second sentence.");
		expect(ttsSyncMocks.synthesizeTts).not.toHaveBeenCalled();
		expect(ttsSyncMocks.enqueueOrdered).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("routes dynamic NVA speech through Shell TTS instead of the renderer", async () => {
		const playAuthoredClip = vi.fn();
		const setSpeakingVisual = vi.fn();
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => false,
				playAuthoredClip,
				setSpeakingVisual,
				setVoice: vi.fn().mockResolvedValue(false),
				interrupt: vi.fn(),
				stop: vi.fn(),
			} as never,
		});
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				avatarProvider: "naia-video-avatar",
				nvaModel: "naia",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "dynamic speech test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "No authored clip matches this sentence.",
		});

		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		expect(playAuthoredClip).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("applies a local voice preset to the active Shell TTS pipeline", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				voiceRefUrl: "http://127.0.0.1:8910/ref/audio/ref_ko_485.wav",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "voice switch test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));

		window.dispatchEvent(
			new CustomEvent("naia:voice-ref-url", {
				detail: "http://127.0.0.1:8910/ref/audio/male-20s-01.wav",
			}),
		);
		capturedRequests[0].onChunk({
			type: "text",
			requestId: capturedRequests[0].requestId,
			text: "The selected voice is active.",
		});

		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "naia-local-voice",
				voice: "male-20s-01.wav",
			}),
		);
		localStorage.removeItem("naia-config");
	});

	it("keeps the video avatar visible without synthesizing speech when TTS is off", async () => {
		const playAuthoredClip = vi.fn();
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => true,
				playAuthoredClip,
				setSpeakingVisual: vi.fn(),
				setVoice: vi.fn().mockResolvedValue(false),
				interrupt: vi.fn(),
				stop: vi.fn(),
			} as never,
		});
		ttsSyncMocks.streamsAvatarPcm.mockReturnValue(true);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: false,
				ttsProvider: "naia-local-voice",
				avatarProvider: "naia-video-avatar",
				nvaModel: "naia",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "silent avatar test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "The avatar remains visible without voice.",
		});

		await waitFor(() =>
			expect(
				screen.getByText("The avatar remains visible without voice."),
			).toBeDefined(),
		);
		expect(ttsSyncMocks.synthesizeTts).not.toHaveBeenCalled();
		expect(playAuthoredClip).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("serializes 6GB local sentence synthesis while playback queues independently", async () => {
		const firstTts = deferred<{ audioBase64: string; costUsd: number }>();
		const secondTts = deferred<{ audioBase64: string; costUsd: number }>();
		ttsSyncMocks.streamsAvatarPcm.mockReturnValue(false);
		ttsSyncMocks.wavDurationSeconds.mockReturnValue(0.001);
		ttsSyncMocks.synthesizeTts.mockImplementation(
			({ text }: { text: string }) =>
				text.startsWith("First") ? firstTts.promise : secondTts.promise,
		);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "voice queue test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "First sentence.",
		});
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Second sentence.",
		});

		await waitFor(() =>
			expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalledTimes(1),
		);
		expect(ttsSyncMocks.synthesizeTts.mock.calls[0][0].text).toBe(
			"First sentence.",
		);
		firstTts.resolve({ audioBase64: "audio-1", costUsd: 0 });

		await waitFor(() =>
			expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalledWith(
				0,
				"audio-1",
				expect.any(Object),
			),
		);
		expect(ttsSyncMocks.pauseBeforePlayback).toHaveBeenCalledTimes(1);
		expect(ttsSyncMocks.resumePlayback).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalledTimes(2),
		);
		expect(ttsSyncMocks.synthesizeTts.mock.calls[1][0].text).toBe(
			"Second sentence.",
		);
		secondTts.resolve({ audioBase64: "audio-2", costUsd: 0 });
		await waitFor(() =>
			expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalledWith(
				1,
				"audio-2",
				expect.any(Object),
			),
		);
		// FR-VOICE.19 (#519): with RTF>1 (cold engine) a later sentence no
		// longer releases playback — the warming hold survives until the whole
		// turn is synthesized after stream end (complete-then-play), so a
		// starved queue can never start mid-warmup.
		expect(ttsSyncMocks.resumePlayback).not.toHaveBeenCalled();
		request.onChunk({ type: "finish", requestId: request.requestId });
		await waitFor(() =>
			expect(ttsSyncMocks.resumePlayback).toHaveBeenCalledTimes(1),
		);
		localStorage.removeItem("naia-config");
	});

	it("reveals text without duplicate AudioQueue playback when media runtime fails", async () => {
		const playAuthoredClip = vi
			.fn()
			.mockImplementation(
				(_text: string, opts: { onPlaybackFailure?: () => void }) => {
					opts.onPlaybackFailure?.();
					return Promise.resolve();
				},
			);
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => true,
				playAuthoredClip,
				setSpeakingVisual: vi.fn(),
				setVoice: vi.fn().mockResolvedValue(false),
				interrupt: vi.fn(),
				stop: vi.fn(),
			} as never,
		});
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "failure test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Avatar failure sentence.",
		});

		await waitFor(() => expect(playAuthoredClip).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(screen.getByText("Avatar failure sentence.")).toBeDefined(),
		);
		expect(ttsSyncMocks.synthesizeTts).not.toHaveBeenCalled();
		expect(ttsSyncMocks.enqueueOrdered).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("reveals TTS chat text only when embedded avatar playback starts", async () => {
		const playback = deferred<void>();
		const interrupt = vi.fn();
		const playAuthoredClip = vi.fn(
			(_text: string, _options: { onPlaybackReady?: () => void }) =>
				playback.promise,
		);
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => true,
				playAuthoredClip,
				setSpeakingVisual: vi.fn(),
				setVoice: vi.fn().mockResolvedValue(false),
				interrupt,
				stop: vi.fn(),
			} as never,
		});
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "sync test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Visible with speech.",
		});

		await waitFor(() => expect(playAuthoredClip).toHaveBeenCalledTimes(1));
		expect(screen.queryByText("Visible with speech.")).toBeNull();
		expect(screen.getByRole("status").getAttribute("data-stage")).toBe(
			"render",
		);
		const playbackOptions = playAuthoredClip.mock.calls[0][1] as {
			onPlaybackReady?: () => void;
		};
		playbackOptions.onPlaybackReady?.();
		await waitFor(() =>
			expect(screen.getByText("Visible with speech.")).toBeDefined(),
		);
		expect(screen.queryByRole("status")).toBeNull();
		interrupt.mockClear();
		const cancel = screen.getByTitle("ESC");
		fireEvent.click(cancel);
		await waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.queryByTitle("ESC")).toBeNull());
		expect(useAvatarStore.getState().currentEmotion).toBe("neutral");
		expect(screen.getByText("Visible with speech.")).toBeDefined();

		playback.resolve();
		localStorage.removeItem("naia-config");
	});

	it("keeps the completed message masked and preserves CJK spacing across sentences", async () => {
		const playAuthoredClip = vi.fn().mockResolvedValue(undefined);
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => true,
				playAuthoredClip,
				setSpeakingVisual: vi.fn(),
				setVoice: vi.fn().mockResolvedValue(false),
				interrupt: vi.fn(),
				stop: vi.fn(),
			} as never,
		});
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "中文同步" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		const first = "这是第一句测试内容。";
		const second = "这是第二句测试内容。";
		let completedBeforePlayback = false;
		const completedObserver = new MutationObserver(() => {
			if (document.body.textContent?.includes(first + second)) {
				completedBeforePlayback = true;
			}
		});
		completedObserver.observe(document.body, {
			childList: true,
			characterData: true,
			subtree: true,
		});
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: first,
		});
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: second,
		});
		request.onChunk({
			type: "usage",
			requestId: request.requestId,
			inputTokens: 1,
			outputTokens: 2,
			cost: 0,
			model: "test",
		});
		request.onChunk({ type: "finish", requestId: request.requestId });

		await waitFor(() => expect(playAuthoredClip).toHaveBeenCalledTimes(2));
		expect(completedBeforePlayback).toBe(false);
		completedObserver.disconnect();
		expect(screen.queryByText(first + second)).toBeNull();
		const firstOptions = playAuthoredClip.mock.calls[0][1] as {
			onPlaybackReady?: () => void;
		};
		firstOptions.onPlaybackReady?.();
		await waitFor(() => expect(screen.getByText(first)).toBeDefined());
		expect(document.body.textContent).not.toContain(`${first} ${second}`);

		const secondOptions = playAuthoredClip.mock.calls[1][1] as {
			onPlaybackReady?: () => void;
		};
		secondOptions.onPlaybackReady?.();
		await waitFor(() =>
			expect(document.body.textContent).toContain(first + second),
		);
		expect(document.body.textContent).not.toContain(`${first} ${second}`);
		localStorage.removeItem("naia-config");
	});

	it("releases a completed answer when a playback-ready callback is lost", async () => {
		const playAuthoredClip = vi.fn().mockReturnValue(new Promise(() => {}));
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => true,
				playAuthoredClip,
				setSpeakingVisual: vi.fn(),
				setVoice: vi.fn().mockResolvedValue(false),
				interrupt: vi.fn(),
				stop: vi.fn(),
			} as never,
		});
		localStorage.setItem("naia-config", JSON.stringify({
			apiKey: "test-key", provider: "gemini", model: "gemini-2.5-flash",
			ttsEnabled: true, ttsProvider: "naia-local-voice", vllmTtsHost: "http://localhost:8910",
		}));

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "lost callback" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		const answer = "The complete answer must remain readable.";
		request.onChunk({ type: "text", requestId: request.requestId, text: answer });
		await waitFor(() => expect(playAuthoredClip).toHaveBeenCalledTimes(1));
		expect(screen.queryByText(answer)).toBeNull();

		vi.useFakeTimers();
		request.onChunk({ type: "finish", requestId: request.requestId });
		await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
		expect(screen.getByText(answer)).toBeDefined();
		vi.useRealTimers();
		localStorage.removeItem("naia-config");
	});

	it("does not retarget the completed-message mask to a later TTS failure notice", async () => {
		let rejectSynthesis!: (reason?: unknown) => void;
		const synthesis = new Promise<{ audioBase64: string; costUsd: number }>(
			(_resolve, reject) => {
				rejectSynthesis = reject;
			},
		);
		ttsSyncMocks.synthesizeTts.mockReturnValue(synthesis);
		ttsSyncMocks.streamsAvatarPcm.mockReturnValue(false);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "failure mask" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		const answer = "This sentence remains the answer.";
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: answer,
		});
		request.onChunk({
			type: "usage",
			requestId: request.requestId,
			inputTokens: 1,
			outputTokens: 2,
			cost: 0,
			model: "test",
		});
		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		request.onChunk({ type: "finish", requestId: request.requestId });
		expect(useAvatarStore.getState().currentEmotion).toBe("think");
		rejectSynthesis(new Error("voice offline"));

		await waitFor(() => expect(screen.getByText(answer)).toBeDefined());
		await waitFor(() =>
			expect(
				screen.getByText(/Can't reach the host voice engine/),
			).toBeDefined(),
		);
		await waitFor(() => expect(screen.getAllByText(answer)).toHaveLength(1));
		await waitFor(() =>
			expect(useAvatarStore.getState().currentEmotion).toBe("neutral"),
		);
		expect(screen.getByText(/Can't reach the host voice engine/)).toBeDefined();
		localStorage.removeItem("naia-config");
	});

	it("reports VoxCPM2 startup instead of an unreachable engine while cascade is starting", async () => {
		ttsSyncMocks.synthesizeTts.mockRejectedValue(new Error("voice starting"));
		mockInvoke.mockImplementation((command: string) =>
			Promise.resolve(
				command === "voxcpm2_runtime_status" ? "starting" : undefined,
			),
		);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "startup state" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "This sentence waits for the model.",
		});

		await waitFor(() =>
			expect(screen.getByText(/host voice model is starting/i)).toBeDefined(),
		);
		expect(screen.queryByText(/Can't reach the host voice engine/)).toBeNull();
		localStorage.removeItem("naia-config");
	});

	it("does not synthesize stale fallback audio after a media runtime interrupt", async () => {
		const playback = deferred<void>();
		let playbackFailure = () => {};
		const interrupt = vi.fn();
		const playAuthoredClip = vi.fn(
			(_text: string, opts: { onPlaybackFailure?: () => void }) => {
				playbackFailure = opts.onPlaybackFailure ?? (() => {});
				return playback.promise;
			},
		);
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => true,
				playAuthoredClip,
				setSpeakingVisual: vi.fn(),
				setVoice: vi.fn().mockResolvedValue(false),
				interrupt,
				stop: vi.fn(),
			} as never,
		});
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "interrupt test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Interrupted sentence.",
		});
		await waitFor(() => expect(playAuthoredClip).toHaveBeenCalledTimes(1));
		interrupt.mockClear();
		const cancel = screen.getByTitle("ESC");
		fireEvent.click(cancel);
		await waitFor(() => expect(screen.queryByTitle("ESC")).toBeNull());
		expect(interrupt).toHaveBeenCalledTimes(1);
		playbackFailure();
		playback.resolve();
		await Promise.resolve();
		expect(ttsSyncMocks.synthesizeTts).not.toHaveBeenCalled();
		expect(ttsSyncMocks.enqueueOrdered).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("does not hydrate stale Gateway history over the local conversation", async () => {
		// A completed first turn must remain the source of the second request.
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ discordSessionMigrated: true }),
		);
		const { getGatewayHistory } = await import("../../lib/gateway-sessions");
		(getGatewayHistory as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			{
				id: "gw-1",
				role: "user",
				content: "이전 메시지",
				timestamp: 1000,
			},
			{
				id: "gw-2",
				role: "assistant",
				content: "이전 응답",
				timestamp: 2000,
			},
		]);

		render(<ChatArea />);
		await new Promise((r) => setTimeout(r, 100));

		const state = useChatStore.getState();
		expect(state.sessionId).toBe("agent:main:main");
		expect(getGatewayHistory).not.toHaveBeenCalled();
		expect(state.messages).toHaveLength(0);

		localStorage.removeItem("naia-config");
	});

	it("renders new conversation button", () => {
		render(<ChatArea />);
		const btn = screen.getByTitle(/새 대화|New Chat/);
		expect(btn).toBeDefined();
		expect(btn.textContent).toBe("+");
	});

	it("new conversation resets messages", async () => {
		// Pre-populate some state
		useChatStore.setState({
			sessionId: "agent:main:main",
			messages: [
				{
					id: "m1",
					role: "user",
					content: "old",
					timestamp: 1000,
				},
			],
		});

		render(<ChatArea />);
		const btn = screen.getByTitle(/새 대화|New Chat/);
		fireEvent.click(btn);

		await new Promise((r) => setTimeout(r, 100));

		const state = useChatStore.getState();
		expect(state.messages).toHaveLength(0);
		expect(state.sessionId).toBe("agent:main:main");
	});

	it("recalls previous input with ArrowUp", async () => {
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(
			/메시지|message/i,
		) as HTMLTextAreaElement;

		// Send two messages
		fireEvent.change(input, { target: { value: "첫번째" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await new Promise((r) => setTimeout(r, 50));

		fireEvent.change(input, { target: { value: "두번째" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await new Promise((r) => setTimeout(r, 50));

		// Input should be empty after send
		expect(input.value).toBe("");

		// ArrowUp should recall "두번째" (most recent)
		// Set selectionStart/End to 0 for empty input
		Object.defineProperty(input, "selectionStart", {
			value: 0,
			writable: true,
		});
		Object.defineProperty(input, "selectionEnd", { value: 0, writable: true });
		fireEvent.keyDown(input, { key: "ArrowUp" });
		await new Promise((r) => setTimeout(r, 50));
		expect(input.value).toBe("두번째");
	});

	it("navigates history with ArrowUp/ArrowDown and restores draft", async () => {
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(
			/메시지|message/i,
		) as HTMLTextAreaElement;

		// Send two messages
		fireEvent.change(input, { target: { value: "첫번째" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await new Promise((r) => setTimeout(r, 50));

		fireEvent.change(input, { target: { value: "두번째" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await new Promise((r) => setTimeout(r, 50));

		// Type a draft (not sent)
		fireEvent.change(input, { target: { value: "작성 중" } });

		// Set cursor to position 0 for ArrowUp to work
		Object.defineProperty(input, "selectionStart", {
			value: 0,
			writable: true,
		});
		Object.defineProperty(input, "selectionEnd", { value: 0, writable: true });

		// ArrowUp → most recent ("두번째")
		fireEvent.keyDown(input, { key: "ArrowUp" });
		await new Promise((r) => setTimeout(r, 50));
		expect(input.value).toBe("두번째");

		// ArrowUp → older ("첫번째")
		fireEvent.keyDown(input, { key: "ArrowUp" });
		await new Promise((r) => setTimeout(r, 50));
		expect(input.value).toBe("첫번째");

		// ArrowDown → back to "두번째"
		fireEvent.keyDown(input, { key: "ArrowDown" });
		await new Promise((r) => setTimeout(r, 50));
		expect(input.value).toBe("두번째");

		// ArrowDown → restore draft "작성 중"
		fireEvent.keyDown(input, { key: "ArrowDown" });
		await new Promise((r) => setTimeout(r, 50));
		expect(input.value).toBe("작성 중");
	});

	it("ArrowDown does nothing when not browsing history", () => {
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(
			/메시지|message/i,
		) as HTMLTextAreaElement;

		fireEvent.change(input, { target: { value: "some text" } });
		fireEvent.keyDown(input, { key: "ArrowDown" });
		// Value should remain unchanged
		expect(input.value).toBe("some text");
	});
});
