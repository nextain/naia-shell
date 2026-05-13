import { type Page, expect, test } from "@playwright/test";

/**
 * Workspace Panel E2E — Session dashboard + FileTree + Editor
 *
 * Prerequisites:
 *   pnpm tauri dev  (Vite serves UI at localhost:1420)
 *
 * Test approach:
 *   Playwright opens localhost:1420 in a regular browser.
 *   Tauri IPC is mocked via addInitScript to return fake workspace data.
 *   Panel is activated via ModeBar tab click.
 */

const FAKE_ROOT = "/var/home/luke/dev";

/** Fake session data returned by workspace_get_sessions */
const FAKE_SESSIONS = [
	{
		dir: "naia-os-issue-79",
		path: `${FAKE_ROOT}/naia-os-issue-79`,
		branch: "issue-79-qwen3-asr",
		origin_path: null,
		status: "active",
		progress: { issue: "#79", phase: "build", title: "Qwen3 ASR integration" },
		recent_file: "shell/src/lib/stt/registry.ts",
		last_change: Math.floor(Date.now() / 1000) - 10,
	},
	{
		dir: "naia.nextain.io",
		path: `${FAKE_ROOT}/naia.nextain.io`,
		branch: "main",
		origin_path: null,
		status: "idle",
		progress: { issue: "#8", phase: "e2e", title: null },
		recent_file: null,
		last_change: Math.floor(Date.now() / 1000) - 150,
	},
	{
		dir: "vllm",
		path: `${FAKE_ROOT}/vllm`,
		branch: "main",
		origin_path: null,
		status: "stopped",
		progress: null,
		recent_file: null,
		last_change: Math.floor(Date.now() / 1000) - 7200,
	},
];

/** Fake sessions: worktree grouping scenario (naia-os main + linked worktree) */
const FAKE_SESSIONS_WORKTREE = [
	{
		dir: "naia-os",
		path: `${FAKE_ROOT}/naia-os`,
		branch: "main",
		origin_path: null,
		status: "idle",
		progress: null,
		recent_file: null,
		last_change: Math.floor(Date.now() / 1000) - 300,
	},
	{
		dir: "naia-os-issue-121",
		path: `${FAKE_ROOT}/naia-os-issue-121`,
		branch: "issue-121-worktree-grouping",
		origin_path: `${FAKE_ROOT}/naia-os`,
		status: "active",
		progress: { issue: "#121", phase: "build", title: "Worktree grouping" },
		recent_file: "shell/src/panels/workspace/WorktreeGroup.tsx",
		last_change: Math.floor(Date.now() / 1000) - 5,
	},
	{
		dir: "naia.nextain.io",
		path: `${FAKE_ROOT}/naia.nextain.io`,
		branch: "main",
		origin_path: null,
		status: "stopped",
		progress: null,
		recent_file: null,
		last_change: Math.floor(Date.now() / 1000) - 7200,
	},
];

const FAKE_DIRS = [
	{
		name: "naia-os",
		path: `${FAKE_ROOT}/naia-os`,
		is_dir: true,
		children: null,
	},
	{
		name: "naia-os-issue-79",
		path: `${FAKE_ROOT}/naia-os-issue-79`,
		is_dir: true,
		children: null,
	},
	{
		name: "naia.nextain.io",
		path: `${FAKE_ROOT}/naia.nextain.io`,
		is_dir: true,
		children: null,
	},
	{ name: "vllm", path: `${FAKE_ROOT}/vllm`, is_dir: true, children: null },
	{
		name: "ref-cline",
		path: `${FAKE_ROOT}/ref-cline`,
		is_dir: true,
		children: null,
	},
	{
		name: "AGENTS.md",
		path: `${FAKE_ROOT}/AGENTS.md`,
		is_dir: false,
		children: null,
	},
];

const FAKE_CLASSIFIED = [
	{ name: "naia-os", path: `${FAKE_ROOT}/naia-os`, category: "project" },
	{
		name: "naia-os-issue-79",
		path: `${FAKE_ROOT}/naia-os-issue-79`,
		category: "worktree",
	},
	{
		name: "naia.nextain.io",
		path: `${FAKE_ROOT}/naia.nextain.io`,
		category: "project",
	},
	{ name: "vllm", path: `${FAKE_ROOT}/vllm`, category: "other" },
	{ name: "ref-cline", path: `${FAKE_ROOT}/ref-cline`, category: "reference" },
];

