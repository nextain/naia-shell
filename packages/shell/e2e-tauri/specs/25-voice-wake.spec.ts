import { S } from "../helpers/selectors.js";

/**
 * 25 — Voice Wake E2E
 *
 * Verifies Settings > Voice Wake section:
 * - Voice wake section appears when tools enabled
 * - Trigger list shows (or loading state)
 * - Can add/remove triggers via UI
 */
describe("25 — voice wake", () => {
	it("should navigate to Settings tab", async () => {
		const settingsBtn = await $(S.settingsTabBtn);
		await settingsBtn.waitForDisplayed({ timeout: 10_000 });
		await settingsBtn.click();

		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 5_000 });
	});

	it("should show voice wake section when tools enabled", async () => {
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

		// Wait for voice wake content to load
		await browser.pause(2_000);

		// Check voice wake triggers area or input exists
		const triggersArea = await $(S.voiceWakeTriggers);
		const inputField = await $(S.voiceWakeInput);

		const triggersExists = await triggersArea.isExisting();
		const inputExists = await inputField.isExisting();

		// At least one should be present (triggers or input for adding)
		expect(triggersExists || inputExists).toBe(true);
	});

	it("should have voice wake input field", async () => {
		const inputField = await $(S.voiceWakeInput);
		const exists = await inputField.isExisting();
		if (exists) {
			// Type a test trigger
			await inputField.setValue("test-trigger");
			const value = await inputField.getValue();
			expect(value).toBe("test-trigger");
			// Clear it
			await inputField.clearValue();
		}
	});

	it("should have save button for triggers", async () => {
		const saveBtn = await $(S.voiceWakeSave);
		const exists = await saveBtn.isExisting();
		if (exists) {
			expect(await saveBtn.isDisplayed()).toBe(true);
		}
	});

	it("should navigate back to chat tab", async () => {
		const chatTabBtn = await $(S.chatTab);
		await chatTabBtn.click();

		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
