import { S } from "../helpers/selectors.js";
import {
	clickBySelector,
	ensureAppReady,
	navigateToSettings,
} from "../helpers/settings.js";

/**
 * 59 — Skills Tab Interactions (#605 checkbox model)
 *
 * - Refresh button present
 * - Gesture youtube toggle flips
 * - CLI recheck buttons exist when CLIs are installed
 */
describe("59 — skills interactions", () => {
	before(async () => {
		await ensureAppReady();
		await navigateToSettings();
		await clickBySelector(S.skillsTab);
		const skillsApp = await $(S.skillsTabApp);
		await skillsApp.waitForDisplayed({ timeout: 10_000 });
	});

	it("should show refresh control", async () => {
		const refresh = await $('[data-testid="skills-cli-refresh"]');
		await refresh.waitForDisplayed({ timeout: 10_000 });
		expect(await refresh.isDisplayed()).toBe(true);
	});

	it("should toggle youtube gesture checkbox", async () => {
		const toggle = await $('[data-testid="gesture-enable-youtube"]');
		await toggle.waitForExist({ timeout: 5_000 });
		const before = await toggle.isSelected();
		await browser.execute(() => {
			const el = document.querySelector(
				'[data-testid="gesture-enable-youtube"]',
			) as HTMLInputElement | null;
			el?.click();
		});
		await browser.pause(300);
		const after = await toggle.isSelected();
		expect(after).toBe(!before);
	});

	it("should keep CLI section mounted after refresh", async () => {
		await clickBySelector('[data-testid="skills-cli-refresh"]');
		await browser.pause(500);
		const section = await $('[data-testid="skills-cli-section"]');
		expect(await section.isExisting()).toBe(true);
	});
});
