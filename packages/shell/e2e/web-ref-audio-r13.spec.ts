import { expect, type Page, test } from "@playwright/test";
import { openWebShellWithBgm, silentWav, WEB_BGM_VIEWPORTS } from "./helpers/web-bgm";

// R13: 웹판 설정 음성 탭에 내 목소리 올리기가 보이고, 게이트웨이 형식으로 올라간다.
test.skip(process.env.NAIA_E2E_WEB !== "1" || process.env.VITE_NAIA_WEB_LLM !== "fake", "requires web runtime and fake model");
test.setTimeout(300_000);

const SHOTS = process.env.NAIA_E2E_SHOTS_DIR;
const FAKE_KEY = "e2e-fake-naia-key-r13";

type Upload = { authorization: string | null; body: string };

/** 운영·개발 게이트웨이로 나가는 요청은 모두 여기서 끊고 흉내 낸다. */
async function mockGateway(page: Page, uploads: Upload[]) {
	await page.route(/^https:\/\/([a-z0-9-]+\.)*(naia\.land|nextain\.io)\//, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.pathname === "/v1/ref-audio" && request.method() === "POST") {
			uploads.push({ authorization: request.headers().authorization ?? null, body: request.postDataBuffer()?.toString("latin1") ?? "" });
			return route.fulfill({ json: { uploaded_at: "2026-11-19T00:00:00Z", size_bytes: 32044, duration_seconds: 1, new_balance_usd: 1.99 } });
		}
		if (url.pathname === "/v1/ref-audio") {
			const active = uploads.length > 0 ? { kind: "upload", uploaded_at: "2026-11-19T00:00:00Z", size_bytes: 32044, duration_seconds: 1 } : null;
			return route.fulfill({ json: { active, history_count: uploads.length } });
		}
		if (url.pathname === "/v1/ref-audio/presets") return route.fulfill({ json: { presets: [] } });
		return route.fulfill({ status: 404, json: {} });
	});
}

async function openVoiceSettings(page: Page) {
	const settings = page.locator(".app-bar-settings");
	await expect(page.locator(".app-bar-settings:visible, .web-mobile-menu-trigger:visible").first()).toBeVisible({ timeout: 60_000 });
	if (await settings.isVisible()) await settings.click();
	else {
		await page.locator(".web-mobile-menu-trigger").click();
		await page.getByRole("button", { name: /설정/ }).first().click();
	}
	await page.locator('[data-settings-tab="voice"]').click();
}

for (const viewport of WEB_BGM_VIEWPORTS) {
	test(`R13 web voice tab shows voice upload and sends it in the gateway format (${viewport.width}x${viewport.height})`, async ({ browser }) => {
		const context = await browser.newContext({ viewport, locale: "ko-KR" });
		const page = await context.newPage();
		const uploads: Upload[] = [];
		await mockGateway(page, uploads);

		// 로그아웃: 올리기 대신 로그인 안내.
		await openWebShellWithBgm(page, { openBgm: false });
		await openVoiceSettings(page);
		await expect(page.getByTestId("web-ref-audio-login")).toBeVisible();
		await expect(page.getByTestId("ref-audio-file-button")).toHaveCount(0);

		// 로그인(가짜 키): 올리기와 "어디에 쓰이는지" 안내가 보인다.
		await page.evaluate((key) => localStorage.setItem("naia-remote-key", key), FAKE_KEY);
		await page.reload();
		await expect.poll(() => page.evaluate(() => window.__NAIA_WEB_ADK_STATUS__?.().phase), { timeout: 120_000 }).toBe("ready");
		await openVoiceSettings(page);
		const notice = page.getByTestId("web-ref-audio-notice");
		await expect(notice).toBeVisible();
		await expect(notice).toContainText("Naia Omni");
		const fileButton = page.getByTestId("ref-audio-file-button");
		await fileButton.scrollIntoViewIfNeeded();
		await expect(fileButton).toBeVisible();

		await page.getByTestId("ref-audio-file-input").setInputFiles({ name: "my-voice.wav", mimeType: "audio/wav", buffer: silentWav() });
		await expect.poll(() => uploads.length).toBe(1);
		// 게이트웨이 /v1/ref-audio 형식: Authorization Bearer + multipart 의 base64 RIFF/WAVE.
		expect(uploads[0].authorization).toBe(`Bearer ${FAKE_KEY}`);
		expect(uploads[0].body).toContain('filename="ref-audio.b64"');
		expect(uploads[0].body).toContain("UklGR");
		// 올리기 뒤 Tauri 전용 로컬 사본 때문에 오류로 끝나지 않고, 현재 음색이 바뀐다.
		await expect(page.getByText("설정된 음색 없음")).toHaveCount(0, { timeout: 15_000 });
		await expect(page.getByText("알 수 없는 오류")).toHaveCount(0);
		await notice.scrollIntoViewIfNeeded();
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/R13-${viewport.width}.png` });
		await context.close();
	});
}
