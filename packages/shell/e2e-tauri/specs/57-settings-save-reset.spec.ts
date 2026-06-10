import { S } from "../helpers/selectors.js";
import {
	clickBySelector,
	ensureAppReady,
	navigateToSettings,
	scrollToSection,
	setNativeValue,
} from "../helpers/settings.js";

/**
 * 57 — Settings: Save & Reset Round-trip
 *
 * Verifies settings persistence:
 * - Change theme + persona → Save
 * - Navigate away (chat tab) → come back
 * - Values should persist
 * - Reset button exists
 */
describe("57 — settings save & reset", () => {
	let originalThemeIdx: number;

	before(async () => {
		await ensureAppReady();
		await navigateToSettings();
		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 10_000 });
	});

	it("should save current theme index", async () => {
		originalThemeIdx = await browser.execute((allSel: string) => {
			const all = document.querySelectorAll(allSel);
			for (let i = 0; i < all.length; i++) {
				if (all[i].classList.contains("active")) return i;
			}
			return 0;
		}, S.themeSwatch);
		expect(originalThemeIdx).toBeGreaterThanOrEqual(0);
	});

	it("should change theme to a different swatch", async () => {
		const changed = await browser.execute(
			(allSel: string, origIdx: number) => {
				const all = document.querySelectorAll(allSel);
				for (let i = 0; i < all.length; i++) {
					if (i !== origIdx) {
						(all[i] as HTMLElement).click();
						return i;
					}
				}
				return -1;
			},
			S.themeSwatch,
			originalThemeIdx,
		);
		expect(changed).toBeGreaterThanOrEqual(0);
		await browser.pause(200);
	});

	it("should set persona text", async () => {
		await scrollToSection(S.personaInput);
		await setNativeValue(S.personaInput, "저장 테스트 페르소나");
		await browser.pause(200);
	});

	it("should click save button", async () => {
		await scrollToSection(S.settingsSaveBtn);
		await clickBySelector(S.settingsSaveBtn);
		await browser.pause(500);
	});

	it("should persist values after tab round-trip", async () => {
		// Navigate to chat tab
		await clickBySelector(S.chatTab);
		await browser.pause(300);

		// Navigate back to settings
		await navigateToSettings();
		await browser.pause(500);

		// Theme should NOT be the original index
		const currentThemeIdx = await browser.execute((allSel: string) => {
			const all = document.querySelectorAll(allSel);
			for (let i = 0; i < all.length; i++) {
				if (all[i].classList.contains("active")) return i;
			}
			return -1;
		}, S.themeSwatch);
		expect(currentThemeIdx).not.toBe(originalThemeIdx);

		// Persona should contain our test text
		await scrollToSection(S.personaInput);
		const persona = await browser.execute(
			(sel: string) =>
				(document.querySelector(sel) as HTMLTextAreaElement)?.value ?? "",
			S.personaInput,
		);
		expect(persona).toContain("저장 테스트");
	});

	it("should have a reset button", async () => {
		await scrollToSection(S.settingsResetBtn);
		const exists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.settingsResetBtn,
		);
		expect(exists).toBe(true);
	});

	it("should navigate back to chat tab", async () => {
		await clickBySelector(S.chatTab);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
