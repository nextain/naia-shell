describe("Codex readiness through the real Tauri Shell", () => {
	it("reports the signed-in Codex CLI as ready from the Brain settings screen", async () => {
		const settings = await $(".app-bar-settings");
		if (!(await settings.getAttribute("class"))?.includes("--active")) {
			await settings.waitForClickable({ timeout: 30_000 });
			await settings.click();
		}
		const brainTab = await $("[data-settings-tab='brain']");
		await brainTab.waitForClickable({ timeout: 30_000 });
		await brainTab.click();

		const provider = await $("#provider-select");
		await provider.waitForDisplayed({ timeout: 30_000 });
		expect(await provider.getValue()).toBe("codex");

		const readiness = await $("[data-testid='codex-readiness']");
		await readiness.waitForDisplayed({ timeout: 30_000 });
		const check = await $("[data-testid='codex-readiness-check']");
		await check.waitForClickable({ timeout: 30_000 });
		await check.click();

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
});
