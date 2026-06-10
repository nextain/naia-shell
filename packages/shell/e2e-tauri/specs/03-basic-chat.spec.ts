import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";

describe("03 — Basic Chat", () => {
	before(async () => {
		// Ensure chat input is available (settings already configured in 02)
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	it("should send a message and receive a response", async () => {
		await sendMessage("안녕");

		const text = await getLastAssistantMessage();
		expect(text).not.toMatch(/\[오류\]|API key not valid|Bad Request/i);
		await assertSemantic(
			text,
			"사용자가 '안녕'이라고 인사했다",
			"AI가 인사에 적절히 응답했는가? 에러 메시지나 '도구를 찾을 수 없다' 같은 실패 응답은 FAIL",
		);
	});
});
