import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 38 — File read E2E (#611)
 *
 * Direct write/search/diff tools were removed from the model-facing keep list.
 * This spec keeps only read_file coverage.
 */
describe("38 — file read (model-facing keep list)", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		await enableToolsForSpec(["read_file", "list_dir"]);
		dispose = autoApprovePermissions().dispose;
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	after(() => {
		dispose?.();
	});

	it("should read a file via read_file tool", async () => {
		await sendMessage(
			"README.md 파일 내용을 읽어줘. read_file 도구를 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"README.md 파일 내용을 읽어달라고 했다",
			"AI 응답에 파일 내용이 포함되어 있는가? 파일 내용이 언급되면 PASS. '도구를 찾을 수 없다'거나 에러 메시지만 있으면 FAIL",
		);
	});
});
