import { expect, type Page } from "@playwright/test";

export function webAppInstallUrl(shellUrl: string, appId: string): URL {
	const url = new URL(shellUrl);
	url.searchParams.set("installApp", appId);
	return url;
}

export async function prepareStoreWorkspace(page: Page) {
	const start = page.getByTestId("web-workspace-start-default");
	const phase = () =>
		page.evaluate(() => window.__NAIA_WEB_ADK_STATUS__?.().phase);
	await expect
		.poll(
			async () => (await start.isVisible()) || (await phase()) === "ready",
			{
				timeout: 90_000,
			},
		)
		.toBe(true);
	if (await start.isVisible()) await start.click();
	await expect.poll(phase, { timeout: 90_000 }).toBe("ready");
}

export async function openAppFromStoreLink(page: Page, appId: string) {
	await page.goto(webAppInstallUrl(page.url(), appId).href);
	const confirmation = page.getByTestId("web-app-install-confirm");
	await expect(confirmation).toBeVisible({ timeout: 60_000 });
	await confirmation.getByTestId("web-app-install-accept").press("Enter");
	await expect(confirmation).toBeHidden({ timeout: 30_000 });
}