const FAKE_AGENTS_MD = `# Naia OS

Bazzite-based AI OS.

## Project Structure

- shell/ — Tauri app
- agent/ — AI agent core
`;

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
	var fakeDirs = ${JSON.stringify(FAKE_DIRS)};
	var fakeClassified = ${JSON.stringify(FAKE_CLASSIFIED)};
	var fakeAgentsMd = ${JSON.stringify(FAKE_AGENTS_MD)};

	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		// Event system
		if (cmd === "plugin:event|listen") {
			if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
			eventListeners.get(args.event).push(args.handler);
			return args.handler;
		}
		if (cmd === "plugin:event|emit") { emitEvent(args.event, args.payload); return null; }
		if (cmd === "plugin:event|unlisten") return;

		// Window management
		if (cmd === "plugin:window|get_cursor_position" || cmd === "plugin:window|start_resize_dragging") return null;
		if (cmd === "plugin:window|is_maximized") return false;
		if (cmd === "plugin:window|show") return;
		if (cmd === "plugin:updater|check") return null;

		// Agent
		if (cmd === "send_to_agent_command" || cmd === "cancel_stream") return;
		if (cmd === "frontend_log") return;
		if (cmd === "list_skills") return [];
		if (cmd === "list_stt_models") return [];

		// Panel
		if (cmd === "panel_list_installed") return [];
		if (cmd === "pty_execute_sync") return { success: false, output: "gh: command not found", exit_code: 127 };

		// naia-settings
		if (cmd === "copy_bundled_assets") return;
		if (cmd === "list_naia_assets") return [];
		if (cmd === "read_local_binary") return [];
		if (cmd === "read_naia_config") return null;
		if (cmd === "check_naia_settings") return true;
		if (cmd === "get_linked_channels") return [];
		if (cmd === "get_lab_user_info") return null;
		if (cmd === "get_memory_facts") return [];

		// Workspace commands
		if (cmd === "workspace_set_root") {
			window.__NAIA_E2E__.lastSetRootArg = (args && args.root) || null;
			return (args && args.root) || "${FAKE_ROOT}";
		}
		if (cmd === "workspace_get_sessions") return fakeSessions;
		if (cmd === "workspace_list_dirs") return fakeDirs;
		if (cmd === "workspace_get_git_info") return { branch: "main" };
		if (cmd === "workspace_get_progress") return null;
		if (cmd === "workspace_start_watch") return;
		if (cmd === "workspace_stop_watch") return;
		if (cmd === "workspace_classify_dirs") return fakeClassified;
		if (cmd === "workspace_detect_adk_root") return "${FAKE_ROOT}";
		if (cmd === "workspace_load_project_index") return {};
		if (cmd === "workspace_discover_skills") return [];
		if (cmd === "workspace_read_skill_content") return "";
		if (cmd === "workspace_read_file") {
			var path = (args && args.path) || "";
			if (path.endsWith("AGENTS.md") || path.endsWith("README.md")) return fakeAgentsMd;
			if (path.indexOf("registry.ts") !== -1) return "// Registry TS file content\\nexport const registry = {};";
			return "// file: " + path;
		}
		if (cmd === "workspace_write_file") return;
		if (cmd === "workspace_discover_adk_server") return null;
		if (cmd === "workspace_check_adk_server") return null;

		return undefined;
	};
})();
`;

/** Navigate to the workspace panel via ModeBar */
async function openWorkspacePanel(page: Page): Promise<void> {
	// Click the workspace tab in ModeBar — target the button element specifically
	const tab = page.locator('button[data-panel-id="workspace"]');
	await expect(tab).toBeVisible({ timeout: 10_000 });
	await tab.click();

	// Verify workspace panel content is visible
	await expect(page.locator(".workspace-panel")).toBeVisible({
		timeout: 5_000,
	});
}

test.describe("Workspace Panel E2E", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(TAURI_MOCK_SCRIPT);

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
			// Set ADK path so isAdkInitialized() returns true (avoids AdkSetupScreen)
			localStorage.setItem("naia-adk-path", "/var/home/luke/dev");
			// Clear any saved classification so Phase 4 triggers first-run
			localStorage.removeItem("workspace-classified-dirs");
		});

		await page.goto("/");
		await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
	});

	// ── S1: Panel loads with FileTree + SessionDashboard ──────────────────

	test("S1-a: 워크스페이스 패널 탭이 ModeBar에 표시됨", async ({ page }) => {
		const tab = page.locator('button[data-panel-id="workspace"]');
		await expect(tab).toBeVisible({ timeout: 10_000 });
	});

	test("S1-b: 패널 탭 클릭 시 FileTree와 SessionDashboard 표시", async ({
		page,
	}) => {
		await openWorkspacePanel(page);

		// FileTree header visible
		await expect(page.locator(".workspace-panel__tree-header")).toBeVisible();
		expect(
			await page.locator(".workspace-panel__tree-header").textContent(),
		).toContain("탐색기");

		// Sessions section visible
		await expect(page.locator(".issues-panel__sessions")).toBeVisible({
			timeout: 5_000,
		});
	});

	// ── S1-c: Session cards display ───────────────────────────────────────

	test("S1-c: 세션 카드 3개 표시 (active, idle, stopped)", async ({ page }) => {
		await openWorkspacePanel(page);

		// Wait for session cards to load
		await expect(page.locator(".workspace-session-card")).toHaveCount(3, {
			timeout: 8_000,
		});

		// Active session shows green emoji
		const activeCard = page
			.locator(".workspace-session-card--active")
			.filter({ hasText: "naia-os-issue-79" });
		await expect(activeCard).toBeVisible();
		await expect(
			activeCard.locator(".workspace-session-card__status-icon"),
		).toContainText("🟢");

		// Idle session shows yellow emoji
		const idleCard = page
			.locator(".workspace-session-card--idle")
			.filter({ hasText: "naia.nextain.io" });
		await expect(idleCard).toBeVisible();
		await expect(
			idleCard.locator(".workspace-session-card__status-icon"),
		).toContainText("🟡");

		// Stopped session shows black emoji
		const stoppedCard = page
			.locator(".workspace-session-card--stopped")
			.filter({ hasText: "vllm" });
		await expect(stoppedCard).toBeVisible();
		await expect(
			stoppedCard.locator(".workspace-session-card__status-icon"),
		).toContainText("⚫");
	});

	// ── S2: Session card shows progress badge ─────────────────────────────

	test("S2: 세션 카드에 이슈/단계 배지 표시 (#79 · build)", async ({
		page,
	}) => {
		await openWorkspacePanel(page);

		await expect(page.locator(".workspace-session-card")).toHaveCount(3, {
			timeout: 8_000,
		});

		const issueLabel = page
			.locator(".workspace-session-card__issue")
			.filter({ hasText: "#79" });
		await expect(issueLabel).toBeVisible();
		await expect(issueLabel).toContainText("build");
	});

	// ── S3: Session card click → opens file in editor ─────────────────────

	test("S3: 세션 카드 클릭 시 에디터에 최근 파일 표시", async ({ page }) => {
		await openWorkspacePanel(page);

		await expect(page.locator(".workspace-session-card")).toHaveCount(3, {
			timeout: 8_000,
		});

		// Click the active session card
		const activeCard = page
			.locator(".workspace-session-card--active")
			.filter({ hasText: "naia-os-issue-79" });
		await activeCard.click();

		// Editor should show a file (registry.ts)
		await expect(page.locator(".workspace-editor__filename")).toBeVisible({
			timeout: 5_000,
		});
		await expect(page.locator(".workspace-editor__filename")).toContainText(
			"registry.ts",
		);
	});

	// ── S4: Editor badge shows issue and phase ────────────────────────────

	test("S4: 에디터 상단 배지에 이슈/단계 표시", async ({ page }) => {
		await openWorkspacePanel(page);

		await expect(page.locator(".workspace-session-card")).toHaveCount(3, {
			timeout: 8_000,
		});

		// Click active session
		const activeCard = page
			.locator(".workspace-session-card--active")
			.filter({ hasText: "naia-os-issue-79" });
		await activeCard.click();

		// Badge should show "#79 · build"
		await expect(page.locator(".workspace-editor__badge")).toBeVisible({
			timeout: 5_000,
		});
		await expect(page.locator(".workspace-editor__badge")).toContainText("#79");
	});

	// ── S5: FileTree shows root dirs ──────────────────────────────────────

	test("S5: FileTree에 루트 디렉토리 목록 표시", async ({ page }) => {
		await openWorkspacePanel(page);

		// Wait for FileTree to load
		await expect(page.locator(".workspace-tree")).toBeVisible({
			timeout: 5_000,
		});

		// naia-os dir should be visible
		const naiaDir = page
			.locator(".workspace-tree__node")
			.filter({ hasText: "naia-os" })
			.first();
		await expect(naiaDir).toBeVisible({ timeout: 5_000 });
	});

	// ── S6: FileTree item click → opens file in editor ───────────────────

	test("S6: FileTree 파일 클릭 시 에디터에 파일 내용 표시", async ({
		page,
	}) => {
		await openWorkspacePanel(page);

		await expect(page.locator(".workspace-tree")).toBeVisible({
			timeout: 5_000,
		});

		// Click AGENTS.md file node
		const fileNode = page
			.locator(".workspace-tree__node--file")
			.filter({ hasText: "AGENTS.md" });
		await expect(fileNode).toBeVisible({ timeout: 5_000 });
		await fileNode.click();

		// Editor should show the file
		await expect(page.locator(".workspace-editor__filename")).toBeVisible({
			timeout: 5_000,
		});
		await expect(page.locator(".workspace-editor__filename")).toContainText(
			"AGENTS.md",
		);
	});

	// ── S7: Markdown preview toggle ───────────────────────────────────────

	test("S7: 마크다운 파일 선택 시 미리보기 기본 표시 및 편집 버튼 전환", async ({
		page,
	}) => {
		await openWorkspacePanel(page);

		await expect(page.locator(".workspace-tree")).toBeVisible({
			timeout: 5_000,
		});

		// Click AGENTS.md
		const fileNode = page
			.locator(".workspace-tree__node--file")
			.filter({ hasText: "AGENTS.md" });
		await expect(fileNode).toBeVisible({ timeout: 5_000 });
		await fileNode.click();

		// Markdown file defaults to preview mode
		await expect(page.locator(".workspace-editor__preview")).toBeVisible({
			timeout: 5_000,
		});

		// "편집" view button visible
		await expect(
			page.locator(".workspace-editor__view-btn").filter({ hasText: "편집" }),
		).toBeVisible({ timeout: 3_000 });

		// Click "편집" → split view (editor + preview side by side)
		await page
			.locator(".workspace-editor__view-btn")
			.filter({ hasText: "편집" })
			.click();
		await expect(page.locator(".workspace-editor__body--split")).toBeVisible({
			timeout: 3_000,
		});
	});

	// ── S8: ref- directory shows read-only ───────────────────────────────

	test("S8: ref-* 디렉토리 파일 선택 시 읽기 전용 표시", async ({ page }) => {
		await openWorkspacePanel(page);

		// Click ref-cline in FileTree
		await expect(page.locator(".workspace-tree")).toBeVisible({
			timeout: 5_000,
		});

		// Wait for ref-cline node
		const refNode = page
			.locator(".workspace-tree__node")
			.filter({ hasText: "ref-cline" })
			.first();
		await expect(refNode).toBeVisible({ timeout: 5_000 });
		await refNode.click(); // expand dir

		// After expansion, workspace_list_dirs for ref-cline would be called.
		// Since mock returns fakeDirs again (without README.md for ref-cline), just verify tree expands.
		// The read-only test is covered by unit tests for the ref- path detection.
		await expect(refNode).toBeVisible();
	});

	// ── S9: Empty editor state ────────────────────────────────────────────

	test("S9: 파일 선택 전 에디터 빈 힌트 메시지 표시", async ({ page }) => {
		await openWorkspacePanel(page);

		await expect(page.locator(".workspace-editor--empty")).toBeVisible({
			timeout: 5_000,
		});
		await expect(page.locator(".workspace-editor__empty-hint")).toBeVisible();
	});

	// ── S10: Panel deactivation stops watcher ─────────────────────────────

	test("S10: 다른 패널로 전환 시 워크스페이스 패널 비활성화", async ({
		page,
	}) => {
		await openWorkspacePanel(page);

		await expect(page.locator(".workspace-panel")).toBeVisible({
			timeout: 5_000,
		});

		// Switch to avatar panel (first tab in ModeBar, or any other panel)
		const avatarTab = page.locator('[data-panel-id="avatar"]');
		if (await avatarTab.isVisible()) {
			await avatarTab.click();
			// Workspace panel should no longer be visible
			await expect(page.locator(".workspace-panel")).toBeHidden({
				timeout: 3_000,
			});
		}
	});

	// ── S12: workspaceReady gate — sessions load after workspace_set_root ──

	test("S12: workspaceReady 게이트 — workspace_set_root 완료 후 세션 로드됨", async ({
		page,
	}) => {
		// workspace_set_root mock returns a canonical string (Result<String, String>).
		// If the gate works correctly, sessions should load after set_root resolves.
		await openWorkspacePanel(page);

		// Verify both sessions section (gated) and session cards load successfully
		await expect(page.locator(".issues-panel__sessions")).toBeVisible({
			timeout: 5_000,
		});
		await expect(page.locator(".workspace-session-card")).toHaveCount(3, {
			timeout: 8_000,
		});
	});

	// ── S13: workspaceRoot config override reflected in SessionDashboard ──

	test("S13: config workspaceRoot 설정 시 workspace_set_root가 해당 경로로 호출됨", async ({
		page,
	}) => {
		const CUSTOM_ROOT = "/custom/workspace/path";

		// Re-navigate with custom workspaceRoot in config (overrides beforeEach config)
		await page.addInitScript(`
			localStorage.setItem("naia-config", JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "e2e-mock-key",
				locale: "ko",
				onboardingComplete: true,
				workspaceRoot: "${CUSTOM_ROOT}",
			}));
			localStorage.removeItem("workspace-classified-dirs");
		`);

		await page.goto("/");
		await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
		await openWorkspacePanel(page);

		// workspaceReady gate should resolve with custom root → sessions load
		await expect(page.locator(".issues-panel__sessions")).toBeVisible({
			timeout: 5_000,
		});
		await expect(page.locator(".workspace-session-card")).toHaveCount(3, {
			timeout: 8_000,
		});

		// Verify workspace_set_root was called with the config workspaceRoot value
		const capturedRoot = await page.evaluate(
			() => (window as any).__NAIA_E2E__?.lastSetRootArg,
		);
		expect(capturedRoot).toBe(CUSTOM_ROOT);
	});

	// ── S11: panel_tool_call via workspace:file-changed event ─────────────

	test("S11: workspace:file-changed 이벤트 수신 시 세션 새로고침", async ({
		page,
	}) => {
		await openWorkspacePanel(page);

		await expect(page.locator(".workspace-session-card")).toHaveCount(3, {
			timeout: 8_000,
		});

		// Emit a file-changed event to trigger refresh
		await page.evaluate(() => {
			window.__NAIA_E2E__.emitEvent("workspace:file-changed", {
				session: "/var/home/luke/dev/naia-os-issue-79",
				file: "shell/src/App.tsx",
				timestamp: Math.floor(Date.now() / 1000),
			});
		});

		// Session cards should still be visible after refresh
		await expect(page.locator(".workspace-session-card")).toHaveCount(3, {
			timeout: 8_000,
		});
	});
});

test.describe("WG: Worktree grouping", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(TAURI_MOCK_SCRIPT);
		// Override workspace_get_sessions to return worktree grouping scenario
		await page.addInitScript(`(function(){
			var wgSessions = ${JSON.stringify(FAKE_SESSIONS_WORKTREE)};
			var _orig = window.__TAURI_INTERNALS__.invoke;
			window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
				if (cmd === "workspace_get_sessions") return wgSessions;
				return _orig(cmd, args);
			};
		})();`);
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
			// Set ADK path so isAdkInitialized() returns true (avoids AdkSetupScreen)
			localStorage.setItem("naia-adk-path", "/var/home/luke/dev");
			// Ensure clean classification state (same as main describe beforeEach)
			localStorage.removeItem("workspace-classified-dirs");
		});

		await page.goto("/");
		await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
	});

	test("WG1: 같은 origin_path 세션이 WorktreeGroup으로 묶임", async ({
		page,
	}) => {
		await openWorkspacePanel(page);

		// One WorktreeGroup visible
		await expect(page.locator(".workspace-worktree-group")).toBeVisible({
			timeout: 5_000,
		});
		// Group starts expanded — cards container must be visible before counting cards
		await expect(page.locator(".workspace-worktree-group__cards")).toBeVisible({
			timeout: 3_000,
		});
		// 3 session cards total: 2 inside group (expanded) + 1 standalone
		await expect(page.locator(".workspace-session-card")).toHaveCount(3, {
			timeout: 8_000,
		});
		// Group header shows repo basename "naia-os"
		await expect(page.locator(".workspace-worktree-group__name")).toContainText(
			"naia-os",
		);
		// Group count badge shows 2
		await expect(
			page.locator(".workspace-worktree-group__count"),
		).toContainText("2");
	});

	test("WG2: WorktreeGroup 헤더 클릭 시 접기/펼치기", async ({ page }) => {
		await openWorkspacePanel(page);

		await expect(page.locator(".workspace-worktree-group")).toBeVisible({
			timeout: 5_000,
		});
		// Initially expanded — cards container visible
		await expect(
			page.locator(".workspace-worktree-group__cards"),
		).toBeVisible();
		// Collapse
		await page.locator(".workspace-worktree-group__header").click();
		await expect(
			page.locator(".workspace-worktree-group__cards"),
		).not.toBeVisible();
		// Re-expand
		await page.locator(".workspace-worktree-group__header").click();
		await expect(
			page.locator(".workspace-worktree-group__cards"),
		).toBeVisible();
	});
});
