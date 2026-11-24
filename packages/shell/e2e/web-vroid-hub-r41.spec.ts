import { expect, test } from "@playwright/test";
import { openWebShellWithBgm, WEB_BGM_VIEWPORTS } from "./helpers/web-bgm";
import { captureWebRequirement, openWebSettings } from "./helpers/web-settings";

test.skip(process.env.NAIA_E2E_WEB !== "1", "requires the web runtime");

for (const viewport of WEB_BGM_VIEWPORTS) {
	test(`R41 opens VRoid Hub from the VRM picker at ${viewport.width}px`, async ({
		page,
		context,
	}) => {
		await page.setViewportSize(viewport);
		await context.route(/^https?:\/\//, async (route) => {
			const url = new URL(route.request().url());
			if (url.hostname === "127.0.0.1" || url.hostname === "localhost")
				return route.continue();
			return route.fulfill({
				status: 503,
				body: "Only local resources are available in this test.",
			});
		});
		await openWebShellWithBgm(page, { openBgm: false });
		await openWebSettings(page);
		await page.locator('[data-settings-tab="avatar"]').click();
		const provider = page.locator("#avatar-provider");
		await provider.selectOption("vrm");
		const creator = page.getByRole("button", { name: "NVA 아바타 만들기" });
		const hub = page.getByRole("link", { name: "VRoid Hub" });
		await expect(creator).toHaveCount(0);
		await expect(hub).toBeInViewport();
		await expect(page.getByTestId("settings-vrm-list")).toBeVisible();
		await hub.focus();
		await expect(hub).toBeFocused();
		await captureWebRequirement(page, "R41");
		const popupPromise = page.waitForEvent("popup");
		await hub.press("Enter");
		const popup = await popupPromise;
		await popup.waitForLoadState();
		expect(popup.url()).toBe("https://hub.vroid.com/");
		await popup.close();
		await expect(provider).toHaveValue("vrm");
		await provider.selectOption("naia-video-avatar");
		await expect(hub).toHaveCount(0);
		await expect(creator).toBeInViewport();
	});
}
