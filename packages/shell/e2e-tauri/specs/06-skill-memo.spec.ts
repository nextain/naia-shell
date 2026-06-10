import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

describe("06 — skill_memo (save + read)", () => {
	before(async () => {
		await enableToolsForSpec(["skill_memo"]);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	it("should save a memo with skill_memo", async () => {
		await sendMessage(
			"skill_memo 도구로 e2e-test 키에 hello-tauri 값을 저장해. 반드시 skill_memo 도구를 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_memo 도구로 'e2e-test' 키에 'hello-tauri' 값을 저장하라고 했다",
			"AI가 메모를 실제로 저장했다고 확인했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 저장 완료/성공을 알리는 응답이어야 PASS",
		);
	});

	it("should read the saved memo with skill_memo", async () => {
		await sendMessage(
			"skill_memo 도구로 e2e-test 키의 메모를 읽어줘. 반드시 skill_memo 도구를 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_memo 도구로 'e2e-test' 키의 메모를 읽으라고 했다. 기대값: 'hello-tauri'",
			"AI가 저장된 메모 값 'hello-tauri'를 실제로 읽어서 보여줬는가? '도구를 찾을 수 없다'면 FAIL. 메모 내용이 포함되어야 PASS",
		);
	});
});
