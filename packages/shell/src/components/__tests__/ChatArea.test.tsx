import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentResponseChunk } from "../../lib/types";
import { useAvatarStore } from "../../stores/avatar";
import { useChatStore } from "../../stores/chat";
import { ChatArea } from "../ChatArea";

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
	sendApprovalResponse: vi.fn().mockResolvedValue(undefined),
	sendPanelToolResult: vi.fn().mockResolvedValue(undefined),
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
	});

	it("renders input field and buttons", () => {
		render(<ChatArea />);
		expect(screen.getByPlaceholderText(/메시지|message/i)).toBeDefined();
		const buttons = screen.getAllByRole("button");
		expect(buttons.length).toBeGreaterThanOrEqual(2);
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
