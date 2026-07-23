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
		// E2E starts from a deliberately blank WebView profile. The app first
		// creates the normal onboarding cache and then hydrates it from the
		// workspace-owned config.json; assert the user-visible settled value,
		// rather than sampling that short pre-hydration render.
		await browser.waitUntil(async () => (await provider.getValue()) === "codex", {
			timeout: 30_000,
			timeoutMsg: "workspace Codex configuration did not hydrate into Brain settings",
		});
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
