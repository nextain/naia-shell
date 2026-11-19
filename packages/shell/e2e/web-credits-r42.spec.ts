import { expect, test } from "@playwright/test";
import { openWebShellWithBgm, WEB_BGM_VIEWPORTS } from "./helpers/web-bgm";
import { captureWebRequirement, openWebSettings } from "./helpers/web-settings";

test.skip(process.env.NAIA_E2E_WEB !== "1", "requires the web runtime");

const cors = {
	"access-control-allow-origin": "*",
	"access-control-allow-headers": "content-type,x-anyllm-key,authorization",
	"access-control-allow-methods": "GET,POST,OPTIONS",
};

for (const viewport of WEB_BGM_VIEWPORTS) {
	const locale = viewport.width === 390 ? "en" : "ko";
	test(`R42 uses Cr in ${locale} at ${viewport.width}px`, async ({
		page,
		context,
	}) => {
		await page.setViewportSize(viewport);
		let balanceReply: Promise<number> = Promise.resolve(200);
		await context.route(/^https?:\/\//, async (route) => {
			const url = new URL(route.request().url());
			if (url.hostname === "127.0.0.1" || url.hostname === "localhost")
				return route.continue();
			if (route.request().method() === "OPTIONS")
				return route.fulfill({ status: 204, headers: cors });
			if (url.pathname === "/v1/profile/balance") {
				const status = await balanceReply;
				return route.fulfill({
					status,
					headers: cors,
					json: { credits: 1234 },
				});
			}
			if (url.pathname === "/v1/pricing") {
				return route.fulfill({
					headers: cors,
					json: [
						{
							model_key: "azure:gpt-5.6-luna",
							input_price_per_million: 1.234,
							output_price_per_million: 4.567,
							cached_price_per_million: 0.123,
							cache_write_price_per_million: 0.2,
						},
					],
				});
			}
			if (url.pathname === "/v1/models") {
				return route.fulfill({
					headers: cors,
					json: { data: [{ id: "gpt-5.6-luna", object: "model" }] },
				});
			}
			return route.fulfill({ status: 404, headers: cors, json: {} });
		});
		await page.addInitScript((locale) => {
			localStorage.setItem("naia-remote-key", "fixture-r42-local-key");
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					provider: "nextain",
					model: "gpt-5.6-luna",
					locale,
					ttsEnabled: false,
				}),
			);
		}, locale);
		await openWebShellWithBgm(page, { openBgm: false });

		if (viewport.width === 1280) {
			const chip = page.locator(".web-credit__chip");
			await expect(chip).toHaveText(/1,234 Cr/);
			await chip.click();
			await expect(page.locator(".web-credit__popover strong")).toHaveText(
				"1,234 Cr",
			);
			await chip.click();
		}

		let failBalance!: (status: number) => void;
		balanceReply = new Promise((resolve) => {
			failBalance = resolve;
		});
		const profile = page.getByTestId("profile-naia-account");
		const balance = profile.locator(".lab-balance-value");
		try {
			await openWebSettings(page);
			await expect(balance).toHaveText(/Loading balance|잔액 조회 중/);
		} finally {
			failBalance(503);
		}
		await expect(balance).toHaveText(/Failed to load balance|잔액 조회 실패/);
		balanceReply = Promise.resolve(200);
		const retry = page.getByTestId("lab-balance-retry");
		await retry.focus();
		await expect(retry).toBeFocused();
		await retry.press("Enter");
		await expect(balance).toHaveText("1,234 Cr");

		await page.locator('[data-settings-tab="brain"]').click();
		const provider = page.locator("#provider-select");
		if ((await provider.inputValue()) !== "nextain")
			await provider.selectOption("nextain");
		await page.locator("#model-select").selectOption("gpt-5.6-luna");
		const price = page.locator(
			".settings-model-selected-label:not([data-testid])",
		);
		await expect(price).toContainText("1,234 Cr");
		await expect(price).toContainText("4,567 Cr");
		await expect(price).toContainText("123 Cr");
		await expect(price.getByText("200 Cr", { exact: true })).toHaveCSS(
			"white-space",
			"nowrap",
		);
		await expect(price).not.toContainText(/약|≈|크레딧|credits/i);
		await expect(page.getByTestId("small-model-selected-label")).toContainText(
			"1,234 Cr",
		);
		await price.scrollIntoViewIfNeeded();
		await expect(price).toBeInViewport();
		await captureWebRequirement(page, "R42");
	});
}
