import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 46 — Channels Operations E2E
 *
 * Verifies channel operations via chat (skill_channels):
 * - logout: disconnect a channel (graceful error if none connected)
 * - login_start: start QR login (graceful error — no QR scan)
 *
 * Covers RPC: channels.logout, web.login.start, web.login.wait (error path)
 */
describe("46 — channels operations", () => {
	let dispose: (() => void) | undefined;

	before(async () => {
		await enableToolsForSpec(["skill_channels"]);
		dispose = autoApprovePermissions().dispose;
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});

	after(() => {
		dispose?.();
	});

	it("should handle channel logout gracefully", async () => {
		await sendMessage(
			"채널 로그아웃을 해줘. skill_channels 도구의 logout 액션을 사용해. channel은 'telegram'.",
		);

		const text = await getLastAssistantMessage();
		// Likely no channel connected — graceful error is valid
		await assertSemantic(
			text,
			"skill_channels 도구의 logout 액션으로 채널 로그아웃을 요청했다",
			"AI가 skill_channels로 채널 로그아웃을 시도했는가? '도구를 찾을 수 없다/사용할 수 없다'면 FAIL. 로그아웃 결과나 연결된 채널이 없다는 graceful 에러가 있으면 PASS",
		);
	});

	it("should simulate a realistic Discord notification scenario", async () => {
		// Enable notification tool and configure dummy webhook in Settings
		await enableToolsForSpec(["skill_notify_discord"]);

		// Set a mock Webhook URL using Settings UI
		await browser.execute(() => {
			const el = document.querySelector(".settings-tab-btn") as HTMLElement;
			if (el) el.click();
		});
		await browser.pause(500);

		await browser.execute((val: string) => {
			const el = document.querySelector(
				"#discord-webhook-input",
			) as HTMLInputElement;
			if (el) {
				const setter = Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value",
				)?.set;
				if (setter) setter.call(el, val);
				else el.value = val;
				el.dispatchEvent(new Event("input", { bubbles: true }));
			}
		}, "http://localhost:18789/mock/discord");

		await browser.execute(() => {
			const el = document.querySelector(".settings-save-btn") as HTMLElement;
			if (el) el.click();

			const chat = document.querySelector(
				".chat-tab:first-child",
			) as HTMLElement;
			if (chat) chat.click();
		});
		await browser.pause(500);

		await sendMessage(
			"지금 즉시 내 디스코드로 'E2E 테스트 완료!'라고 메시지 좀 보내줘. skill_notify_discord 도구를 반드시 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_notify_discord 도구로 디스코드 알림 발송을 요청했다",
			"AI가 skill_notify_discord 도구를 인식하고 실행을 시도했는가? '도구를 찾을 수 없다'면 FAIL. 전송 성공 메시지나 '오류가 발생했다'는 네트워크 에러(가짜 URL이므로) 안내가 있으면 PASS",
		);
	});

	it("should simulate a realistic Google Chat notification scenario", async () => {
		await enableToolsForSpec(["skill_notify_google_chat"]);

		await sendMessage(
			"지금 즉시 내 구글 챗으로 '알림 테스트입니다'라고 메시지 보내줘. skill_notify_google_chat 도구를 반드시 사용해.",
		);

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"skill_notify_google_chat 도구로 구글 챗 알림 발송을 요청했다",
			"AI가 skill_notify_google_chat 도구를 인식하고 실행을 시도했는가? '도구를 찾을 수 없다'면 FAIL. 전송 성공 메시지나 '설정이 되어있지 않다'는 안내가 있으면 PASS",
		);
	});
});
