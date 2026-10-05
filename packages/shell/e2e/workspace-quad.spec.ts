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
		if (cmd === "write_naia_ui_config") {
			try {
				var jsonStr = typeof args.json === "string" ? args.json : JSON.stringify(args.json || {});
				sessionStorage.setItem("__mock_ui_config__", jsonStr);
			} catch (e) {}
			return true;
		}
		if (cmd === "read_naia_ui_config") {
			var saved = sessionStorage.getItem("__mock_ui_config__");
			return saved || "{}";
		}
		if (cmd === "read_naia_config") return JSON.stringify({ onboardingComplete: true });
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

		// Wait until checking indicator disappears and offline alert is gone (item 4)
		await expect(page.getByTestId("quad-docs-checking")).not.toBeVisible({ timeout: 10_000 });
		await expect(offline).not.toBeVisible({ timeout: 10_000 });

		// Iframe should be visible with the new URL
		await expect(page.getByTestId("quad-docs-iframe")).toBeVisible();
		await expect(page.getByTestId("quad-docs-iframe")).toHaveAttribute(
			"src",
			"http://127.0.0.1:8899/offline-test",
		);
	});

	test("handles A->B->A route race: second A success is preserved against delayed first A failure", async ({
		page,
	}) => {
		let releaseFirstAFetch: (() => void) | null = null;
		let notifyFirstAFetchReceived: () => void = () => {};
		const firstAFetchEntered = new Promise<void>((resolve) => {
			notifyFirstAFetchReceived = resolve;
		});
		let aFetchCount = 0;

		await page.route("http://127.0.0.1:8896/temp-b**", (route) => {
			if (route.request().resourceType() === "fetch") {
				return route.fulfill({ status: 200, body: "OK" });
			}
			return route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>Temp B OK</body></html>" });
		});
		await page.route("http://127.0.0.1:8896/**", (route) => {
			if (route.request().resourceType() === "fetch") {
				return route.fulfill({ status: 200, body: "OK" });
			}
			return route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>Board</body></html>" });
		});

		await openWorkspace(page);

		await page.unroute("**/localhost:3142/**");
		await page.route("**/localhost:3142/**", async (route) => {
			const resourceType = route.request().resourceType();
			if (resourceType === "document") {
				// iframe document requests always fulfill immediately with small HTML
				return route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>Docs A OK</body></html>" });
			}
			if (resourceType === "fetch") {
				aFetchCount++;
				if (aFetchCount === 1) {
					// Defer only the first A server health check fetch
					notifyFirstAFetchReceived();
					await new Promise<void>((resolve) => {
						releaseFirstAFetch = resolve;
					});
					return route.abort();
				}
				// Second A server health check fetch fulfills immediately
				return route.fulfill({ status: 200, body: "OK" });
			}
			return route.fulfill({ status: 200, body: "OK" });
		});

		// Trigger fresh probe for current A URL so first A is deferred
		await page.getByTestId("quad-docs-reload").click();

		// 1. Wait until first A's server probe fetch has entered route handler (pending state)
		await firstAFetchEntered;
		expect(releaseFirstAFetch).not.toBeNull();

		// 2. Switch to B
		await page.getByTestId("quad-docs-change-url").click();
		await page.getByTestId("quad-docs-url-input").fill("http://127.0.0.1:8896/temp-b");
		await page.getByTestId("quad-docs-url-save").click();

		await expect(page.getByTestId("quad-docs-iframe")).toHaveAttribute(
			"src",
			"http://127.0.0.1:8896/temp-b",
		);

		// 3. Switch back to A (second A)
		await page.getByTestId("quad-docs-change-url").click();
		await page.getByTestId("quad-docs-url-input").fill("http://localhost:3142/docs");
		await page.getByTestId("quad-docs-url-save").click();

		// 4. Wait for second A's probe to complete: checking indicator gone, offline absent, iframe visible
		await expect(page.getByTestId("quad-docs-checking")).not.toBeVisible({ timeout: 10_000 });
		await expect(page.getByTestId("quad-docs-offline")).not.toBeVisible();
		await expect(page.getByTestId("quad-docs-iframe")).toBeVisible();
		await expect(page.getByTestId("quad-docs-iframe")).toHaveAttribute(
			"src",
			"http://localhost:3142/docs",
		);

		// 5. Release first deferred A request so it fails late
		(releaseFirstAFetch as unknown as () => void)();
		await page.waitForTimeout(300);

		// 6. Assert that after delayed first A failure, checking and offline are still absent, and iframe remains visible
		await expect(page.getByTestId("quad-docs-checking")).not.toBeVisible();
		await expect(page.getByTestId("quad-docs-offline")).not.toBeVisible();
		await expect(page.getByTestId("quad-docs-iframe")).toBeVisible();
		await expect(page.getByTestId("quad-docs-iframe")).toHaveAttribute(
			"src",
			"http://localhost:3142/docs",
		);
	});

	test("persists edited pane URL across page.reload() (g)", async ({ page }) => {
		await page.route("http://localhost:5000/**", (route) =>
			route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>Custom Reload OK</body></html>" }),
		);

		await openWorkspace(page);

		// Edit docs URL and save
		await page.getByTestId("quad-docs-change-url").click();
		const input = page.getByTestId("quad-docs-url-input");
		await expect(input).toBeVisible();
		await input.fill("http://localhost:5000/reloaded-docs");
		await page.getByTestId("quad-docs-url-save").click();
		await expect(input).not.toBeVisible();
		await expect(page.getByTestId("quad-docs-iframe")).toHaveAttribute(
			"src",
			"http://localhost:5000/reloaded-docs",
		);

		// Reload the page
		await page.reload();
		await expect(page.locator(".chat-app")).toBeVisible({ timeout: 10_000 });

		// Reopen workspace
		await openWorkspace(page);

		// Assert restored URL in docs iframe
		await expect(page.getByTestId("quad-docs-iframe")).toHaveAttribute(
			"src",
			"http://localhost:5000/reloaded-docs",
		);
	});
});
