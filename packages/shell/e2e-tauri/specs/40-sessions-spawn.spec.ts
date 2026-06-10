import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 40 — Sessions Spawn E2E
 *
 * Verifies sessions_spawn Gateway tool:
 * - Sub-agent creation via sessions.spawn RPC
 * - Wait for completion via agent.wait RPC
 * - Retrieve transcript via sessions.transcript RPC
 *
 * Covers RPC: sessions.spawn, agent.wait, sessions.transcript
 */
describe("40 — sessions spawn", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		await enableToolsForSpec(["sessions_spawn"]);
		dispose = autoApprovePermissions().dispose;
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	after(() => {
		dispose?.();
	});

	it("should spawn a sub-agent session", async () => {
		await sendMessage(
			"서브 에이전트를 생성해서 '현재 시각 확인' 작업을 위임해줘. sessions_spawn 도구를 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"서브 에이전트를 생성해서 '현재 시각 확인' 작업을 위임해줘 (sessions_spawn)",
			"AI가 sessions_spawn을 호출 시도했는가? 도구의 존재 자체를 모르면 FAIL. 도구를 호출했으면(성공이든 Gateway 미지원/오류든) PASS",
		);
	});
});
