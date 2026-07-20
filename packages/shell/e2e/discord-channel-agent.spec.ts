import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const DISCORD_TAURI_MOCK = `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__TAURI_INTERNALS__.metadata = {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" },
	};
	window.__DISCORD_INVOKES__ = [];
	var callbacks = new Map();
	var nextCallbackId = 1;
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) {
		var id = nextCallbackId++;
		callbacks.set(id, function(data) {
			if (once) callbacks.delete(id);
			return fn && fn(data);
		});
		return id;
	};
	window.__TAURI_INTERNALS__.unregisterCallback = function(id) {
		callbacks.delete(id);
	};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		window.__DISCORD_INVOKES__.push({ cmd: cmd, args: args || null });
		if (cmd === "plugin:event|listen") return 1;
		if (cmd === "plugin:event|unlisten") return null;
		if (cmd === "discord_connection_status") return {
			tokenConfigured: true,
			generation: 1,
			state: "ready",
			authoritative: true,
		};
		if (cmd === "discord_discover_channels") return {
			botId: "900",
			botUsername: "Naia",
			messageContentIntent: true,
			intentCode: "message_content_enabled",
			degradedGuildIds: [],
			discoveryTruncated: false,
			guilds: [{
				id: "100",
				name: "Nextain",
				channels: [
					{
						id: "200",
						name: "general",
						kind: 0,
						position: 0,
						permissions: {
							viewChannel: true,
							sendMessages: true,
							readMessageHistory: true,
							usable: true,
						},
					},
					{
						id: "201",
						name: "private",
						kind: 0,
						position: 1,
						permissions: {
							viewChannel: true,
							sendMessages: false,
							readMessageHistory: true,
							usable: false,
						},
					},
				],
			}],
		};
		if (cmd === "discord_binding_snapshot")
			return { generation: 1, bindings: [] };
		if (cmd === "discord_save_bindings") return (args.bindings || []).length;
		if (cmd === "discord_get_last_binding") return null;
		if (cmd === "discord_set_last_binding") return null;
		if (cmd === "discord_inbox_snapshot") return [{
			bindingId: "discord_100_200",
			guildId: "100",
			guildName: "Nextain",
			channelId: "200",
			channelName: "general",
			participation: "mentions",
			unread: 1,
			lastActivity: 1720000000000,
			records: [{
				recordId: "incoming:m1",
				direction: "incoming",
				bindingId: "discord_100_200",
				guildId: "100",
				channelId: "200",
				sourceMessageId: "m1",
				authorId: "300",
				content: "배포 상태를 확인해줘",
				createdAt: 1720000000000,
			}],
		}];
		if (cmd === "discord_inbox_snapshot_cached") return [{
			bindingId: "discord_100_200",
			guildId: "100",
			guildName: "Nextain",
			channelId: "200",
			channelName: "general",
			participation: "mentions",
			unread: 0,
			lastActivity: 1720000000000,
			records: [],
		}];
		if (cmd === "discord_fetch_channel_history") return [{
			recordId: "history:h1",
			direction: "incoming",
			bindingId: "discord_100_200",
			guildId: "100",
			channelId: "200",
			sourceMessageId: "h1",
			authorId: "300",
			content: "이전 Discord 대화",
			createdAt: 1719999999000,
		}];
		if (cmd === "discord_mark_inbox_read") return null;
		return undefined;
	};
})();
`;

test.beforeEach(async ({ page }) => {
	await page.addInitScript({ content: DISCORD_TAURI_MOCK });
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript({
		content: `localStorage.setItem("naia-chat-mode-v1", "app");
		localStorage.setItem("naia-config", JSON.stringify({
			onboardingComplete: true,
			provider: "ollama",
			model: "qwen3",
			enableTools: true
		}));`,
	});
	await page.goto("/");
	await page.waitForLoadState("networkidle");
	await expect(page.locator(".titlebar")).toBeVisible();
});

