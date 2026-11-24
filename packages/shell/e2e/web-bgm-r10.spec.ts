import { expect, test } from "@playwright/test";
import {
	openBgmApp,
	openWebShellWithBgm,
	silentWav,
	waitWebWorkspaceReady,
	WEB_BGM_VIEWPORTS,
} from "./helpers/web-bgm";

// R10: 웹판 음악 앱 로컬 탭에 사용자 음악 파일을 올려 재생한다.
test.skip(process.env.NAIA_E2E_WEB !== "1" || process.env.VITE_NAIA_WEB_LLM !== "fake", "requires web runtime and fake model");
test.setTimeout(300_000);

const SHOTS = process.env.NAIA_E2E_SHOTS_DIR;

for (const viewport of WEB_BGM_VIEWPORTS) {
	test(`R10 web local tab imports, plays and removes a music file (${viewport.width}x${viewport.height})`, async ({ browser }) => {
		const context = await browser.newContext({ viewport, locale: "ko-KR" });
		const page = await context.newPage();
		await openWebShellWithBgm(page);
		await page.locator(".bgm-app-tab").nth(1).click();
		await expect(page.locator(".bgm-yt-status").first()).toContainText("이 브라우저에만");
		const upload = page.getByTestId("bgm-local-upload");
		await expect(upload).toBeVisible();
		await expect(upload).toHaveText("음악 올리기");
		await page.getByTestId("bgm-local-file-input").setInputFiles([
			{ name: "내 노래.wav", mimeType: "audio/wav", buffer: silentWav() },
			{ name: "memo.txt", mimeType: "text/plain", buffer: Buffer.from("x") },
		]);
		const rows = page.locator(".bgm-local-row");
		await expect(rows).toHaveCount(1);
		await expect(rows.first()).toContainText("내 노래");
		await expect(page.locator(".bgm-player")).toHaveAttribute("data-bgm-local-count", "1");
		// 음악이 아닌 파일은 거절 이유를 보인다.
		const message = page.getByTestId("bgm-local-import-message");
		await expect(message).toHaveAttribute("role", "alert");
		await expect(message).toContainText("음악 파일");
		await rows.first().click();
		await expect
			.poll(() =>
				page.evaluate(() => {
					const audio = Array.from(document.querySelectorAll("audio")).find((el) => el.src.startsWith("blob:"));
					return audio ? { error: audio.error?.code ?? 0 } : null;
				}),
			)
			.toMatchObject({ error: 0 });
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/R10-${viewport.width}.png` });
		// 새로고침 뒤에도 목록이 남는다 — 브라우저 저장소(OPFS).
		await page.reload();
		await waitWebWorkspaceReady(page);
		await openBgmApp(page);
		await page.locator(".bgm-app-tab").nth(1).click();
		await expect(page.locator(".bgm-local-row")).toHaveCount(1);
		await page.getByTestId("bgm-local-remove").first().click();
		await expect(page.locator(".bgm-local-row")).toHaveCount(0);
		await context.close();
	});
}
