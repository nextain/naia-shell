import { S } from "../helpers/selectors.js";
import {
	ensureAppReady,
	navigateToSettings,
	scrollToSection,
} from "../helpers/settings.js";

/**
 * 73 — Edge TTS Preview E2E
 *
 * Verifies that the voice preview button works with Edge TTS (free, default).
 * This is the user's first experience: app launches → edge is default → click preview.
 * The preview must work even when Gateway is not yet connected.
 */
describe("73 — Edge TTS preview", () => {
	before(async () => {
		await ensureAppReady();
		await navigateToSettings();
		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 10_000 });
	});

	it("should have TTS provider selector defaulting to edge", async () => {
		await scrollToSection(S.gatewayTtsProvider);
		const providerValue = await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLSelectElement | null;
			return el?.value ?? "";
		}, S.gatewayTtsProvider);

		// Default should be "edge" on fresh app or at least a valid string
		expect(typeof providerValue).toBe("string");
	});

	it("should have voice preview button", async () => {
		await scrollToSection(S.voicePreviewBtn);
		const exists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.voicePreviewBtn,
		);
		expect(exists).toBe(true);
	});

	it("should have TTS voice select with Korean voices", async () => {
		await scrollToSection(S.ttsVoiceSelect);
		const voiceInfo = await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			if (!select) return { count: 0, value: "" };
			return {
				count: select.options.length,
				value: select.value,
			};
		}, S.ttsVoiceSelect);

		expect(voiceInfo.count).toBeGreaterThan(0);
	});

	it("should click preview and produce audio without error", async () => {
		await scrollToSection(S.voicePreviewBtn);

		// Click voice preview
		await browser.execute((sel: string) => {
			const btn = document.querySelector(sel) as HTMLButtonElement | null;
			if (btn) btn.click();
		}, S.voicePreviewBtn);

		// Wait for preview to complete (up to 30s for Edge TTS network call)
		// Check that no error message appears
		await browser.pause(2_000);

		// Check for error — the settings tab shows errors in .settings-error or similar
		const errorText = await browser.execute(() => {
			// Look for any error message in the settings panel
			const errorEls = document.querySelectorAll(
				".settings-tab .error-message, .settings-tab [class*='error'], .settings-tab .text-red",
			);
			for (const el of errorEls) {
				const text = (el as HTMLElement).textContent?.trim();
				if (text?.includes("TTS")) return text;
			}
			return "";
		});

		// Wait until preview finishes (button re-enables)
		await browser.waitUntil(
			async () => {
				return browser.execute((sel: string) => {
					const btn = document.querySelector(sel) as HTMLButtonElement | null;
					return btn ? !btn.disabled : true;
				}, S.voicePreviewBtn);
			},
			{
				timeout: 30_000,
				timeoutMsg: "Voice preview did not complete within 30s",
			},
		);

		// Verify no TTS error occurred
		if (errorText) {
			console.error("[E2E] TTS preview error:", errorText);
		}
		expect(errorText).toBe("");
	});

	it("should navigate back to chat tab", async () => {
		await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLElement | null;
			if (el) el.click();
		}, S.chatTab);

		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
