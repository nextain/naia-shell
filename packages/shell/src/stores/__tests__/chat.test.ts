import { afterEach, describe, expect, it } from "vitest";
import { useChatStore } from "../chat";

describe("useChatStore", () => {
	afterEach(() => {
		useChatStore.setState(useChatStore.getInitialState());
	});

	it("has correct initial state", () => {
		const state = useChatStore.getState();
		expect(state.sessionId).toBeNull();
		expect(state.messages).toEqual([]);
		expect(state.isStreaming).toBe(false);
		expect(state.streamingContent).toBe("");
		expect(state.provider).toBe("gemini");
		expect(state.totalSessionCost).toBe(0);
	});

	// === Session management ===

	it("setSessionId sets the session id", () => {
		useChatStore.getState().setSessionId("s1");
		expect(useChatStore.getState().sessionId).toBe("s1");
	});

	it("setMessages replaces all messages", () => {
		const store = useChatStore.getState();
		store.setMessages([
			{
				id: "m1",
				role: "user",
				content: "restored",
				timestamp: 1000,
			},
		]);
		const { messages } = useChatStore.getState();
		expect(messages).toHaveLength(1);
		expect(messages[0].content).toBe("restored");
	});

	it("newConversation resets all state except provider", () => {
		const store = useChatStore.getState();
		store.setSessionId("s1");
		store.addMessage({ role: "user", content: "hi" });
		store.setProvider("xai");

		store.newConversation();

		const state = useChatStore.getState();
		expect(state.sessionId).toBeNull();
		expect(state.messages).toEqual([]);
		expect(state.totalSessionCost).toBe(0);
		// provider is preserved (not reset by newConversation)
		expect(state.provider).toBe("xai");
	});

	it("addMessage adds user message", () => {
		const { addMessage } = useChatStore.getState();
		addMessage({ role: "user", content: "Hello" });
		const { messages } = useChatStore.getState();
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("user");
		expect(messages[0].content).toBe("Hello");
		expect(messages[0].id).toBeDefined();
		expect(messages[0].timestamp).toBeDefined();
	});

	it("addMessage adds assistant message", () => {
		const { addMessage } = useChatStore.getState();
		addMessage({ role: "assistant", content: "Hi there!" });
		const { messages } = useChatStore.getState();
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("assistant");
		expect(messages[0].content).toBe("Hi there!");
	});

	it("startStreaming sets streaming state", () => {
		const { startStreaming } = useChatStore.getState();
		startStreaming();
		const state = useChatStore.getState();
		expect(state.isStreaming).toBe(true);
		expect(state.streamingContent).toBe("");
	});

	it("appendStreamChunk accumulates content", () => {
		const store = useChatStore.getState();
		store.startStreaming();
		store.appendStreamChunk("Hello ");
		expect(useChatStore.getState().streamingContent).toBe("Hello ");
		store.appendStreamChunk("world!");
		expect(useChatStore.getState().streamingContent).toBe("Hello world!");
	});

	it("finishStreaming creates assistant message and resets", () => {
		const store = useChatStore.getState();
		store.startStreaming();
		store.appendStreamChunk("Final answer");
		store.finishStreaming();

		const state = useChatStore.getState();
		expect(state.isStreaming).toBe(false);
		expect(state.streamingContent).toBe("");
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0].role).toBe("assistant");
		expect(state.messages[0].content).toBe("Final answer");
	});

	it("finishStreaming does nothing when not streaming", () => {
		const store = useChatStore.getState();
		store.finishStreaming();
		expect(useChatStore.getState().messages).toHaveLength(0);
	});

	it("addCostEntry accumulates totalSessionCost", () => {
		const store = useChatStore.getState();
		store.addCostEntry({
			inputTokens: 100,
			outputTokens: 50,
			cost: 0.001,
			provider: "gemini",
			model: "gemini-2.5-flash",
		});
		expect(useChatStore.getState().totalSessionCost).toBe(0.001);

		store.addCostEntry({
			inputTokens: 200,
			outputTokens: 100,
			cost: 0.002,
			provider: "gemini",
			model: "gemini-2.5-flash",
		});
		expect(useChatStore.getState().totalSessionCost).toBe(0.003);
	});

	it("addCostEntry attaches cost to last assistant message", () => {
		const store = useChatStore.getState();
		store.addMessage({ role: "assistant", content: "response" });
		store.addCostEntry({
			inputTokens: 100,
			outputTokens: 50,
			cost: 0.001,
			provider: "gemini",
			model: "gemini-2.5-flash",
		});
		const msg = useChatStore.getState().messages[0];
		expect(msg.cost).toEqual({
			inputTokens: 100,
			outputTokens: 50,
			cost: 0.001,
			provider: "gemini",
			model: "gemini-2.5-flash",
		});
	});

	it("setProvider changes active provider", () => {
		useChatStore.getState().setProvider("xai");
		expect(useChatStore.getState().provider).toBe("xai");
	});

	// === Tool call tracking ===

	it("has empty streamingToolCalls initially", () => {
		expect(useChatStore.getState().streamingToolCalls).toEqual([]);
	});

	it("startStreaming resets streamingToolCalls", () => {
		const store = useChatStore.getState();
		store.addStreamingToolUse("tc-1", "read_file", { path: "/a" });
		store.startStreaming();
		expect(useChatStore.getState().streamingToolCalls).toEqual([]);
	});

	it("addStreamingToolUse adds a running tool call", () => {
		const store = useChatStore.getState();
		store.addStreamingToolUse("tc-1", "execute_command", {
			command: "ls",
		});
		const calls = useChatStore.getState().streamingToolCalls;
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			toolCallId: "tc-1",
			toolName: "execute_command",
			args: { command: "ls" },
			status: "running",
		});
	});

	it("updateStreamingToolResult updates status and output", () => {
		const store = useChatStore.getState();
		store.addStreamingToolUse("tc-1", "read_file", { path: "/a" });
		store.updateStreamingToolResult("tc-1", true, "file contents");
		const calls = useChatStore.getState().streamingToolCalls;
		expect(calls[0].status).toBe("success");
		expect(calls[0].output).toBe("file contents");
	});

	it("updateStreamingToolResult sets error status on failure", () => {
		const store = useChatStore.getState();
		store.addStreamingToolUse("tc-1", "write_file", { path: "/b" });
		store.updateStreamingToolResult("tc-1", false, "permission denied");
		const calls = useChatStore.getState().streamingToolCalls;
		expect(calls[0].status).toBe("error");
		expect(calls[0].output).toBe("permission denied");
	});

	it("finishStreaming includes toolCalls in the message", () => {
		const store = useChatStore.getState();
		store.startStreaming();
		store.appendStreamChunk("result");
		store.addStreamingToolUse("tc-1", "web_search", { query: "test" });
		store.updateStreamingToolResult("tc-1", true, "results");
		store.finishStreaming();

		const msg = useChatStore.getState().messages[0];
		expect(msg.toolCalls).toHaveLength(1);
		expect(msg.toolCalls?.[0].toolCallId).toBe("tc-1");
		expect(msg.toolCalls?.[0].status).toBe("success");
	});

	it("finishStreaming omits toolCalls when empty", () => {
		const store = useChatStore.getState();
		store.startStreaming();
		store.appendStreamChunk("no tools");
		store.finishStreaming();

		const msg = useChatStore.getState().messages[0];
		expect(msg.toolCalls).toBeUndefined();
	});

	it("addStreamingToolUse deduplicates by toolCallId", () => {
		const store = useChatStore.getState();
		store.addStreamingToolUse("tc-1", "read_file", { path: "/a" });
		store.addStreamingToolUse("tc-1", "read_file", { path: "/a" });
		expect(useChatStore.getState().streamingToolCalls).toHaveLength(1);
	});

	it("updateStreamingToolResult ignores unknown toolCallId", () => {
		const store = useChatStore.getState();
		store.updateStreamingToolResult("unknown-id", true, "data");
		// No crash, no state change
		expect(useChatStore.getState().streamingToolCalls).toEqual([]);
	});

	// === Pending approval ===

	it("has null pendingApproval initially", () => {
		expect(useChatStore.getState().pendingApproval).toBeNull();
	});

	it("setPendingApproval sets the approval data", () => {
		const store = useChatStore.getState();
		store.setPendingApproval({
			requestId: "req-1",
			toolCallId: "tc-1",
			toolName: "execute_command",
			args: { command: "ls" },
			tier: 2,
			description: "명령 실행: ls",
		});
		const pa = useChatStore.getState().pendingApproval;
		expect(pa).not.toBeNull();
		expect(pa?.toolName).toBe("execute_command");
		expect(pa?.tier).toBe(2);
	});

	it("clearPendingApproval resets to null", () => {
		const store = useChatStore.getState();
		store.setPendingApproval({
			requestId: "req-1",
			toolCallId: "tc-1",
			toolName: "write_file",
			args: { path: "/tmp/x" },
			tier: 1,
			description: "파일 쓰기: /tmp/x",
		});
		store.clearPendingApproval();
		expect(useChatStore.getState().pendingApproval).toBeNull();
	});

	it("finishStreaming clears pendingApproval", () => {
		const store = useChatStore.getState();
		store.startStreaming();
		store.setPendingApproval({
			requestId: "req-1",
			toolCallId: "tc-1",
			toolName: "write_file",
			args: {},
			tier: 1,
			description: "test",
		});
		store.appendStreamChunk("done");
		store.finishStreaming();
		expect(useChatStore.getState().pendingApproval).toBeNull();
	});
});
