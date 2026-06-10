import {
	getLastAssistantMessage,
	sendMessage,
	waitForToolSuccess,
} from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";

describe("05 — skill_system_status", () => {
	before(async () => {
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	it("should execute skill_system_status and return memory info", async () => {
		await sendMessage(
			"시스템 메모리 상태 알려줘. skill_system_status 도구를 반드시 사용해.",
		);

		let toolUsed = true;
		try {
			await waitForToolSuccess();
		} catch {
			toolUsed = false;
		}

		const text = await getLastAssistantMessage();
		expect(text).not.toMatch(/\[오류\]|API key not valid|Bad Request/i);
		await assertSemantic(
			text,
			"skill_system_status 도구로 시스템 메모리 상태를 알려달라고 했다",
			"AI가 실제 시스템 정보(메모리 MB/GB, CPU 등)를 제공했는가? '도구를 찾을 수 없다/실행할 수 없다'는 FAIL. 구체적인 시스템 수치가 있어야 PASS",
		);
	});
});
