import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 49 — Approvals Full E2E
 *
 * Verifies approval management via chat (skill_approvals):
 * - set_rules: update approval rules
 * - resolve: resolve a pending approval (error path)
 *
 * Covers RPC: exec.approvals.set, exec.approvals.resolve (error path)
 */
describe("49 — approvals full", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		await enableToolsForSpec(["skill_approvals"]);
		dispose = autoApprovePermissions().dispose;
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	after(() => {
		dispose?.();
	});

	it("should set approval rules", async () => {
		await sendMessage(
			"실행 승인 규칙을 설정해줘. skill_approvals 도구의 set_rules 액션을 사용해. 기본 규칙으로 설정해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_approvals 도구의 set_rules 액션으로 실행 승인 규칙을 설정하라고 했다",
			"AI가 skill_approvals.set_rules를 호출 시도했는가? 도구 자체를 인식하지 못하면 FAIL. 도구를 호출했으면(성공이든 파라미터 오류든) PASS",
		);
	});

	it("should handle resolve gracefully", async () => {
		await sendMessage(
			"대기 중인 승인을 처리해줘. skill_approvals의 resolve 액션을 사용해. requestId는 'test', decision은 'approve'.",
		);

		const text = await getLastAssistantMessage();
		// Likely error (no pending approval or unknown method) — just verify response exists
		await assertSemantic(
			text,
			"skill_approvals 도구의 resolve 액션으로 대기 중인 승인을 처리하라고 했다",
			"AI가 skill_approvals.resolve를 호출 시도했는가? 도구 자체를 인식하지 못하면 FAIL. 도구를 호출했거나 시도했으면(성공, 오류, 메서드 없음 등) PASS",
		);
	});
});
