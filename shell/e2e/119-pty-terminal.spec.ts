import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * PTY Terminal E2E — #119
 *
 * Tests the terminal tab management in the Workspace panel.
 * xterm.js canvas is not tested (no actual PTY in Playwright browser).
 * Focus: tab bar UI, tab switching, tab close, skill_workspace_new_session.
 *
 * Out of scope:
 * - tier:2 approval_request → PermissionModal → send_approval_response flow
 *   (mock emits panel_tool_call directly to test tab UI behavior only)
 * - PTY I/O: pty:output / pty:exit events (no real PTY in Playwright)
 *
 * Prerequisites: pnpm tauri dev (Vite serves at localhost:1420)
 */

const FAKE_ROOT = "/var/home/luke/dev";
const FAKE_DIR = `${FAKE_ROOT}/naia-os`;

const FAKE_SESSIONS = [
	{
		dir: "naia-os",
		path: FAKE_DIR,
		branch: "main",
		origin_path: null,
		status: "active",
		progress: { issue: "#119", phase: "build", title: "PTY terminal" },
		recent_file: "shell/src/App.tsx",
		last_change: Math.floor(Date.now() / 1000) - 10,
	},
];

const TAURI_MOCK_SCRIPT = `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};

	window.__TAURI_INTERNALS__.metadata = {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" },
	};

	var callbacks = new Map();
	var nextCbId = 1;
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) {
		var id = nextCbId++;
		callbacks.set(id, function(data) { if (once) callbacks.delete(id); return fn && fn(data); });
		return id;
	};
	window.__TAURI_INTERNALS__.unregisterCallback = function(id) { callbacks.delete(id); };
	window.__TAURI_INTERNALS__.runCallback = function(id, data) { var cb = callbacks.get(id); if (cb) cb(data); };
	window.__TAURI_INTERNALS__.callbacks = callbacks;

	var eventListeners = new Map();
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};

	function emitEvent(event, payload) {
		var handlers = eventListeners.get(event) || [];
		for (var h of handlers) {
			window.__TAURI_INTERNALS__.runCallback(h, { event: event, payload: payload });
		}
	}

	window.__TAURI_INTERNALS__.convertFileSrc = function(p, proto) {
		return (proto || "asset") + "://localhost/" + encodeURIComponent(p);
	};

	window.__NAIA_E2E__ = { emitEvent: emitEvent };

	var fakeSessions = ${JSON.stringify(FAKE_SESSIONS)};
	var nextPtyPid = 10001;

	// Simulate panel_tool_call response from agent
	function buildPanelToolCallResponse(requestId, toolName, args, followUpText) {
		var tcId = "ptc-1";
		return [
			{ type: "panel_tool_call", requestId: requestId, toolCallId: tcId, toolName: toolName, args: args },
			{ type: "text", requestId: requestId, text: followUpText },
			{ type: "finish", requestId: requestId, cost: { cost: 0.001, inputTokens: 10, outputTokens: 20 } },
		];
	}

	// plugin:store mock (required by store plugin)
	var storeData = {};

	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		// Event system
		if (cmd === "plugin:event|listen") {
			if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
			eventListeners.get(args.event).push(args.handler);
			return args.handler;
		}
		if (cmd === "plugin:event|emit") { emitEvent(args.event, args.payload); return null; }
		if (cmd === "plugin:event|unlisten") return;

		// plugin:store
		if (cmd === "plugin:store|load") return 1;
		if (cmd === "plugin:store|get") return [null, false];
		if (cmd === "plugin:store|set") return;
		if (cmd === "plugin:store|delete") return;
		if (cmd === "plugin:store|save") return;

		// Window management
		if (cmd === "plugin:window|get_cursor_position") return null;
		if (cmd === "plugin:window|start_resize_dragging") return null;

		// Misc
		if (cmd === "send_to_agent_command") {
			var msg = JSON.parse(args.message);
			if (msg.type === "panel_tool_result") return; // result already applied to state
			// Regular chat — trigger skill_workspace_new_session tool call
			var requestId = msg.requestId;
			var lastMsg = msg.messages && msg.messages[msg.messages.length - 1];
			// content may be a string or an array of {type,text} blocks (Anthropic format)
			var rawContent = lastMsg && lastMsg.content ? lastMsg.content : "";
			var contentStr = typeof rawContent === "string"
				? rawContent
				: Array.isArray(rawContent)
					? rawContent.map(function(c) { return c.text || ""; }).join(" ")
					: "";
			var content = contentStr.toLowerCase();
			var chunks;
			if (content.indexOf("터미널") !== -1 || content.indexOf("terminal") !== -1) {
				chunks = buildPanelToolCallResponse(requestId, "skill_workspace_new_session",
					{ dir: "${FAKE_DIR}" },
					"터미널을 열었어요! naia-os 디렉토리에 새 터미널 세션을 시작했습니다.");
			} else {
				chunks = [
					{ type: "text", requestId: requestId, text: "안녕하세요!" },
					{ type: "finish", requestId: requestId, cost: { cost: 0.001, inputTokens: 5, outputTokens: 10 } },
				];
			}
			var delay = 100;
			for (var i = 0; i < chunks.length; i++) {
				(function(chunk, d) {
					setTimeout(function() { emitEvent("agent_response", JSON.stringify(chunk)); }, d);
				})(chunks[i], delay);
				delay += 150;
			}
			return;
		}
		if (cmd === "cancel_stream") return;
		if (cmd === "frontend_log") return;
		if (cmd === "list_skills") return [];
		if (cmd === "list_stt_models") return [];

		// Panel
		if (cmd === "panel_list_installed") return [];

		// Workspace commands
		if (cmd === "workspace_get_sessions") return fakeSessions;
		if (cmd === "workspace_list_dirs") return [{ name: "naia-os", path: "${FAKE_DIR}", is_dir: true, children: null }];
		if (cmd === "workspace_get_git_info") return { branch: "main" };
		if (cmd === "workspace_get_progress") return null;
		if (cmd === "workspace_start_watch") return;
		if (cmd === "workspace_stop_watch") return;
		if (cmd === "workspace_set_root") return "${FAKE_ROOT}";
		if (cmd === "workspace_classify_dirs") return [];
		if (cmd === "workspace_read_file") return "// file content";
		if (cmd === "workspace_write_file") return;

		// PTY commands
		if (cmd === "pty_create") {
			var pid = nextPtyPid++;
			return { pty_id: "pty-" + pid, pid: pid };
		}
		if (cmd === "pty_write") return;
		if (cmd === "pty_resize") return;
		if (cmd === "pty_kill") return;

		// send_approval_response (for panel tool results)
		if (cmd === "send_approval_response") return;

		return undefined;
	};
})();
`;

