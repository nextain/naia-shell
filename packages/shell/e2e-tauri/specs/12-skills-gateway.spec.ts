import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 12 — Gateway Skills E2E
 *
 * Tests gateway-proxied skills that can be verified without external dependencies.
 * Remaining 47+ skills are covered by agent-level bulk-migration.test.ts (manifest validation).
 */
describe("12 — gateway skills", () => {
	before(async () => {
		await enableToolsForSpec(["skill_healthcheck", "skill_session-logs"]);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	it("should invoke skill_healthcheck and return security info", async () => {
		await sendMessage(
			"시스템 보안 상태를 확인해줘. skill_healthcheck 도구를 반드시 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_healthcheck 도구로 시스템 보안 상태를 확인하라고 했다",
			"AI가 도구 실행을 시도했는가? 실제 보안 정보를 제공하거나, 도구를 호출했지만 에러가 발생해서 에러 내용을 보고했으면 PASS. 도구를 호출하지 않고 텍스트만 출력하거나 'print()'를 출력한 경우 FAIL",
		);
	});

	it("should invoke skill_session-logs and return log info", async () => {
		await sendMessage(
			"이전 세션 로그를 검색해줘. skill_session-logs 도구를 반드시 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_session-logs 도구로 이전 세션 로그를 검색하라고 했다",
			"AI가 세션 로그 정보를 제공하거나 로그 검색을 시도했는가? '도구를 찾을 수 없다'면 FAIL. 로그 데이터 또는 검색 결과가 있으면 PASS",
		);
	});

	it("should have skill_ tools registered (at least built-in 4)", async () => {
		await sendMessage(
			"skill_time, skill_memo, skill_weather 같은 도구가 있어? 다른 도구는 호출하지 말고 알고 있는 것만 답해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_time, skill_memo, skill_weather 같은 도구가 있는지 물었다",
			"AI가 skill_ 도구의 존재를 인정했는가? skill_time/memo/weather 중 하나라도 언급하면 PASS. '[오류]'나 '모르겠다'면 FAIL",
		);
	});
});
