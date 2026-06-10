import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

describe("20 — cron basic (one-shot)", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		await enableToolsForSpec(["skill_cron"]);
		dispose = autoApprovePermissions().dispose;
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	after(() => {
		dispose?.();
	});

	it("should create a cron job via natural language", async () => {
		await sendMessage(
			"5초 후에 테스트 알림 보내줘. skill_cron 도구를 사용해서 작업을 예약해. task는 '테스트 알림'으로 설정해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_cron 도구로 5초 후 테스트 알림을 예약하라고 했다",
			"AI가 skill_cron 도구를 호출 시도했는가? 도구 자체를 인식하지 못하면 FAIL. 도구를 호출했으면(성공이든 Gateway 오류든) PASS",
		);
	});

	it("should list cron jobs", async () => {
		await sendMessage(
			"예약된 작업 목록을 보여줘. skill_cron 도구의 list 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_cron 도구로 예약된 작업 목록을 보여달라고 했다",
			"AI가 skill_cron.list를 호출 시도했는가? 도구 자체를 인식하지 못하면 FAIL. 도구를 호출했으면(결과 있든 비어있든) PASS",
		);
	});

	it("should remove a cron job", async () => {
		await sendMessage(
			"아까 만든 테스트 알림을 취소해줘. skill_cron의 remove 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_cron 도구로 이전에 만든 테스트 알림을 취소하라고 했다",
			"AI가 skill_cron.remove를 호출 시도했는가? 도구 자체를 인식하지 못하면 FAIL. 도구를 호출했으면(삭제 성공, 작업 없음 오류, Gateway 오류 등 무관) PASS",
		);
	});
});
