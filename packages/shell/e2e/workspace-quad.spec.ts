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
		await page.route("**/127.0.0.1:8896/**", (route) =>
			route.fulfill({ status: 200, body: "<html><body>Board OK</body></html>" }),
		);
		await page.route("**/localhost:8896/**", (route) =>
			route.fulfill({ status: 200, body: "<html><body>Board OK</body></html>" }),
		);
		await page.route("**/localhost:3142/**", (route) =>
			route.fulfill({ status: 200, body: "<html><body>Docs OK</body></html>" }),
		);
		await page.route("**/127.0.0.1:3142/**", (route) =>
			route.fulfill({ status: 200, body: "<html><body>Docs OK</body></html>" }),
		);
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

	async function openWorkspace(page: Page) {
		const tab = page.locator('button[data-app-id="workspace"]');
		await expect(tab).toBeVisible({ timeout: 10_000 });
		await tab.click();
		await expect(page.getByTestId("workspace-quad")).toBeVisible();
	}

	test("verifies default board pane URL and allows editing, canceling, and rejecting invalid URLs", async ({
		page,
	}) => {
		await page.route(/:5000\//, (route) =>
			route.fulfill({ status: 200, body: "<html><body>API Docs OK</body></html>" }),
		);

		await openWorkspace(page);

		// (a) Default Board and Docs URLs
		const boardIframe = page.getByTestId("quad-dashboard-iframe");
		await expect(boardIframe).toHaveAttribute("src", "http://127.0.0.1:8896/");
		const docsIframe = page.getByTestId("quad-docs-iframe");
		await expect(docsIframe).toHaveAttribute("src", "http://localhost:3142/docs");

		// (b) Edit URL and save
		await page.getByTestId("quad-docs-change-url").click();
		const input = page.getByTestId("quad-docs-url-input");
		await expect(input).toBeVisible();
		await input.fill("http://localhost:5000/api-docs");
		await page.getByTestId("quad-docs-url-save").click();
		await expect(input).not.toBeVisible();
		await expect(page.getByTestId("quad-docs-iframe")).toHaveAttribute(
			"src",
			"http://localhost:5000/api-docs",
		);

		// (c) Cancel edit with cancel button
		await page.getByTestId("quad-docs-change-url").click();
		await expect(input).toBeVisible();
		await input.fill("http://localhost:9999/abandoned");
		await page.getByTestId("quad-docs-url-cancel").click();
		await expect(input).not.toBeVisible();
		await expect(page.getByTestId("quad-docs-iframe")).toHaveAttribute(
			"src",
			"http://localhost:5000/api-docs",
		);

		// (c) Cancel edit with Escape key
		await page.getByTestId("quad-docs-change-url").click();
		await expect(input).toBeVisible();
		await input.fill("http://localhost:9999/abandoned");
		await input.press("Escape");
		await expect(input).not.toBeVisible();
		await expect(page.getByTestId("quad-docs-iframe")).toHaveAttribute(
			"src",
			"http://localhost:5000/api-docs",
		);

		// (d) Reject invalid URLs with role=alert
		await page.getByTestId("quad-docs-change-url").click();
		await expect(input).toBeVisible();
		await input.fill("http://example.com/evil");
		await page.getByTestId("quad-docs-url-save").click();
		const alert = page.getByTestId("quad-docs-url-error");
		await expect(alert).toBeVisible();
		await expect(alert).toHaveAttribute("role", "alert");
		// iframe src must not change
		await expect(page.getByTestId("quad-docs-iframe")).toHaveAttribute(
			"src",
			"http://localhost:5000/api-docs",
		);

		// Test javascript: scheme rejection
		await input.fill("javascript:alert(1)");
		await page.getByTestId("quad-docs-url-save").click();
		await expect(alert).toBeVisible();
		await page.getByTestId("quad-docs-url-cancel").click();
	});

	test("calls external opener when clicking header ↗ button and footer button", async ({
		page,
	}) => {
		await page.route("http://127.0.0.1:8896/**", (route) =>
			route.fulfill({ status: 200, body: "<html><body>Board</body></html>" }),
		);
		await page.route("http://localhost:3142/**", (route) =>
			route.fulfill({ status: 200, body: "<html><body>Docs</body></html>" }),
		);

		await openWorkspace(page);

		// Click header external open button
		await page.getByTestId("quad-docs-external").click();
		// Click pane footer open browser button
		await page.getByTestId("quad-docs-open-browser").click();

		const calls = await page.evaluate(
			() => (window as unknown as { __NAIA_E2E__: { calls: Array<{ cmd: string; args?: { url?: string } }> } }).__NAIA_E2E__.calls,
		);
		const openerCalls = calls.filter((c) => c.cmd === "plugin:opener|open_url");
		expect(openerCalls.length).toBeGreaterThanOrEqual(2);
		expect(openerCalls[0].args?.url).toBe("http://localhost:3142/docs");
		expect(openerCalls[1].args?.url).toBe("http://localhost:3142/docs");
	});

	test("maintains 3 non-overlapping panes with visible content at 1024px width", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 });
		await page.route("http://127.0.0.1:8896/**", (route) =>
			route.fulfill({ status: 200, body: "<html><body>Board</body></html>" }),
		);
		await page.route("http://localhost:3142/**", (route) =>
			route.fulfill({ status: 200, body: "<html><body>Docs</body></html>" }),
		);

		await openWorkspace(page);

		const termPane = page.getByTestId("quad-pane-terminal");
		const docsPane = page.getByTestId("quad-pane-docs");
		const boardPane = page.getByTestId("quad-pane-dashboard");

		await expect(termPane).toBeVisible();
		await expect(docsPane).toBeVisible();
		await expect(boardPane).toBeVisible();

		const termBox = await termPane.boundingBox();
		const docsBox = await docsPane.boundingBox();
		const boardBox = await boardPane.boundingBox();

		expect(termBox).not.toBeNull();
		expect(docsBox).not.toBeNull();
		expect(boardBox).not.toBeNull();

		// Bounding boxes must not overlap horizontally (allowing small handle gap/overlap within 2px)
		expect(termBox!.x + termBox!.width).toBeLessThanOrEqual(docsBox!.x + 2);
		expect(docsBox!.x + docsBox!.width).toBeLessThanOrEqual(boardBox!.x + 2);
		expect(termBox!.width).toBeGreaterThanOrEqual(140);
		expect(docsBox!.width).toBeGreaterThanOrEqual(140);
		expect(boardBox!.width).toBeGreaterThanOrEqual(140);
	});

	test("shows checking status and offline alert when server is down, then recovers on retry after route is up", async ({
		page,
	}) => {
		await openWorkspace(page);

		// Switch Docs pane to an offline URL (aborted route on port 8899)
		const abortHandler = (route: any) => route.abort();
		await page.route(/:8899\//, abortHandler);

		await page.getByTestId("quad-docs-change-url").click();
		const input = page.getByTestId("quad-docs-url-input");
		await input.fill("http://127.0.0.1:8899/offline-test");
		await page.getByTestId("quad-docs-url-save").click();

		// Offline alert should appear because port 8899 is aborted
		const offline = page.getByTestId("quad-docs-offline");
		await expect(offline).toBeVisible();
		await expect(offline).toHaveAttribute("role", "alert");

		// Now bring server back up (fulfill route for 8899)
		await page.unroute(/:8899\//, abortHandler);
		await page.route(/:8899\//, (route) =>
			route.fulfill({ status: 200, body: "<html><body>8899 Restored</body></html>" }),
		);

		// Click retry
		await page.getByTestId("quad-docs-retry").click();

		// Iframe should be visible with the new URL and offline notice gone
		await expect(page.getByTestId("quad-docs-iframe")).toBeVisible();
		await expect(page.getByTestId("quad-docs-iframe")).toHaveAttribute(
			"src",
			"http://127.0.0.1:8899/offline-test",
		);
		await expect(offline).not.toBeVisible();
	});

	test("handles A->B->A route race: second A success is preserved against delayed first A failure", async ({
		page,
	}) => {
		let firstAResolve: (() => void) | null = null;
		let firstACount = 0;

		await page.route("http://127.0.0.1:8896/temp-b", (route) =>
			route.fulfill({ status: 200, body: "<html><body>Temp B OK</body></html>" }),
		);
		await page.route("http://127.0.0.1:8896/**", (route) =>
			route.fulfill({ status: 200, body: "<html><body>Board</body></html>" }),
		);

		await page.route("http://localhost:3142/docs", async (route) => {
			firstACount++;
			if (firstACount === 1) {
				// Defer first A request
				await new Promise<void>((resolve) => {
					firstAResolve = resolve;
				});
				await route.abort();
				return;
			}
			await route.fulfill({ status: 200, body: "<html><body>Docs A OK</body></html>" });
		});

		await openWorkspace(page);

		// First A is pending. Switch to B:
		await page.getByTestId("quad-docs-change-url").click();
		await page.getByTestId("quad-docs-url-input").fill("http://127.0.0.1:8896/temp-b");
		await page.getByTestId("quad-docs-url-save").click();

		await expect(page.getByTestId("quad-docs-iframe")).toHaveAttribute(
			"src",
			"http://127.0.0.1:8896/temp-b",
		);

		// Now switch back to A (second A):
		await page.getByTestId("quad-docs-change-url").click();
		await page.getByTestId("quad-docs-url-input").fill("http://localhost:3142/docs");
		await page.getByTestId("quad-docs-url-save").click();

		// Second A succeeds -> iframe should appear with http://localhost:3142/docs
		await expect(page.getByTestId("quad-docs-iframe")).toHaveAttribute(
			"src",
			"http://localhost:3142/docs",
		);

		// Release first deferred A request so it fails late
		if (firstAResolve) {
			(firstAResolve as () => void)();
		}
		await page.waitForTimeout(300);

		// State must remain online with iframe visible
		await expect(page.getByTestId("quad-docs-iframe")).toBeVisible();
		await expect(page.getByTestId("quad-docs-offline")).not.toBeVisible();
	});
});
