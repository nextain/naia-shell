describe("Discord secure credential cancellation through the real Tauri Shell", () => {
	it("keeps the token outside the WebView and renders native cancellation", async () => {
		try {
			await browser.waitUntil(
				() =>
					browser.execute(
						() => document.querySelector(".app-bar-settings") !== null,
					),
				{ timeout: 20_000, interval: 250 },
			);
		} catch {
			const diagnostic = await browser.execute(() => ({
				body: document.body.innerText.slice(0, 1_500),
				classes: [...document.querySelectorAll("button")]
					.map((button) => button.className)
					.filter(Boolean)
					.slice(0, 40),
				splash: document.querySelector(".splash-screen") !== null,
			}));
			throw new Error(
				`Settings control did not render: ${JSON.stringify(diagnostic)}`,
			);
		}
		const settings = await $(".app-bar-settings");
		await settings.click();

		const connectionsTab = await $("[data-settings-tab='connections']");
		await connectionsTab.waitForClickable({ timeout: 30_000 });
		await connectionsTab.click();

		const panel = await $("[data-testid='discord-connections']");
		await panel.waitForDisplayed({ timeout: 30_000 });
		expect(await panel.$$("input[type='password']")).toHaveLength(0);

		// The isolated WebView starts without a Discord credential. The focused
		// component contract test separately proves this action invokes the native
		// command with no argument; WebView2 blocks replacing its injected IPC host.
		expect(
			await browser.execute(() => {
				const storage = [
					...Object.values(localStorage),
					...Object.values(sessionStorage),
				];
				return storage.some((value) =>
					/discord.{0,32}(token|bot)|(?:token|bot).{0,32}discord/i.test(value),
				);
			}),
		).toBe(false);
		await browser.waitUntil(
			() =>
				browser.execute(() => {
					const button = document.querySelector<HTMLButtonElement>(
						"[data-testid='discord-connections'] .settings-actions button",
					);
					return Boolean(button && !button.disabled);
				}),
			{
				timeout: 30_000,
				timeoutMsg: "native Discord connect control remained disabled",
			},
		);
		await browser.execute(() => {
			const button = document.querySelector<HTMLButtonElement>(
				"[data-testid='discord-connections'] .settings-actions button",
			);
			if (!button || button.disabled)
				throw new Error("native Discord connect control unavailable");
			button.click();
		});

		const cancellation = await panel.$(
			"[role='alert'][data-error-code='capture_cancelled']",
		);
		await cancellation.waitForDisplayed({ timeout: 30_000 });
		expect(await panel.$$("input[type='password']")).toHaveLength(0);
	});
});
