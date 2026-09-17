import { S } from "../helpers/selectors.js";
import {
	clickBySelector,
	ensureAppReady,
	navigateToSettings,
} from "../helpers/settings.js";

/**
 * 14 — Skills Tab E2E (#605 checkbox model)
 *
 * Verifies the Skills management UI:
 * - Tab navigation works
 * - CLI section + gesture section render
 * - Detected CLI cards use checkboxes
 * - No gateway install / agent-tool list surface
 */
describe("14 — skills tab", () => {
	before(async () => {
		await ensureAppReady();
		await navigateToSettings();
	});

	it("should navigate to Skills tab", async () => {
		const skillsTabBtn = await $(S.skillsTab);
		await skillsTabBtn.waitForDisplayed({ timeout: 10_000 });
		await clickBySelector(S.skillsTab);

		const skillsApp = await $(S.skillsTabApp);
		await skillsApp.waitForDisplayed({ timeout: 5_000 });
	});

	it("should show CLI and gesture sections", async () => {
		await browser.waitUntil(
			async () => {
				const cli = await $('[data-testid="skills-cli-section"]');
				const gesture = await $('[data-testid="skills-gesture-section"]');
				return (await cli.isExisting()) && (await gesture.isExisting());
			},
			{
				timeout: 15_000,
				timeoutMsg: "CLI/gesture sections did not appear",
			},
		);
		const cliText = await $('[data-testid="skills-cli-section"]').getText();
		expect(cliText).toMatch(/CLI|감지/i);
		const gestureText = await $(
			'[data-testid="skills-gesture-section"]',
		).getText();
		expect(gestureText).toMatch(/gesture|몸짓|YouTube|유튜브/i);
	});

	it("should show youtube gesture checkbox", async () => {
		const toggle = await $('[data-testid="gesture-enable-youtube"]');
		await toggle.waitForExist({ timeout: 5_000 });
		expect(await toggle.isExisting()).toBe(true);
	});

	it("should not show gateway install buttons", async () => {
		const installCount = await browser.execute(
			() => document.querySelectorAll('[data-testid="skills-install-btn"]').length,
		);
		expect(installCount).toBe(0);
	});

	it("should navigate back to chat tab", async () => {
		await clickBySelector(S.chatTab);

		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