test("Connections에서 권한 가능한 채널만 저장한다", async ({ page }) => {
	await page.locator(".chat-input").fill("디스코드 연결 설정해줘");
	await page.locator(".chat-send-btn").click();
	const guide = page.getByRole("dialog");
	await expect(guide).toContainText(/비밀|secret/i);
	await guide.getByRole("button").click();

	const panel = page.locator('[data-testid="discord-connections"]:visible');
	await expect(panel).toBeVisible();
	await expect(panel).toContainText("Naia");

	const checkboxes = panel.locator('input[type="checkbox"]');
	await expect(checkboxes).toHaveCount(2);
	await expect(checkboxes.nth(1)).toBeDisabled();
	await checkboxes.nth(0).check();
	await panel
		.locator('input[type="text"]')
		.fill("300000, 301000, 300000");
	await panel.locator("select").selectOption("all");
	const applyButton = panel.getByRole("button", { name: /Apply|적용/ });
	await applyButton.focus();
	await page.keyboard.press("Enter");

	const save = await expect
		.poll(() =>
			page.evaluate(() => {
				const calls = (
					window as unknown as {
						__DISCORD_INVOKES__: Array<{ cmd: string; args: unknown }>;
					}
				).__DISCORD_INVOKES__;
				return calls.find((call) => call.cmd === "discord_save_bindings");
			}),
		)
		.toBeTruthy()
		.then(() =>
			page.evaluate(() =>
				(
					window as unknown as {
						__DISCORD_INVOKES__: Array<{ cmd: string; args: unknown }>;
					}
				).__DISCORD_INVOKES__.find(
					(call) => call.cmd === "discord_save_bindings",
				),
			),
		);
	expect(save?.args).toEqual({
		expectedGeneration: 1,
		bindings: [
			{
				bindingId: "discord_100_200",
				guildId: "100",
				guildName: "Nextain",
				channelId: "200",
				channelName: "general",
				allowedUserIds: ["300000", "301000"],
				processingProfileRef: "default",
				participation: "all",
			},
		],
	});
});

test("Channels 메시지는 개인 채팅에 복사하지 않고 읽음 상태만 저장한다", async ({
	page,
}) => {
	await page.getByRole("button", { name: /Channels|채널/ }).click();
	const panel = page.locator('[data-testid="channels-tab"]:visible');
	await expect(panel).toBeVisible();
	await expect(panel).toContainText("Nextain");
	await expect(panel).toContainText("배포 상태를 확인해줘");
	await expect(panel).toContainText("이전 Discord 대화");

	await panel.locator(".channels-inbox-list button").click();
	await expect
		.poll(() =>
			page.evaluate(() =>
				(
					window as unknown as {
						__DISCORD_INVOKES__: Array<{ cmd: string }>;
					}
				).__DISCORD_INVOKES__.some(
					(call) => call.cmd === "discord_mark_inbox_read",
				),
			),
		)
		.toBe(true);

	await expect(panel.locator(".dm-message button")).toHaveCount(0);
	await expect(page.locator(".chat-input")).toHaveValue("");
});

test("좁은 Channels 화면은 목록과 대화를 분리하고 뒤로 돌아간다", async ({
	page,
}) => {
	await page.setViewportSize({ width: 520, height: 760 });
	await page.getByRole("button", { name: /Channels|채널/ }).click();
	const panel = page.locator('[data-testid="channels-tab"]:visible');
	const layout = panel.locator(".channels-inbox-layout");
	const list = panel.locator(".channels-inbox-list");
	const messages = panel.locator(".dm-messages");

	await expect(layout).toHaveClass(/detail-open/);
	await expect(list).toBeHidden();
	await expect(messages).toBeVisible();
	await expect(messages).toContainText("이전 Discord 대화");
	await expect
		.poll(() =>
			page.evaluate(() =>
				(
					window as unknown as {
						__DISCORD_INVOKES__: Array<{ cmd: string }>;
					}
				).__DISCORD_INVOKES__.some(
					(call) => call.cmd === "discord_fetch_channel_history",
				),
			),
		)
		.toBe(true);
	await messages.locator(".channels-inbox-back").click();
	await expect(layout).not.toHaveClass(/detail-open/);
	await expect(list).toBeVisible();
	await expect(messages).toBeHidden();
	await expect(list.getByRole("button")).toHaveAttribute("aria-current", "page");
	await list.getByRole("button").click();
	await expect(layout).toHaveClass(/detail-open/);
	const clearedPreference = await page.evaluate(() =>
		(
			window as unknown as {
				__DISCORD_INVOKES__: Array<{
					cmd: string;
					args: { bindingId?: string | null } | null;
				}>;
			}
		).__DISCORD_INVOKES__.some(
			(call) =>
				call.cmd === "discord_set_last_binding" &&
				call.args?.bindingId === null,
		),
	);
	expect(clearedPreference).toBe(false);
});
