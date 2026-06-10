import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";

/**
 * 68 — History Auto-Title
 *
 * Verifies that conversations get auto-generated titles instead of
 * showing "제목 없음" (Untitled) in the history tab.
 *
 * Bug: All previous conversations showed "제목 없음" because
 * createSession() was called without a title and no title generation
 * logic existed. Fix: first user message → updateSessionTitle().
 */
describe("68 — History Auto-Title", () => {
	const TEST_MESSAGE = "자기소개를 한 문장으로 해줘";

	before(async () => {
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	it("should start a new conversation and get a valid response", async () => {
		// Create new conversation
		const newChatBtn = await $(S.newChatBtn);
		await newChatBtn.waitForClickable({ timeout: 10_000 });
		await newChatBtn.click();

		// Wait for messages to clear
		await browser.waitUntil(
			async () => {
				const count = await browser.execute(
					(sel: string) => document.querySelectorAll(sel).length,
					S.userMessage,
				);
				return count === 0;
			},
			{ timeout: 10_000 },
		);

		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 10_000 });
		await sendMessage(TEST_MESSAGE);

		const text = await getLastAssistantMessage();
		expect(text).not.toMatch(/\[오류\]|400|error|Bad Request/i);
		await assertSemantic(
			text,
			"사용자가 자기소개를 요청했다",
			"AI가 자기소개 요청에 적절히 응답했는가? 에러 메시지나 도구 호출 실패가 아닌 실제 자기소개 응답이면 PASS",
		);
	});

	it("should show the user message as title in history tab", async () => {
		// Give a moment for title to persist to DB
		await browser.pause(2000);

		// Switch to history tab
		const historyTab = await $(S.historyTab);
		await historyTab.waitForClickable({ timeout: 10_000 });
		await historyTab.click();

		// Wait for history items
		await browser.waitUntil(
			async () => {
				return browser.execute(
					(sel: string) => document.querySelectorAll(sel).length > 0,
					S.historyItem,
				);
			},
			{ timeout: 15_000, timeoutMsg: "No history items appeared" },
		);

		// Get the title of the current session
		const currentTitle = await browser.execute(() => {
			const current = document.querySelector(
				".history-item.current .history-item-title",
			);
			if (!current) return null;
			const badge = current.querySelector(".history-current-badge");
			const badgeText = badge ? badge.textContent || "" : "";
			return (current.textContent || "").replace(badgeText, "").trim();
		});

		expect(currentTitle).not.toBeNull();
		expect(currentTitle).not.toBe("");
		expect(currentTitle).not.toBe("제목 없음");
		expect(currentTitle).not.toBe("Untitled");

		// Title should contain part of the user's message
		await assertSemantic(
			`대화 제목: "${currentTitle}"`,
			`사용자의 첫 메시지는 "${TEST_MESSAGE}"이었다`,
			"대화 제목이 사용자의 첫 메시지를 기반으로 생성되었는가? '제목 없음'이 아니고 메시지 내용과 관련 있으면 PASS",
		);
	});

	it("should return to chat tab", async () => {
		const chatTab = await $(S.chatTab);
		await chatTab.click();

		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 10_000 });
	});
});
