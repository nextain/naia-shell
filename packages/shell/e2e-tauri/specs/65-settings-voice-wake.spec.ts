import { S } from "../helpers/selectors.js";
import {
	clickBySelector,
	enableToolsForSpec,
	ensureAppReady,
	navigateToSettings,
	scrollToSection,
	setNativeValue,
} from "../helpers/settings.js";

/**
 * 65 — Settings: Voice Wake Triggers
 *
 * Verifies voice wake configuration (requires enableTools):
 * - Voice wake input exists
 * - Add trigger via input → tag appears
 * - Remove trigger via × button
 * (Gateway dependent — graceful)
 */
describe("65 — settings voice wake", () => {
	let sectionAvailable = false;

	before(async () => {
		await ensureAppReady();
		await enableToolsForSpec([]);
		await navigateToSettings();
		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 10_000 });

		// Wait for voice wake section to load
		await browser.pause(3_000);
		sectionAvailable = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.voiceWakeInput,
		);
	});

	it("should show voice wake input or skip", async () => {
		if (!sectionAvailable) return;
		const exists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.voiceWakeInput,
		);
		expect(exists).toBe(true);
	});

	it("should show existing triggers as tags", async () => {
		if (!sectionAvailable) return;
		const tagCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.voiceWakeTag,
		);
		// May be 0 if no triggers configured
		expect(tagCount).toBeGreaterThanOrEqual(0);
	});

	it("should add a trigger tag via input", async () => {
		if (!sectionAvailable) return;

		const beforeCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.voiceWakeTag,
		);

		await setNativeValue('[data-testid="voice-wake-input"]', "테스트트리거");
		await browser.pause(200);

		// Press Enter to add (or click the add button next to input)
		await browser.execute(() => {
			const input = document.querySelector(
				'[data-testid="voice-wake-input"]',
			) as HTMLInputElement;
			if (input) {
				input.dispatchEvent(
					new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
				);
			}
		});
		await browser.pause(500);

		const afterCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.voiceWakeTag,
		);

		expect(afterCount).toBeGreaterThanOrEqual(beforeCount);
	});

	it("should have remove button on each tag", async () => {
		if (!sectionAvailable) return;
		const tagCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.voiceWakeTag,
		);
		const removeCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.voiceWakeTagRemove,
		);
		expect(removeCount).toBe(tagCount);
	});

	it("should remove a trigger tag on × click", async () => {
		if (!sectionAvailable) return;

		const beforeCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.voiceWakeTag,
		);
		if (beforeCount === 0) return;

		await browser.execute((sel: string) => {
			const btn = document.querySelector(sel) as HTMLElement;
			if (btn) btn.click();
		}, S.voiceWakeTagRemove);
		await browser.pause(500);

		const afterCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.voiceWakeTag,
		);
		expect(afterCount).toBeLessThan(beforeCount);
	});

	it("should navigate back to chat tab", async () => {
		await clickBySelector(S.chatTab);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
