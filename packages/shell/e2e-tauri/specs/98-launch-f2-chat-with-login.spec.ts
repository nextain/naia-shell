/**
 * 런칭 F2 — 로그인 후 대화 (naia 계정 chat)
 *
 * 사용자 시나리오:
 *   1. naiaKey 저장된 상태 (= 로그인 완료)
 *   2. App 진입 → chat app 표시
 *   3. chat input 에 "안녕" 입력 + Enter
 *   4. agent 응답 수신 (= naia 계정 chat 경유)
 *   5. assistant message 표시
 *
 * naia-agent 없을 때 = sendChatMessage throw → ChatApp 측 UI 안내
 * (W2 swallow + caller surface).
 */

import { ensureAppReady } from "../helpers/settings.js";
import { S } from "../helpers/selectors.js";

// 하네스(wdio.conf.ts)가 나이아 게이트웨이 공급자를 워크스페이스에 심는다.
// 예전에는 Gemini 직결 키가 없으면 전송 검사를 조용히 건너뛰었고, 그 키를
// 요구한다는 이유로 스펙 전체가 회귀에서 빠졌다(#602 로 그 공급자는 사라졌다).

describe("98 — F2 로그인 후 대화 (런칭 핵심)", () => {
	before(async () => {
		await ensureAppReady();
	});

	it("chat input 이 표시되고 enable 상태", async () => {
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 30_000 });
		await chatInput.waitForEnabled({ timeout: 30_000 });
	});

	it("채팅 머리에 chat · history 탭이 표시된다", async () => {
		// 나머지 화면(스킬·채널·진단 등)은 설정 안으로 옮겨졌다. 개수로 재면 그 이동마다
		// 조용히 깨지므로 남아 있어야 하는 두 탭을 이름으로 잰다.
		await (await $(S.chatTab)).waitForDisplayed({ timeout: 30_000 });
		await (await $(S.historyTab)).waitForDisplayed({ timeout: 30_000 });
	});

	it("심긴 공급자로 sendChatMessage path 를 지난다", async () => {
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
