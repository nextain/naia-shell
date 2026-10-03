import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../../stores/chat";

// Mock conversation-store module (로컬 transcript read — 죽은 gateway-sessions directToolCall 대체, FR-CONV.4)
const mockListConversations = vi.fn();
const mockGetConversationHistory = vi.fn();
const mockDeleteConversation = vi.fn();

vi.mock("../../lib/conversation-store", () => ({
	listConversations: (...args: unknown[]) => mockListConversations(...args),
	getConversationHistory: (...args: unknown[]) => mockGetConversationHistory(...args),
	deleteConversation: (...args: unknown[]) => mockDeleteConversation(...args),
}));

// Import after mocks
import { HistoryTab } from "../HistoryTab";

describe("HistoryTab", () => {
	const onLoadSession = vi.fn();

	afterEach(() => {
		cleanup();
		mockListConversations.mockReset();
		mockGetConversationHistory.mockReset();
		mockDeleteConversation.mockReset();
		onLoadSession.mockReset();
		useChatStore.setState(useChatStore.getInitialState());
	});

	it("shows empty state when no sessions", async () => {
		mockListConversations.mockResolvedValue([]);
		render(<HistoryTab onLoadSession={onLoadSession} />);
		await waitFor(() => {
			expect(screen.getByText(/대화 기록이 없|No conversation/)).toBeDefined();
		});
	});

	it("shows error state when agent is unreachable", async () => {
		mockListConversations.mockRejectedValue(new Error("agent-unreachable"));
		render(<HistoryTab onLoadSession={onLoadSession} />);
		await waitFor(() => {
			expect(screen.getByText(/에이전트에 연결할 수 없|Cannot connect/)).toBeDefined();
			// Retry button visible
			expect(screen.getByRole("button", { name: /다시 시도|Retry/i })).toBeDefined();
		});
	});

	it("retries loading when retry button is clicked", async () => {
		mockListConversations
			.mockRejectedValueOnce(new Error("agent-unreachable"))
			.mockResolvedValueOnce([
				{
					key: "agent:main:main",
					label: "Recovered Session",
					messageCount: 2,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			]);
		render(<HistoryTab onLoadSession={onLoadSession} />);
		await waitFor(() => {
			expect(screen.getByRole("button", { name: /다시 시도|Retry/i })).toBeDefined();
		});

		fireEvent.click(screen.getByRole("button", { name: /다시 시도|Retry/i }));

		await waitFor(() => {
			expect(screen.getByText("Recovered Session")).toBeDefined();
		});
	});

	it("renders session list", async () => {
		mockListConversations.mockResolvedValue([
			{
				key: "agent:main:main",
				label: "Test Session",
				messageCount: 5,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		]);

		render(<HistoryTab onLoadSession={onLoadSession} />);
		await waitFor(() => {
			expect(screen.getByText("Test Session")).toBeDefined();
		});
	});

	it("hides legacy channel sessions from the list", async () => {
		mockListConversations.mockResolvedValue([
			{
				key: "agent:main:main",
				label: "Keep Me",
				messageCount: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
			{
				key: "discord:dm:456",
				label: "Legacy Channel",
				messageCount: 3,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
			{
				key: "agent:main:discord:direct:865850174651498506",
				label: "Legacy Peer",
				messageCount: 2,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		]);

		render(<HistoryTab onLoadSession={onLoadSession} />);
		await waitFor(() => {
			expect(screen.getByText("Keep Me")).toBeDefined();
		});
		expect(screen.queryByText("Legacy Channel")).toBeNull();
		expect(screen.queryByText("Legacy Peer")).toBeNull();
	});

	it("marks current session by localSessionId", async () => {
		useChatStore.setState({ localSessionId: "chat-1234", sessionId: "agent:main:main" });
		mockListConversations.mockResolvedValue([
			{
				key: "chat-1234",
				label: "Current",
				messageCount: 3,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		]);

		const { container } = render(<HistoryTab onLoadSession={onLoadSession} />);
		await waitFor(() => {
			const current = container.querySelector(".history-item.current");
			expect(current).not.toBeNull();
		});
	});

	it("does not reload when clicking current session", async () => {
		useChatStore.setState({ localSessionId: "chat-1234", sessionId: "agent:main:main" });
		mockListConversations.mockResolvedValue([
			{
				key: "chat-1234",
				label: "Current Chat",
				messageCount: 2,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		]);

		render(<HistoryTab onLoadSession={onLoadSession} />);
		await waitFor(() => {
			expect(screen.getByText("Current Chat")).toBeDefined();
		});

		fireEvent.click(screen.getByText("Current Chat"));
		expect(mockGetConversationHistory).not.toHaveBeenCalled();
		expect(onLoadSession).not.toHaveBeenCalled();
	});

	it("loads regular session on click", async () => {
		useChatStore.setState({ localSessionId: "chat-1234", sessionId: "agent:main:main" });
		mockListConversations.mockResolvedValue([
			{
				key: "chat-abc",
				label: "Regular Chat",
				messageCount: 2,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		]);
		mockGetConversationHistory.mockResolvedValue([
			{
				id: "gw-1",
				role: "user",
				content: "Hello",
				timestamp: 1000,
			},
		]);

		render(<HistoryTab onLoadSession={onLoadSession} />);
		await waitFor(() => {
			expect(screen.getByText("Regular Chat")).toBeDefined();
		});

		fireEvent.click(screen.getByText("Regular Chat"));

		await waitFor(() => {
			expect(onLoadSession).toHaveBeenCalled();
			const state = useChatStore.getState();
			expect(state.localSessionId).toBe("chat-abc");
			expect(state.sessionId).toBe("agent:main:main");
			expect(state.messages).toHaveLength(1);
		});
	});

	it("resets chat when current session is deleted", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		useChatStore.setState({
			localSessionId: "chat-current",
			sessionId: "agent:main:main",
			messages: [
				{ id: "m1", role: "user", content: "active message", timestamp: 1000 },
			],
		});
		mockListConversations.mockResolvedValue([
			{
				key: "chat-current",
				label: "Current To Delete",
				messageCount: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		]);
		mockDeleteConversation.mockResolvedValue(true);

		const { container } = render(<HistoryTab onLoadSession={onLoadSession} />);
		await waitFor(() => {
			expect(screen.getByText("Current To Delete")).toBeDefined();
		});

		const deleteBtn = container.querySelector(".history-delete-btn");
		expect(deleteBtn).not.toBeNull();
		fireEvent.click(deleteBtn!);

		await waitFor(() => {
			expect(mockDeleteConversation).toHaveBeenCalledWith("chat-current");
		});

		const state = useChatStore.getState();
		expect(state.messages).toHaveLength(0);
		expect(state.localSessionId).not.toBe("chat-current");
		expect(state.sessionId).toBe("agent:main:main");
	});

	it("deletes session on confirm", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		mockListConversations.mockResolvedValue([
			{
				key: "agent:main:old",
				label: "To Delete",
				messageCount: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		]);
		mockDeleteConversation.mockResolvedValue(true);

		const { container } = render(<HistoryTab onLoadSession={onLoadSession} />);
		await waitFor(() => {
			expect(screen.getByText("To Delete")).toBeDefined();
		});

		const deleteBtn = container.querySelector(".history-delete-btn");
		expect(deleteBtn).not.toBeNull();
		fireEvent.click(deleteBtn!);

		await waitFor(() => {
			expect(mockDeleteConversation).toHaveBeenCalledWith("agent:main:old");
		});
	});

	it("preserves session, messages, costs, list, and summaries when deleteConversation fails, but discards on success (#727 Defect 2)", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		const key = "chat-fail-test";
		useChatStore.setState({
			localSessionId: key,
			sessionId: "agent:main:main",
			totalSessionCost: 0.05,
			messages: [
				{ id: "m1", role: "user", content: "saved message", timestamp: 1000 },
			],
		});
		useChatStore.getState().recordVoiceCostSummary(key, {
			role: "assistant",
			content: "Voice cost 1",
			cost: { cost: 0.01, inputTokens: 1, outputTokens: 1, provider: "test-provider", model: "test-model" },
		});

		mockListConversations.mockResolvedValue([
			{
				key,
				label: "Fail Target",
				messageCount: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		]);
		// Simulate delete failure (IPC error or backend false)
		mockDeleteConversation.mockResolvedValue(false);

		const { container } = render(<HistoryTab onLoadSession={onLoadSession} />);
		await waitFor(() => {
			expect(screen.getByText("Fail Target")).toBeDefined();
		});

		const deleteBtn = container.querySelector(".history-delete-btn");
		expect(deleteBtn).not.toBeNull();
		fireEvent.click(deleteBtn!);

		await waitFor(() => {
			expect(mockDeleteConversation).toHaveBeenCalledWith(key);
		});

		// Check preservation after deletion failure
		const stateAfterFailure = useChatStore.getState();
		expect(stateAfterFailure.localSessionId).toBe(key);
		expect(stateAfterFailure.messages.length).toBeGreaterThanOrEqual(1);
		expect(stateAfterFailure.totalSessionCost).toBeGreaterThan(0);
		expect(screen.getByText("Fail Target")).toBeDefined();

		// Subsequent voice summary must NOT be blocked
		useChatStore.getState().recordVoiceCostSummary(key, {
			role: "assistant",
			content: "Voice cost 2",
			cost: { cost: 0.02, inputTokens: 2, outputTokens: 2, provider: "test-provider", model: "test-model" },
		});
		const overlayAfterFollowup = useChatStore.getState().sessionOverlays[key];
		expect(overlayAfterFollowup?.deleted).toBeFalsy();
		expect(overlayAfterFollowup?.messages.length).toBe(2);

		// Now simulate delete success
		mockDeleteConversation.mockResolvedValue(true);
		fireEvent.click(deleteBtn!);

		await waitFor(() => {
			expect(screen.queryByText("Fail Target")).toBeNull();
		});

		const stateAfterSuccess = useChatStore.getState();
		expect(stateAfterSuccess.localSessionId).not.toBe(key);
		const overlayAfterSuccess = useChatStore.getState().sessionOverlays[key];
		expect(overlayAfterSuccess?.deleted).toBe(true);

		// Subsequent voice summary is now discarded
		useChatStore.getState().recordVoiceCostSummary(key, {
			role: "assistant",
			content: "Voice cost 3",
			cost: { cost: 0.03, inputTokens: 3, outputTokens: 3, provider: "test-provider", model: "test-model" },
		});
		expect(useChatStore.getState().sessionOverlays[key]?.messages.length).toBe(0);
	});
});
