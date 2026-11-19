import { expect, type Page, test } from "@playwright/test";
import { openWebShellWithBgm, WEB_BGM_VIEWPORTS } from "./helpers/web-bgm";

test.skip(
	process.env.NAIA_E2E_WEB !== "1" || process.env.VITE_NAIA_WEB_LLM !== "fake",
	"requires web runtime and fake model",
);
test.setTimeout(150_000);
test.beforeEach(async ({ context, baseURL }) => {
	await context.route(/^https?:\/\//, (route) =>
		new URL(route.request().url()).origin ===
		new URL(baseURL ?? "http://localhost").origin
			? route.continue()
			: route.abort(),
	);
});

const shots = process.env.NAIA_E2E_SHOTS_DIR;

async function playCatalogTrack(page: Page) {
	// YouTube is replaced only at the iframe boundary. The app still receives its
	// regular playback event and renders the real player, card and settings.
	await page.route(/youtube(-nocookie)?\.com\/embed\//, (route) => {
		const videoId = new URL(route.request().url()).pathname.split("/").pop();
		const message = JSON.stringify({
			event: "infoDelivery",
			info: {
				currentTime: 1,
				duration: 180,
				playerState: 1,
				videoData: { video_id: videoId },
			},
		});
		return route.fulfill({
			contentType: "text/html",
			body:
				"<script>parent.postMessage(" +
				JSON.stringify(message) +
				", '*')</script>",
		});
	});
	await page.locator(".bgm-yt-cat-btn", { hasText: "지브리" }).click();
	await page.locator(".bgm-yt-app .bgm-yt-row").first().click();
	await expect(page.locator(".bgm-player")).toHaveAttribute(
		"data-bgm-playback-status",
		"playing",
	);
}

async function openSettings(page: Page, mobile: boolean) {
	if (mobile) {
		await page.getByRole("button", { name: "Menu", exact: true }).click();
		await page
			.locator(".web-mobile-menu-list")
			.getByRole("button", { name: /설정/ })
			.click();
	} else {
		await page.getByRole("button", { name: "설정", exact: true }).click();
	}
	await expect(page.locator('[data-settings-tab="profile"]')).toBeVisible();
}

for (const viewport of WEB_BGM_VIEWPORTS) {
	test.describe(viewport.width + "×" + viewport.height, () => {
		test.use({ viewport, locale: "ko-KR" });

		test("R36 briefly shows Now Playing and keeps settings controls usable during playback", async ({
			page,
		}) => {
			const mobile = viewport.width === 390;
			await openWebShellWithBgm(page);
			const card = page.getByTestId("bgm-youtube-now-playing");
			await expect(card).toHaveCount(0);
			await playCatalogTrack(page);
			await expect(card).toBeVisible();
			await expect(card).toContainText("GhibliJazz");

			if (await page.locator(".bgm-yt-app").isVisible()) {
				await page
					.locator(".bgm-icon")
					.evaluate((element: HTMLElement) => element.click());
			}
			await openSettings(page, mobile);
			await expect(card).toHaveCount(0);
			const avatarTab = page.locator('[data-settings-tab="avatar"]');
			await avatarTab.click();
			await expect(avatarTab).toHaveClass(/settings-tab-btn--active/);

			const close = mobile
				? page.locator(".web-mobile-workspace-close")
				: page.getByRole("button", { name: "설정 닫기" });
			await close.click({ trial: true });
			await expect(page.locator(".bgm-player")).toHaveAttribute(
				"data-bgm-playback-status",
				"playing",
			);
			if (shots)
				await page.screenshot({
					path: shots + "/R36-" + viewport.width + ".png",
				});
			await close.click();
			await expect(avatarTab).toBeHidden();
			await expect(card).toHaveCount(0, { timeout: 10_000 });
			await expect(page.locator(".bgm-player")).toHaveAttribute(
				"data-bgm-playback-status",
				"playing",
			);
		});
	});
}
