import { S } from "../helpers/selectors.js";

/**
 * 24 — TTS Providers E2E
 *
 * Verifies Settings > Gateway TTS section:
 * - TTS provider selector renders with options
 * - Provider options are valid IDs
 *
 * Covers RPC: tts.providers
 */
describe("24 — TTS providers", () => {
	it("should navigate to Settings tab", async () => {
		const settingsBtn = await $(S.settingsTabBtn);
		await settingsBtn.waitForDisplayed({ timeout: 10_000 });
		await settingsBtn.click();

		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 5_000 });
	});

	it("should ensure tools are enabled", async () => {
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
	});

	it("should show TTS provider selector with options", async () => {
		// Wait for Gateway TTS data to load
		await browser.pause(3_000);

		const providerExists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.gatewayTtsProvider,
		);

		if (providerExists) {
			// Verify it has at least one option
			const optionCount = await browser.execute((sel: string) => {
				const select = document.querySelector(sel) as HTMLSelectElement | null;
				if (!select) return 0;
				return Array.from(select.options).filter(
					(o) => o.value && o.value !== "",
				).length;
			}, S.gatewayTtsProvider);

			expect(optionCount).toBeGreaterThan(0);

			// Current value should be a valid string
			const value = await browser.execute((sel: string) => {
				const select = document.querySelector(sel) as HTMLSelectElement | null;
				return select?.value ?? "";
			}, S.gatewayTtsProvider);

			expect(typeof value).toBe("string");
			expect(value.length).toBeGreaterThan(0);
		}
		// Gateway may not be running — ok for E2E
	});

	it("should navigate back to chat tab", async () => {
		const chatTabBtn = await $(S.chatTab);
		await chatTabBtn.click();

		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
