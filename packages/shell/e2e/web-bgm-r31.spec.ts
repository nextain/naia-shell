import { expect, test, type Page } from "@playwright/test";
import { openWebShellWithBgm, WEB_BGM_VIEWPORTS } from "./helpers/web-bgm";

// R31: 웹판 상단 음악 바의 ▶ 가 유튜브 곡을 실제로 싣는다.
// 외부 YouTube 는 헬퍼가 빈 문서로 바꿔 두므로(봇 확인 회피) 플레이어는 진행을 알리지 않는다
// = "유튜브가 재생하지 않음" 상태를 결정적으로 재현한다.
test.skip(process.env.NAIA_E2E_WEB !== "1" || process.env.VITE_NAIA_WEB_LLM !== "fake", "requires web runtime and fake model");
test.setTimeout(300_000);

const SHOTS = process.env.NAIA_E2E_SHOTS_DIR;
const FIRST_CATALOG_ID = "8XmoPmtBi-I";

/**
 * 상단 바 ▶ 를 누른다. 세로 모바일(390)은 앱 바 묶음이 상단 바를 숨기므로(진입점은 그 묶음 몫)
 * 여기서는 숨은 단추를 스크립트로 눌러 재생·알림 경로만 본다.
 */
async function pressTopBarPlay(page: Page) {
	const play = page.locator(".bgm-player .bgm-btn--play");
	if (await play.isVisible()) await play.click();
	else await play.evaluate((el) => (el as HTMLElement).click());
}

/** 포털(dev.naia.land /app)과 같은 cross-origin isolation 헤더를 첫 문서에 붙인다. */
async function servePortalHeaders(page: Page) {
	await page.route(
		(url) => url.pathname === "/" || url.pathname === "/index.html",
		async (route) => {
			if (!route.request().isNavigationRequest()) return route.fallback();
			const response = await route.fetch();
			await route.fulfill({
				response,
				headers: {
					...response.headers(),
					"cross-origin-opener-policy": "same-origin",
					"cross-origin-embedder-policy": "credentialless",
					"permissions-policy": "microphone=(self), camera=(self), autoplay=(self), clipboard-write=(self)",
				},
			});
		},
	);
}

for (const viewport of WEB_BGM_VIEWPORTS) {
	test(`R31 top-bar ▶ loads a real YouTube song and admits when it does not start (${viewport.width}x${viewport.height})`, async ({ browser }) => {
		const context = await browser.newContext({ viewport, locale: "ko-KR" });
		const page = await context.newPage();
		await openWebShellWithBgm(page, { openBgm: false });
		const play = page.locator(".bgm-player .bgm-btn--play");
		await expect(play).toHaveText("▶");
		await expect(page.locator(".app-bg-iframe")).toHaveCount(0);

		await pressTopBarPlay(page);
		// 기본: 아무 곡도 고르지 않았어도 ▶ 가 실제 곡을 싣는다(예전: iframe 없이 ■ 만 켜짐).
		await expect.poll(() => page.locator(".app-bg-iframe").getAttribute("src")).toContain(FIRST_CATALOG_ID);
		await expect(page.locator(".bgm-player")).toHaveAttribute("data-bgm-current-title", /Lofi Chill/);
		await expect(play).toHaveText("■");
		// isolation 없는 페이지에서는 credentialless 를 달지 않는다.
		await expect(page.locator(".app-bg-iframe")).not.toHaveAttribute("credentialless", /.*/);

		// 오류: 플레이어가 진행을 한 번도 알리지 않으면 ■ 를 내리고 이유를 보인다.
		const notice = page.locator(".bgm-yt-notice");
		await expect(notice).toBeVisible({ timeout: 45_000 });
		await expect(notice).toHaveAttribute("role", "status");
		await expect(notice).toContainText("유튜브가 이 곡을 재생하지 않았습니다");
		await expect(play).toHaveText("▶");
		const box = await notice.boundingBox();
		expect(box).not.toBeNull();
		if (box) {
			expect(box.x).toBeGreaterThanOrEqual(0);
			expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
		}
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/R31-${viewport.width}.png` });

		// 복구: 닫기 단추(키보드)로 알림을 지우고, ▶ 를 다시 누르면 새 재생을 싣는다.
		await notice.getByRole("button").focus();
		await page.keyboard.press("Enter");
		await expect(notice).toHaveCount(0);
		await pressTopBarPlay(page);
		await expect(play).toHaveText("■");
		await expect(page.locator(".app-bg-iframe")).toHaveAttribute("src", /naiaPlayback=bgm-playback-2/);
		await context.close();
	});
}

test("R31 cross-origin isolated page embeds the YouTube iframe credentialless instead of blocking it (1280x720)", async ({ browser }) => {
	const context = await browser.newContext({ viewport: WEB_BGM_VIEWPORTS[0], locale: "ko-KR", serviceWorkers: "block" });
	const page = await context.newPage();
	await servePortalHeaders(page);
	await openWebShellWithBgm(page, { openBgm: false });
	expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
	await pressTopBarPlay(page);
	const iframe = page.locator(".app-bg-iframe");
	await expect.poll(() => iframe.getAttribute("src")).toContain(FIRST_CATALOG_ID);
	await expect(iframe).toHaveAttribute("credentialless", "");
	// COEP 아래 일반 iframe 이면 문서가 막혀 오류 페이지가 된다. 실린 문서가 헬퍼의 빈 문서인지 본다.
	await expect
		.poll(async () => {
			const frame = page.frames().find((f) => f.url().includes(FIRST_CATALOG_ID));
			if (!frame) return "no-frame";
			return frame.evaluate(() => document.body?.getAttribute("style") ?? "").catch(() => "blocked");
		})
		.toContain("background:#111");
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/R31-coep-1280.png` });
	await context.close();
});
