import { expect, test } from "@playwright/test";

/**
 * Integration validation E2E — issue-driven follow-up to #272/#273/#274 wire-up.
 *
 * Verifies the multi-component wire actually renders + responds in the browser
 * via Playwright with Tauri IPC mocked. Three scenarios:
 *
 *   1. ADK setup wizard renders correctly when no ADK path is set
 *   2. Setting ADK path in localStorage bypasses the wizard and the main shell
 *      mounts (tab strip + panels)
 *   3. The agent IPC bridge (send_to_agent_command) fires when chat is sent,
 *      and panel skill registration (panel_skills frames) is invoked during
 *      app startup — proving the skill registry wire is alive
 */

const TAURI_MOCK = `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__TAURI_INTERNALS__.metadata = {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" },
	};

	// Record every invoke so the test can assert which Tauri commands fire
	window.__INVOKE_LOG__ = [];

	var callbacks = new Map();
	var nextCbId = 1;
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) {
		var id = nextCbId++;
		callbacks.set(id, function(data) { if (once) callbacks.delete(id); return fn && fn(data); });
		return id;
	};
	window.__TAURI_INTERNALS__.unregisterCallback = function(id) { callbacks.delete(id); };
	window.__TAURI_INTERNALS__.runCallback = function(id, data) {
		var cb = callbacks.get(id);
		if (cb) cb(data);
	};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};

	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		window.__INVOKE_LOG__.push({ cmd: cmd, args: args ?? null, t: Date.now() });

		// Safe defaults
		if (cmd === "plugin:event|listen") return 1;
		if (cmd === "plugin:event|unlisten") return undefined;
		if (cmd === "plugin:window|show") return undefined;
		if (cmd === "plugin:window|inner_size") return { width: 1024, height: 768 };
		if (cmd === "plugin:store|load") return undefined;
		if (cmd === "plugin:store|get") return undefined;
		if (cmd === "plugin:store|set") return undefined;
		if (cmd === "plugin:store|save") return undefined;
		if (cmd === "plugin:store|entries") return [];
		if (cmd === "plugin:store|has") return false;
		if (cmd === "plugin:updater|check") return undefined;
		if (cmd === "plugin:path|resolve_directory") return "/tmp/naia-mock-home";
		if (cmd === "plugin:path|join") return (args.paths || []).filter(Boolean).join("/");
		if (cmd === "workspace_detect_adk_root") return null;
		if (cmd === "panel_list_installed") return [];
		if (cmd === "send_to_agent_command") return undefined;
		if (cmd === "frontend_log") return undefined;
		if (cmd === "read_text_file") return "";
		if (cmd === "list_directory") return [];
		if (cmd === "exists") return false;
		// Default: log + return undefined so React doesn't crash on missing handler
		return undefined;
	};
})();
`;

const SET_ADK_PATH = `
localStorage.setItem("naia-adk-path", "/tmp/mock-naia-adk-workspace");
`;

const INVOKE_LOG_QUERY = `
JSON.stringify((window.__INVOKE_LOG__ || []).map(e => ({ cmd: e.cmd })))
`;

test("scenario 1: ADK setup wizard renders when no ADK path is set", async ({ page }) => {
	await page.addInitScript({ content: TAURI_MOCK });

	await page.goto("/");
	await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
	await page.waitForTimeout(1_500);

	// Wizard header text
	await expect(page.locator(".adk-setup-headline")).toBeVisible();
	await expect(page.locator(".adk-setup-headline")).toContainText(/Naia/);

	// Three setup option cards
	const cards = page.locator(".adk-setup-option-card");
	await expect(cards).toHaveCount(3);

	// Verify cards are buttons (have role=button)
	const cardButtons = await page.locator("button.adk-setup-option-card").count();
	expect(cardButtons).toBe(3);
});

