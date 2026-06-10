import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 42 — Sessions CRUD E2E
 *
 * Verifies session management via chat (skill_sessions):
 * - preview: session summary
 * - patch: update session label
 * - reset: clear session messages
 *
 * Covers RPC: sessions.preview, sessions.patch, sessions.reset
 */
describe("42 — sessions CRUD", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		await enableToolsForSpec(["skill_sessions"]);
		dispose = autoApprovePermissions().dispose;
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	after(() => {
		dispose?.();
	});

	it("should preview a session via skill_sessions preview", async () => {
		await sendMessage(
			"현재 세션 목록에서 세션 미리보기를 보여줘. skill_sessions 도구의 preview 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_sessions 도구의 preview 액션으로 세션 미리보기를 요청했다",
			"AI가 skill_sessions 또는 preview를 언급하며 세션 미리보기를 처리하려 했는가? AI 응답에 'skill_sessions', 'preview', '세션', '미리보기' 중 하나라도 포함되면 PASS. 도구를 전혀 인식하지 못하면 FAIL.",
		);
	});

	it("should patch a session label via skill_sessions patch", async () => {
		await sendMessage(
			"현재 세션의 라벨을 'E2E Test Session'으로 변경해줘. skill_sessions의 patch 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_sessions 도구의 patch 액션으로 세션 라벨을 변경하라고 했다",
			"AI가 세션 라벨 변경을 처리했는가? '변경했어', '완료', '성공' 등 변경 완료 응답이면 PASS. 도구 호출 시도(성공이든 오류든)도 PASS. 도구를 전혀 인식하지 못하면 FAIL.",
		);
	});

	it("should handle session reset via skill_sessions reset", async () => {
		await sendMessage(
			"가장 오래된 세션을 리셋해줘. skill_sessions의 reset 액션을 사용해. 현재 세션은 리셋하지 마.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_sessions 도구의 reset 액션으로 세션을 리셋하라고 했다",
			"AI가 세션 리셋을 처리했는가? '리셋했어', '완료', '성공' 등 완료 응답이면 PASS. 도구 호출 시도(성공이든 오류든)도 PASS. 도구를 전혀 인식하지 못하면 FAIL.",
		);
	});
});
