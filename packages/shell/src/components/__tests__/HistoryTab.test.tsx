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

	it("marks current session", async () => {
		useChatStore.setState({ sessionId: "agent:main:main" });
		mockListConversations.mockResolvedValue([
			{
				key: "agent:main:main",
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

	it("loads regular session on click", async () => {
		mockListConversations.mockResolvedValue([
			{
				key: "agent:main:abc",
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
			expect(state.sessionId).toBe("agent:main:abc");
			expect(state.messages).toHaveLength(1);
		});
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
});
