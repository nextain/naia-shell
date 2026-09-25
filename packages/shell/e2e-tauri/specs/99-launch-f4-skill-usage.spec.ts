/**
 * 런칭 F4 — 자체 스킬 이용
 *
 * 사용자 시나리오:
 *   1. naiaKey 저장된 상태 (하네스가 나이아 게이트웨이 공급자를 심는다)
 *   2. App 진입 → chat app 표시
 *   3. "지금 몇시야?" 같은 시간 질의
 *   4. agent → skill_time tool 호출 → 결과 응답
 *   5. assistant message 에 시간 정보 포함
 *
 * directToolCall path (W2 swallow + 33 caller) 가 작동하는지 검증.
 */

import {
	clickBySelector,
	enableToolsForSpec,
	ensureAppReady,
	navigateToSettings,
} from "../helpers/settings.js";
import { S } from "../helpers/selectors.js";

// 예전에는 Gemini 직결 키가 없으면 스킬 호출 검사를 조용히 건너뛰었고, 그 키를
// 요구한다는 이유로 스펙 전체가 회귀에서 빠졌다(#602 로 그 공급자는 사라졌다).
// 건너뛰는 동안 아래 단정은 한 번도 돌지 않아, 도구 칸의 표시 글자(모르는 도구는
// "unknown" 으로 그린다)에서 "skill_time" 을 찾는 도달 불가능한 조건이 남아
// 있었다. 이제 도구 이름은 `data-tool-name` 으로 읽는다.

describe("99 — F4 자체 스킬 이용 (런칭 핵심)", () => {
	before(async () => {
		await ensureAppReady();
	});

	it("Skills tab 진입 가능 + Skills 목록 표시", async () => {
		// 예전에는 채팅 탭 넷째가 스킬이었다. 지금 채팅 탭은 둘뿐이고
		// (chat · history — `ChatArea.tsx` 의 `data-chat-tab`),
		// 스킬 화면은 설정 안으로 옮겨졌다. 자리 번호로 집으면 조용히 다른 것을
		// 누르거나(있을 때) 영영 기다린다(없을 때).
		await navigateToSettings();
		const skillsTab = await $(S.skillsTab);
		await skillsTab.waitForDisplayed({ timeout: 30_000 });
		await clickBySelector(S.skillsTab);

		// Skills 목록 UI render
		await browser.waitUntil(
			async () => {
				const skillsRoot = await browser.execute(
					() => !!document.querySelector(".skills-tab, .skills-list, .skills"),
				);
				return skillsRoot;
			},
			{
				timeout: 30_000,
				timeoutMsg: "skills app did not appear",
			},
		);
	});

	it("Chat tab 으로 돌아가서 skill_time 을 호출한다", async () => {
		await enableToolsForSpec(["skill_time"]);

		// Chat tab 으로 복귀
		const chatTab = await $(S.chatTab);
		await chatTab.click();

		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 30_000 });
		await chatInput.click();
		await browser.keys(
			"지금 몇시야? 반드시 get_time 도구를 실제 호출해서 알려줘.".split(""),
		);
		await browser.keys("Enter");

		// 사용자 메시지 표시
		await browser.waitUntil(
			async () => {
				const userMsgs = await $$(S.userMessage);
				return userMsgs.length > 0;
			},
			{ timeout: 30_000 },
		);

		// skill_time tool activity 가 보임 (= chat-service 의 directToolCall path)
		await browser.waitUntil(
			async () => {
				const toolActivity = await browser.execute(
					() =>
						document.querySelector(
							'.tool-activity.tool-success[data-tool-name="get_time"]',
						) !== null,
				);
				return toolActivity;
			},
			{
				timeout: 60_000,
				timeoutMsg: "skill_time tool activity did not appear",
			},
		);
	});
});
