import { writeFileSync } from "node:fs";
import { join } from "node:path";
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
 *
 * 격리 워크스페이스는 naia-settings 만 심겨 README.md 가 없다. 예전에는 모델이
 * "파일이 없다" 고 바르게 답해도 판정이 FAIL 이었다. 읽을 파일을 직접 두고,
 * 그 안의 표식이 답에 실렸는지로 실제로 읽었는지를 잰다.
 */
const README_MARKER = "NAIA-E2E-README-7F3A";
describe("38 — file read (model-facing keep list)", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		const adkPath = process.env.NAIA_E2E_ADK_PATH;
		if (!adkPath) throw new Error("NAIA_E2E_ADK_PATH is required for 38");
		writeFileSync(
			join(adkPath, "README.md"),
			`# E2E workspace\n\nMarker: ${README_MARKER}\n`,
		);
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
		expect(text).toContain(README_MARKER);
		await assertSemantic(
			text,
			"README.md 파일 내용을 읽어달라고 했다",
			"AI 응답에 파일 내용이 포함되어 있는가? 파일 내용이 언급되면 PASS. '도구를 찾을 수 없다'거나 에러 메시지만 있으면 FAIL",
		);
	});
});
