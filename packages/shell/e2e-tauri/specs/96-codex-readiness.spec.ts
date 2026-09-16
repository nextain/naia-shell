import { clickElement } from "../helpers/click.js";

/**
 * 96 — Codex readiness through descriptor-driven cli_detect (#605).
 * Uses the shared descriptor-driven CLI detection module.
 */
describe("Codex readiness through the real Tauri Shell", () => {
	it("reports the signed-in Codex CLI as ready from the Brain settings screen", async () => {
		const settings = await $(".app-bar-settings");
		if (!(await settings.getAttribute("class"))?.includes("--active")) {
			await clickElement(".app-bar-settings", 30_000);
		}
		const brainTab = await $("[data-settings-tab='brain']");
		await clickElement("[data-settings-tab='brain']", 30_000);

		const provider = await $("#provider-select");
		await provider.waitForDisplayed({ timeout: 30_000 });
		await browser.waitUntil(async () => (await provider.getValue()) === "codex", {
			timeout: 30_000,
			timeoutMsg: "workspace Codex configuration did not hydrate into Brain settings",
		});
		expect(await provider.getValue()).toBe("codex");

		const readiness = await $("[data-testid='codex-readiness']");
		await readiness.waitForDisplayed({ timeout: 30_000 });
		await clickElement("[data-testid='codex-readiness-check']", 30_000);

		const status = await $("[data-testid='codex-readiness-status']");
		await browser.waitUntil(
			async () => /준비됨|Ready/.test(await status.getText()),
			{
				timeout: 30_000,
				timeoutMsg: "Codex readiness did not report the signed-in CLI as ready",
			},
		);
		expect(await status.getText()).toMatch(/준비됨|Ready/);
	});

	it("exposes installed CLIs on the Skills tab via descriptors", async () => {
		await clickElement("[data-settings-tab='skills']", 30_000);
		const section = await $('[data-testid="skills-cli-section"]');
		await section.waitForDisplayed({ timeout: 30_000 });
		const card = await $('[data-testid="cli-skill-card"][data-cli-id="codex"]');
		await card.waitForExist({ timeout: 30_000 });
		expect(await card.isExisting()).toBe(true);
	});
});
