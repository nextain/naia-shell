import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 47 — TTS Full E2E
 *
 * Verifies TTS operations via chat (skill_tts):
 * - status: current TTS configuration
 * - enable: enable TTS
 * - set_provider: change TTS provider
 * - convert: text-to-speech conversion
 * - disable: disable TTS
 *
 * Covers RPC: tts.status, tts.enable, tts.setProvider, tts.convert, tts.disable
 */
describe("47 — TTS full", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		await enableToolsForSpec(["skill_tts"]);
		dispose = autoApprovePermissions().dispose;
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	after(() => {
		dispose?.();
	});

	it("should check TTS status", async () => {
		await sendMessage(
			"TTS 상태를 확인해줘. skill_tts 도구의 status 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_tts 도구의 status 액션으로 TTS 상태를 요청했다",
			"AI가 skill_tts로 TTS 상태 조회를 실행했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. TTS 상태 정보가 있으면 PASS",
		);
	});

	it("should enable TTS", async () => {
		await sendMessage("TTS를 활성화해줘. skill_tts의 enable 액션을 사용해.");

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_tts 도구의 enable 액션으로 TTS 활성화를 요청했다",
			"AI가 skill_tts로 TTS 활성화를 실행했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. TTS가 활성화되었다는 결과가 있으면 PASS",
		);
	});

	it("should set TTS provider", async () => {
		await sendMessage(
			"TTS 프로바이더를 'edge'로 변경해줘. skill_tts의 set_provider 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_tts 도구의 set_provider 액션으로 TTS 프로바이더를 변경하라고 했다",
			"AI가 skill_tts로 프로바이더 변경을 실행했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 프로바이더가 변경되었다는 결과가 있으면 PASS",
		);
	});

	it("should convert text to speech", async () => {
		await sendMessage(
			"'안녕하세요'를 TTS로 변환해줘. skill_tts의 convert 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		// May succeed or fail depending on TTS config
		await assertSemantic(
			text,
			"skill_tts 도구의 convert 액션으로 텍스트를 음성으로 변환하라고 했다",
			"AI가 skill_tts로 TTS 변환을 시도했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 변환 결과나 TTS 설정 관련 graceful 에러가 있으면 PASS",
		);
	});

	it("should disable TTS", async () => {
		await sendMessage("TTS를 비활성화해줘. skill_tts의 disable 액션을 사용해.");

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_tts 도구의 disable 액션으로 TTS 비활성화를 요청했다",
			"AI가 skill_tts로 TTS 비활성화를 실행했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. TTS가 비활성화되었다는 결과가 있으면 PASS",
		);
	});
});
