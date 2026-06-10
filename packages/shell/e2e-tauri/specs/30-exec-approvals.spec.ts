import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 30 — Exec Approvals E2E
 *
 * Verifies approval system via chat (skill_approvals):
 * - get_rules: retrieve current approval rules
 * - Auto-approve permissions flow
 *
 * Covers RPC: exec.approvals.get
 */
describe("30 — exec approvals", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		await enableToolsForSpec(["skill_approvals", "skill_time"]);
		dispose = autoApprovePermissions().dispose;
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	after(() => {
		dispose?.();
	});

	it("should retrieve approval rules via skill_approvals get_rules", async () => {
		await sendMessage(
			"현재 실행 승인 규칙을 확인해줘. skill_approvals 도구의 get_rules 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"현재 실행 승인 규칙을 확인해줘 (skill_approvals get_rules)",
			"AI가 skill_approvals으로 승인 규칙 조회를 실행했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 승인 규칙 목록을 보여주거나 규칙이 없다고 안내하면 PASS",
		);
	});

	it("should handle auto-approve for tool invocations", async () => {
		await sendMessage("현재 시각을 확인해줘. skill_time 도구를 사용해.");

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"현재 시각을 확인해줘 (skill_time)",
			"AI가 skill_time으로 현재 시각을 확인했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 시각/시간 정보를 포함한 응답이면 PASS",
		);
	});
});
