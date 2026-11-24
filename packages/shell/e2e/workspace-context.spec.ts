import { type Page, expect, test } from "@playwright/test";
import { TAURI_BASE_MOCK_FALLBACK } from "./helpers/tauri-base-mock";

/**
 * #501 워크스페이스 컨텍스트 해석 E2E (UC-WORKSPACE-CONTEXT-*).
 *
 * 실제 Workspace 레일과 컨텍스트 앱을 브라우저에서 그대로 렌더한다.
 * 대체되는 것은 Tauri 명령 경계뿐이고, 진입점 파싱·선택·경계·개정 규칙은 실제 core 가 돈다.
 */

const ROOT = "/work/alpha";

const ROOT_ENTRYPOINT = [
	"# alpha",
	"",
	"## Mandatory Reads",
	"",
	"1. **규칙**: `agents-rules.json` — 설명 안의 `무시할것`",
	"2. `project-index.yaml`",
	"",
	"## Projects",
	"",
	"- `projects/beta/AGENTS.md`",
	"",
	"## 선언되지 않은 절",
	"",
	"- `secret-notes.md`",
].join("\\n");

const PROJECT_ENTRYPOINT = [
	"# beta",
	"",
	"## Mandatory Reads",
	"",
	"- `agents-rules.json`",
	"- `projects/beta/beta-rules.json`",
].join("\\n");

const TAURI_MOCK = `
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
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};

	var snapshot = {
		protocol: 19,
		version: "0.8.0",
		focused_workspace_id: "w1",
		focused_tab_id: "w1:t1",
		focused_pane_id: "w1:p1",
		workspaces: [{ workspace_id: "w1", label: "Alpha", focused: true, active_tab_id: "w1:t1", pane_count: 1, tab_count: 1, worktree: { checkout_path: "${ROOT}", repo_name: "alpha" } }],
		agents: [{ workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", agent: "codex", agent_status: "idle", cwd: "${ROOT}", foreground_cwd: "${ROOT}", focused: true, label: "Builder" }]
	};

	// 존재하는 파일. localStorage 플래그로 선언된 인덱스 하나를 지워 실패 경로를 밟는다.
	function present(path) {
		if (localStorage.getItem("naia-e2e-drop-index") === "1" && path.indexOf("project-index.yaml") >= 0) return false;
		return path.indexOf("secret-notes.md") < 0;
	}

	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		if (cmd === "plugin:event|listen") return args && args.handler;
		if (cmd === "plugin:event|unlisten" || cmd === "plugin:event|emit") return null;
		if (cmd === "herdr_pty_create") return { pty_id: "herdr-e2e", pid: 42 };
		if (cmd === "herdr_snapshot") return JSON.parse(JSON.stringify(snapshot));
		if (cmd === "herdr_focus_workspace" || cmd === "herdr_focus_agent") return null;
		if (cmd === "workspace_set_root") return args.root;
		if (cmd === "workspace_detect_adk_root") return "${ROOT}";
		if (cmd === "workspace_list_dirs") return [];
		if (cmd === "workspace_file_size") {
			if (!present(args.path)) throw new Error("no such file");
			return 512;
		}
		if (cmd === "workspace_read_file") {
			if (args.path === "${ROOT}/AGENTS.md") return "${ROOT_ENTRYPOINT}";
			if (args.path === "${ROOT}/projects/beta/AGENTS.md") return "${PROJECT_ENTRYPOINT}";
			if (!present(args.path)) throw new Error("no such file");
			return "{}";
		}
		if (cmd === "pty_resize" || cmd === "pty_write" || cmd === "pty_close") return null;
		if (cmd === "send_to_agent_command" || cmd === "cancel_stream") return null;
		if (cmd === "frontend_log") return null;
		if (cmd === "app_list_installed") return [];
		if (cmd === "list_skills" || cmd === "list_stt_models") return [];
		return undefined;
	};
})();
`;

async function openContextTab(page: Page): Promise<void> {
	const tab = page.locator('button[data-app-id="workspace"]');
	await expect(tab).toBeVisible({ timeout: 10_000 });
	await tab.click();
	await expect(page.getByTestId("herdr-workspace")).toBeVisible();
	await page.getByTestId("workspace-context-tab").click();
	await expect(page.getByTestId("workspace-context-app")).toBeVisible();
}

