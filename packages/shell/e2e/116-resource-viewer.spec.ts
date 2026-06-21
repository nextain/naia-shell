import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * #116 Resource Viewer E2E — image / CSV / log viewer + chat file deeplinks.
 *
 * Prerequisites:
 *   pnpm run dev  (Vite serves UI at localhost:1420)
 *
 * Approach:
 *   Playwright opens localhost:1420. Tauri IPC mocked via addInitScript.
 *   workspace_read_file returns fake CSV/log content.
 *   Agent responses are injected via simulated agent_response events.
 */

const FAKE_ROOT = "/home/user/dev";

const FAKE_CSV =
	"name,score,city\nAlice,95,Seoul\nBob,80,Busan\nCharlie,70,Incheon";
const FAKE_LOG =
	"2026-03-22 INFO: server started\n2026-03-22 ERROR: connection refused\n2026-03-22 OK: reconnected";

const FAKE_DIRS = [
	{
		name: "naia-os",
		path: `${FAKE_ROOT}/naia-os`,
		is_dir: true,
		children: null,
	},
	{
		name: "data.csv",
		path: `${FAKE_ROOT}/data.csv`,
		is_dir: false,
		children: null,
	},
	{
		name: "app.log",
		path: `${FAKE_ROOT}/app.log`,
		is_dir: false,
		children: null,
	},
	{
		name: "screenshot.png",
		path: `${FAKE_ROOT}/screenshot.png`,
		is_dir: false,
		children: null,
	},
	{
		name: "report.pdf",
		path: `${FAKE_ROOT}/report.pdf`,
		is_dir: false,
		children: null,
	},
	{
		name: "AGENTS.md",
		path: `${FAKE_ROOT}/AGENTS.md`,
		is_dir: false,
		children: null,
	},
];

