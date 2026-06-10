import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * skill_workspace_send_to_session E2E — #120
 *
 * Tests that pty_write is invoked with the correct pty_id and data
 * when the agent calls skill_workspace_send_to_session.
 *
 * Out of scope:
 * - tier:2 approval_request → PermissionModal flow (mock bypasses it)
 * - actual PTY I/O (no real PTY in Playwright)
 *
 * Prerequisites: pnpm tauri dev (Vite serves at localhost:1420)
 */

const FAKE_ROOT = "/var/home/luke/dev";
const FAKE_DIR = `${FAKE_ROOT}/naia-os`;
const SEND_TEXT = "ls -la\n";

const FAKE_SESSIONS = [
	{
		dir: "naia-os",
		path: FAKE_DIR,
		branch: "main",
		origin_path: null,
		status: "active",
		progress: { issue: "#120", phase: "build", title: "send_to_session" },
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

	window.__NAIA_E2E__ = {
		emitEvent: emitEvent,
		lastPtyWriteCall: null,  // { pty_id, data } — set by pty_write mock
		lastCreatedPtyId: null,  // pty_id from pty_create mock
	};

	var fakeSessions = ${JSON.stringify(FAKE_SESSIONS)};
	var nextPtyPid = 20001;

	function buildPanelToolCallResponse(requestId, toolName, args, followUpText) {
		var tcId = "ptc-1";
		return [
			{ type: "panel_tool_call", requestId: requestId, toolCallId: tcId, toolName: toolName, args: args },
			{ type: "text", requestId: requestId, text: followUpText },
			{ type: "finish", requestId: requestId, cost: { cost: 0.001, inputTokens: 10, outputTokens: 20 } },
		];
	}

	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		if (cmd === "plugin:event|listen") {
			if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
			eventListeners.get(args.event).push(args.handler);
			return args.handler;
		}
		if (cmd === "plugin:event|emit") { emitEvent(args.event, args.payload); return null; }
		if (cmd === "plugin:event|unlisten") return;

		if (cmd === "plugin:store|load") return 1;
		if (cmd === "plugin:store|get") return [null, false];
		if (cmd === "plugin:store|set") return;
		if (cmd === "plugin:store|delete") return;
		if (cmd === "plugin:store|save") return;

		if (cmd === "plugin:window|get_cursor_position") return null;
		if (cmd === "plugin:window|start_resize_dragging") return null;

		if (cmd === "send_to_agent_command") {
			var msg = JSON.parse(args.message);
			if (msg.type === "panel_tool_result") return;
			var requestId = msg.requestId;
			var lastMsg = msg.messages && msg.messages[msg.messages.length - 1];
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
					"터미널을 열었어요!");
			} else if (content.indexOf("stdin") !== -1 || content.indexOf("send") !== -1) {
				chunks = buildPanelToolCallResponse(requestId, "skill_workspace_send_to_session",
					{ dir: "${FAKE_DIR}", text: ${JSON.stringify(SEND_TEXT)} },
					"터미널에 입력을 전송했어요!");
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
		if (cmd === "panel_list_installed") return [];

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

		if (cmd === "pty_create") {
			var pid = nextPtyPid++;
			var pty_id = "pty-" + pid;
			window.__NAIA_E2E__.lastCreatedPtyId = pty_id;
			return { pty_id: pty_id, pid: pid };
		}
		if (cmd === "pty_write") {
			window.__NAIA_E2E__.lastPtyWriteCall = { pty_id: args.pty_id, data: args.data };
			return;
		}
		if (cmd === "pty_resize") return;
		if (cmd === "pty_kill") return;
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
	await page
		.locator(".chat-message.assistant")
		.last()
		.waitFor({ state: "attached", timeout: 8_000 });
}

test.describe("skill_workspace_send_to_session E2E — #120", () => {
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

	// SS1: pty_write called with correct pty_id and data
	test("SS1: skill_workspace_send_to_session → pty_write가 올바른 pty_id와 data로 호출됨", async ({
		page,
	}) => {
		await openWorkspacePanel(page);

		// Step 1: Create a terminal session (establishes dir → pty_id mapping)
		await sendMessage(page, "터미널 열어줘");
		await expect(page.locator(".workspace-panel__tab-bar")).toBeVisible({
			timeout: 5_000,
		});

		// Step 2: Trigger skill_workspace_send_to_session for the same dir
		await sendMessage(page, "stdin 보내줘");

		// Step 3: Wait for pty_write to be recorded by the mock
		await page.waitForFunction(
			() => (window as any).__NAIA_E2E__?.lastPtyWriteCall !== null,
			{ timeout: 5_000 },
		);

		// Step 4: Assert pty_write received the correct pty_id (from the created terminal)
		const ptyWriteCall = await page.evaluate(
			() => (window as any).__NAIA_E2E__?.lastPtyWriteCall,
		);
		const createdPtyId = await page.evaluate(
			() => (window as any).__NAIA_E2E__?.lastCreatedPtyId,
		);

		expect(ptyWriteCall).not.toBeNull();
		expect(ptyWriteCall.pty_id).toBe(createdPtyId);
		expect(ptyWriteCall.data).toBe(SEND_TEXT);
	});
});
