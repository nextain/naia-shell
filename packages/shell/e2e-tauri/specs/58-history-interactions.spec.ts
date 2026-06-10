import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { clickBySelector, ensureAppReady } from "../helpers/settings.js";

/**
 * 58 — History Tab Interactions
 *
 * Verifies detailed history item interactions:
 * - History item meta (date, message count) rendering
 * - Delete button + window.confirm mocking
 * - Item count decreases after delete
 */
describe("58 — history interactions", () => {
	before(async () => {
		await ensureAppReady();
		// Ensure we have at least one conversation
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
		await sendMessage("히스토리 인터랙션 테스트");
		const text = await getLastAssistantMessage();
		expect(text.length).toBeGreaterThan(0);
	});

	it("should navigate to history tab and see items", async () => {
		await clickBySelector(S.historyTab);
		await browser.waitUntil(
			async () =>
				browser.execute(
					(sel: string) => document.querySelectorAll(sel).length > 0,
					S.historyItem,
				),
			{ timeout: 10_000 },
		);
	});

	it("should render history-item-meta with date and message count", async () => {
		const metaTexts = await browser.execute((sel: string) => {
			return Array.from(document.querySelectorAll(sel))
				.map((el) => el.textContent?.trim() ?? "")
				.filter((t) => t.length > 0);
		}, S.historyItemMeta);

		expect(metaTexts.length).toBeGreaterThanOrEqual(1);
		// Meta should contain a number (message count)
		expect(metaTexts[0]).toMatch(/\d/);
	});

	it("should have delete buttons for each item", async () => {
		const deleteCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.historyDeleteBtn,
		);
		const itemCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.historyItem,
		);
		expect(deleteCount).toBe(itemCount);
	});

	it("should delete a non-current item via mocked confirm", async () => {
		const beforeCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.historyItem,
		);

		if (beforeCount < 2) {
			// Not enough items to safely delete — skip
			return;
		}

		// Mock window.confirm to return true
		await browser.execute(() => {
			window.confirm = () => true;
		});

		// Click delete on the last non-current item
		await browser.execute(
			(itemSel: string, delSel: string) => {
				const items = document.querySelectorAll(itemSel);
				for (let i = items.length - 1; i >= 0; i--) {
					if (!items[i].classList.contains("current")) {
						const btn = items[i].querySelector(delSel) as HTMLElement;
						if (btn) btn.click();
						return;
					}
				}
			},
			S.historyItem,
			S.historyDeleteBtn,
		);

		await browser.pause(1_000);

		const afterCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.historyItem,
		);
		expect(afterCount).toBeLessThan(beforeCount);
	});

	it("should navigate back to chat tab", async () => {
		await clickBySelector(S.chatTab);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
