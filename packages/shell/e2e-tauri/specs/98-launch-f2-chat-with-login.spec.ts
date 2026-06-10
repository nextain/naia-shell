/**
 * 런칭 F2 — 로그인 후 대화 (naia 계정 chat + Gemini Live direct)
 *
 * 사용자 시나리오:
 *   1. naiaKey 저장된 상태 (= 로그인 완료)
 *   2. App 진입 → chat panel 표시
 *   3. chat input 에 "안녕" 입력 + Enter
 *   4. agent 응답 수신 (= naia 계정 chat 경유 또는 Gemini Live direct)
 *   5. assistant message 표시
 *
 * naia-agent 없을 때 = sendChatMessage throw → ChatPanel 측 UI 안내
 * (W2 swallow + caller surface).
 */

import { ensureAppReady } from "../helpers/settings.js";
import { S } from "../helpers/selectors.js";

const API_KEY =
	process.env.CAFE_E2E_API_KEY || process.env.GEMINI_API_KEY || "";

describe("98 — F2 로그인 후 대화 (런칭 핵심)", () => {
	before(async () => {
		await ensureAppReady();
	});

	it("chat input 이 표시되고 enable 상태", async () => {
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 30_000 });
		await chatInput.waitForEnabled({ timeout: 30_000 });
	});

	it("chat tabs 8개 표시 (chat / history / progress / skills / channels / agents / diagnostics / settings)", async () => {
		const tabCount = await browser.execute(
			() => document.querySelectorAll(".chat-tabs .chat-tab").length,
		);
		expect(tabCount).toBeGreaterThanOrEqual(8);
	});

	it("API key 있고 enableTools=true 인 경우 sendChatMessage path 통과", async () => {
		if (!API_KEY) {
			console.log("API key not configured — skipping chat send test");
			return;
		}

		// 메시지 입력 + 전송
		const chatInput = await $(S.chatInput);
		await chatInput.click();
		await browser.keys("안녕".split(""));

		// Enter → 전송
		await browser.keys("Enter");

		// 사용자 메시지 표시 검증
		await browser.waitUntil(
			async () => {
				const userMsgs = await $$(S.userMessage);
				return userMsgs.length > 0;
			},
			{ timeout: 30_000, timeoutMsg: "user message did not appear after Enter" },
		);
	});
});
