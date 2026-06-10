import { S } from "../helpers/selectors.js";
import {
	clickBySelector,
	ensureAppReady,
	navigateToSettings,
	scrollToSection,
	setNativeValue,
} from "../helpers/settings.js";

/**
 * 55 — Settings: Persona & Model
 *
 * Pure client-side interactions:
 * - Persona textarea set value via native setter
 * - Provider select shows current value
 * - Model input set value
 */
describe("55 — settings persona & model", () => {
	before(async () => {
		await ensureAppReady();
		await navigateToSettings();
		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 10_000 });
	});

	it("should have persona textarea", async () => {
		await scrollToSection(S.personaInput);
		const exists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.personaInput,
		);
		expect(exists).toBe(true);
	});

	it("should set persona value", async () => {
		const testText = "E2E 테스트 페르소나";
		await setNativeValue(S.personaInput, testText);
		await browser.pause(200);

		const value = await browser.execute(
			(sel: string) =>
				(document.querySelector(sel) as HTMLTextAreaElement)?.value ?? "",
			S.personaInput,
		);
		expect(value).toBe(testText);
	});

	it("should show provider select with valid value", async () => {
		await scrollToSection(S.providerSelect);
		const value = await browser.execute(
			(sel: string) =>
				(document.querySelector(sel) as HTMLSelectElement)?.value ?? "",
			S.providerSelect,
		);
		expect(value.length).toBeGreaterThan(0);
	});

	it("should have model input", async () => {
		await scrollToSection(S.modelInput);
		const exists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.modelInput,
		);
		expect(exists).toBe(true);
	});

	it("should navigate back to chat tab", async () => {
		await clickBySelector(S.chatTab);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
