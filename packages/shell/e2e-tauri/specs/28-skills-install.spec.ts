import { S } from "../helpers/selectors.js";
import {
	clickBySelector,
	ensureAppReady,
	navigateToSettings,
} from "../helpers/settings.js";

/**
 * 28 — Skills install surface removed (#605)
 *
 * Gateway skill install via skill_skill_manager is dead code and deleted.
 * This spec now asserts the install UI is gone and CLI checkboxes remain.
 */
describe("28 — skills install", () => {
	before(async () => {
		await ensureAppReady();
		await navigateToSettings();
	});

	it("should navigate to Skills tab", async () => {
		const skillsBtn = await $(S.skillsTab);
		await skillsBtn.waitForDisplayed({ timeout: 10_000 });
		await clickBySelector(S.skillsTab);

		const skillsApp = await $(S.skillsTabApp);
		await skillsApp.waitForDisplayed({ timeout: 5_000 });
	});

	it("should not show gateway skill cards or install buttons", async () => {
		await browser.pause(1_000);
		const gatewayCardCount = await browser.execute(
			() =>
				document.querySelectorAll('[data-testid="gateway-skill-card"]').length,
		);
		const installBtnCount = await browser.execute(
			() =>
				document.querySelectorAll('[data-testid="skills-install-btn"]').length,
		);
		expect(gatewayCardCount).toBe(0);
		expect(installBtnCount).toBe(0);
	});

	it("should still expose CLI or empty-CLI state", async () => {
		const hasCliSection = await browser.execute(
			() => !!document.querySelector('[data-testid="skills-cli-section"]'),
		);
		expect(hasCliSection).toBe(true);
	});
});
