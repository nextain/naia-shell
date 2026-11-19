import { expect, type Page } from "@playwright/test";

/** 웹판 음악 앱 시험 공통(R7·R10). */

/** 두 폭(넓은 화면·세로 모바일)에서 같은 시험을 돈다. */
export const WEB_BGM_VIEWPORTS = [
	{ width: 1280, height: 720 },
	{ width: 390, height: 844 },
] as const;

/** 1초짜리 무음 PCM WAV. */
export function silentWav(): Buffer {
	const rate = 8000;
	const samples = rate;
	const buf = Buffer.alloc(44 + samples * 2);
	buf.write("RIFF", 0);
	buf.writeUInt32LE(36 + samples * 2, 4);
	buf.write("WAVE", 8);
	buf.write("fmt ", 12);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(rate, 24);
	buf.writeUInt32LE(rate * 2, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write("data", 36);
	buf.writeUInt32LE(samples * 2, 40);
	return buf;
}

/** 웹 작업 공간을 준비하고 음악 앱을 연다. */
export async function openWebShellWithBgm(page: Page) {
	await page.route("**/web-adk/*.json", async (route) => {
		const response = await route.fetch();
		const bundle = await response.json();
		const agents = bundle.files.find((file: { path: string }) => file.path === "AGENTS.md");
		if (!agents) throw new Error("workspace bundle lacks AGENTS.md");
		await route.fulfill({ json: { ...bundle, files: [agents], dirs: [] } });
	});
	// 외부 YouTube 는 샌드박스에서 봇 확인 화면을 띄우므로 재생기 자리만 남긴다.
	await page.route(/youtube(-nocookie)?\.com\/embed\//, (route) =>
		route.fulfill({ contentType: "text/html", body: "<html><body style='background:#111'></body></html>" }),
	);
	await page.addInitScript(() => {
		if (!localStorage.getItem("naia-config")) localStorage.setItem("naia-config", JSON.stringify({ provider: "webllm", model: "Qwen3-4B-q4f32_1-MLC", ttsEnabled: false, locale: "ko" }));
		if (!localStorage.getItem("naia-web-llm-model")) localStorage.setItem("naia-web-llm-model", "Qwen3-4B-q4f32_1-MLC");
	});
	await page.goto("/");
	await page.getByTestId("web-workspace-start-default").click();
	await waitWebWorkspaceReady(page);
	await openBgmApp(page);
}

export async function waitWebWorkspaceReady(page: Page) {
	await expect.poll(() => page.evaluate(() => window.__NAIA_WEB_ADK_STATUS__?.().phase), { timeout: 120_000 }).toBe("ready");
}

/**
 * 세로 모바일(390)은 앱 바가 숨고 ☰ 메뉴에도 음악 항목이 없다(진입점은 앱 바
 * 묶음 몫). 여기서는 재생기 내부만 보므로 숨은 아이콘을 스크립트로 누른다.
 */
export async function openBgmApp(page: Page) {
	const icon = page.locator(".bgm-icon");
	await expect(icon).toHaveCount(1, { timeout: 120_000 });
	if (await icon.isVisible()) await icon.click();
	else await icon.evaluate((el) => (el as HTMLElement).click());
	await expect(page.locator(".bgm-yt-app")).toBeVisible();
}
