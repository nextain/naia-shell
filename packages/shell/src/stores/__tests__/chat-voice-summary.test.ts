// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { useChatStore } from "../chat";

describe("Voice cost summary conversation binding (#727)", () => {
	beforeEach(() => {
		useChatStore.setState({
			sessionOverlays: {},
			messages: [],
			totalSessionCost: 0,
			totalSessionCostNaia: 0,
		});
		useChatStore.getState().newConversation();
	});

	it("switched to new conversation during query does not attach summary to new conversation", () => {
		const store = useChatStore.getState();
		store.setLocalSessionId("session-a");

		// User starts a new conversation before async pricing returns
		store.newConversation();
		expect(useChatStore.getState().localSessionId).not.toBe("session-a");

		useChatStore.getState().recordVoiceCostSummary("session-a", {
			role: "assistant",
			content: "🎙️ 45s · 약 12 크레딧",
			cost: {
				provider: "nextain",
				model: "naia-omni",
				inputTokens: 0,
				outputTokens: 0,
				cost: 0.012,
			},
		});

		// Active new conversation must remain clean
		expect(useChatStore.getState().messages).toHaveLength(0);
		expect(useChatStore.getState().totalSessionCost).toBe(0);
	});

	it("switched to another existing conversation during query does not attach summary to active conversation", () => {
		const store = useChatStore.getState();
		store.setLocalSessionId("session-a");

		// User loads session-b
		store.setLocalSessionId("session-b");
		store.setMessages([]);

		useChatStore.getState().recordVoiceCostSummary("session-a", {
			role: "assistant",
			content: "🎙️ 45s · 약 12 크레딧",
			cost: {
				provider: "nextain",
				model: "naia-omni",
				inputTokens: 0,
				outputTokens: 0,
				cost: 0.012,
			},
		});

		// Active session-b must remain clean
		expect(useChatStore.getState().messages).toHaveLength(0);
		expect(useChatStore.getState().totalSessionCost).toBe(0);
	});

	it("reopening original conversation restores voice summary and cost", () => {
		const store = useChatStore.getState();
		store.setLocalSessionId("session-a");

		// User switches to session-b
		store.setLocalSessionId("session-b");
		store.setMessages([]);

		// Voice summary arrives for session-a
		useChatStore.getState().recordVoiceCostSummary("session-a", {
			role: "assistant",
			content: "🎙️ 45s · 약 12 크레딧",
			cost: {
				provider: "nextain",
				model: "naia-omni",
				inputTokens: 0,
				outputTokens: 0,
				cost: 0.012,
			},
		});

		// Now user returns to session-a
		store.newConversation();
		store.setLocalSessionId("session-a");
		store.setMessages([]);

		expect(useChatStore.getState().messages).toHaveLength(1);
		expect(useChatStore.getState().messages[0].content).toContain("45s · 약 12 크레딧");
		expect(useChatStore.getState().totalSessionCost).toBe(0.012);
		expect(useChatStore.getState().totalSessionCostNaia).toBe(0.012);
	});

	it("response is dropped when target conversation was deleted before arrival", () => {
		const store = useChatStore.getState();
		store.setLocalSessionId("session-a");

		// User switches away and deletes session-a
		store.newConversation();
		store.deleteSessionOverlay("session-a");

		// Voice summary arrives for deleted session-a
		useChatStore.getState().recordVoiceCostSummary("session-a", {
			role: "assistant",
			content: "🎙️ 45s · 약 12 크레딧",
			cost: {
				provider: "nextain",
				model: "naia-omni",
				inputTokens: 0,
				outputTokens: 0,
				cost: 0.012,
			},
		});

		// If session-a is ever reopened, summary is NOT present
		store.setLocalSessionId("session-a");
		store.setMessages([]);

		expect(useChatStore.getState().messages).toHaveLength(0);
		expect(useChatStore.getState().totalSessionCost).toBe(0);
	});
});
