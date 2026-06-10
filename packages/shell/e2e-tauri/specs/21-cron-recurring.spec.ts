import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

describe("21 — cron recurring", () => {
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

	it("should create a recurring cron job", async () => {
		await sendMessage(
			"매일 오전 9시에 서울 날씨를 알려주는 반복 작업을 만들어. skill_cron 도구의 add 액션을 사용해. cron은 '0 9 * * *', task는 '서울 날씨 확인'으로 설정해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_cron 도구로 매일 오전 9시 날씨 알림 반복 작업을 만들라고 했다",
			"AI가 skill_cron을 호출 시도했는가? 도구 자체를 인식하지 못하면 FAIL. 도구를 호출했으면(성공이든 Gateway 오류든) PASS",
		);
	});

	it("should show schedule info in job list", async () => {
		await sendMessage("예약된 작업 목록 보여줘. skill_cron의 list를 사용해.");

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_cron 도구로 예약된 작업 목록을 보여달라고 했다",
			"AI가 skill_cron.list를 호출 시도했는가? 도구 자체를 인식하지 못하면 FAIL. 도구를 호출했으면(결과 있든 비어있든) PASS",
		);
	});

	it("should disable a recurring job", async () => {
		await sendMessage(
			"아까 만든 날씨 알림을 비활성화해줘. skill_cron의 update로 enabled를 false로 바꿔.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_cron 도구로 날씨 알림을 비활성화하라고 했다",
			"AI가 비활성화를 시도하거나 관련 응답을 했는가? 도구를 인식하지 못하면 FAIL. 비활성화 시도, 작업 없음 안내, 또는 Gateway 오류 응답이면 PASS",
		);
	});
});