const FAKE_SESSIONS = [
	{
		dir: "naia-os",
		path: `${FAKE_ROOT}/naia-os`,
		branch: "main",
		status: "active",
		progress: { issue: "#116", phase: "e2e", title: "resource viewer" },
		recent_file: null,
		last_change: Math.floor(Date.now() / 1000) - 5,
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
		for (var i = 0; i < handlers.length; i++) {
			window.__TAURI_INTERNALS__.runCallback(handlers[i], { event: event, payload: payload });
		}
	}

	window.__TAURI_INTERNALS__.convertFileSrc = function(p, proto) {
		return (proto || "asset") + "://localhost/" + encodeURIComponent(p);
	};

	window.__NAIA_E2E__ = { emitEvent: emitEvent };

	var fakeDirs = ${JSON.stringify(FAKE_DIRS)};
	var fakeSessions = ${JSON.stringify(FAKE_SESSIONS)};
	var fakeCsv = ${JSON.stringify(FAKE_CSV)};
	var fakeLog = ${JSON.stringify(FAKE_LOG)};

	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		if (typeof window.__recordInvoke__ === "function") window.__recordInvoke__(cmd);
		if (cmd === "plugin:event|listen") {
			if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
			eventListeners.get(args.event).push(args.handler);
			return args.handler;
		}
		if (cmd === "plugin:event|emit") { emitEvent(args.event, args.payload); return null; }
		if (cmd === "plugin:event|unlisten") return;
		if (cmd === "plugin:window|get_cursor_position" || cmd === "plugin:window|start_resize_dragging") return null;
		// plugin-store: load returns a fake RID; get returns [value, exists] tuple; set/delete are void
		if (cmd === "plugin:store|load") return 1;
		if (cmd === "plugin:store|get") return [null, false];
		if (cmd === "plugin:store|set" || cmd === "plugin:store|delete" || cmd === "plugin:store|save") return null;
		// Other optional commands
		if (cmd === "restart_gateway" || cmd === "browser_check" || cmd === "browser_embed_show" || cmd === "browser_embed_close") return null;
		if (cmd === "memory_get_all_facts" || cmd === "read_openclaw_memory_files") return [];
		if (cmd === "get_progress_data") return { events: [], stats: { totalCost: 0, messageCount: 0, toolCount: 0, errorCount: 0 } };
		if (cmd === "send_to_agent_command") {
			var req = JSON.parse(args.message);
			var rid = req.requestId;
			var lastMsg = req.messages[req.messages.length - 1];
			var text = (lastMsg.content || "").toLowerCase().indexOf("deeplink") !== -1
				? "수정한 파일: /home/user/dev/naia-os/shell/src/App.tsx 입니다."
				: "안녕하세요!";
			setTimeout(function() {
				emitEvent("agent_response", JSON.stringify({ type: "text", requestId: rid, text: text }));
			}, 200);
			setTimeout(function() {
				emitEvent("agent_response", JSON.stringify({ type: "finish", requestId: rid, cost: { cost: 0, inputTokens: 5, outputTokens: 10 } }));
			}, 400);
			return;
		}
		if (cmd === "cancel_stream") return;
		if (cmd === "send_approval_response") return;
		if (cmd === "frontend_log") return;
		if (cmd === "list_skills") return [];
		if (cmd === "list_stt_models") return [];
		if (cmd === "panel_list_installed") return [];
		if (cmd === "workspace_get_sessions") return fakeSessions;
		if (cmd === "workspace_list_dirs") return fakeDirs;
		if (cmd === "workspace_get_git_info") return { branch: "main" };
		if (cmd === "workspace_get_progress") return null;
		if (cmd === "workspace_start_watch") return;
		if (cmd === "workspace_stop_watch") return;
		if (cmd === "workspace_classify_dirs") return [];
		if (cmd === "workspace_read_file") {
			var path = (args && args.path) || "";
			if (path.endsWith(".csv")) return fakeCsv;
			if (path.endsWith(".log")) return fakeLog;
			return "// file: " + path;
		}
		if (cmd === "workspace_write_file") return;
		// Image/PDF bytes — single-pixel transparent PNG (sufficient for src-set check)
		if (cmd === "workspace_read_file_bytes") return [137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,2,0,0,0,144,119,83,222,0,0,0,12,73,68,65,84,8,215,99,248,207,192,0,0,0,2,0,1,226,33,188,51,0,0,0,0,73,69,78,68,174,66,96,130];
		if (cmd === "workspace_discover_skills") return [];
		if (cmd === "workspace_read_skill_content") return "";
		if (cmd === "workspace_set_root") return (args && args.root) || "";
		if (cmd === "workspace_load_project_index") return null;
		if (cmd === "list_naia_assets") return [];
		if (cmd === "list_audio_output_devices") return [];
		if (cmd === "list_audio_input_devices") return [];
		if (cmd === "sync_gateway_config") return null;
		if (cmd === "read_naia_config") return null;
		if (cmd === "browser_wv_hide") return null;
		if (cmd === "browser_wv_show") return null;
		if (cmd === "plugin:app|version") return "0.1.3";
		if (cmd === "plugin:updater|check") return null;
		if (cmd === "plugin:window|show") return null;
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

async function clickFileInTree(page: Page, name: string): Promise<void> {
	await expect(page.locator(".workspace-tree")).toBeVisible({ timeout: 5_000 });
	const node = page
		.locator(".workspace-tree__node--file")
		.filter({ hasText: name });
	await expect(node).toBeVisible({ timeout: 5_000 });
	await node.click();
}

// ── Viewer tests ──────────────────────────────────────────────────────────────

test.describe("Resource Viewer — Editor (#116)", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(TAURI_MOCK_SCRIPT);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });
		await page.addInitScript(() => {
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					provider: "anthropic",
					model: "claude-opus-4-6",
					apiKey: "e2e-mock-key",
					locale: "ko",
					onboardingComplete: true,
				}),
			);
			localStorage.setItem("naia-adk-path", "/tmp/mock-naia-adk-workspace");
			localStorage.removeItem("workspace-classified-dirs");
		});
		await page.goto("/");
		await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
	});

	// ── V1: CSV 뷰어 ──────────────────────────────────────────────────────

	test("V1: .csv 파일 선택 시 테이블 뷰어 표시", async ({ page }) => {
		await openWorkspacePanel(page);
		await clickFileInTree(page, "data.csv");

		// File header visible
		await expect(page.locator(".workspace-editor__filename")).toContainText(
			"data.csv",
			{
				timeout: 5_000,
			},
		);

		// Table renders
		await expect(page.locator(".workspace-editor__csv-table")).toBeVisible({
			timeout: 5_000,
		});

		// Header row
		await expect(
			page.locator(".workspace-editor__csv-th").filter({ hasText: "name" }),
		).toBeVisible();
		await expect(
			page.locator(".workspace-editor__csv-th").filter({ hasText: "score" }),
		).toBeVisible();

		// Data rows
		await expect(
			page.locator(".workspace-editor__csv-td").filter({ hasText: "Alice" }),
		).toBeVisible();
		await expect(
			page.locator(".workspace-editor__csv-td").filter({ hasText: "Bob" }),
		).toBeVisible();
	});

	test("V1-b: CSV 헤더 클릭 시 정렬 표시자 나타남", async ({ page }) => {
		await openWorkspacePanel(page);
		await clickFileInTree(page, "data.csv");
		await expect(page.locator(".workspace-editor__csv-table")).toBeVisible({
			timeout: 5_000,
		});

		// Click name header → ascending sort
		await page
			.locator(".workspace-editor__csv-th")
			.filter({ hasText: "name" })
			.click();
		await expect(
			page.locator(".workspace-editor__csv-th").filter({ hasText: "name ▲" }),
		).toBeVisible();

		// Click again → descending
		await page
			.locator(".workspace-editor__csv-th")
			.filter({ hasText: "name ▲" })
			.click();
		await expect(
			page.locator(".workspace-editor__csv-th").filter({ hasText: "name ▼" }),
		).toBeVisible();
	});

	test("V1-c: CSV 파일에 편집/미리보기 버튼 없음 (CodeMirror 미사용)", async ({
		page,
	}) => {
		await openWorkspacePanel(page);
		await clickFileInTree(page, "data.csv");
		await expect(page.locator(".workspace-editor__csv-table")).toBeVisible({
			timeout: 5_000,
		});

		// No markdown view-mode buttons
		await expect(
			page.locator(".workspace-editor__view-btn").filter({ hasText: "편집" }),
		).not.toBeVisible();
		await expect(
			page
				.locator(".workspace-editor__view-btn")
				.filter({ hasText: "미리보기" }),
		).not.toBeVisible();
	});

	// ── V2: Log 뷰어 ──────────────────────────────────────────────────────

	test("V2: .log 파일 선택 시 로그 뷰어 표시", async ({ page }) => {
		await openWorkspacePanel(page);
		await clickFileInTree(page, "app.log");

		await expect(page.locator(".workspace-editor__filename")).toContainText(
			"app.log",
			{
				timeout: 5_000,
			},
		);
		await expect(page.locator(".workspace-editor__log-pre")).toBeVisible({
			timeout: 5_000,
		});
		await expect(page.locator(".workspace-editor__log-pre")).toContainText(
			"server started",
		);
		await expect(page.locator(".workspace-editor__log-pre")).toContainText(
			"connection refused",
		);
	});

	// ── V3: 이미지 뷰어 ───────────────────────────────────────────────────

	test("V3: .png 파일 선택 시 이미지 뷰어 표시 (workspace_read_file 미호출)", async ({
		page,
	}) => {
		// Spy on invoke calls to verify workspace_read_file is NOT called for images
		const invokeCalls: string[] = [];
		await page.exposeFunction("__recordInvoke__", (cmd: string) => {
			invokeCalls.push(cmd);
		});

		await openWorkspacePanel(page);
		await clickFileInTree(page, "screenshot.png");

		await expect(page.locator(".workspace-editor__filename")).toContainText(
			"screenshot.png",
			{
				timeout: 5_000,
			},
		);
		await expect(page.locator(".workspace-editor__image")).toBeVisible({
			timeout: 5_000,
		});

		// img src is a blob: URL (image bytes loaded via workspace_read_file_bytes)
		const imgSrc = await page
			.locator(".workspace-editor__image")
			.getAttribute("src");
		expect(imgSrc).toMatch(/^blob:/);

		// workspace_read_file must NOT have been called for an image file
		expect(invokeCalls).not.toContain("workspace_read_file");
	});

	test("V3-b: 이미지 파일에 편집/미리보기 버튼 없음", async ({ page }) => {
		await openWorkspacePanel(page);
		await clickFileInTree(page, "screenshot.png");
		await expect(page.locator(".workspace-editor__image")).toBeVisible({
			timeout: 5_000,
		});

		await expect(
			page.locator(".workspace-editor__view-btn").filter({ hasText: "편집" }),
		).not.toBeVisible();
	});

	// ── V4: PDF 뷰어 ────────────────────────────────────────────────────

	test("V4: .pdf 파일 선택 시 PDF 뷰어 표시 (workspace_read_file 미호출)", async ({
		page,
	}) => {
		const invokeCalls: string[] = [];
		await page.exposeFunction("__recordInvoke__", (cmd: string) => {
			invokeCalls.push(cmd);
		});

		await openWorkspacePanel(page);
		await clickFileInTree(page, "report.pdf");

		await expect(page.locator(".workspace-editor__filename")).toContainText(
			"report.pdf",
			{
				timeout: 5_000,
			},
		);
		await expect(page.locator(".workspace-editor__pdf-viewer")).toBeVisible({
			timeout: 5_000,
		});

		// workspace_read_file must NOT have been called for a PDF file
		expect(invokeCalls).not.toContain("workspace_read_file");
	});

	test("V4-b: PDF 파일에 편집/미리보기 버튼 없음", async ({ page }) => {
		await openWorkspacePanel(page);
		await clickFileInTree(page, "report.pdf");
		await expect(page.locator(".workspace-editor__filename")).toContainText(
			"report.pdf",
			{
				timeout: 5_000,
			},
		);

		await expect(
			page.locator(".workspace-editor__view-btn").filter({ hasText: "편집" }),
		).not.toBeVisible();
		await expect(
			page
				.locator(".workspace-editor__view-btn")
				.filter({ hasText: "미리보기" }),
		).not.toBeVisible();
	});
});

