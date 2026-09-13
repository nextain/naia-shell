import { S } from "../helpers/selectors.js";
import {
	enableToolsForSpec,
	ensureAppReady,
	navigateToSettings,
	openSettingsSection,
} from "../helpers/settings.js";

/**
 * 34 — Device pairing section is reachable.
 *
 * 43 covers the mutating operations. This spec only checks that the Settings
 * device section is actually on screen after tools are enabled.
 */
describe("34 — device pairing", () => {
	before(async () => {
		await ensureAppReady();
		await enableToolsForSpec([]);
	});

	it("shows the device pairing section in Settings > brain", async () => {
		await navigateToSettings();
		await openSettingsSection("brain");
		const section = await $(S.deviceSection);
		await section.waitForDisplayed({ timeout: 15_000 });
		expect(await section.isDisplayed()).toBe(true);
		const emptyOrList = await browser.execute(() => {
			return !!(
				document.querySelector(".device-nodes-list") ||
				document.querySelector('[data-testid="device-section"] .settings-hint')
			);
		});
		expect(emptyOrList).toBe(true);
	});
});
