import { expect, type Page } from "@playwright/test";

/**
 * Ensures the web workspace is ready.
 * If the workspace setup screen is present, clicks "Start with default workspace",
 * waits until the setup screen is gone, and waits until the status bar is ready.
 * If already ready, returns immediately.
 */
export async function startDefaultWorkspace(page: Page): Promise<void> {
	const setup = page.locator('[data-testid="web-workspace-setup"]');
	const startBtn = page.locator('[data-testid="web-workspace-start-default"]');
	const readyStatus = page.locator('[data-phase="ready"]');

	// Wait until the workspace phase is resolved beyond the initial "checking" state
	await page.waitForFunction(() => {
		const statusFn = window.__NAIA_WEB_ADK_STATUS__;
		if (!statusFn) return false;
		return statusFn().phase !== "checking";
	}, undefined, { timeout: 10_000 });

	const phase = await page.evaluate(() => {
		return window.__NAIA_WEB_ADK_STATUS__?.().phase;
	});

	if (phase === "needs-setup") {
		await startBtn.waitFor({ state: "visible", timeout: 5000 });
		await startBtn.click();
		await expect(setup).not.toBeVisible({ timeout: 30_000 });
	}

	await expect(readyStatus).toBeAttached({ timeout: 30_000 });
}
