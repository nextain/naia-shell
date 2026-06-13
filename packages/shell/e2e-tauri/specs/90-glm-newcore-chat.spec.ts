import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { safeRefresh } from "../helpers/settings.js";

// 실 Tauri 앱 레벨 e2e — glm(zai) API-key 직결 새-core 흐름. GLM 키는 키체인(GLM_API_KEY)서 agent 가 read.
// 판단 LLM(semantic) 의존 없이: 응답이 에러/빈값 아닌 실 텍스트인지만(z.ai 실호출 통과).
describe("90 — GLM new-core live chat (직결)", () => {
	before(async () => {
		await browser.execute(() => {
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					provider: "zai",
					model: "glm-5.1",
					agentName: "Naia",
					userName: "Tester",
					vrmModel: "/avatars/01-Sendagaya-Shino-uniform.vrm",
					persona: "Friendly AI companion",
					enableTools: false,
					locale: "ko",
					onboardingComplete: true,
				}),
			);
		});
		await safeRefresh(); // JS location.reload — WebDriver /refresh 헤드리스 행 회피
		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 30_000 });
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 60_000 }); // 간헐 workspace_set_root 경합 여유

	});

	it("glm 직결로 실 응답(에러/빈값 아님)", async () => {
		await sendMessage("안녕");
		const text = await getLastAssistantMessage(); // .message-content(본문만 — cost-badge footer 제외)
		// eslint-disable-next-line no-console
		console.log("=== GLM RESPONSE ===\n" + text + "\n====================");
		// 본문에 에러 마커 부재(가짜 키면 핸들러가 `[오류] provider error ... 401` 을 본문에 append → 여기서 RED).
		expect(text).not.toMatch(/\[오류\]|API key not valid|Bad Request|provider error|failed:|\b40[0-9]\b|\b500\b/i);
		expect(text.trim().length).toBeGreaterThan(1);
		// 적대 게이트(2026-06-13): length>1 + 에러정규식만으론 약함(footer/우연 통과 여지) → cost-badge 토큰>0 으로
		//   실 z.ai 호출을 명시 입증. 키 깨지면 usage 0 토큰 → RED. uc-provider-provenance-live(Playwright)와 동일
		//   판별자이며 그쪽은 뮤테이션(가짜 secret-tool)으로 RED 실증됨.
		const tokens = await browser.execute(() => {
			const badges = document.querySelectorAll(
				".chat-message.assistant:not(.streaming) .cost-badge",
			);
			const last = badges[badges.length - 1]?.textContent ?? "";
			const m = last.match(/(\d[\d,]*)\s*토큰/);
			return m ? Number(m[1].replace(/,/g, "")) : 0;
		});
		expect(tokens, "cost-badge 토큰>0 = 실 z.ai 호출(키 깨지면 0 토큰)").toBeGreaterThan(0);
	});
});
