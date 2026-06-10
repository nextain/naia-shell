import { S } from "../helpers/selectors.js";

/**
 * 26 — Sessions Management E2E
 *
 * Verifies AgentsTab > Sessions section:
 * - Session list loads with cards or empty state
 * - Session cards have metadata
 * - Compact/delete buttons exist
 * - Refresh button works
 *
 * Covers RPC: sessions.list, sessions.delete (UI), sessions.compact (UI)
 */
describe("26 — sessions management", () => {
	it("should navigate to Agents tab", async () => {
		const agentsBtn = await $(S.agentsTabBtn);
		await agentsBtn.waitForDisplayed({ timeout: 10_000 });
		await agentsBtn.click();

		const agentsPanel = await $(S.agentsTabPanel);
		await agentsPanel.waitForDisplayed({ timeout: 5_000 });
	});

	it("should load sessions data", async () => {
		await browser.pause(3_000);

		const sessionCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.sessionCard,
		);

		if (sessionCount > 0) {
			// Verify first session card has text content
			const cardText = await browser.execute((sel: string) => {
				const card = document.querySelector(sel);
				return card?.textContent?.trim() ?? "";
			}, S.sessionCard);
			expect(cardText.length).toBeGreaterThan(0);
		} else {
			// Empty state — should show some message
			const panel = await $(S.agentsTabPanel);
			const panelText = await panel.getText();
			expect(panelText.length).toBeGreaterThan(0);
		}
	});

	it("should show action buttons on session cards", async () => {
		const sessionCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.sessionCard,
		);

		if (sessionCount > 0) {
			const actionCount = await browser.execute(
				(compactSel: string, deleteSel: string) => {
					return (
						document.querySelectorAll(compactSel).length +
						document.querySelectorAll(deleteSel).length
					);
				},
				S.sessionCompactBtn,
				S.sessionDeleteBtn,
			);
			expect(actionCount).toBeGreaterThan(0);
		}
	});

	it("should have refresh button", async () => {
		const refreshBtn = await $(S.agentsRefreshBtn);
		const exists = await refreshBtn.isExisting();

		if (exists) {
			expect(await refreshBtn.isDisplayed()).toBe(true);
			await refreshBtn.click();
			await browser.pause(2_000);

			const agentsPanel = await $(S.agentsTabPanel);
			expect(await agentsPanel.isDisplayed()).toBe(true);
		}
	});

	it("should navigate back to chat tab", async () => {
		const chatTabBtn = await $(S.chatTab);
		await chatTabBtn.click();

		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