// ── Chat deeplink tests ──────────────────────────────────────────────────────

test.describe("Chat File Deeplinks (#116)", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(TAURI_MOCK_SCRIPT);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });
		await page.addInitScript(() => {
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					provider: "anthropic",
					model: "claude-opus-4-6",
					apiKey: "e2e-mock-key",
					locale: "ko",
					onboardingComplete: true,
				}),
			);
			localStorage.setItem("naia-adk-path", "/tmp/mock-naia-adk-workspace");
			localStorage.removeItem("workspace-classified-dirs");
		});
		await page.goto("/");
		await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
	});

	test("D1: 어시스턴트 응답에 절대경로 포함 시 deeplink 버튼 렌더링", async ({
		page,
	}) => {
		// Send a message that triggers the mock to respond with a file path
		const input = page.locator(".chat-input");
		await expect(input).toBeEnabled({ timeout: 5_000 });
		await input.fill("deeplink 테스트");
		await input.press("Enter");

		// Wait for assistant response containing a deeplink button
		await expect(page.locator(".chat-file-deeplink")).toBeVisible({
			timeout: 8_000,
		});

		const btn = page.locator(".chat-file-deeplink").first();
		await expect(btn).toContainText("App.tsx");
	});

	test("D2: deeplink 클릭 시 워크스페이스 패널 활성화", async ({ page }) => {
		const input = page.locator(".chat-input");
		await expect(input).toBeEnabled({ timeout: 5_000 });
		await input.fill("deeplink 테스트");
		await input.press("Enter");

		await expect(page.locator(".chat-file-deeplink")).toBeVisible({
			timeout: 8_000,
		});

		// Workspace panel should NOT be the active panel yet
		// (keepAlive panels are always mounted; check active slot instead of visibility)
		await expect(
			page.locator(".content-panel__slot--active .workspace-panel"),
		).not.toBeVisible();

		// Click the deeplink
		await page.locator(".chat-file-deeplink").first().click();

		// Workspace panel should now be in the active slot
		await expect(
			page.locator(".content-panel__slot--active .workspace-panel"),
		).toBeVisible({ timeout: 5_000 });
	});
});
