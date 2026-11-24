import { ttsSyncMocks, capturedRequests, mockInvoke } from "./chat-area-fixture";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { fetchAgentSkills } from "../../lib/chat-service";
import { SLIDE_PRESENTER_SPEAK_EVENT } from "../../lib/slide-presenter-events";
import { useChatStore } from "../../stores/chat";
import { ChatArea } from "../ChatArea";

export function registerChatAreaCases07() {
	it("does not hydrate stale Gateway history over the local conversation", async () => {
		// A completed first turn must remain the source of the second request.
		localStorage.setItem("naia-config", JSON.stringify({}));
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

	it("restores current conversation messages on mount when stored key and transcript exist", async () => {
		sessionStorage.setItem("naia-chat-session-id", "chat-mount-restore-test");
		const jsonl = [
			JSON.stringify({
				role: "user",
				content: "복원된 메시지",
				timestamp: 1000,
			}),
			JSON.stringify({
				role: "assistant",
				content: "복원된 답변",
				timestamp: 1001,
			}),
		].join("\n");
		mockInvoke.mockImplementation((cmd, args) => {
			if (
				cmd === "read_conversation" &&
				args?.sessionId === "chat-mount-restore-test"
			) {
				return Promise.resolve(jsonl);
			}
			return Promise.resolve(undefined);
		});

		render(<ChatArea />);
		await waitFor(() => {
			expect(screen.getByText("복원된 메시지")).toBeDefined();
			expect(screen.getByText("복원된 답변")).toBeDefined();
		});

		const state = useChatStore.getState();
		expect(state.localSessionId).toBe("chat-mount-restore-test");
		expect(state.sessionId).toBe("agent:main:main");
		expect(state.messages).toHaveLength(2);
		expect(state.messages[0].content).toBe("복원된 메시지");
		expect(state.messages[1].content).toBe("복원된 답변");
		sessionStorage.removeItem("naia-chat-session-id");
	});

	it("keeps stored key and shows empty messages on mount when no transcript exists", async () => {
		sessionStorage.setItem(
			"naia-chat-session-id",
			"chat-fresh-key-no-transcript",
		);
		mockInvoke.mockImplementation((cmd) => {
			if (cmd === "read_conversation") {
				return Promise.resolve("");
			}
			return Promise.resolve(undefined);
		});

		render(<ChatArea />);
		await new Promise((r) => setTimeout(r, 100));

		const state = useChatStore.getState();
		expect(state.localSessionId).toBe("chat-fresh-key-no-transcript");
		expect(state.sessionId).toBe("agent:main:main");
		expect(state.messages).toHaveLength(0);
		sessionStorage.removeItem("naia-chat-session-id");
	});

	it("new conversation button replaces stored key in sessionStorage and resets messages", async () => {
		sessionStorage.setItem("naia-chat-session-id", "chat-previous-session");
		useChatStore.setState({
			sessionId: "agent:main:main",
			localSessionId: "chat-previous-session",
			messages: [
				{
					id: "m1",
					role: "user",
					content: "이전 대화",
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
		expect(state.localSessionId).not.toBe("chat-previous-session");
		expect(state.localSessionId.startsWith("chat-")).toBe(true);
		expect(sessionStorage.getItem("naia-chat-session-id")).toBe(
			state.localSessionId,
		);
		sessionStorage.removeItem("naia-chat-session-id");
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

	it("splits slide narration into sentences instead of one page-sized request", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "nextain",
			}),
		);
		render(<ChatArea />);
		window.dispatchEvent(
			new CustomEvent(SLIDE_PRESENTER_SPEAK_EVENT, {
				detail: {
					requestId: "slide-speak-1",
					generation: 1,
					page: 3,
					text: "첫 문장입니다. 둘째 문장입니다. 셋째 문장입니다.",
				},
			}),
		);
		// One request per sentence — the first one can play while the rest
		// are still being synthesized.
		await waitFor(() =>
			expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalledTimes(3),
		);
		expect(
			ttsSyncMocks.synthesizeTts.mock.calls.map((call: any[]) => call[0].text),
		).toEqual(["첫 문장입니다.", "둘째 문장입니다.", "셋째 문장입니다."]);
		localStorage.removeItem("naia-config");
	});

	it("offers knowledge tools and filters non-model tools on both turn 1 and turn 2", async () => {
		vi.mocked(fetchAgentSkills).mockResolvedValue([
			{ name: "skill_knowledge_ask", description: "ask", parameters: {} },
			{ name: "skill_memory_recall", description: "recall", parameters: {} },
			{ name: "shell_exec", description: "exec", parameters: {} },
		]);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				enableTools: true,
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);

		fireEvent.change(input, { target: { value: "Turn 1 message" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		capturedRequests[0].onChunk({
			type: "finish",
			requestId: capturedRequests[0].requestId,
		});

		fireEvent.change(input, { target: { value: "Turn 2 message" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(2));
		capturedRequests[1].onChunk({
			type: "finish",
			requestId: capturedRequests[1].requestId,
		});

		expect(capturedRequests[0].enableTools).toBe(true);
		expect(capturedRequests[0].disabledSkills).toContain("shell_exec");
		expect(capturedRequests[0].disabledSkills).not.toContain(
			"skill_knowledge_ask",
		);

		expect(capturedRequests[1].enableTools).toBe(true);
		expect(capturedRequests[1].disabledSkills).toContain("shell_exec");
		expect(capturedRequests[1].disabledSkills).not.toContain(
			"skill_knowledge_ask",
		);

		localStorage.removeItem("naia-config");
	});

	it("disables tools on first send when fetchAgentSkills rejects", async () => {
		vi.mocked(fetchAgentSkills).mockRejectedValue(new Error("Agent offline"));
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				enableTools: true,
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);

		fireEvent.change(input, { target: { value: "Hello" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		expect(capturedRequests[0].enableTools).toBe(false);

		capturedRequests[0].onChunk({
			type: "finish",
			requestId: capturedRequests[0].requestId,
		});
		localStorage.removeItem("naia-config");
	});

	it("sends thinking { level: 'high' } and enableThinking: true when thinkingLevel is high (#709 / FR-CHAT-THINKING.5)", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				thinkingLevel: "high",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "Hello High" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() =>
			expect(capturedRequests.length).toBeGreaterThanOrEqual(1),
		);
		const lastReq = capturedRequests[capturedRequests.length - 1];
		expect(lastReq.thinking).toEqual({ level: "high" });
		expect(lastReq.enableThinking).toBe(true);

		lastReq.onChunk({ type: "finish", requestId: lastReq.requestId });
		localStorage.removeItem("naia-config");
	});

	it("sends thinking { level: 'off' } and enableThinking: false by default (#709 / FR-CHAT-THINKING.5)", async () => {
		useChatStore.setState(useChatStore.getInitialState());
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
		fireEvent.change(input, { target: { value: "Hello Off" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() =>
			expect(capturedRequests.length).toBeGreaterThanOrEqual(1),
		);
		const lastReq = capturedRequests[capturedRequests.length - 1];
		expect(lastReq.thinking).toEqual({ level: "off" });
		expect(lastReq.enableThinking).toBe(false);

		lastReq.onChunk({ type: "finish", requestId: lastReq.requestId });
		localStorage.removeItem("naia-config");
	});
}
