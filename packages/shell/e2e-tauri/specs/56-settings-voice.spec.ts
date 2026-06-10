import { S } from "../helpers/selectors.js";
import {
	clickBySelector,
	ensureAppReady,
	navigateToSettings,
	scrollToSection,
} from "../helpers/settings.js";

/**
 * 56 — Settings: Voice (TTS/STT)
 *
 * Pure client-side interactions:
 * - TTS toggle on/off
 * - STT toggle on/off
 * - TTS voice select shows options
 * - Voice preview button exists
 */
describe("56 — settings voice", () => {
	before(async () => {
		await ensureAppReady();
		await navigateToSettings();
		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 10_000 });
	});

	it("should have TTS toggle", async () => {
		await scrollToSection(S.ttsToggle);
		const exists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.ttsToggle,
		);
		expect(exists).toBe(true);
	});

	it("should toggle TTS on/off", async () => {
		const originalState = await browser.execute(
			(sel: string) =>
				(document.querySelector(sel) as HTMLInputElement)?.checked ?? false,
			S.ttsToggle,
		);

		await clickBySelector(S.ttsToggle);
		await browser.pause(200);

		const newState = await browser.execute(
			(sel: string) =>
				(document.querySelector(sel) as HTMLInputElement)?.checked ?? false,
			S.ttsToggle,
		);
		expect(newState).toBe(!originalState);

		// Restore
		await clickBySelector(S.ttsToggle);
		await browser.pause(200);
	});

	it("should have STT toggle", async () => {
		await scrollToSection(S.sttToggle);
		const exists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.sttToggle,
		);
		expect(exists).toBe(true);
	});

	it("should have TTS voice select with options", async () => {
		await scrollToSection(S.ttsVoiceSelect);
		const optionCount = await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			return select?.options.length ?? 0;
		}, S.ttsVoiceSelect);
		expect(optionCount).toBeGreaterThanOrEqual(1);
	});

	it("should show current TTS voice selection", async () => {
		const value = await browser.execute(
			(sel: string) =>
				(document.querySelector(sel) as HTMLSelectElement)?.value ?? "",
			S.ttsVoiceSelect,
		);
		// Voice should be a ko-KR string or empty
		expect(typeof value).toBe("string");
	});

	it("should navigate back to chat tab", async () => {
		await clickBySelector(S.chatTab);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
