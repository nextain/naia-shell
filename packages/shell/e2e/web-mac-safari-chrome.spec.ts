import { expect, test, type Page } from "@playwright/test";

test.skip(
	process.env.SAFARI_WEB_TEST !== "1",
	"requires a web-mode Vite server",
);
test.use({ serviceWorkers: "block" });

const safari =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
const iPhoneSafari =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";
async function fullyVisible(
	page: Page,
	locator: ReturnType<Page["getByTestId"]>,
) {
	const rect = await locator.boundingBox();
	const viewport = page.viewportSize();
	expect(rect).not.toBeNull();
	expect(rect!.x).toBeGreaterThanOrEqual(0);
	expect(rect!.y).toBeGreaterThanOrEqual(0);
	expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport!.width);
	expect(rect!.y + rect!.height).toBeLessThanOrEqual(viewport!.height);
}

const chrome =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

async function setup(
	page: Page,
	baseURL: string | undefined,
	ua: string,
	touch = 0,
	locale = "en",
	platform = "MacIntel",
) {
	if (!baseURL) throw new Error("The web test requires a loopback baseURL");
	const base = new URL(baseURL);
	if (
		base.protocol !== "http:" ||
		!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
	) {
		throw new Error("The web test requires an HTTP loopback baseURL");
	}
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		return url.origin === base.origin ? route.continue() : route.abort();
	});
	await page.addInitScript(
		({ ua, touch, locale, platform }) => {
			Object.defineProperty(navigator, "userAgent", { get: () => ua });
			Object.defineProperty(navigator, "platform", { get: () => platform });
			Object.defineProperty(navigator, "maxTouchPoints", { get: () => touch });
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					provider: "webllm",
					model: "Qwen3-4B-q4f32_1-MLC",
					ttsEnabled: false,
					locale,
				}),
			);
		},
		{ ua, touch, locale, platform },
	);
	await page.goto(`/app/`);
}

test("public entry: Safari notice, login modal, and authentication", async ({
	page,
	baseURL,
}) => {
	test.skip(process.env.SAFARI_LOGIN_REQUIRED === "1");
	await page.setViewportSize({ width: 390, height: 844 });
	await setup(page, baseURL, safari, 0, "ko");
	const notice = page.getByTestId("mac-safari-notice");
	await expect(notice).toHaveCount(1);
	await expect(notice).toContainText(
		"Mac에서는 Chrome으로 나이아를 열어 주세요.",
	);
	await expect(notice).toContainText("현재 주소를 Chrome에서");
	const link = notice.getByRole("link", { name: "Chrome 받기" });
	await expect(link).toHaveAttribute("href", "https://www.google.com/chrome/");
	await fullyVisible(page, link);
	await link.focus();
	await expect(link).toBeFocused();
	await page.getByTestId("web-workspace-start-default").click();
	await expect(
		page.getByRole("button", { name: "Menu", exact: true }),
	).toBeVisible({ timeout: 120000 });
	const menu = page.getByRole("button", { name: "Menu", exact: true });
	const noticeText = await notice.locator("strong").boundingBox();
	const menuBounds = await menu.boundingBox();
	expect(noticeText!.x + noticeText!.width).toBeLessThanOrEqual(menuBounds!.x);
	await fullyVisible(page, link);
	await page.getByRole("button", { name: "Menu", exact: true }).click();
	const login = page.getByTestId("web-mobile-login-btn");
	await fullyVisible(page, login);
	if (process.env.SAFARI_SCREENSHOT_PATH) {
		await page.screenshot({ path: process.env.SAFARI_SCREENSHOT_PATH });
	}
	await login.click();
	const modal = page.getByTestId("web-login-prompt-overlay");
	await expect(modal).toBeVisible();
	await expect(page.getByTestId("mac-safari-notice")).toHaveCount(1);
	await expect(modal.getByRole("button", { name: /로그인/ })).toBeVisible();
	await page.evaluate(() => {
		localStorage.setItem("naia-remote-key", "test-authenticated-key");
		window.dispatchEvent(new CustomEvent("naia-web-auth-changed"));
	});
	await expect(notice).toHaveCount(0);
	await expect(modal).toHaveCount(0);
});

for (const [name, ua, touch, platform] of [
	["Chrome", chrome, 0, "MacIntel"],
	["iPhone Safari", iPhoneSafari, 5, "iPhone"],
	["iPad desktop Safari", safari, 5, "MacIntel"],
] as const) {
	test(`public entry excludes ${name}`, async ({ page, baseURL }) => {
		test.skip(process.env.SAFARI_LOGIN_REQUIRED === "1");
		await setup(page, baseURL, ua, touch, "en", platform);
		await expect(page.getByTestId("web-workspace-start-default")).toBeVisible();
		await expect(page.getByTestId("mac-safari-notice")).toHaveCount(0);
	});
}

test("required login: notice precedes login, errors and callback remain usable", async ({
	page,
	baseURL,
}) => {
	test.skip(process.env.SAFARI_LOGIN_REQUIRED !== "1");
	await page.setViewportSize({ width: 390, height: 844 });
	await setup(page, baseURL, safari);
	const notice = page.getByTestId("mac-safari-notice");
	const button = page.getByTestId("web-login-submit");
	await expect(notice).toHaveCount(1);
	await expect(notice).toContainText("On Mac, please open Naia in Chrome.");
	await fullyVisible(page, notice.getByRole("link", { name: "Get Chrome" }));
	await fullyVisible(page, button);
	await page.keyboard.press("Tab");
	await expect(notice.getByRole("link", { name: "Get Chrome" })).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(button).toBeFocused();
	await expect
		.poll(() => notice.evaluate((el) => el.getBoundingClientRect().top))
		.toBeLessThan(
			await button.evaluate((el) => el.getBoundingClientRect().top),
		);
	await page.evaluate(() => {
		Object.defineProperty(crypto, "getRandomValues", {
			configurable: true,
			value: () => {
				throw new Error("test login error");
			},
		});
	});
	await button.click();
	await expect(page.getByTestId("web-login-error")).toHaveText(
		"test login error",
	);
	await expect(notice).toHaveCount(1);
	await page.evaluate(() => {
		delete (crypto as unknown as { getRandomValues?: unknown }).getRandomValues;
	});
	const [loginRequest] = await Promise.all([
		page.waitForRequest(
			(request) =>
				request.url().startsWith("https://naia.land/") &&
				request.url().includes("/login?"),
		),
		button.click(),
	]);
	const state = new URL(loginRequest.url()).searchParams.get("state");
	expect(state).toBeTruthy();
	await page.goto(
		`/app/auth/callback#state=${state}&key=test-authenticated-key&onboarding_complete=1`,
	);
	await expect(notice).toHaveCount(0);
	await expect(page.getByTestId("web-login-screen")).toHaveCount(0);
});
