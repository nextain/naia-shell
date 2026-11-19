import { expect, test } from "@playwright/test";
import { openWebShellWithBgm, WEB_BGM_VIEWPORTS } from "./helpers/web-bgm";

// R7: 웹판 음악 목록의 제목이 실제로 재생되는 영상과 같다.
test.skip(process.env.NAIA_E2E_WEB !== "1" || process.env.VITE_NAIA_WEB_LLM !== "fake", "requires web runtime and fake model");
test.setTimeout(300_000);

const SHOTS = process.env.NAIA_E2E_SHOTS_DIR;

for (const viewport of WEB_BGM_VIEWPORTS) {
	test(`R7 web catalog row plays the video it names (${viewport.width}x${viewport.height})`, async ({ browser }) => {
		const context = await browser.newContext({ viewport, locale: "ko-KR" });
		const page = await context.newPage();
		await openWebShellWithBgm(page);
		await page.locator(".bgm-yt-cat-btn", { hasText: "지브리" }).click();
		const row = page.locator(".bgm-yt-app .bgm-yt-row").first();
		await expect(row).toContainText("GhibliJazz");
		await row.click();
		await expect.poll(() => page.locator(".app-bg-iframe").getAttribute("src")).toContain("3jWRrafhO7M");
		await expect(page.locator(".bgm-player")).toHaveAttribute("data-bgm-current-title", /GhibliJazz/);
		// 예전 표의 지어낸 곡명이 웹 목록에 남아 있지 않아야 한다.
		const titles = await page.evaluate(async () => {
			const source = "/src/lib/bgm-skill.ts";
			const mod = await import(/* @vite-ignore */ source);
			return (mod.WEB_YOUTUBE_CATALOG as { title: string }[]).map((entry) => entry.title);
		});
		for (const fake of ["Joe Hisaishi - Summer Piano Theme", "Yiruma - River Flows in You", "Tokyo Sunset City Pop", "Rio Morning Bossa"]) {
			expect(titles).not.toContain(fake);
		}
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/R7-${viewport.width}.png` });
		await context.close();
	});
}
