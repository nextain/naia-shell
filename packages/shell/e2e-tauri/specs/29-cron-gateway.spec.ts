import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 29 — Cron Gateway E2E
 *
 * Verifies Gateway cron RPC via chat (skill_cron gateway_* actions):
 * - gateway_list: list cron jobs on Gateway
 *
 * Covers RPC: cron.list
 */
describe("29 — cron gateway", () => {
	before(async () => {
		await enableToolsForSpec(["skill_cron"]);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	it("should list Gateway cron jobs via skill_cron gateway_list", async () => {
		await sendMessage(
			"게이트웨이의 크론 잡 목록을 보여줘. skill_cron 도구의 gateway_list 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"게이트웨이의 크론 잡 목록을 보여줘 (skill_cron gateway_list)",
			"AI가 skill_cron으로 게이트웨이 크론 잡 목록 조회를 실행했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 크론 잡 목록을 보여주거나 빈 목록이라고 안내하면 PASS",
		);
	});
});
