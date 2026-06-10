import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { safeRefresh } from "../helpers/settings.js";

describe("08 — Memory (conversation persistence)", () => {
	/**
	 * Helper: count visible user messages in the DOM.
	 */
	async function countUserMessages(): Promise<number> {
		return browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.userMessage,
		);
	}

	/**
	 * Helper: count visible completed assistant messages in the DOM.
	 */
	async function countAssistantMessages(): Promise<number> {
		return browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.completedAssistantMessage,
		);
	}

	/**
	 * Helper: get all user message texts.
	 */
	async function getUserMessageTexts(): Promise<string[]> {
		return browser.execute((sel: string) => {
			const nodes = document.querySelectorAll(sel);
			return Array.from(nodes).map(
				(n) => n.querySelector(".message-content")?.textContent?.trim() ?? "",
			);
		}, S.userMessage);
	}

	it("should send a message and have it persisted", async () => {
		const input = await $(S.chatInput);
		await input.waitForEnabled({ timeout: 15_000 });

		await sendMessage("메모리 테스트 메시지");

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"사용자가 '메모리 테스트 메시지'라고 보냈다",
			"AI가 적절히 응답했는가? 에러 메시지나 빈 응답은 FAIL",
		);

		// Verify at least 1 user + 1 assistant message exist
		const userCount = await countUserMessages();
		const assistantCount = await countAssistantMessages();
		expect(userCount).toBeGreaterThanOrEqual(1);
		expect(assistantCount).toBeGreaterThanOrEqual(1);
	});

	it("should persist messages after page refresh", async () => {
		// Count messages before refresh
		const userCountBefore = await countUserMessages();
		const assistantCountBefore = await countAssistantMessages();

		expect(userCountBefore).toBeGreaterThanOrEqual(1);

		// Refresh the webview — this triggers loadOrCreateSession() on remount
		await safeRefresh();

		// Wait for app root to be ready
		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 30_000 });

		// Wait for messages to be restored from DB
		await browser.waitUntil(
			async () => {
				const count = await countUserMessages();
				return count >= userCountBefore;
			},
			{
				timeout: 15_000,
				timeoutMsg: `Expected ${userCountBefore} user messages after refresh`,
			},
		);

		// Verify the same number of messages are restored
		const userCountAfter = await countUserMessages();
		const assistantCountAfter = await countAssistantMessages();
		expect(userCountAfter).toBe(userCountBefore);
		expect(assistantCountAfter).toBe(assistantCountBefore);

		// Verify message content is preserved
		const texts = await getUserMessageTexts();
		const hasMemoryMsg = texts.some((t) => t.includes("메모리 테스트 메시지"));
		expect(hasMemoryMsg).toBe(true);
	});

	it("should clear messages on new conversation", async () => {
		// Verify we have messages from previous tests
		const countBefore = await countUserMessages();
		expect(countBefore).toBeGreaterThanOrEqual(1);

		// Click "새 대화" button
		const newChatBtn = await $(S.newChatBtn);
		await newChatBtn.waitForClickable({ timeout: 10_000 });
		await newChatBtn.click();

		// Wait for messages to be cleared
		await browser.waitUntil(
			async () => {
				const count = await countUserMessages();
				return count === 0;
			},
			{
				timeout: 10_000,
				timeoutMsg: "Messages were not cleared after new conversation",
			},
		);

		const userCount = await countUserMessages();
		const assistantCount = await countAssistantMessages();
		expect(userCount).toBe(0);
		expect(assistantCount).toBe(0);
	});

	it("should start fresh conversation after new chat", async () => {
		const input = await $(S.chatInput);
		await input.waitForEnabled({ timeout: 10_000 });

		await sendMessage("새 대화 첫 메시지");

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"사용자가 '새 대화 첫 메시지'라고 보냈다",
			"AI가 적절히 응답했는가? 에러 메시지나 빈 응답은 FAIL",
		);

		// Should have exactly 1 user + 1 assistant message (fresh session)
		const userCount = await countUserMessages();
		expect(userCount).toBe(1);

		const texts = await getUserMessageTexts();
		expect(texts[0]).toContain("새 대화 첫 메시지");
	});
});
