import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 48 — VoiceWake Set E2E
 *
 * Verifies voicewake set via chat (skill_voicewake):
 * - set: update wake word triggers
 * - get: verify triggers
 *
 * Covers RPC: voicewake.set, voicewake.get
 */
describe("48 — voicewake set", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		await enableToolsForSpec(["skill_voicewake"]);
		dispose = autoApprovePermissions().dispose;
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	after(() => {
		dispose?.();
	});

	it("should set voice wake triggers", async () => {
		await sendMessage(
			"지금 즉시 음성 깨우기 트리거를 '낸야,낸'로 설정해줘. skill_voicewake 도구의 set 액션을 반드시 사용해. triggers 파라미터는 ['낸야', '낸'] 야.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_voicewake 도구의 set 액션으로 음성 깨우기 트리거를 설정하라고 했다",
			"AI가 skill_voicewake 도구를 인식하고 설정(set)을 시도했거나 수행하겠다고 안내하면 PASS. 도구 자체를 모른다고 하거나 무시하면 FAIL",
		);
	});

	it("should verify wake triggers", async () => {
		await sendMessage(
			"지금 즉시 현재 음성 깨우기 트리거를 확인해줘. skill_voicewake의 get 액션을 반드시 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_voicewake 도구의 get 액션으로 현재 음성 깨우기 트리거를 확인하라고 했다",
			"AI가 skill_voicewake 도구를 인식하고 조회(get)를 시도했거나 수행하겠다고 안내하면 PASS. 도구 자체를 모른다고 하거나 무시하면 FAIL",
		);
	});
});
