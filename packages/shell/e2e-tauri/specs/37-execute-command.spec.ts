import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 37 — Execute Command E2E
 *
 * Verifies execute_command Gateway tool:
 * - Shell command execution via Gateway exec.bash RPC
 * - Result shown in assistant response
 *
 * Covers RPC: exec.bash
 */
describe("37 — execute command", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		await enableToolsForSpec(["execute_command"]);
		dispose = autoApprovePermissions().dispose;
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	after(() => {
		dispose?.();
	});

	it("should execute a shell command via execute_command tool", async () => {
		await sendMessage(
			"'echo naia-e2e-test'를 실행해줘. execute_command 도구를 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"'echo naia-e2e-test'를 실행해줘 (execute_command)",
			"AI가 execute_command으로 셸 명령을 실행했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 명령 실행 결과(naia-e2e-test 출력)를 보여주면 PASS",
		);
	});
});
