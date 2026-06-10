import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 17 — Notification Skills E2E
 *
 * Verifies that notification skills (Slack/Discord) are registered
 * and handle missing webhook configuration gracefully.
 * Note: actual webhook delivery is not tested here (no real webhooks).
 */
describe("17 — notification skills", () => {
	let disposePermissions: (() => void) | undefined;

	const sendAndResolveResult = async (prompt: string): Promise<string> => {
		await sendMessage(prompt);
		let text = await getLastAssistantMessage();

		if (/Tool Call:/i.test(text)) {
			await sendMessage(
				"방금 도구 호출의 실행 결과를 요약해줘. 성공/실패와 이유만 답하고 새 도구는 호출하지 마.",
			);
			text = await getLastAssistantMessage();
		}

		// Gateway/agent propagation may lag briefly; poll a couple of times if result isn't ready yet.
		for (let i = 0; i < 2; i += 1) {
			if (!/결과를 받지 못|아직.*결과|still waiting|not received/i.test(text))
				break;
			await browser.pause(2_000);
			await sendMessage(
				"직전 도구 호출 결과가 도착했는지 다시 확인해줘. 새 도구는 호출하지 말고 결과만 답해.",
			);
			text = await getLastAssistantMessage();
		}

		return text;
	};

	before(async () => {
		await enableToolsForSpec(["skill_notify_slack", "skill_notify_discord"]);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
		disposePermissions = autoApprovePermissions().dispose;
	});

	after(() => {
		disposePermissions?.();
	});

	it("should keep notification skills in allowed tools config", async () => {
		const hasNotifyTools = await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			if (!raw) return false;
			const config = JSON.parse(raw);
			const allowed = Array.isArray(config.allowedTools)
				? config.allowedTools
				: [];
			return (
				allowed.includes("skill_notify_slack") &&
				allowed.includes("skill_notify_discord")
			);
		});
		expect(hasNotifyTools).toBe(true);
	});

	it("should explain webhook config when Slack webhook is not set", async () => {
		const text = await sendAndResolveResult(
			"Slack으로 '테스트 메시지' 보내줘. skill_notify_slack 도구를 반드시 사용해.",
		);
		expect(text).not.toMatch(/\[오류\]|API key not valid|Bad Request/i);
		await assertSemantic(
			text,
			"Slack으로 메시지를 보내달라고 했으나 webhook이 설정되지 않은 상태",
			"AI가 webhook 설정이 필요하다고 안내했는가? 또는 도구를 실행했으나 webhook 미설정으로 실패했다고 보고했는가? '도구를 찾을 수 없다'면 FAIL. webhook/설정 관련 안내가 있으면 PASS",
		);
	});

	it("should explain webhook config when Discord webhook is not set", async () => {
		const text = await sendAndResolveResult(
			"Discord로 '테스트' 알림 보내줘. skill_notify_discord 도구를 반드시 사용해.",
		);
		expect(text).not.toMatch(/\[오류\]|API key not valid|Bad Request/i);
		await assertSemantic(
			text,
			"Discord로 알림을 보내달라고 했으나 webhook이 설정되지 않은 상태",
			"AI가 webhook 설정이 필요하다고 안내했는가? 또는 도구를 실행했으나 webhook 미설정으로 실패했다고 보고했는가? '도구를 찾을 수 없다'면 FAIL. webhook/설정 관련 안내가 있으면 PASS",
		);
	});
});
