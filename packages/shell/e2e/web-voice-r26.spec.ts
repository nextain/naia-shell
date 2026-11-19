import { expect, type Page, test } from "@playwright/test";
import { openWebShellWithBgm, WEB_BGM_VIEWPORTS } from "./helpers/web-bgm";

// R26: 웹판 음성 대화 — 말하면 답을 읽어 주고, 마이크 오류는 고치는 방법을 알린다.
test.skip(process.env.NAIA_E2E_WEB !== "1" || process.env.VITE_NAIA_WEB_LLM !== "fake", "requires web runtime and fake model");
test.setTimeout(300_000);

const SHOTS = process.env.NAIA_E2E_SHOTS_DIR;

type Probe = { starts: number; aborts: number; spoken: string[] };

/**
 * 헤드리스 Chrome 의 SpeechRecognition 은 마이크·구글 음성 서버가 없어 audio-capture 로 끝난다.
 * 브라우저가 주는 결과·오류를 흉내 내고, 말하기(speechSynthesis)는 기록만 한다.
 */
async function fakeBrowserSpeech(page: Page, scenario: "result" | `error:${string}`) {
	await page.addInitScript((scenario) => {
		const probe = { starts: 0, aborts: 0, spoken: [] as string[] };
		Object.assign(window, { __r26: probe });
		class FakeRecognition {
			onresult: ((event: unknown) => void) | null = null;
			onerror: ((event: unknown) => void) | null = null;
			onend: (() => void) | null = null;
			start() {
				probe.starts += 1;
				const first = probe.starts === 1;
				setTimeout(() => {
					if (scenario.startsWith("error:")) {
						this.onerror?.({ error: scenario.slice(6), message: "" });
						return;
					}
					if (!first) return;
					const alt = { transcript: "안녕하세요", confidence: 0.9 };
					const res = Object.assign([alt], { isFinal: true, item: () => alt });
					this.onresult?.({ resultIndex: 0, results: Object.assign([res], { item: () => res }) });
				}, 500);
			}
			stop() {
				setTimeout(() => this.onend?.(), 10);
			}
			abort() {
				probe.aborts += 1;
			}
		}
		Object.assign(window, { SpeechRecognition: FakeRecognition, webkitSpeechRecognition: FakeRecognition });
		window.speechSynthesis.speak = (utterance: SpeechSynthesisUtterance) => {
			probe.spoken.push(utterance.text);
			setTimeout(() => utterance.onstart?.(new Event("start") as SpeechSynthesisEvent), 10);
			setTimeout(() => utterance.onend?.(new Event("end") as SpeechSynthesisEvent), 300);
		};
		localStorage.setItem("naia-config", JSON.stringify({ provider: "webllm", model: "Qwen3-4B-q4f32_1-MLC", ttsEnabled: true, locale: "ko" }));
	}, scenario);
}

const probe = (page: Page) => page.evaluate(() => (window as unknown as { __r26: Probe }).__r26);

for (const viewport of WEB_BGM_VIEWPORTS) {
	test(`R26 web voice chat answers speech and explains microphone errors (${viewport.width}x${viewport.height})`, async ({ browser }) => {
		// 말하기 → 답 → 읽어 주기 → 다시 듣기.
		const context = await browser.newContext({ viewport, locale: "ko-KR" });
		const page = await context.newPage();
		await fakeBrowserSpeech(page, "result");
		await openWebShellWithBgm(page, { openBgm: false });
		const voice = page.locator(".chat-voice-btn");
		await voice.click();
		await expect(voice).toHaveClass(/active/);
		await expect(page.locator(".chat-messages .chat-message.user")).toContainText("안녕하세요", { timeout: 60_000 });
		await expect.poll(async () => (await probe(page)).spoken.length, { timeout: 60_000 }).toBeGreaterThan(0);
		await expect.poll(async () => (await probe(page)).starts, { timeout: 30_000 }).toBeGreaterThan(1);
		await expect(voice).toHaveClass(/active/);
		await voice.click();
		await expect(voice).not.toHaveClass(/active/);
		await context.close();

		// 마이크 권한 거부: 원래 코드(not-allowed) 대신 고치는 방법, 데스크톱 전용 STT 정지 호출 없음.
		const denied = await browser.newContext({ viewport, locale: "ko-KR" });
		const deniedPage = await denied.newPage();
		const deniedLogs: string[] = [];
		deniedPage.on("console", (m) => deniedLogs.push(m.text()));
		await fakeBrowserSpeech(deniedPage, "error:not-allowed");
		await openWebShellWithBgm(deniedPage, { openBgm: false });
		const deniedVoice = deniedPage.locator(".chat-voice-btn");
		await deniedVoice.click();
		const last = deniedPage.locator(".chat-messages .chat-message.assistant").last();
		await expect(last).toContainText("마이크 권한이 막혀 있습니다", { timeout: 60_000 });
		await expect(last).not.toContainText("not-allowed");
		await expect(deniedVoice).not.toHaveClass(/active/);
		expect(deniedLogs.filter((line) => line.includes("plugin:stt|stop_listening"))).toEqual([]);
		if (SHOTS) await deniedPage.screenshot({ path: `${SHOTS}/R26-${viewport.width}.png` });
		await denied.close();
	});
}