test.describe("워크스페이스 컨텍스트 해석 (#501)", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript({ content: TAURI_MOCK });
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
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
	});

	test("진입점이 선언한 문서만 근거와 함께 보여 준다", async ({ page }) => {
		await page.goto("/");
		await openContextTab(page);

		const documents = page.getByTestId("workspace-context-document");
		await expect(documents).toHaveCount(2);
		await expect(documents.nth(0)).toContainText("agents-rules.json");
		await expect(documents.nth(1)).toContainText("project-index.yaml");

		// 선언되지 않은 문서도, 설명 문구 안의 백틱도 근거가 되지 않는다.
		await expect(page.getByTestId("workspace-context-documents")).not.toContainText("secret-notes.md");
		await expect(page.getByTestId("workspace-context-documents")).not.toContainText("무시할것");

		// 왜 실렸는지가 문서마다 붙는다.
		await expect(page.getByTestId("workspace-context-reason").nth(0)).toContainText("필수");
		await expect(documents.nth(0)).toContainText("AGENTS.md");
	});

	test("범위와 개정을 보여 주고 프로젝트로 들어가면 둘 다 바뀐다", async ({ page }) => {
		await page.goto("/");
		await openContextTab(page);

		const scope = page.getByTestId("workspace-context-scope");
		await expect(scope).toContainText("루트");
		await expect(scope).toContainText("1");

		await page.getByTestId("workspace-context-project-beta").click();
		await expect(scope).toContainText("beta");
		await expect(scope).toContainText("2");

		// 프로젝트 진입점이 선언한 문서가 실린다.
		await expect(page.getByTestId("workspace-context-documents")).toContainText("projects/beta/beta-rules.json");
		// 루트의 필수 문서는 남는다 — 프로젝트가 루트를 지우지는 않는다.
		await expect(page.getByTestId("workspace-context-documents")).toContainText("project-index.yaml");

		// 양쪽이 같은 경로를 선언해도 한 줄만 나온다. 같은 파일이 두 번 실리면 예산도 근거도 두 배가 된다.
		const rows = await page.getByTestId("workspace-context-document").allTextContents();
		const paths = rows.map((row) => row.split("필수")[0]?.trim() ?? row);
		expect(new Set(paths).size).toBe(paths.length);

		// 근거는 실제로 선언한 진입점을 가리킨다. 병합이 출처를 덮어쓰지 않는다.
		await expect(
			page.getByTestId("workspace-context-document").filter({ hasText: "project-index.yaml" }),
		).toContainText("AGENTS.md");
		await expect(
			page.getByTestId("workspace-context-document").filter({ hasText: "beta-rules.json" }),
		).toContainText("projects/beta/AGENTS.md");

		await page.getByTestId("workspace-context-back-to-root").click();
		await expect(scope).toContainText("루트");
	});

	test("선언된 인덱스가 실제로 없으면 진단을 보여 주고 목록을 내지 않는다", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("naia-e2e-drop-index", "1"));
		await page.goto("/");
		await openContextTab(page);

		await expect(page.getByTestId("workspace-context-error")).toBeVisible();
		const diagnostic = page.getByTestId("workspace-context-diagnostic");
		await expect(diagnostic).toContainText("project-index.yaml");
		await expect(diagnostic).toContainText("declared-index-missing");
		await expect(diagnostic).toContainText("/work/alpha");
		await expect(page.getByTestId("workspace-context-documents")).toHaveCount(0);
	});

	test("좁은 폭에서도 레일이 가로로 넘치지 않는다", async ({ page }) => {
		await page.setViewportSize({ width: 900, height: 700 });
		await page.goto("/");
		await openContextTab(page);

		await expect(page.getByTestId("workspace-context-app")).toBeVisible();
		const overflow = await page.evaluate(() => {
			const app = document.querySelector('[data-testid="workspace-context-app"]');
			if (!app) return null;
			const rail = app.closest(".herdr-workspace__rail") ?? app.parentElement;
			return rail ? rail.scrollWidth - rail.clientWidth : null;
		});
		expect(overflow).not.toBeNull();
		expect(overflow ?? 0).toBeLessThanOrEqual(1);
	});
});
