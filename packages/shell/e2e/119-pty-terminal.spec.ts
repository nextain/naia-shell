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

const FAKE_ROOT = "/home/user/dev";
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
						path: "/home/user/dev/naia-os",
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

		// Terminal view toggle (tabs ⇄ grid) lives in the terminal tab bar
		await expect(
			page.locator(".workspace-panel__term-viewtoggle"),
		).toBeVisible();

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

	// T4: Document viewer stays visible alongside the terminal (split layout —
	// the editor is now a permanent top zone, not a tab competing with terminals)
	test("T4: 터미널이 열려도 문서뷰어가 항상 함께 표시됨", async ({ page }) => {
		await openWorkspacePanel(page);
		await sendMessage(page, "터미널 열어줘");

		await expect(page.locator(".workspace-panel__tab-bar")).toBeVisible({
			timeout: 5_000,
		});

		// Both zones coexist: the document viewer (top) and the terminal (bottom).
		await expect(page.locator(".workspace-panel__doc-zone")).toBeVisible();
		await expect(page.locator(".workspace-panel__term-zone")).toBeVisible();
		await expect(page.locator(".workspace-panel__editor-slot")).not.toHaveCSS(
			"opacity",
			"0",
		);
	});

	// T5: Click × button → terminal tab removed, terminal zone empties
	test("T5: × 버튼 클릭 시 터미널 탭 제거, 빈 터미널 영역", async ({
		page,
	}) => {
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

		// Document viewer stays visible (it is a permanent zone, not a fallback tab)
		await expect(page.locator(".workspace-panel__editor-slot")).not.toHaveCSS(
			"opacity",
			"0",
		);
		// Terminal zone shows its empty state
		await expect(page.locator(".workspace-panel__term-empty")).toBeVisible();
	});

	// ── UI reorg layout: home VN · workspace rail · center split · doc tabs ──

	// T6: Home screen uses the immersive visual-novel chat variant
	test("T6: 홈 화면은 VN 몰입 대화 variant", async ({ page }) => {
		// beforeEach lands on home (no panel active)
		await expect(page.locator('.app-root[data-ui-mode="home"]')).toBeAttached();
		await expect(page.locator(".chat-panel--vn")).toBeVisible();
	});

	// T7: Opening the workspace switches the chat to the left-rail variant
	test("T7: 워크스페이스 진입 시 대화창이 좌측 레일 variant", async ({
		page,
	}) => {
		await openWorkspacePanel(page);
		await expect(
			page.locator('.app-root[data-ui-mode="workspace"]'),
		).toBeAttached();
		await expect(page.locator(".chat-panel--rail")).toBeVisible();
	});

	// T8: The conversation rail can be collapsed and re-expanded (ChatPanel stays
	// mounted — verified by the rail toggle not unmounting .chat-panel)
	test("T8: 대화 레일 접기/펼치기 토글", async ({ page }) => {
		await openWorkspacePanel(page);
		const toggle = page.locator(".ws-rail-toggle");
		await expect(toggle).toBeVisible();
		await expect(
			page.locator('.app-root[data-rail-collapsed="false"]'),
		).toBeAttached();
		await toggle.click();
		await expect(
			page.locator('.app-root[data-rail-collapsed="true"]'),
		).toBeAttached();
		// ChatPanel is still mounted while collapsed (single-instance invariant)
		await expect(page.locator(".chat-panel")).toBeAttached();
		await toggle.click();
		await expect(
			page.locator('.app-root[data-rail-collapsed="false"]'),
		).toBeAttached();
	});

	// T9: The center is split into a document viewer (top) + terminal (bottom)
	test("T9: 중앙은 문서뷰어(상)+터미널(하) 분할", async ({ page }) => {
		await openWorkspacePanel(page);
		await expect(page.locator(".workspace-panel__doc-zone")).toBeVisible();
		await expect(page.locator(".workspace-panel__term-zone")).toBeVisible();
		// Document tab bar is present (empty until a document is opened)
		await expect(page.locator(".doc-tab-bar")).toBeVisible();
	});

	// T10: Clicking a sub-agent (session) surfaces its recent file as a doc tab
	test("T10: 서브에이전트 클릭 시 최근 문서가 탭으로 surface", async ({
		page,
	}) => {
		await openWorkspacePanel(page);
		const card = page.locator(".workspace-session-card").first();
		await expect(card).toBeVisible({ timeout: 8_000 });
		await card.click();
		// recent_file "shell/src/App.tsx" → a document tab labeled "App.tsx"
		await expect(page.locator(".doc-tab", { hasText: "App.tsx" })).toBeVisible({
			timeout: 5_000,
		});
	});

	// T11: A chat hidden in home mode must not leave the workspace rail collapsed
	// to 0 height (the height toggle is display:none in workspace). Regression for
	// the chatVisible × --hidden interaction.
	test("T11: 홈에서 채팅 숨겨도 워크스페이스 레일은 보임", async ({ page }) => {
		// Wait for the splash to clear so it doesn't intercept the toggle click
		await page
			.locator(".splash-screen")
			.waitFor({ state: "detached", timeout: 15_000 })
			.catch(() => {});
		// Hide the chat in home (the toggle exists here, not in workspace)
		await page.locator(".naia-chat-toggle").click();
		await expect(page.locator(".naia-chat-wrapper--hidden")).toBeAttached();
		// Switch to workspace — the rail must stay visible (not height:0)
		await openWorkspacePanel(page);
		const wrapper = page.locator(".naia-chat-wrapper");
		await expect(wrapper).toBeVisible();
		const box = await wrapper.boundingBox();
		expect(box?.height ?? 0).toBeGreaterThan(40);
		await expect(page.locator(".chat-panel--rail")).toBeVisible();
	});
});
