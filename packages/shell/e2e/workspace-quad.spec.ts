import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const ROOT_A = "/work/alpha";

const snapshot = {
	protocol: 19,
	version: "0.8.0",
	focused_workspace_id: "w1",
	focused_tab_id: "w1:t1",
	focused_pane_id: "w1:p1",
	workspaces: [
		{
			workspace_id: "w1",
			label: "Alpha",
			focused: true,
			active_tab_id: "w1:t1",
			pane_count: 1,
			tab_count: 1,
			worktree: { checkout_path: ROOT_A, repo_name: "alpha" },
		},
	],
	agents: [
		{
			workspace_id: "w1",
			tab_id: "w1:t1",
			pane_id: "w1:p1",
			agent: "codex",
			agent_status: "working",
			cwd: ROOT_A,
			foreground_cwd: ROOT_A,
			focused: true,
			label: "Builder",
		},
	],
};

const TAURI_MOCK_SCRIPT = `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__TAURI_INTERNALS__.metadata = {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" },
	};

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
	window.__TAURI_INTERNALS__.runCallback = function(id, data) {
		var callback = callbacks.get(id);
		if (callback) callback(data);
	};

	var eventListeners = new Map();
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
	function emitEvent(event, payload) {
		var listeners = eventListeners.get(event) || [];
		for (var callbackId of listeners) {
			window.__TAURI_INTERNALS__.runCallback(callbackId, { event: event, payload: payload });
		}
	}

	var state = ${JSON.stringify(snapshot)};
	var calls = [];

	window.__NAIA_E2E__ = {
		calls: calls,
		emitEvent: emitEvent,
	};

	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		calls.push({ cmd: cmd, args: args || null });
		if (cmd === "plugin:event|listen") {
			if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
			eventListeners.get(args.event).push(args.handler);
			return args.handler;
		}
		if (cmd === "plugin:event|emit") { emitEvent(args.event, args.payload); return null; }
		if (cmd === "plugin:event|unlisten") return null;
		if (cmd === "herdr_pty_create") return { pty_id: "herdr-e2e", pid: 42 };
		if (cmd === "pty_create") return { pty_id: "pty-e2e", pid: 101 };
		if (cmd === "herdr_snapshot") return JSON.parse(JSON.stringify(state));
		if (cmd === "workspace_set_root") return args.root;
		if (cmd === "workspace_detect_adk_root") return "${ROOT_A}";
		if (cmd === "workspace_list_dirs") return [];
		if (cmd === "workspace_file_size") return 512;
		if (cmd === "workspace_read_file") return "# Demo";
		if (cmd === "workspace_resolve_file_location") return "${ROOT_A}/src/App.tsx";
		if (cmd === "pty_resize" || cmd === "pty_write" || cmd === "pty_close") return null;
		if (cmd === "send_to_agent_command" || cmd === "cancel_stream") return null;
		if (cmd === "frontend_log") return null;
		if (cmd === "app_list_installed") return [];
		if (cmd === "list_skills" || cmd === "list_stt_models") return [];
		if (cmd === "read_naia_config") return null;
		return undefined;
	};
})();
`;

test.describe("Workspace 3-pane quad layout (issue #732)", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(TAURI_MOCK_SCRIPT);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });
		await page.addInitScript(() => {
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					provider: "gemini",
					model: "gemini-2.5-flash",
					apiKey: "e2e-mock-key",
					locale: "ko",
					onboardingComplete: true,
				}),
			);
			localStorage.setItem("naia-adk-path", "/work/alpha");
		});
		await page.goto("/");
		await expect(page.locator(".chat-app")).toBeVisible({ timeout: 10_000 });
	});

	test("renders 3-pane quad view by default and allows toggling to standard 1-pane", async ({
		page,
	}) => {
		const tab = page.locator('button[data-app-id="workspace"]');
		await expect(tab).toBeVisible({ timeout: 10_000 });
		await tab.click();
		await expect(page.getByTestId("herdr-workspace")).toBeVisible();

		// 3-pane quad view should be rendered
		const quadView = page.getByTestId("workspace-quad");
		await expect(quadView).toBeVisible();

		// Check the three panes
		await expect(page.getByTestId("quad-pane-terminal")).toBeVisible();
		await expect(page.getByTestId("quad-pane-docs")).toBeVisible();
		await expect(page.getByTestId("quad-pane-dashboard")).toBeVisible();

		// Check the resize handles
		await expect(page.getByTestId("quad-handle-0")).toBeVisible();
		await expect(page.getByTestId("quad-handle-1")).toBeVisible();

		// Check toggle layout button in rail header
		const toggleBtn = page.getByTestId("workspace-layout-toggle");
		await expect(toggleBtn).toBeVisible();
		await expect(toggleBtn).toContainText("1단");

		// Click to switch to standard 1-pane layout
		await toggleBtn.click();
		await expect(quadView).not.toBeVisible();
		await expect(page.locator(".herdr-workspace__main")).toBeVisible();
		await expect(toggleBtn).toContainText("3단");

		// Click again to switch back to 3-pane quad layout
		await toggleBtn.click();
		await expect(quadView).toBeVisible();
	});

	test("contains terminal source switcher and opencode trigger in quad view", async ({
		page,
	}) => {
		const tab = page.locator('button[data-app-id="workspace"]');
		await expect(tab).toBeVisible({ timeout: 10_000 });
		await tab.click();
		await expect(page.getByTestId("workspace-quad")).toBeVisible();

		const opencodeBtn = page.getByTestId("quad-run-opencode");
		await expect(opencodeBtn).toBeVisible();
		await expect(opencodeBtn).toHaveText("opencode");

		const sourceSwitch = page.getByRole("radiogroup", { name: "터미널 소스 선택" });
		await expect(sourceSwitch).toBeVisible();
	});
});
