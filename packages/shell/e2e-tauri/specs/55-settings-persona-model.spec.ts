import { S } from "../helpers/selectors.js";
import {
	clickBySelector,
	ensureAppReady,
	navigateToSettings,
	openSettingsSection,
	scrollToSection,
	setNativeValue,
} from "../helpers/settings.js";

const modelSelector = "#model-select";

/**
 * 55 — Settings: Persona & Model
 *
 * Pure client-side interactions:
 * - Persona textarea set value via native setter
 * - Provider select shows current value
 * - Model control (input or select) is rendered
 */
describe("55 — settings persona & model", () => {
	before(async () => {
		await ensureAppReady();
		await navigateToSettings();
		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 10_000 });
	});

	it("should have persona textarea", async () => {
		await openSettingsSection("persona");
		await scrollToSection(S.personaInput);
		const state = await browser.execute((sel: string) => {
			const input = document.querySelector(sel) as HTMLTextAreaElement | null;
			return { exists: !!input, disabled: input?.disabled ?? true };
		}, S.personaInput);
		expect(state.exists).toBe(true);
		expect(state.disabled).toBe(false);
	});

	it("should set persona value", async () => {
		await openSettingsSection("persona");
		const testText = "E2E 테스트 페르소나";
		await browser.execute((sel: string) => {
			(document.querySelector(sel) as HTMLTextAreaElement | null)?.focus();
		}, S.personaInput);
		await setNativeValue(S.personaInput, testText);
		await browser.execute((sel: string) => {
			(document.querySelector(sel) as HTMLTextAreaElement | null)?.blur();
		}, S.personaInput);
		await browser.pause(200);

		const value = await browser.execute(
			(sel: string) =>
				(document.querySelector(sel) as HTMLTextAreaElement)?.value ?? "",
			S.personaInput,
		);
		expect(value).toBe(testText);
	});

	it("should show provider select with valid value", async () => {
		await openSettingsSection("brain");
		await scrollToSection(S.providerSelect);
		const value = await browser.execute(
			(sel: string) =>
				(document.querySelector(sel) as HTMLSelectElement)?.value ?? "",
			S.providerSelect,
		);
		expect(value.length).toBeGreaterThan(0);
	});

	it("should have model control", async () => {
		await openSettingsSection("brain");
		await scrollToSection(modelSelector);
		const exists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			modelSelector,
		);
		expect(exists).toBe(true);
	});

	it("should navigate back to chat tab", async () => {
		await clickBySelector(S.chatTab);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
