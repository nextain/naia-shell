// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedCharacterCard } from "../../apps/charcard/card-parser";
import { buildRoleplayPrompt } from "../../apps/charcard/prompt-builder";
import { useAppStore } from "../../stores/app";
import { useChatStore } from "../../stores/chat";
import {
	CHARCARD_APP_ID,
	extractCharcardGreeting,
	useCharcardChatStart,
} from "../charcard-chat-start";
import { setWebAssetsModeForTests } from "../web-runtime/web-assets";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const GREETING = "*톱니바퀴를 내려놓으며* 어서 와, {{user}}! 오늘은 뭘 고쳐 볼까?\n\n두 번째 문단도 인사야.";

function roleplayFor(greeting: string, postHistory = "") {
	const card: NormalizedCharacterCard = {
		specVersion: "v3",
		sourceFormat: "json",
		name: "Tinker",
		description: "A clockwork tinkerer.",
		personality: "",
		scenario: "",
		first_mes: greeting,
		alternate_greetings: [],
		mes_example: "",
		system_prompt: "",
		post_history_instructions: postHistory,
		creator: "",
		creator_notes: "",
		tags: [],
		character_book: { name: "", description: "", entries: [] },
		rawJson: {},
	} as NormalizedCharacterCard;
	return buildRoleplayPrompt(card, { userName: "루크", locale: "ko" });
}

describe("R12: character card start opens chat with the card greeting (web)", () => {
	beforeEach(() => {
		setWebAssetsModeForTests(true);
		useChatStore.getState().setMessages([]);
		useAppStore.getState().setActiveAppContext(null);
	});
	afterEach(() => {
		setWebAssetsModeForTests(null);
	});

	it("R12: extracts a multi-paragraph greeting and stops before later sections", () => {
		const result = roleplayFor(GREETING, "Stay in character.");
		const greeting = extractCharcardGreeting(result.context.data.roleplay);
		expect(greeting).toBe(result.greeting.trim());
		expect(greeting).toContain("두 번째 문단도 인사야.");
		expect(greeting).not.toContain("Post-History");
		expect(greeting).not.toContain("Safety Rule");
		expect(extractCharcardGreeting("no marker")).toBeNull();
		expect(extractCharcardGreeting(undefined)).toBeNull();
	});

	it("R12: a pushed charcard context opens chat and starts with the greeting", () => {
		const openChat = vi.fn();
		useChatStore.getState().setMessages([
			{ id: "old", role: "user", content: "이전 대화", timestamp: 1 },
		]);
		renderHook(() => useCharcardChatStart(openChat));
		const result = roleplayFor(GREETING);
		useAppStore.getState().setActiveAppContext(result.context, CHARCARD_APP_ID);

		expect(openChat).toHaveBeenCalledTimes(1);
		const messages = useChatStore.getState().messages;
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ role: "assistant", content: result.greeting.trim() });

		// Re-pushing the same card only reopens the chat and keeps the conversation.
		useChatStore.getState().addMessage({ role: "user", content: "안녕" });
		useAppStore.getState().setActiveAppContext({ ...result.context }, CHARCARD_APP_ID);
		expect(openChat).toHaveBeenCalledTimes(2);
		expect(useChatStore.getState().messages).toHaveLength(2);

		// After the roleplay is stopped, starting again begins a fresh conversation.
		useAppStore.getState().setActiveAppContext(null, CHARCARD_APP_ID);
		useAppStore.getState().setActiveAppContext({ ...result.context }, CHARCARD_APP_ID);
		expect(useChatStore.getState().messages).toHaveLength(1);
	});

	it("R12: ignores other apps' contexts and the desktop build", () => {
		const openChat = vi.fn();
		const { unmount } = renderHook(() => useCharcardChatStart(openChat));
		useAppStore.getState().setActiveAppContext({ type: "slides", data: {} }, "land.naia.slides");
		useAppStore.getState().setActiveAppContext(roleplayFor(GREETING).context, "land.naia.slides");
		expect(openChat).not.toHaveBeenCalled();
		unmount();

		setWebAssetsModeForTests(false);
		renderHook(() => useCharcardChatStart(openChat));
		useAppStore.getState().setActiveAppContext(roleplayFor(GREETING).context, CHARCARD_APP_ID);
		expect(openChat).not.toHaveBeenCalled();
	});
});
