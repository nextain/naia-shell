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
			output: "Logged in as codex-user@example.com",
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
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });
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
	// 표본은 예시 주소를 쓴다 — 신원이 새면 안 된다는 것을 확인하는 자리에
	// 실제 계정을 적어 두면 공개 저장소로 그 신원이 새어 나간다.
	await expect(page.getByText("codex-user@example.com")).toHaveCount(0);
	expect(
		await page.evaluate(() => JSON.parse(localStorage.getItem("naia-config") || "{}")),
	).toMatchObject({
		provider: "codex",
		model: "gpt-5.4",
		apiKey: "",
		// The native ADK-path cache is the workspace SoT and deliberately repairs
		// the stale workspaceRoot seeded above during boot.
		workspaceRoot: "/tmp/mock-naia-adk-workspace",
	});

	// Connections is intentionally not shipped yet. Course readiness keeps that
	// unfinished surface disabled and never exposes a raw token field.
	const connectionsTab = page.locator('[data-settings-tab="connections"]');
	await expect(connectionsTab).toBeEnabled();
	await connectionsTab.click();
	await expect(page.getByTestId("discord-connections")).toBeVisible();
	await expect(page.locator('input[type="password"]')).toHaveCount(0);
});