test("scenario 2: setting ADK path bypasses wizard, main shell mounts", async ({ page }) => {
	await page.addInitScript({ content: TAURI_MOCK });
	await page.addInitScript({ content: SET_ADK_PATH });

	await page.goto("/");
	await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
	await page.waitForTimeout(2_500);

	// Wizard should be gone
	await expect(page.locator(".adk-setup-screen")).toBeHidden({ timeout: 3_000 });

	// Main shell — titlebar always present
	await expect(page.locator(".titlebar")).toBeVisible();

	// At least one app-root or root container
	const rootHTML = await page.locator("#root").innerHTML();
	expect(rootHTML.length).toBeGreaterThan(1_000);
});

test("scenario 3: skill registry + Rust IPC wires fire (main shell mounted)", async ({ page }) => {
	await page.addInitScript({ content: TAURI_MOCK });
	await page.addInitScript({ content: SET_ADK_PATH });

	await page.goto("/");
	await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
	await page.waitForTimeout(3_000);

	const log = await page.evaluate(INVOKE_LOG_QUERY);
	const cmds = JSON.parse(log) as { cmd: string }[];

	// Skill registry wire: panel_skills frames sent during startup
	const sendCommands = cmds.filter((e) => e.cmd === "send_to_agent_command");
	expect(sendCommands.length, "send_to_agent_command fired at least once").toBeGreaterThanOrEqual(1);

	// Window plumbing (titlebar render → window show)
	const showWindow = cmds.filter((e) => e.cmd === "plugin:window|show");
	expect(showWindow.length, "plugin:window|show invoked (titlebar mounted)").toBeGreaterThanOrEqual(1);

	// Frontend log integration alive
	const feLog = cmds.filter((e) => e.cmd === "frontend_log");
	expect(feLog.length, "frontend_log proxied to Rust backend").toBeGreaterThanOrEqual(1);

	// Panel listing (registered panel system alive)
	const panelList = cmds.filter((e) => e.cmd === "panel_list_installed");
	expect(panelList.length, "panel_list_installed invoked").toBeGreaterThanOrEqual(1);
});

test("scenario 5: ADK detection probe fires when wizard is shown (no ADK path)", async ({ page }) => {
	await page.addInitScript({ content: TAURI_MOCK });
	// NO SET_ADK_PATH — wizard should be shown, and detection should run

	await page.goto("/");
	await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
	await page.waitForTimeout(2_500);

	const log = await page.evaluate(INVOKE_LOG_QUERY);
	const cmds = JSON.parse(log) as { cmd: string }[];

	const detectAdk = cmds.filter((e) => e.cmd === "workspace_detect_adk_root");
	expect(
		detectAdk.length,
		"workspace_detect_adk_root probed at startup (wizard auto-detection)",
	).toBeGreaterThanOrEqual(1);
});

test("scenario 4: panel_skills frames carry skill registrations from agent (browser/workspace panels)", async ({ page }) => {
	await page.addInitScript({ content: TAURI_MOCK });
	await page.addInitScript({ content: SET_ADK_PATH });

	await page.goto("/");
	await page.waitForTimeout(3_000);

	// Inspect panel_skills frames captured in the invoke log
	const frames = await page.evaluate(() => {
		const log: { cmd: string; args: { message?: string } | null }[] =
			(window as unknown as { __INVOKE_LOG__: { cmd: string; args: { message?: string } | null }[] }).__INVOKE_LOG__ ?? [];
		const out: { panelId: string; toolCount: number }[] = [];
		for (const e of log) {
			if (e.cmd !== "send_to_agent_command") continue;
			const m = e.args?.message;
			if (!m) continue;
			try {
				const obj = JSON.parse(m);
				if (obj?.type === "panel_skills") {
					out.push({ panelId: obj.panelId, toolCount: (obj.tools || []).length });
				}
			} catch {
				// ignore non-JSON
			}
		}
		return out;
	});

	console.log("panel_skills frames captured:", JSON.stringify(frames));

	// Expect both browser + workspace panels to register their skills via the agent IPC
	const panelIds = frames.map((f) => f.panelId);
	expect(panelIds, "browser panel registered skills").toContain("browser");
	expect(panelIds, "workspace panel registered skills").toContain("workspace");

	// Each panel should have at least one tool
	for (const f of frames) {
		expect(f.toolCount, `${f.panelId} has tools`).toBeGreaterThanOrEqual(1);
	}
});
