import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

const DISCORD_WEBHOOK =
	process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || "";

/**
 * 69 — Discord Notify Live E2E
 *
 * Sends an actual Discord notification using the webhook configured
 * in .env. Skips if no webhook URL is set.
 *
 * Bug context: Discord webhook set during onboarding was not reaching
 * the agent because env var name mismatch (DISCORD_WEBHOOK vs DISCORD_WEBHOOK_URL).
 */
describe("69 — Discord Notify (Live)", () => {
	if (!DISCORD_WEBHOOK) {
		it("(skipped — no DISCORD_WEBHOOK env var)", () => {});
		return;
	}

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
		// Set webhook URL in config so agent can find it
		await browser.execute((url: string) => {
			const raw = localStorage.getItem("naia-config");
			const config = raw ? JSON.parse(raw) : {};
			config.discordWebhookUrl = url;
			localStorage.setItem("naia-config", JSON.stringify(config));
		}, DISCORD_WEBHOOK);

		await enableToolsForSpec(["skill_notify_discord"]);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
		disposePermissions = autoApprovePermissions().dispose;
	});

	after(() => {
		disposePermissions?.();
	});

	it("should send a Discord notification successfully", async () => {
		const text = await sendAndResolveResult(
			"Discord로 'Naia E2E 테스트 알림입니다 🎉' 메시지를 보내줘. skill_notify_discord 도구를 반드시 사용해.",
		);

		expect(text).not.toMatch(/\[오류\]|API key not valid|Bad Request/i);

		await assertSemantic(
			text,
			"Discord로 알림을 보내달라고 요청했다",
			"AI가 Discord 알림을 성공적으로 보냈다고 보고했는가? 또는 도구를 실행하여 메시지가 전송됐다는 결과가 있는가? 'webhook 미설정' 또는 '실패'면 FAIL. '성공' 또는 '전송 완료'면 PASS",
		);
	});
});
