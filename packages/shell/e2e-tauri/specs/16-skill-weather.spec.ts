import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

describe("16 — skill_weather", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		await enableToolsForSpec(["skill_weather"]);
		dispose = autoApprovePermissions().dispose;
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	after(() => {
		dispose?.();
	});

	it("should get weather for Seoul", async () => {
		await sendMessage("서울 날씨 알려줘. skill_weather 도구를 반드시 사용해.");

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_weather 도구로 서울 날씨를 알려달라고 했다",
			"AI가 skill_weather 도구를 호출 시도했는가? 도구 자체를 인식하지 못하면 FAIL. 도구를 호출했으면(날씨 데이터 제공, 타임아웃, Gateway 오류 등 무관) PASS",
		);
	});

	it("should get weather for another city", async () => {
		await sendMessage("도쿄 날씨는? skill_weather 도구를 사용해서 알려줘.");

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_weather 도구로 도쿄(Tokyo) 날씨를 알려달라고 했다",
			"AI가 skill_weather 도구를 호출 시도했는가? 도구 자체를 인식하지 못하면 FAIL. 도구를 호출했으면(날씨 데이터 제공, 타임아웃, Gateway 오류 등 무관) PASS",
		);
	});
});
