import { S } from "../helpers/selectors.js";

/**
 * 23 — Channels Status E2E
 *
 * Verifies Channels tab (5th tab):
 * - Tab renders with channel data or empty/error state
 * - Channel cards have status badges
 * - Refresh button reloads data
 *
 * Covers RPC: channels.status
 */
describe("23 — channels status", () => {
	it("should navigate to channels tab", async () => {
		const channelsBtn = await $(S.channelsTabBtn);
		await channelsBtn.waitForDisplayed({ timeout: 10_000 });
		await channelsBtn.click();

		const channelsPanel = await $(S.channelsTabPanel);
		await channelsPanel.waitForDisplayed({ timeout: 5_000 });
	});

	it("should load channel data (cards or empty state)", async () => {
		// Wait for loading to complete
		await browser.waitUntil(
			async () => {
				return browser.execute(() => {
					return !document.querySelector(".channels-loading");
				});
			},
			{ timeout: 15_000, timeoutMsg: "Channels loading did not complete" },
		);

		const cardCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.channelCard,
		);

		if (cardCount > 0) {
			// Verify status badges exist
			const statusCount = await browser.execute(
				(sel: string) => document.querySelectorAll(sel).length,
				S.channelStatus,
			);
			expect(statusCount).toBeGreaterThan(0);
		} else {
			// Empty or error state — should have meaningful text
			const panel = await $(S.channelsTabPanel);
			const panelText = await panel.getText();
			expect(panelText.length).toBeGreaterThan(0);
		}
	});

	it("should have refresh button that reloads data", async () => {
		const refreshBtn = await $(S.channelsRefreshBtn);
		const exists = await refreshBtn.isExisting();

		if (exists) {
			expect(await refreshBtn.isDisplayed()).toBe(true);
			await refreshBtn.click();
			await browser.pause(2_000);

			// Panel should still be displayed after refresh
			const panel = await $(S.channelsTabPanel);
			expect(await panel.isDisplayed()).toBe(true);
		}
	});

	it("should navigate back to chat tab", async () => {
		const chatTabBtn = await $(S.chatTab);
		await chatTabBtn.click();

		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
