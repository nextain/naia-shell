import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 43 — Device Management E2E
 *
 * Verifies device/node management via chat (skill_device):
 * All operations are graceful error paths (no paired devices in E2E).
 *
 * Covers RPC: node.describe, node.rename, node.pair.request, node.pair.verify,
 *   device.pair.list, device.pair.approve, device.token.rotate, device.token.revoke
 */
describe("43 — device management", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		await enableToolsForSpec(["skill_device"]);
		dispose = autoApprovePermissions().dispose;
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	after(() => {
		dispose?.();
	});

	it("should describe a node via skill_device node_describe", async () => {
		await sendMessage(
			"노드 상세 정보를 보여줘. skill_device 도구의 node_describe 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_device 도구의 node_describe 액션으로 노드 상세 정보를 요청했다",
			"AI가 skill_device 도구를 호출 시도했는가? 도구 자체를 인식하지 못하면 FAIL. 도구를 호출했으면(node_describe든 node_list든, 성공이든 오류든) PASS",
		);
	});

	it("should list device pairings via skill_device device_list", async () => {
		await sendMessage(
			"디바이스 페어링 목록을 보여줘. skill_device 도구의 device_list 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_device 도구의 device_list 액션으로 디바이스 페어링 목록을 요청했다",
			"AI가 skill_device로 디바이스 목록 조회를 실행했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 디바이스 목록이나 결과가 있으면 PASS",
		);
	});

	it("should handle token rotate gracefully", async () => {
		await sendMessage(
			"디바이스 토큰을 교체해줘. skill_device 도구의 token_rotate 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_device 도구의 token_rotate 액션으로 디바이스 토큰 교체를 요청했다",
			"AI가 skill_device로 토큰 교체를 시도했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 토큰 교체 결과나 graceful 에러 응답이 있으면 PASS",
		);
	});

	it("should handle token revoke gracefully", async () => {
		await sendMessage(
			"디바이스 토큰을 폐기해줘. skill_device 도구의 token_revoke 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_device 도구의 token_revoke 액션으로 디바이스 토큰 폐기를 요청했다",
			"AI가 skill_device로 토큰 폐기를 시도했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 토큰 폐기 결과나 graceful 에러 응답이 있으면 PASS",
		);
	});

	it("should handle node rename gracefully", async () => {
		await sendMessage(
			"첫 번째 노드 이름을 'e2e-node'로 변경해줘. skill_device의 node_rename 액션을 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_device 도구의 node_rename 액션으로 노드 이름 변경을 요청했다",
			"AI가 skill_device로 노드 이름 변경을 시도했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 이름 변경 결과나 graceful 에러 응답이 있으면 PASS",
		);
	});

	it("should handle pair request gracefully", async () => {
		await sendMessage(
			"새 노드 페어링을 요청해줘. skill_device의 pair_request 액션을 사용해. nodeId는 'test-node'.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_device 도구의 pair_request 액션으로 노드 페어링을 요청했다",
			"AI가 skill_device로 페어링 요청을 시도했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 페어링 요청 결과나 graceful 에러 응답이 있으면 PASS",
		);
	});

	it("should handle pair verify gracefully", async () => {
		await sendMessage(
			"페어링 검증을 해줘. skill_device의 pair_verify 액션을 사용해. requestId는 'test-req', code는 '1234'.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_device 도구의 pair_verify 액션으로 페어링 검증을 요청했다",
			"AI가 skill_device로 페어링 검증을 시도했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 검증 결과나 graceful 에러 응답이 있으면 PASS",
		);
	});

	it("should handle device pair approve gracefully", async () => {
		await sendMessage(
			"디바이스 페어링을 승인해줘. skill_device의 device_approve 액션을 사용해. pairingId는 'test'.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_device 도구의 device_approve 액션으로 디바이스 페어링 승인을 요청했다",
			"AI가 skill_device로 페어링 승인을 시도했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 승인 결과나 graceful 에러 응답이 있으면 PASS",
		);
	});
});
