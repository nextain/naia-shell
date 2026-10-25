import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * Workspace preservation + Herdr integration E2E.
 *
 * The real Herdr process is replaced only at the Tauri command boundary. The
 * browser still renders the production Workspace rail, xterm surface, file
 * tree, viewer, and focus transitions.
 */

const ROOT_A = "/work/alpha";
const ROOT_B = "/work/beta";

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
		{
			workspace_id: "w2",
			label: "Beta",
			focused: false,
			active_tab_id: "w2:t1",
			pane_count: 1,
			tab_count: 1,
			worktree: { checkout_path: ROOT_B, repo_name: "beta" },
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
		{
			workspace_id: "w2",
			tab_id: "w2:t1",
			pane_id: "w2:p1",
			agent: "claude",
			agent_status: "idle",
			cwd: ROOT_B,
			foreground_cwd: ROOT_B,
			focused: false,
			label: "Reviewer",
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
	function setFocus(workspaceId, paneId) {
		state.focused_workspace_id = workspaceId;
		state.focused_pane_id = paneId;
		state.focused_tab_id = workspaceId + ":t1";
		state.workspaces.forEach(function(space) { space.focused = space.workspace_id === workspaceId; });
		state.agents.forEach(function(agent) { agent.focused = agent.pane_id === paneId; });
	}

	window.__NAIA_E2E__ = {
		calls: calls,
		emitEvent: emitEvent,
		externalFocus: function(workspaceId, paneId) { setFocus(workspaceId, paneId); },
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
		if (cmd === "herdr_snapshot" && localStorage.getItem("naia-e2e-stall-herdr") === "1") {
			return new Promise(function() {});
		}
		if (cmd === "herdr_snapshot") return JSON.parse(JSON.stringify(state));
		if (cmd === "herdr_focus_workspace") {
			var workspace = state.workspaces.find(function(item) { return item.workspace_id === args.workspaceId; });
			setFocus(args.workspaceId, workspace.active_tab_id.replace(":t1", ":p1"));
			return null;
		}
		if (cmd === "herdr_focus_agent") {
			var agent = state.agents.find(function(item) { return item.pane_id === args.paneId; });
			setFocus(agent.workspace_id, agent.pane_id);
			return null;
		}
		if (cmd === "workspace_set_root") return args.root;
		if (cmd === "workspace_detect_adk_root") return "${ROOT_A}";
		if (cmd === "workspace_list_dirs") {
			if (args.parent === "${ROOT_B}") {
				return [{ name: "beta.ts", path: "${ROOT_B}/beta.ts", is_dir: false, children: null }];
			}
			return [
				{ name: "README.md", path: "${ROOT_A}/README.md", is_dir: false, children: null },
				{ name: "alpha.ts", path: "${ROOT_A}/alpha.ts", is_dir: false, children: null },
				{ name: "track.mp3", path: "${ROOT_A}/track.mp3", is_dir: false, children: null }
			];
		}
		if (cmd === "workspace_file_size") return 512;
		if (cmd === "workspace_read_file") {
			if (args.path.endsWith("README.md")) return "# Workspace Guide\\n\\n- [x] GFM ready\\n\\n| Mode | State |\\n|---|---|\\n| Preview | Ready |\\n\\n[Source](alpha.ts)";
			return "export const alpha = true;\\n";
		}
		if (cmd === "workspace_resolve_file_location") return "${ROOT_A}/src/App.tsx";
		if (cmd === "pty_resize" || cmd === "pty_write" || cmd === "pty_close") return null;
		if (cmd === "send_to_agent_command" || cmd === "cancel_stream") return null;
		if (cmd === "frontend_log") return null;
		if (cmd === "app_list_installed") return [];
		if (cmd === "list_skills" || cmd === "list_stt_models") return [];
		if (cmd === "read_naia_config") return localStorage.getItem("naia-config") || "";
		if (cmd === "read_naia_ui_config") return "";
		return undefined;
	};
})();
`;

async function openWorkspace(page: Page): Promise<void> {
	const tab = page.locator('button[data-app-id="workspace"]');
	await expect(tab).toBeVisible({ timeout: 10_000 });
	await tab.click();
	await expect(page.getByTestId("herdr-workspace")).toBeVisible();
	await expect(page.locator(".workspace-app__terminal .xterm")).toBeVisible();
}

function callCount(page: Page, command: string): Promise<number> {
	return page.evaluate(
		(cmd) =>
			(window as any).__NAIA_E2E__.calls.filter(
				(call: { cmd: string }) => call.cmd === cmd,
			).length,
		command,
	);
}

function commandArgs(
	page: Page,
	command: string,
): Promise<Array<Record<string, unknown> | null>> {
	return page.evaluate(
		(cmd) =>
			(window as any).__NAIA_E2E__.calls
				.filter((call: { cmd: string }) => call.cmd === cmd)
				.map((call: { args: Record<string, unknown> | null }) => call.args),
		command,
	);
}

test.describe("Herdr Workspace integration", () => {
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
			localStorage.setItem("naia-adk-path", "${ROOT_A}");
		});
		await page.goto("/");
		await expect(page.locator(".chat-app")).toBeVisible({ timeout: 10_000 });
	});

	test("새 설치 기본값은 왼쪽 소형이고 Workspace를 열어도 사용자 배치를 유지한다", async ({
		page,
	}) => {
		const root = page.locator(".app-root");
		await expect(root).toHaveAttribute("data-ui-mode", "app");
		await expect(page.getByTitle("왼쪽 소형")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(
			await page.evaluate(() => localStorage.getItem("naia-chat-mode-v1")),
		).toBe("app");

		await openWorkspace(page);
		await expect(root).toHaveAttribute("data-ui-mode", "app");
		await expect(page.getByTitle("왼쪽 소형")).toHaveAttribute(
			"aria-pressed",
			"true",
		);

		await page.getByTitle("왼쪽 채움").click();
		await expect(root).toHaveAttribute("data-ui-mode", "workspace");
		await page.locator('button[data-app-id="browser"]').click();
		await expect(root).toHaveAttribute("data-ui-mode", "workspace");
	});

	test("파일 트리가 Spaces와 Agents 위에 있고 Herdr가 기본 화면이다", async ({
		page,
	}) => {
		await openWorkspace(page);
		const files = page.locator(".herdr-workspace__files");
		const spaces = page.getByRole("tab", { name: "Spaces" });
		const agents = page.getByRole("tab", { name: "Agents" });
		await expect(files).toBeVisible();
		await expect(spaces).toHaveAttribute("aria-selected", "true");
		await expect(agents).toHaveAttribute("aria-selected", "false");
		expect(
			await files.evaluate(
				(node, tab) =>
					Boolean(
						node.compareDocumentPosition(tab as Node) &
							Node.DOCUMENT_POSITION_FOLLOWING,
					),
				await spaces.elementHandle(),
			),
		).toBe(true);
		expect(
			await spaces.evaluate(
				(node, tab) =>
					Boolean(
						node.compareDocumentPosition(tab as Node) &
							Node.DOCUMENT_POSITION_FOLLOWING,
					),
				await agents.elementHandle(),
			),
		).toBe(true);
		await expect(page.getByText("Alpha", { exact: true })).toBeVisible();
	});

	test("Herdr snapshot이 멈춰도 설정된 Workspace 파일 트리는 대기하지 않는다", async ({
		page,
	}) => {
		await page.evaluate(() =>
			localStorage.setItem("naia-e2e-stall-herdr", "1"),
		);
		await page.reload();
		await expect(page.locator(".chat-app")).toBeVisible({ timeout: 10_000 });
		await openWorkspace(page);
		await expect(page.locator(".herdr-workspace__files")).toBeVisible();
		await expect(
			page.getByRole("button", { name: /README\.md/ }),
		).toBeVisible();
		await expect
			.poll(() => callCount(page, "workspace_list_dirs"))
			.toBeGreaterThan(0);
	});


	test("FileTree Markdown 문서를 GFM 미리보기로 열고 원문 전환한다", async ({
		page,
	}) => {
		await openWorkspace(page);
		await page.getByRole("button", { name: /README\.md/ }).click();
		const preview = page.getByRole("article", { name: "Markdown 미리보기" });
		await expect(preview).toBeVisible();
		await expect(
			preview.getByRole("heading", { name: "Workspace Guide" }),
		).toBeVisible();
		await expect(preview.getByRole("table")).toBeVisible();
		await expect(preview.getByRole("checkbox")).toBeChecked();
		await page.getByTitle("편집 모드로 전환").click();
		await expect(page.locator(".workspace-editor__codemirror")).toBeVisible();
	});

	test("MP3 files open in the audio player without a UTF-8 text read", async ({ page }) => {
		await openWorkspace(page);
		await page
			.locator(".herdr-workspace__files")
			.getByRole("button", { name: /track\.mp3/ })
			.click();

		await expect(page.getByTestId("workspace-viewer")).toBeVisible();
		await expect(
			page.locator('.workspace-editor__media-viewer audio[controls]'),
		).toBeVisible();
		await expect(page.getByText("audio/mpeg", { exact: true })).toBeVisible();
		const textReadPaths = (await commandArgs(page, "workspace_read_file"))
			.map((args) => args?.path)
			.filter(Boolean);
		expect(textReadPaths).not.toContain(`${ROOT_A}/track.mp3`);
	});

	test("a first-run black terminal becomes a visible retryable Herdr error", async ({
		page,
	}) => {
		await openWorkspace(page);
		const overlay = page.locator(".herdr-workspace__state--overlay");
		await expect(overlay).toBeVisible();
		await expect(overlay).toHaveAttribute("role", "status");
		await expect(overlay).toHaveAttribute("aria-live", "polite");
		await expect(overlay).toHaveAttribute("role", "alert", { timeout: 10_000 });
		await expect(overlay).toContainText("Herdr");
		await overlay.getByRole("button").click();
		await expect.poll(() => callCount(page, "pty_kill")).toBe(1);
		expect(await commandArgs(page, "pty_kill")).toEqual([
			{ ptyId: "herdr-e2e" },
		]);
		await expect.poll(() => callCount(page, "herdr_pty_create")).toBe(2);
		await expect(overlay).toHaveAttribute("role", "status");
	});

	test("Spaces와 Agents 선택이 Herdr 포커스와 양방향 동기화된다", async ({
		page,
	}) => {
		await openWorkspace(page);
		await page.getByText("Beta", { exact: true }).click();
		await expect.poll(() => callCount(page, "herdr_focus_workspace")).toBe(1);
		expect(await commandArgs(page, "herdr_focus_workspace")).toEqual([
			{ workspaceId: "w2" },
		]);
		await expect(
			page.locator(".herdr-workspace__items button.is-focused"),
		).toContainText("Beta");

		await page.getByRole("tab", { name: "Agents" }).click();
		await page.getByText("Builder", { exact: true }).click();
		await expect.poll(() => callCount(page, "herdr_focus_agent")).toBe(1);
		expect(await commandArgs(page, "herdr_focus_agent")).toEqual([
			{ paneId: "w1:p1" },
		]);
		await expect(
			page.locator(".herdr-workspace__items button.is-focused"),
		).toContainText("Builder");

		await page.evaluate(() =>
			(window as any).__NAIA_E2E__.externalFocus("w2", "w2:p1"),
		);
		await expect(
			page.locator(".herdr-workspace__items button.is-focused"),
		).toContainText("Reviewer", {
			timeout: 3_000,
		});
	});

	test("외부 Space 포커스가 바뀌어도 사용자가 고른 파일 트리 루트를 유지한다", async ({
		page,
	}) => {
		await openWorkspace(page);
		await expect(page.getByText("alpha.ts", { exact: true })).toBeVisible();
		await page.getByText("Beta", { exact: true }).click();
		await expect.poll(() => callCount(page, "herdr_focus_workspace")).toBe(1);
		await expect(page.getByText("alpha.ts", { exact: true })).toBeVisible();
		await expect(page.getByText("beta.ts", { exact: true })).toHaveCount(0);
	});

	test("파일 트리에서 연 파일을 본 뒤 같은 Herdr 터미널로 돌아간다", async ({
		page,
	}) => {
		await openWorkspace(page);
		const terminal = page.locator(".workspace-app__terminal");
		const terminalNode = await terminal.elementHandle();
		expect(terminalNode).not.toBeNull();
		expect(await callCount(page, "herdr_pty_create")).toBe(1);
		await page.getByText("alpha.ts", { exact: true }).click();
		await expect(page.getByTestId("workspace-viewer")).toBeVisible();
		await expect(terminal).toBeAttached();
		await expect(terminal).toHaveCSS("pointer-events", "none");
		await page.locator(".herdr-workspace__viewer-bar > button").click();
		await expect(page.getByTestId("workspace-viewer")).toBeHidden();
		await expect(terminal).toHaveCSS("pointer-events", "auto");
		expect(
			await terminal.evaluate((node, before) => node === before, terminalNode),
		).toBe(true);
		expect(await callCount(page, "herdr_pty_create")).toBe(1);
		await expect(
			page.locator(".workspace-app__terminal .xterm-helper-textarea"),
		).toBeFocused();
	});
});
