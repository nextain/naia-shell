import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const COURSE_CODEX_TAURI_MOCK = `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__TAURI_INTERNALS__.metadata = {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" },
	};
	window.__COURSE_CODEX_INVOKES__ = [];
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
		window.__COURSE_CODEX_INVOKES__.push({ cmd: cmd, args: args || null });
		if (cmd === "plugin:event|listen") return 1;
		if (cmd === "plugin:event|unlisten") return null;
		if (cmd === "discord_connection_status") return {
			tokenConfigured: true,
			generation: 1,
			state: "ready",
			authoritative: true,
		};
		if (cmd === "discord_binding_snapshot") return { generation: 1, bindings: [] };
		if (cmd === "discord_discover_channels") return {
			botId: "900",
			botUsername: "Naia",
			messageContentIntent: true,
			intentCode: "message_content_enabled",
			degradedGuildIds: [],
			discoveryTruncated: false,
			guilds: [{
				id: "100",
				name: "Course guild",
				channels: [{
					id: "200", name: "class", kind: 0, position: 0,
					permissions: { viewChannel: true, sendMessages: true, readMessageHistory: true, usable: true },
				}],
			}],
		};
		if (cmd === "codex_preflight") return {
			status: "ready",
			output: "Logged in as fstory97@gmail.com",
		};
		return undefined;
	};
})();
`;

test.beforeEach(async ({ page }) => {
	await page.addInitScript({ content: COURSE_CODEX_TAURI_MOCK });
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript({
		content: `localStorage.setItem("naia-chat-mode-v1", "app");
			localStorage.setItem("naia-config", JSON.stringify({
				onboardingComplete: true,
				provider: "codex",
				model: "gpt-5.4",
				apiKey: "",
				workspaceRoot: "D:\\\\course\\\\jeonju-workshop"
			}));`,
	});
	await page.goto("/");
	await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 15_000 });
});

test("UC-JEONJU-COURSE-READINESS: student checks Codex before selecting the course workspace", async ({
	page,
}) => {
	await page.getByRole("button", { name: /^(Settings|설정)$/ }).click();
	await page.locator('[data-settings-tab="brain"]').click();

	const readiness = page.getByTestId("codex-readiness");
	await expect(readiness).toBeVisible();
	await expect(readiness).toContainText(/Not checked|확인 전/);
	await readiness.getByTestId("codex-readiness-check").click();
	await expect(readiness).toContainText(/Ready|준비됨/);

	await expect
		.poll(() =>
			page.evaluate(() =>
				(
					window as unknown as {
						__COURSE_CODEX_INVOKES__: Array<{ cmd: string }>;
					}
				).__COURSE_CODEX_INVOKES__.filter(
					(call) => call.cmd === "codex_preflight",
				).length,
			),
		)
		.toBe(1);

	// Readiness is deliberately a safe status only: no account identity or CLI
	// output can appear in the course UI or be saved as a credential.
	await expect(page.getByText("fstory97@gmail.com")).toHaveCount(0);
	expect(
		await page.evaluate(() => JSON.parse(localStorage.getItem("naia-config") || "{}")),
	).toMatchObject({
		provider: "codex",
		model: "gpt-5.4",
		apiKey: "",
		workspaceRoot: "D:\\course\\jeonju-workshop",
	});

	// The next course step is reachable from the same settings surface. The
	// connection UI exposes discovered channels but never a raw Discord token.
	await page.locator('[data-settings-tab="connections"]').click();
	const connections = page.getByTestId("discord-connections");
	await expect(connections).toBeVisible();
	await expect(connections).toContainText("Naia");
	await expect(connections.locator('input[type="password"]')).toHaveCount(0);
});
