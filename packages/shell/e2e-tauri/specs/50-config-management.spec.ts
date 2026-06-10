import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 50 — Config Management E2E
 *
 * Verifies Gateway config via chat (skill_config):
 * - get: read current config
 * - schema: get config schema
 * - models: list available models
 * - patch: partial config update
 *
 * Covers RPC: config.get, config.set, config.schema, models.list, config.patch
 */
describe("50 — config management", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		await enableToolsForSpec(["skill_config"]);
		dispose = autoApprovePermissions().dispose;
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	after(() => {
		dispose?.();
	});

	it("should get Gateway config", async () => {
		await sendMessage(
			"게이트웨이 설정을 보여줘. skill_config 도구의 get 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_config 도구의 get 액션으로 게이트웨이 설정을 요청했다",
			"AI가 skill_config로 설정 조회를 실행했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 게이트웨이 설정 정보가 있으면 PASS",
		);
	});

	it("should get config schema", async () => {
		await sendMessage(
			"게이트웨이 설정 스키마를 보여줘. skill_config의 schema 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_config 도구의 schema 액션으로 게이트웨이 설정 스키마를 요청했다",
			"AI가 skill_config로 설정 스키마 조회를 실행했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 스키마 정보가 있으면 PASS",
		);
	});

	it("should list available models", async () => {
		await sendMessage(
			"사용 가능한 모델 목록을 보여줘. skill_config의 models 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_config 도구의 models 액션으로 사용 가능한 모델 목록을 요청했다",
			"AI가 skill_config로 모델 목록 조회를 실행했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 모델 목록 정보가 있으면 PASS",
		);
	});

	it("should patch config", async () => {
		await sendMessage(
			"게이트웨이 로깅 레벨을 'info'로 설정해줘. skill_config의 patch 액션을 사용해. logging.level을 'info'로 패치해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_config 도구의 patch 액션으로 게이트웨이 설정 패치를 요청했다",
			"AI가 skill_config.patch를 호출 시도했는가? 도구 자체를 인식하지 못하면 FAIL. 도구를 호출했으면(성공이든 Gateway 오류든) PASS",
		);
	});
});
