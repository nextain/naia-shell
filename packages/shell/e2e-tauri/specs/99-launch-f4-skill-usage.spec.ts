/**
 * 런칭 F4 — 자체 스킬 이용
 *
 * 사용자 시나리오:
 *   1. naiaKey 저장된 상태 + API key 있음
 *   2. App 진입 → chat panel 표시
 *   3. "지금 몇시야?" 같은 시간 질의
 *   4. agent → skill_time tool 호출 → 결과 응답
 *   5. assistant message 에 시간 정보 포함
 *
 * directToolCall path (W2 swallow + 33 caller) 가 작동하는지 검증.
 */

import { ensureAppReady } from "../helpers/settings.js";
import { S } from "../helpers/selectors.js";

const API_KEY =
	process.env.CAFE_E2E_API_KEY || process.env.GEMINI_API_KEY || "";

describe("99 — F4 자체 스킬 이용 (런칭 핵심)", () => {
	before(async () => {
		await ensureAppReady();
	});

	it("Skills tab 진입 가능 + Skills 목록 표시", async () => {
		// chat-tab:nth-child(4) = Skills tab (default 8-tab 레이아웃)
		const skillsTab = await $(".chat-tabs .chat-tab:nth-child(4)");
		await skillsTab.waitForDisplayed({ timeout: 30_000 });
		await skillsTab.click();

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
				timeoutMsg: "skills panel did not appear",
			},
		);
	});

	it("Chat tab 으로 돌아가서 skill_time 호출 시도 (API key 있는 경우)", async () => {
		if (!API_KEY) {
			console.log("API key not configured — skipping skill call test");
			return;
		}

		// Chat tab 으로 복귀
		const chatTab = await $(S.chatTab);
		await chatTab.click();

		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 30_000 });
		await chatInput.click();
		await browser.keys("지금 몇시야?".split(""));
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
				const toolActivity = await browser.execute(() => {
					const tools = document.querySelectorAll(".tool-activity .tool-name");
					return Array.from(tools).some((t) =>
						(t.textContent ?? "").includes("skill_time"),
					);
				});
				return toolActivity;
			},
			{
				timeout: 60_000,
				timeoutMsg: "skill_time tool activity did not appear",
			},
		);
	});
});
