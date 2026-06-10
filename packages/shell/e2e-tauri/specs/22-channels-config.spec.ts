import { S } from "../helpers/selectors.js";

/**
 * 22 — Channels Config E2E
 *
 * Verifies Settings > Channels section:
 * - Channel management section appears when tools enabled
 * - Shows hint about channels tab
 * - Can navigate to channels tab from settings
 */
describe("22 — channels config", () => {
	it("should navigate to Settings tab", async () => {
		const settingsBtn = await $(S.settingsTabBtn);
		await settingsBtn.waitForDisplayed({ timeout: 10_000 });
		await settingsBtn.click();

		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 5_000 });
	});

	it("should show channels section when tools enabled", async () => {
		// Ensure tools toggle is enabled
		const toolsEnabled = await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLInputElement | null;
			return el?.checked ?? false;
		}, S.toolsToggle);

		if (!toolsEnabled) {
			await browser.execute((sel: string) => {
				const el = document.querySelector(sel) as HTMLInputElement | null;
				if (el) el.click();
			}, S.toolsToggle);
			await browser.pause(300);
		}

		// Scroll to channels section hint
		const channelsHint = await $(S.channelsSettingsHint);
		const exists = await channelsHint.isExisting();
		expect(exists).toBe(true);
	});

	it("should navigate to channels tab", async () => {
		const channelsBtn = await $(S.channelsTabBtn);
		await channelsBtn.waitForDisplayed({ timeout: 5_000 });
		await channelsBtn.click();

		const channelsPanel = await $(S.channelsTabPanel);
		await channelsPanel.waitForDisplayed({ timeout: 5_000 });
	});

	it("should navigate back to chat tab", async () => {
		const chatTabBtn = await $(S.chatTab);
		await chatTabBtn.click();

		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
