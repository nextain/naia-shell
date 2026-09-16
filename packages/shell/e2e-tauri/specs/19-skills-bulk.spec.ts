import { S } from "../helpers/selectors.js";
import {
	navigateToSettings,
	safeRefresh,
} from "../helpers/settings.js";

/**
 * 19 — skills bulk (#605 checkbox model)
 * Confirms Skills tab shows CLI/gesture groups rather than bulk agent tools.
 */
describe("19 — skills bulk migration", () => {
	before(async () => {
		await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			const config = raw ? JSON.parse(raw) : {};
			config.enableTools = true;
			localStorage.setItem("naia-config", JSON.stringify(config));
		});
		await safeRefresh();
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
		await navigateToSettings();
	});

	it("should show CLI section in skills tab", async () => {
		await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLButtonElement | null;
			el?.click();
		}, S.skillsTab);
		await browser.pause(1000);

		const hasCli = await browser.execute(
			() => !!document.querySelector('[data-testid="skills-cli-section"]'),
		);
		expect(hasCli).toBe(true);
	});

	it("should show gesture section with youtube toggle", async () => {
		const hasGesture = await browser.execute(
			() => !!document.querySelector('[data-testid="skills-gesture-section"]'),
		);
		expect(hasGesture).toBe(true);
		const hasYoutube = await browser.execute(
			() => !!document.querySelector('[data-testid="gesture-enable-youtube"]'),
		);
		expect(hasYoutube).toBe(true);
	});
});
