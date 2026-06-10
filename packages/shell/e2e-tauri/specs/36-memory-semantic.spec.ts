import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";

/**
 * 36 — Memory Semantic Search E2E
 *
 * Verifies that the semantic (vector) search integration works:
 * - Send a message → stored in DB
 * - Send a recall query in same session
 * - Agent can use memory/context to recall past info
 *
 * Note: Full embedding pipeline requires Gemini API key.
 * This spec checks the UI flow; actual embedding quality
 * depends on the live API.
 */
describe("36 — memory semantic search", () => {
	it("should be on chat tab", async () => {
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 10_000 });
	});

	it("should send a memorable message", async () => {
		await sendMessage("내 생일은 3월 15일이야. 기억해줘.");

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"내 생일은 3월 15일이야. 기억해줘.",
			"AI가 생일 정보를 인지하고 적절히 응답했는가? 에러 메시지나 빈 응답은 FAIL. 생일을 기억하겠다거나 확인했다는 응답이면 PASS",
		);
	});

	it("should recall in a follow-up question", async () => {
		await sendMessage("내 생일이 언제라고 했지?");

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"내 생일이 언제라고 했지?",
			"AI가 이전 대화에서 언급한 생일(3월 15일)을 기억하거나 참조하려고 시도했는가? 에러 메시지나 빈 응답은 FAIL. 생일 날짜를 언급하거나 기억/확인하려는 시도가 보이면 PASS",
		);
	});
});
