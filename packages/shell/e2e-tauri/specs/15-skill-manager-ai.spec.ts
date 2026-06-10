import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 15 — AI Skill Manager E2E
 *
 * Tests skill_skill_manager via natural language (no tool name in prompts).
 * Best-effort: LLM may or may not use the tool, so assertions are flexible.
 */
describe("15 — AI skill manager", () => {
	before(async () => {
		await enableToolsForSpec(["skill_skill_manager"]);
		const chatTabBtn = await $(S.chatTab);
		await chatTabBtn.click();
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	it("should list skills when asked naturally", async () => {
		await sendMessage("지금 사용할 수 있는 스킬 목록을 알려줘");

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"사용 가능한 스킬 목록을 알려달라고 했다",
			"AI가 스킬/도구 목록을 실제로 나열했는가? 스킬 이름이 최소 1개 이상 포함되어야 PASS. '목록을 제공할 수 없다'면 FAIL",
		);
	});

	it("should search for skills by topic", async () => {
		await sendMessage("날씨 관련 기능이 있어?");

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"날씨 관련 기능이 있는지 물었다",
			"AI가 날씨 관련 스킬(skill_weather 등)의 존재를 언급했는가? 날씨 기능에 대해 설명했으면 PASS. '모르겠다/없다'면 FAIL",
		);
	});

	it("should handle skill toggle request", async () => {
		await sendMessage("healthcheck 스킬을 꺼줘");

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"healthcheck 스킬을 비활성화해달라고 했다",
			"AI가 스킬 비활성화 요청에 응답했는가? 비활성화 완료/시도/에러 보고 등 관련 응답이면 PASS. '[오류]'나 빈 응답은 FAIL",
		);
	});
});