async function openWorkspacePanel(page: Page): Promise<void> {
	const tab = page.locator('button[data-panel-id="workspace"]');
	await expect(tab).toBeVisible({ timeout: 10_000 });
	await tab.click();
	await expect(page.locator(".workspace-panel")).toBeVisible({
		timeout: 5_000,
	});
}

async function sendMessage(page: Page, text: string): Promise<void> {
	const input = page.locator(".chat-input");
	await expect(input).toBeEnabled({ timeout: 5_000 });
	await input.fill(text);
	await input.press("Enter");
	// Wait for response to start streaming
	await page
		.locator(".chat-message.assistant")
		.last()
		.waitFor({ state: "attached", timeout: 8_000 });
}

test.describe("PTY Terminal E2E — #119", () => {
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
			localStorage.setItem(
				"workspace-classified-dirs",
				JSON.stringify([
					{
						name: "naia-os",
						path: "/var/home/luke/dev/naia-os",
						category: "project",
					},
				]),
			);
		});
		await page.goto("/");
		await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
	});

	// T1: Tab bar hidden when no terminals
	test("T1: 터미널 없을 때 탭 바가 표시되지 않음", async ({ page }) => {
		await openWorkspacePanel(page);
		// Tab bar should not exist yet
		await expect(page.locator(".workspace-panel__tab-bar")).not.toBeAttached();
		// Editor slot should be active (no opacity:0 override — no terminals yet)
		await expect(page.locator(".workspace-panel__editor-slot")).not.toHaveCSS(
			"opacity",
			"0",
		);
	});

	// T2: skill_workspace_new_session → tab bar appears
	test("T2: skill_workspace_new_session 호출 후 터미널 탭 등장", async ({
		page,
	}) => {
		await openWorkspacePanel(page);

		// Simulate the agent calling skill_workspace_new_session via chat
		await sendMessage(page, "터미널 열어줘");

		// Wait for tab bar to appear (tool call processed → React state updated)
		await expect(page.locator(".workspace-panel__tab-bar")).toBeVisible({
			timeout: 5_000,
		});

		// "에디터" tab should exist
		const editorTab = page.locator('.workspace-panel__tab:has-text("에디터")');
		await expect(editorTab).toBeVisible();

		// Terminal tab with dir name should exist
		const terminalTab = page.locator(
			'.workspace-panel__tab:has-text("naia-os")',
		);
		await expect(terminalTab).toBeVisible();
	});

	// T3: Terminal tab is active after creation
	test("T3: 터미널 탭 생성 후 터미널 탭이 활성화됨", async ({ page }) => {
		await openWorkspacePanel(page);
		await sendMessage(page, "터미널 열어줘");

		await expect(page.locator(".workspace-panel__tab-bar")).toBeVisible({
			timeout: 5_000,
		});

		// The terminal tab (not editor) should be active
		const activeTab = page.locator(".workspace-panel__tab--active");
		await expect(activeTab).toContainText("naia-os");
	});

	// T4: Click editor tab → editor becomes active
	test("T4: 에디터 탭 클릭 시 에디터 탭이 활성화됨", async ({ page }) => {
		await openWorkspacePanel(page);
		await sendMessage(page, "터미널 열어줘");

		await expect(page.locator(".workspace-panel__tab-bar")).toBeVisible({
			timeout: 5_000,
		});

		// Click editor tab
		await page.locator('.workspace-panel__tab:has-text("에디터")').click();

		// Editor tab should now be active
		const activeTab = page.locator(".workspace-panel__tab--active");
		await expect(activeTab).toContainText("에디터");
	});

	// T5: Click × button → terminal tab removed
	test("T5: × 버튼 클릭 시 터미널 탭 제거, 에디터로 복귀", async ({ page }) => {
		await openWorkspacePanel(page);
		await sendMessage(page, "터미널 열어줘");

		await expect(page.locator(".workspace-panel__tab-bar")).toBeVisible({
			timeout: 5_000,
		});

		// Click the close button on the terminal tab
		await page.locator(".workspace-panel__tab-close").first().click();

		// Tab bar should disappear (no more terminals)
		await expect(page.locator(".workspace-panel__tab-bar")).not.toBeAttached({
			timeout: 3_000,
		});

		// Editor slot should be active (opacity not hidden — activeTab fell back to "editor")
		await expect(page.locator(".workspace-panel__editor-slot")).not.toHaveCSS(
			"opacity",
			"0",
		);
	});
});
