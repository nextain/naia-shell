import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 51 — Skills Advanced E2E
 *
 * Verifies advanced skill management via chat (skill_skill_manager):
 * - gateway_status: Gateway skills status
 * - install: install missing skill dependencies
 * - update_config: update skill config
 *
 * Covers RPC: skills.status, skills.bins, skills.install, skills.update
 */
describe("51 — skills advanced", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		await enableToolsForSpec(["skill_skill_manager"]);
		dispose = autoApprovePermissions().dispose;
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	after(() => {
		dispose?.();
	});

	it("should get Gateway skills status", async () => {
		await sendMessage(
			"지금 즉시 게이트웨이 스킬 상태를 확인해줘. skill_skill_manager 도구의 gateway_status 액션을 반드시 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_skill_manager 도구의 gateway_status 액션으로 게이트웨이 스킬 상태를 요청했다",
			"AI가 skill_skill_manager 도구를 인식하고 스킬 상태 조회(gateway_status)에 대해 언급했거나 실행 결과를 보여주면 PASS. '도구를 찾을 수 없다'거나 관련 없는 대답은 FAIL",
		);
	});

	it("should install skill dependencies", async () => {
		await sendMessage(
			"지금 즉시 weather 스킬의 누락된 의존성을 설치해줘. skill_skill_manager의 install 액션을 반드시 사용해. 파라미터 skillName은 'weather'야.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_skill_manager 도구의 install 액션으로 스킬 의존성 설치를 요청했다",
			"AI가 skill_skill_manager 도구를 인식하고 의존성 설치(install)를 시도했거나 수행하겠다고 안내하면 PASS. 도구 자체를 모른다고 하거나 무시하면 FAIL",
		);
	});

	it("should update skill config", async () => {
		await sendMessage(
			"지금 즉시 weather 스킬의 설정을 업데이트해줘. skill_skill_manager의 update_config 액션을 반드시 사용해. 파라미터 skillName은 'weather'야.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_skill_manager 도구의 update_config 액션으로 스킬 설정 업데이트를 요청했다",
			"AI가 skill_skill_manager 도구를 인식하고 설정 업데이트(update_config)를 시도했거나 수행하겠다고 안내하면 PASS. 도구 자체를 모른다고 하거나 무시하면 FAIL",
		);
	});
});
