async function workspaceLabel(): Promise<string> {
	return browser.execute(() => {
		const input = document.querySelector(
			"[data-testid='coding-worker-worktree']",
		);
		if (!(input instanceof HTMLInputElement)) {
			throw new Error("Course worker workspace input is missing");
		}
		return input.closest("label")?.textContent?.trim() ?? "";
	});
}

describe("Jeonju course worker guidance through the real Tauri Shell", () => {
	it("shows an actionable course target state instead of implementation-oriented worker controls", async () => {
		const workspace = await $("button[data-panel-id='workspace']");
		await workspace.waitForClickable({ timeout: 30_000 });
		await workspace.click();

		const toggle = await $("[data-testid='coding-workers-toggle']");
		await toggle.waitForClickable({ timeout: 30_000 });
		await toggle.click();
		const panel = await $("[data-testid='coding-workers']");
		await panel.waitForDisplayed({ timeout: 30_000 });
		const controlRoot = await $("[data-testid='coding-worker-control-root']");
		expect(await controlRoot.getText()).toMatch(/ADK control root|제어 루트/);
		expect(await controlRoot.getText()).not.toMatch(
			/Not configured|설정되지 않음/,
		);
		expect(await workspaceLabel()).toMatch(/Work target|작업 대상/);
		expect(
			await $$("[data-testid='coding-worker-provider'] select"),
		).toHaveLength(0);
		expect(await $("[data-testid='coding-workers-empty']").isDisplayed()).toBe(
			true,
		);

		const courseMode = await $(
			"[data-testid='coding-worker-jeonju-course-preset']",
		);
		await courseMode.click();
		await browser.waitUntil(
			async () =>
				/Course execution-target Git root|수업 작업 대상 Git 루트/.test(
					await workspaceLabel(),
				),
			{
				timeout: 10_000,
				timeoutMsg: "course mode did not replace the work-target label",
			},
		);
		const hint = await $("[data-testid='coding-worker-course-mode-hint']");
		await hint.waitForDisplayed({ timeout: 10_000 });
		expect(await hint.getText()).toMatch(
			/Changes are limited to index\.html and hero\.svg|변경 범위는 index\.html, hero\.svg로 고정됩니다/,
		);
		const targetStatus = await $(
			"[data-testid='coding-worker-course-target-status']",
		);
		expect(await targetStatus.getText()).toMatch(
			/No Discord course target has been saved|저장된 Discord 수업 대상이 없습니다/,
		);
	});
});
