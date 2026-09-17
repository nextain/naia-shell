import { clickElement } from "../helpers/click.js";
describe("Grok readiness through the real Tauri Shell", () => {
	it("reports the signed-in Grok CLI as ready from the Brain settings screen", async () => {
		const settings = await $(".app-bar-settings");
		if (!(await settings.getAttribute("class"))?.includes("--active")) {
			await clickElement(".app-bar-settings", 30_000);
		}
		const brainTab = await $("[data-settings-tab='brain']");
		await clickElement("[data-settings-tab='brain']", 30_000);

		const provider = await $("#provider-select");
		await provider.waitForDisplayed({ timeout: 30_000 });
		await browser.waitUntil(async () => (await provider.getValue()) === "grok", {
			timeout: 30_000,
			timeoutMsg: "workspace Grok configuration did not hydrate into Brain settings",
		});
		expect(await provider.getValue()).toBe("grok");

		const readiness = await $("[data-testid='grok-readiness']");
		await readiness.waitForDisplayed({ timeout: 30_000 });
		const check = await $("[data-testid='grok-readiness-check']");
		await clickElement("[data-testid='grok-readiness-check']", 30_000);

		const status = await $("[data-testid='grok-readiness-status']");
		await browser.waitUntil(
			async () => /준비됨|Ready/.test(await status.getText()),
			{
				timeout: 30_000,
				timeoutMsg: "Grok readiness did not report the signed-in CLI as ready",
			},
		);
		expect(await status.getText()).toMatch(/준비됨|Ready/);
	});

	it("lists Grok on the Skills tab when the descriptor detects it", async () => {
		await clickElement("[data-settings-tab='skills']", 30_000);
		const section = await $('[data-testid="skills-cli-section"]');
		await section.waitForDisplayed({ timeout: 30_000 });
		const card = await $('[data-testid="cli-skill-card"][data-cli-id="grok"]');
		await card.waitForExist({ timeout: 30_000 });
		expect(await card.isExisting()).toBe(true);
	});
});
