import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 18 — Provider tool calling
 *
 * Verifies that tool calling works with the current provider (Gemini).
 * Ensures enableTools is set and skills are visible to the LLM.
 */
describe("18 — provider tool calling", () => {
	before(async () => {
		await enableToolsForSpec(["skill_time"]);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	it("should execute skill_time via tool calling and return time", async () => {
		await sendMessage(
			"지금 몇 시야? 반드시 skill_time 도구를 사용해서 알려줘.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_time 도구를 사용해서 현재 시각을 알려달라고 했다",
			"AI가 실제 시간 정보를 제공했는가? '도구를 찾을 수 없다/실행할 수 없다'면 FAIL. 시:분 형태의 실제 시각이 포함되어야 PASS",
		);
	});
});
