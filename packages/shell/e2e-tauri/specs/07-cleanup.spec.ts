import { sendMessage, waitForToolSuccess } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";

describe("07 — Cleanup", () => {
	before(async () => {
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	it("should delete the e2e-test memo", async () => {
		await sendMessage("skill_memo 도구로 e2e-test 메모 삭제해줘.");

		await waitForToolSuccess();
	});
});
