import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

// This is deliberately a WebView boundary test, not a keychain-success fake.
// The real native credential result is covered by Tauri WebDriver/manual
// provisioned acceptance because raw bot tokens must never be injected here.
const DISCORD_SETTINGS_MOCK = `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__TAURI_INTERNALS__.metadata = {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" },
	};
	window.__DISCORD_SETTINGS_INVOKES__ = [];
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
	window.__TAURI_INTERNALS__.unregisterCallback = function(id) { callbacks.delete(id); };
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		window.__DISCORD_SETTINGS_INVOKES__.push({ cmd: cmd, args: args || null });
		if (cmd === "plugin:event|listen") return 1;
		if (cmd === "plugin:event|unlisten") return null;
		if (cmd === "discord_connection_status") return {
			tokenConfigured: true, generation: 1, state: "ready", authoritative: true,
		};
		if (cmd === "discord_binding_snapshot") return { generation: 1, bindings: [] };
		if (cmd === "discord_discover_channels") return {
			botId: "900", botUsername: "Naia", messageContentIntent: true,
			intentCode: "message_content_enabled", degradedGuildIds: [], discoveryTruncated: false,
			guilds: [{ id: "100", name: "Nextain", channels: [{
				id: "200", name: "general", kind: 0, position: 0,
				permissions: { viewChannel: true, sendMessages: true, readMessageHistory: true, usable: true },
			}]}],
		};
		if (cmd === "discord_capture_bot_token") throw new Error("capture_cancelled");
		return undefined;
	};
})();
`;

test("unavailable Connections keeps credentials out of the WebView", async ({
	page,
}) => {
	await page.addInitScript({ content: DISCORD_SETTINGS_MOCK });
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript({
		content: `localStorage.setItem("naia-chat-mode-v1", "app");
		localStorage.setItem("naia-config", JSON.stringify({
			onboardingComplete: true, provider: "ollama", model: "qwen3", enableTools: true
		}));`,
	});
	await page.goto("/");
	await page.waitForLoadState("networkidle");

	await page.locator(".chat-input").fill("Discord 연결 설정해줘");
	await page.locator(".chat-send-btn").click();
	const guide = page.getByRole("dialog");
	await expect(guide).toBeVisible();
	await guide.getByRole("button").click();

	const connectionsTab = page.locator('[data-settings-tab="connections"]');
	await expect(connectionsTab).toBeEnabled();
	await connectionsTab.click();
	await expect(page.getByTestId("discord-connections")).toBeVisible();
	await expect(page.locator('input[type="password"]')).toHaveCount(0);

	const capture = await page.evaluate(() =>
		(
			window as unknown as {
				__DISCORD_SETTINGS_INVOKES__: Array<{ cmd: string; args: unknown }>;
			}
		).__DISCORD_SETTINGS_INVOKES__.find(
			(call) => call.cmd === "discord_capture_bot_token",
		),
	);
	expect(capture).toBeUndefined();
});
