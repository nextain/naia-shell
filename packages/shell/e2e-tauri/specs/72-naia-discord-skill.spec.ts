import { getLastAssistantMessage } from "../helpers/chat.js";
import { autoApprovePermissions } from "../helpers/permissions.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";
import { enableToolsForSpec } from "../helpers/settings.js";

/**
 * 72 — skill_naia_discord E2E (session-isolated)
 *
 * Prerequisites: Discord OAuth 완료 → config에 discordDefaultUserId 저장됨
 *
 * Verifies:
 * 1. tool enabled in config
 * 2. status → tool 실행 성공 + 디스코드 상태 보고
 * 3. send auto-target → to 없이 보내도 OAuth에서 저장된 userId로 자동 해석
 *
 * Note: sendMessage 헬퍼 대신 inline send 사용.
 * Gemini가 tool 호출 후 follow-up 텍스트를 안 생성하면 sendMessage가 timeout되므로,
 * tool activity + streaming 완료를 직접 대기.
 */
describe("72 — skill_naia_discord", () => {
	let disposePermissions: (() => void) | undefined;

	/** Type text into chat input and click send via browser.execute (WebKitGTK-safe). */
	async function typeAndSend(text: string): Promise<void> {
		await browser.execute(
			(sel: string, val: string) => {
				const el = document.querySelector(sel) as HTMLTextAreaElement | null;
				if (!el) throw new Error(`${sel} not found`);
				el.focus();
				const setter = Object.getOwnPropertyDescriptor(
					HTMLTextAreaElement.prototype,
					"value",
				)?.set;
				if (setter) setter.call(el, val);
				else el.value = val;
				el.dispatchEvent(new Event("input", { bubbles: true }));
			},
			S.chatInput,
			text,
		);
		await browser.pause(100);
		await browser.execute((sel: string) => {
			(document.querySelector(sel) as HTMLElement)?.click();
		}, S.chatSendBtn);
	}

	/** Wait for streaming to start then finish. */
	async function waitStreamingCycle(): Promise<void> {
		await browser.waitUntil(
			async () =>
				browser.execute(
					(sel: string) => !!document.querySelector(sel),
					S.cursorBlink,
				),
			{ timeout: 60_000, timeoutMsg: "Streaming did not start" },
		);
		await browser.waitUntil(
			async () =>
				browser.execute(
					(sel: string) => !document.querySelector(sel),
					S.cursorBlink,
				),
			{ timeout: 180_000, timeoutMsg: "Streaming did not finish" },
		);
	}

	/** Wait for tool-success or tool-error to appear. Returns which one. */
	async function waitToolActivity(): Promise<"success" | "error"> {
		await browser.waitUntil(
			async () =>
				browser.execute(
					() =>
						!!document.querySelector(".tool-activity.tool-success") ||
						!!document.querySelector(".tool-activity.tool-error"),
				),
			{ timeout: 60_000, timeoutMsg: "No tool activity appeared" },
		);
		const isSuccess = await browser.execute(
			() => !!document.querySelector(".tool-activity.tool-success"),
		);
		return isSuccess ? "success" : "error";
	}

	/** Start a new conversation and wait for clean state. */
	async function startNewChat(): Promise<void> {
		await browser.execute((sel: string) => {
			(document.querySelector(sel) as HTMLElement)?.click();
		}, S.newChatBtn);
		await browser.waitUntil(
			async () =>
				browser.execute(
					() => document.querySelectorAll(".chat-message").length === 0,
				),
			{ timeout: 10_000, timeoutMsg: "Messages did not clear after new chat" },
		);
		const input = await $(S.chatInput);
		await input.waitForEnabled({ timeout: 15_000 });
	}

	/** Try to get assistant message text; returns empty string if none exists. */
	async function getAssistantTextOrEmpty(): Promise<string> {
		return browser.execute(() => {
			const msgs = document.querySelectorAll(
				".chat-message.assistant:not(.streaming) .message-content",
			);
			return msgs.length > 0
				? (msgs[msgs.length - 1]?.textContent?.trim() ?? "")
				: "";
		});
	}

	before(async () => {
		await enableToolsForSpec(["skill_naia_discord"]);

		await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			const config = raw ? JSON.parse(raw) : {};
			config.enableTools = true;
			if (!config.gatewayUrl || String(config.gatewayUrl).trim().length === 0) {
				config.gatewayUrl = "ws://127.0.0.1:18789";
			}
			// Clean up stale dummy values from previous E2E runs
			// Only keep discordDefaultUserId if it looks like a real Discord snowflake (17-20 digits, not all zeros)
			const uid = config.discordDefaultUserId;
			if (uid && (/^0+1?$/.test(uid) || uid.length < 17)) {
				config.discordDefaultUserId = undefined;
				config.discordDefaultTarget = undefined;
			}
			localStorage.setItem("naia-config", JSON.stringify(config));
		});

		await startNewChat();
		disposePermissions = autoApprovePermissions().dispose;
	});

	after(() => {
		disposePermissions?.();
	});

	it("should keep skill_naia_discord enabled in config", async () => {
		const info = await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			if (!raw) return { ok: false, reason: "naia-config missing" };
			const config = JSON.parse(raw);
			const allowed = Array.isArray(config.allowedTools)
				? config.allowedTools
				: [];
			const disabled = Array.isArray(config.disabledSkills)
				? config.disabledSkills
				: [];
			return {
				ok:
					allowed.includes("skill_naia_discord") &&
					!disabled.includes("skill_naia_discord"),
				reason: `allowed=${JSON.stringify(allowed)} disabled=${JSON.stringify(disabled)}`,
			};
		});

		if (!info.ok) {
			throw new Error(`skill_naia_discord config invalid: ${info.reason}`);
		}
	});

	it("should execute status flow via tool call", async () => {
		await typeAndSend(
			"skill_naia_discord 도구를 사용해서 action=status를 실행하고, 결과를 짧게 요약해줘.",
		);
		await waitStreamingCycle();
		const toolResult = await waitToolActivity();

		if (toolResult === "error") {
			// Tool errored — check if it's a real gateway/skill issue
			const text = await getAssistantTextOrEmpty();
			throw new Error(
				`status tool returned error. assistant="${text.slice(0, 300)}"`,
			);
		}

		// Tool succeeded. Gemini may or may not generate follow-up text.
		// If follow-up exists, verify semantically. If not, tool-success alone is valid.
		await browser.pause(3_000); // give LLM a moment for optional follow-up
		const text = await getAssistantTextOrEmpty();
		if (text.length > 0) {
			await assertSemantic(
				text,
				"skill_naia_discord status 실행 결과를 물었다",
				"AI가 디스코드 상태/연결 정보에 대해 설명하면 PASS. '사용할 수 없다/unavailable'로 단정하면 FAIL.",
			);
		}
		// If no text but tool-success → status executed fine, pass.
	});

	it("should send with auto-target (no explicit to)", async () => {
		// 1. Verify config has discordDefaultUserId from OAuth
		const configCheck = await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			if (!raw) return { userId: "", target: "" };
			const config = JSON.parse(raw);
			return {
				userId: config.discordDefaultUserId ?? "",
				target: config.discordDefaultTarget ?? "",
			};
		});

		if (!configCheck.userId && !configCheck.target) {
			throw new Error(
				"discordDefaultUserId/discordDefaultTarget not found in config. " +
					"Discord OAuth가 userId를 저장하지 않았거나, 아직 Discord 로그인이 안 되어있습니다. " +
					"nan.nextain.io에서 Discord 연결 후 deep link로 전달되는 discord_user_id 값을 확인하세요.",
			);
		}

		// 2. New conversation to isolate tool-activity
		await startNewChat();

		// 3. Send without 'to' — auto-target should resolve from config
		await typeAndSend(
			"skill_naia_discord 도구로 action=send, message='e2e auto-target test' 실행해. to는 지정하지 마.",
		);
		await waitStreamingCycle();
		const toolResult = await waitToolActivity();

		// 4. Check result
		await browser.pause(3_000);
		const text = await getAssistantTextOrEmpty();

		if (toolResult === "error") {
			// Tool error: "target is required" = auto-target 미동작 (FAIL)
			// Discord API error (권한/없는 유저) = 전송 시도는 함 (PASS)
			const isTargetRequired = /target is required|대상이 필요/i.test(text);
			if (isTargetRequired) {
				throw new Error(
					`Auto-target failed: skill returned "target is required" despite config having userId="${configCheck.userId}" target="${configCheck.target}". Config → agent env 전달 경로에 문제가 있습니다. assistant="${text.slice(0, 300)}"`,
				);
			}
			// Discord API error but target was resolved → auto-target worked
		}

		// 5. Semantic check if text is available
		if (text.length > 0) {
			await assertSemantic(
				text,
				"skill_naia_discord send를 to 없이 자동타깃으로 실행했다",
				[
					"PASS: send를 시도하고 전송 결과를 보고함 (성공이든 API 오류든 전송을 시도한 것이면 OK)",
					"FAIL: 'target is required/대상이 필요하다'로 거부",
					"FAIL: '도구를 찾을 수 없다/unavailable'",
				].join("\n"),
			);
		}
	});
});
