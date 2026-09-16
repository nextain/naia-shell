import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const CLI_TAURI_MOCK = `
(function() {
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
  window.__TAURI_INTERNALS__.metadata = {
    currentWindow: { label: "main" },
    currentWebview: { windowLabel: "main", label: "main" }
  };
  var callbacks = new Map();
  var listeners = new Map();
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
  window.__TAURI_INTERNALS__.runCallback = function(id, data) {
    var callback = callbacks.get(id);
    if (callback) callback(data);
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
  window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
    if (cmd === "plugin:event|listen") {
      if (!listeners.has(args.event)) listeners.set(args.event, []);
      listeners.get(args.event).push(args.handler);
      return args.handler;
    }
    if (cmd === "plugin:event|unlisten") return null;
    if (cmd === "read_naia_config") return JSON.stringify(window.__CLI_CONFIG__);
    if (cmd === "read_naia_ui_config") return null;
    if (cmd === "write_naia_config" || cmd === "write_naia_ui_config") return null;
    if (cmd === "cli_detect_refresh") {
      if (window.__CLI_FAIL__) throw new Error("cli detection unavailable");
      if (window.__CLI_DELAY_MS__) {
        await new Promise(function(resolve) { setTimeout(resolve, window.__CLI_DELAY_MS__); });
      }
      return window.__CLI_SNAPSHOT__;
    }
    if (cmd === "cli_detect_one") {
      var result = window.__CLI_SNAPSHOT__.results.find(function(item) { return item.id === args.id; });
      return result || {
        id: args.id,
        displayName: args.id,
        installed: false,
        status: "not-installed"
      };
    }
    return undefined;
  };
})();
`;

const INSTALLED_SNAPSHOT = {
	refreshedAt: "e2e",
	results: [
		{
			id: "claude",
			displayName: "Claude Code",
			installed: true,
			path: "/usr/bin/claude",
			version: "2.0.0",
			status: "ready",
		},
		{
			id: "codex",
			displayName: "Codex",
			installed: true,
			path: "/usr/bin/codex",
			version: "1.0.0",
			status: "login-required",
		},
		{
			id: "grok",
			displayName: "Grok",
			installed: false,
			status: "not-installed",
		},
	],
};

const EMPTY_SNAPSHOT = {
	refreshedAt: "e2e-empty",
	results: INSTALLED_SNAPSHOT.results.map((result) => ({
		...result,
		installed: false,
		status: "not-installed",
	})),
};

const CONFIG = {
	onboardingComplete: true,
	provider: "ollama",
	model: "e2e",
	apiKey: "",
	locale: "en",
	enableTools: true,
	enabledClis: ["claude"],
};

async function boot(
	page: import("@playwright/test").Page,
	snapshot: typeof INSTALLED_SNAPSHOT | typeof EMPTY_SNAPSHOT,
	options: { fail?: boolean; delayMs?: number } = {},
) {
	await page.addInitScript({
		content: `window.__CLI_CONFIG__ = ${JSON.stringify(CONFIG)};
window.__CLI_SNAPSHOT__ = ${JSON.stringify(snapshot)};
window.__CLI_FAIL__ = ${Boolean(options.fail)};
window.__CLI_DELAY_MS__ = ${options.delayMs ?? 0};
localStorage.setItem("naia-config", ${JSON.stringify(JSON.stringify(CONFIG))});`,
	});
	await page.addInitScript({ content: CLI_TAURI_MOCK });
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.goto("/");
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });
}

async function openSkills(page: import("@playwright/test").Page) {
	await page.getByRole("button", { name: /^(Settings|설정)$/ }).click();
	await page.locator('[data-settings-tab="skills"]').click();
	await expect(page.getByTestId("skills-tab")).toBeVisible();
}

test.describe("S-SKILLS-CLI", () => {
	test("shows installed named CLI checkboxes and stays inside a narrow panel", async ({
		page,
	}) => {
		await boot(page, INSTALLED_SNAPSHOT);
		await openSkills(page);
		await page.setViewportSize({ width: 480, height: 800 });

		await expect(page.getByTestId("skills-cli-section")).toContainText("2");
		await expect(page.getByTestId("cli-skill-card")).toHaveCount(2);
		await expect(page.getByTestId("cli-enable-claude")).toHaveAccessibleName(
			"Claude Code",
		);
		await expect(page.getByTestId("cli-enable-codex")).toHaveAccessibleName(
			"Codex",
		);
		await expect(
			page.getByTestId("cli-skill-card").filter({ hasText: "Grok" }),
		).toHaveCount(0);
		await expect(page.getByTestId("skills-gesture-section")).toContainText(
			/Shell gestures|몸짓/,
		);
		await expect(page.getByTestId("gesture-skill-card")).toContainText(
			/YouTube|유튜브/,
		);
		await expect(page.getByTestId("gesture-enable-youtube")).toBeVisible();
		await expect(page.getByTestId("cli-status-claude")).toContainText(
			/Ready|준비됨/,
		);

		const widths = await page.evaluate(() => ({
			viewport: window.innerWidth,
			scroll: document.documentElement.scrollWidth,
		}));
		expect(widths.scroll).toBeLessThanOrEqual(widths.viewport);
	});

	test("distinguishes empty, progress, and error states with recovery", async ({
		page,
	}) => {
		await boot(page, EMPTY_SNAPSHOT, { fail: true });
		await openSkills(page);
		await expect(page.getByTestId("skills-load-error")).toBeVisible();
		await expect(page.getByTestId("skills-cli-empty")).toBeVisible();
		await expect(page.getByTestId("cli-skill-card")).toHaveCount(0);

		await page.evaluate(() => {
			(window as unknown as { __CLI_FAIL__: boolean }).__CLI_FAIL__ = false;
		});
		await page.getByTestId("skills-cli-refresh").click();
		await expect(page.getByTestId("skills-cli-empty")).toBeVisible();

		await page.evaluate((snapshot) => {
			(window as unknown as { __CLI_SNAPSHOT__: unknown }).__CLI_SNAPSHOT__ =
				snapshot;
		}, INSTALLED_SNAPSHOT);
		await page.getByTestId("skills-cli-refresh").click();
		await expect(page.getByTestId("cli-skill-card")).toHaveCount(2);

		await page.evaluate(() => {
			(window as unknown as { __CLI_DELAY_MS__: number }).__CLI_DELAY_MS__ =
				250;
		});
		const refresh = page.getByTestId("skills-cli-refresh");
		await refresh.click();
		await expect(refresh).toBeDisabled();
		await expect(refresh).toBeEnabled();
	});
});
