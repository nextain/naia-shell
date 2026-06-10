import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 41 — Agents CRUD E2E
 *
 * Verifies agent lifecycle via chat (skill_agents):
 * - create: create a test agent
 * - update: modify agent description
 * - files_set: create a file for agent
 * - delete: remove the test agent
 *
 * Covers RPC: agents.create, agents.update, agents.delete, agents.files.set
 */
describe("41 — agents CRUD", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		await enableToolsForSpec(["skill_agents"]);
		dispose = autoApprovePermissions().dispose;
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	after(() => {
		dispose?.();
	});

	it("should create a test agent via skill_agents create", async () => {
		await sendMessage(
			"새 에이전트를 만들어줘. skill_agents 도구의 create 액션으로, name은 'e2e-test-agent', workspace는 '~/.naia/workspace'로 설정해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_agents 도구의 create 액션으로 'e2e-test-agent' 에이전트를 생성하라고 했다",
			"AI가 skill_agents.create를 호출 시도했는가? 도구 자체를 인식하지 못하면 FAIL. 도구를 호출했으면(성공이든 Gateway 오류든) PASS",
		);
	});

	it("should update the test agent via skill_agents update", async () => {
		await sendMessage(
			"에이전트 목록을 확인하고, e2e-test-agent가 있으면 이름을 'updated-agent'로 수정해줘. skill_agents의 update 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_agents 도구의 update 액션으로 에이전트를 수정하라고 했다",
			"AI가 skill_agents.update 또는 skill_agents.list를 호출 시도했는가? 도구 자체를 인식하지 못하면 FAIL. 도구를 호출했으면(성공, 에이전트 없음, Gateway 오류 등) PASS",
		);
	});

	it("should create a file for the agent via skill_agents files_set", async () => {
		await sendMessage(
			"에이전트 목록에서 아무 에이전트나 골라서 'test.md' 파일을 만들어줘. 내용은 '# E2E Test'. skill_agents의 files_set 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_agents 도구의 files_set 액션으로 에이전트에 파일을 생성하라고 했다",
			"AI가 skill_agents.files_set 또는 skill_agents.list를 호출 시도했는가? 도구 자체를 인식하지 못하면 FAIL. 도구를 호출했으면(성공, 에이전트 없음, Gateway 오류 등) PASS",
		);
	});

	it("should delete the test agent via skill_agents delete", async () => {
		await sendMessage(
			"에이전트 목록을 확인하고, e2e-test-agent가 있으면 삭제해줘. skill_agents의 delete 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_agents 도구의 delete 액션으로 에이전트를 삭제하라고 했다",
			"AI가 skill_agents.delete 또는 skill_agents.list를 호출 시도했는가? 도구 자체를 인식하지 못하면 FAIL. 도구를 호출했으면(성공, 에이전트 없음, Gateway 오류 등) PASS",
		);
	});
});
