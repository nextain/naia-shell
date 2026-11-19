import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

export async function openWebSettings(page: Page) {
	const menu = page.getByRole("button", { name: "Menu", exact: true });
	if (await menu.isVisible()) {
		await menu.click();
		await page
			.locator(".web-mobile-menu-list")
			.getByRole("button", { name: /Settings|설정/ })
			.click();
	} else {
		await page.getByRole("button", { name: /^(Settings|설정)$/ }).click();
	}
	await expect(page.locator(".settings-tab-bar")).toBeVisible();
}

export async function captureWebRequirement(page: Page, requirement: string) {
	const directory = process.env.NAIA_E2E_SHOTS_DIR;
	if (directory) {
		await page.screenshot({
			path: join(directory, `${requirement}-${page.viewportSize()?.width}.png`),
		});
	}
}
