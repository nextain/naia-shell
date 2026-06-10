import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 44 — Diagnostics Full E2E
 *
 * Verifies diagnostics via chat (skill_diagnostics):
 * - health: Gateway health check
 * - usage_status: usage statistics
 * - usage_cost: cost breakdown
 *
 * Covers RPC: health, usage.status, usage.cost
 */
describe("44 — diagnostics full", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		await enableToolsForSpec(["skill_diagnostics"]);
		dispose = autoApprovePermissions().dispose;
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	after(() => {
		dispose?.();
	});

	it("should check Gateway health via skill_diagnostics health", async () => {
		await sendMessage(
			"게이트웨이 health 체크해줘. skill_diagnostics 도구의 health 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_diagnostics 도구의 health 액션으로 게이트웨이 health 체크를 요청했다",
			"AI가 skill_diagnostics로 게이트웨이 health 체크를 실행했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 게이트웨이 상태/건강 정보가 있으면 PASS",
		);
	});

	it("should check usage status via skill_diagnostics usage_status", async () => {
		await sendMessage(
			"사용량 통계를 보여줘. skill_diagnostics의 usage_status 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_diagnostics 도구의 usage_status 액션으로 사용량 통계를 요청했다",
			"AI가 skill_diagnostics로 사용량 통계 조회를 실행했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 사용량/통계 정보가 있으면 PASS",
		);
	});

	it("should check usage cost via skill_diagnostics usage_cost", async () => {
		await sendMessage(
			"비용 정보를 보여줘. skill_diagnostics의 usage_cost 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_diagnostics 도구의 usage_cost 액션으로 비용 정보를 요청했다",
			"AI가 skill_diagnostics로 비용 정보 조회를 실행했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 비용/요금 정보가 있으면 PASS",
		);
	});
});
