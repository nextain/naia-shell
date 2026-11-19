import { expect, type Page, test } from "@playwright/test";
import { openWebShellWithBgm, WEB_BGM_VIEWPORTS } from "./helpers/web-bgm";

// R25-v: 웹판 음성 목록은 현재 언어 목소리를 맨 앞에 두고 언어별로 묶는다.
test.skip(process.env.NAIA_E2E_WEB !== "1" || process.env.VITE_NAIA_WEB_LLM !== "fake", "requires web runtime and fake model");
test.setTimeout(300_000);

const SHOTS = process.env.NAIA_E2E_SHOTS_DIR;

type VoiceGroup = { language: string; current: boolean; voices: string[] };

async function readGroups(page: Page): Promise<VoiceGroup[]> {
	return page.locator("#tts-voice-select").evaluate((el) =>
		Array.from(el.querySelectorAll("optgroup")).map((g) => ({
			language: (g as HTMLElement).dataset.voiceLanguage ?? "",
			current: (g as HTMLElement).dataset.voiceCurrent === "true",
			voices: Array.from(g.querySelectorAll("option")).map((o) => o.value),
		})),
	);
}

for (const viewport of WEB_BGM_VIEWPORTS) {
	test(`R25-v web voice list groups voices by language, current language first (${viewport.width}x${viewport.height})`, async ({ browser }) => {
		const context = await browser.newContext({ viewport, locale: "ko-KR" });
		const page = await context.newPage();
		// 헤드리스 Chrome 은 내장 목소리가 없으므로 실제 Chrome 이 주는 여러 언어 목록을 흉내 낸다.
		await page.addInitScript(() => {
			const voices = [
				["Google português do Brasil", "pt-BR"],
				["Google US English", "en-US"],
				["Google 한국의", "ko-KR"],
				["Google 日本語", "ja-JP"],
				["Google italiano", "it-IT"],
			].map(([name, lang]) => ({ name, lang, voiceURI: name, localService: false, default: false }));
			Object.defineProperty(window.speechSynthesis, "getVoices", { value: () => voices, configurable: true });
		});
		await openWebShellWithBgm(page, { openBgm: false });
		const settings = page.locator(".app-bar-settings");
		if (await settings.isVisible()) await settings.click();
		else {
			await page.locator(".web-mobile-menu-trigger").click();
			await page.getByRole("button", { name: /설정/ }).first().click();
		}
		await page.locator('[data-settings-tab="voice"]').click();
		const select = page.locator("#tts-voice-select");
		await select.scrollIntoViewIfNeeded();
		await expect(select).toBeVisible();

		// 웹 기본(브라우저 내장): 한국어 묶음이 맨 앞, 포르투갈어는 자기 묶음.
		await expect.poll(async () => (await readGroups(page)).length).toBeGreaterThan(1);
		const browserGroups = await readGroups(page);
		expect(browserGroups.map((g) => g.language)).toEqual(["ko", "en", "ja", "pt", "it"]);
		expect(browserGroups[0]).toMatchObject({ current: true, voices: ["Google 한국의"] });

		// Naia Cloud TTS 목록도 같은 규칙.
		await page.getByLabel("말하기 프로바이더 (TTS)").selectOption({ label: "Naia Cloud TTS" });
		await expect.poll(async () => (await readGroups(page))[0]?.language).toBe("ko");
		const cloudGroups = await readGroups(page);
		expect(cloudGroups[0].current).toBe(true);
		expect(cloudGroups[0].voices.some((id) => id.startsWith("ko-KR-"))).toBe(true);
		expect(cloudGroups[0].voices).not.toContain("pt-BR-Thalita:DragonHDLatestNeural");
		expect(cloudGroups.find((g) => g.language === "pt")?.voices).toContain("pt-BR-Thalita:DragonHDLatestNeural");
		expect(cloudGroups.filter((g) => g.current)).toHaveLength(1);

		// 화면 캡처에서 묶음이 보이도록 목록을 펼친 상태로 그린다.
		await select.evaluate((el) => el.setAttribute("size", "14"));
		await select.scrollIntoViewIfNeeded();
		if (SHOTS) await page.screenshot({ path: `${SHOTS}/R25-v-${viewport.width}.png` });
		await context.close();
	});
}
