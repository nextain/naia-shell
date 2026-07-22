async function workspaceLabel(): Promise<string> {
	return browser.execute(() => {
		const input = document.querySelector("[data-testid='coding-worker-worktree']");
		if (!(input instanceof HTMLInputElement)) {
			throw new Error("Course worker workspace input is missing");
		}
		return input.closest("label")?.textContent?.trim() ?? "";
	});
}

describe("Jeonju course worker guidance through the real Tauri Shell", () => {
	it("distinguishes the default isolated worktree from direct course Git-root work", async () => {
		const workspace = await $("button[data-panel-id='workspace']");
		await workspace.waitForClickable({ timeout: 30_000 });
		await workspace.click();

		const toggle = await $("[data-testid='coding-workers-toggle']");
		await toggle.waitForClickable({ timeout: 30_000 });
		await toggle.click();
		const panel = await $("[data-testid='coding-workers']");
		await panel.waitForDisplayed({ timeout: 30_000 });
		expect(await workspaceLabel()).toMatch(
			/dedicated worktree is created automatically|전용 worktree가 자동으로 만들어집니다/,
		);

		const courseMode = await $("[data-testid='coding-worker-jeonju-course-preset']");
		await courseMode.click();
		await browser.waitUntil(
			async () => (await workspaceLabel()).includes("Course workspace Git root"),
			{
				timeout: 10_000,
				timeoutMsg: "course mode did not replace the isolated-worktree guidance",
			},
		);
		const hint = await $("[data-testid='coding-worker-course-mode-hint']");
		await hint.waitForDisplayed({ timeout: 10_000 });
		expect(await hint.getText()).toMatch(
			/Only index\.html and hero\.svg may change|index\.html과 hero\.svg만 변경할 수 있습니다/,
		);
	});
});
