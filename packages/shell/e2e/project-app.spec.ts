import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const CAPTURE_DIR = resolve(
	process.env.PROJECT_APP_CAPTURE_DIR ??
		resolve(process.cwd(), "test-results/project-app-captures"),
);
mkdirSync(CAPTURE_DIR, { recursive: true });

const READY_CATALOG = {
	projects: [
		{
			adapterRoot: "/fixture/adapter-root",
			projectPath: "/fixture/naia-adk/projects/team/projects/example-app",
			sourcePath: "projects/team/projects/example-app",
			projectId: "example-app",
			name: "Example App",
			repository: "octocat/Hello-World",
			issueTracker: "github",
			dashboardUrl: "https://dashboard.example.test/project",
			issuesUrl: "https://issues.example.test/project",
		},
		{
			adapterRoot: "/fixture/adapter-root",
			projectPath: "/fixture/naia-adk/projects/team/projects/example-library",
			sourcePath: "projects/team/projects/example-library",
			projectId: "example-library",
			name: "Example Library",
			repository: "octocat/Hello-World",
			issueTracker: "github",
			dashboardUrl: "javascript:alert(1)",
			issuesUrl: null,
		},
	],
	catalogErrors: [],
	truncation: {
		maxEntries: 200,
		scannedEntries: 8,
		moreEntriesAvailable: false,
		maxRows: 200,
		shownRows: 2,
		moreRowsAvailable: false,
		maxConfigFileBytes: 65536,
		oversizedFiles: [],
	},
};

const TAURI_MOCK = `
(function() {
\twindow.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
\twindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
\twindow.__TAURI_INTERNALS__.metadata = {
\t\tcurrentWindow: { label: "main" },
\t\tcurrentWebview: { windowLabel: "main", label: "main" },
\t};
\tvar callbacks = new Map();
\tvar callbackId = 1;
\twindow.__TAURI_INTERNALS__.transformCallback = function(fn, once) {
\t\tvar id = callbackId++;
\t\tcallbacks.set(id, function(data) {
\t\t\tif (once) callbacks.delete(id);
\t\t\treturn fn && fn(data);
\t\t});
\t\treturn id;
\t};
\twindow.__TAURI_INTERNALS__.unregisterCallback = function(id) { callbacks.delete(id); };
\twindow.__TAURI_INTERNALS__.convertFileSrc = function(path, protocol) {
\t\treturn (protocol || "asset") + "://localhost/" + encodeURIComponent(path);
\t};
\twindow.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
\tvar state = window.__PROJECT_E2E__ = {
\t\tcalls: [],
\t\tdialogPath: "/fixture/naia-adk",
\t\tdialogCount: 0,
\t\tresult: { projects: [], catalogErrors: [] },
\t\tpending: false,
\t\tfailuresRemaining: 0,
\t\tprojectAgentStartError: null,
\t};
\twindow.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
\t\tstate.calls.push({ cmd: cmd, args: args || null });
\t\tif (cmd === "plugin:event|listen") return args.handler;
\t\tif (cmd === "plugin:event|emit" || cmd === "plugin:event|unlisten") return null;
\t\tif (cmd === "plugin:dialog|open") { state.dialogCount++; return state.dialogPath; }
\t\tif (cmd === "read_naia_config") return JSON.stringify({
\t\t\tprovider: "gemini",
\t\t\tmodel: "gemini-2.5-flash",
\t\t\tapiKey: "project-app-e2e",
\t\t\tlocale: "en",
\t\t\tonboardingComplete: true,
\t\t});
\t\tif (cmd === "read_naia_ui_config") return "{}";
\t\tif (cmd === "write_naia_path_cache") return null;
\t\tif (cmd === "projects_scan_adk") {
\t\t\tif (state.pending) return new Promise(function(resolve) { state.resolveScan = resolve; });
\t\t\tif (state.failuresRemaining > 0) {
\t\t\t\tstate.failuresRemaining--;
\t\t\t\tthrow new Error("naia-adk projects cannot be read");
\t\t\t}
\t\t\treturn state.result;
\t\t}
\t\tif (cmd === "project_agent_availability") {
\t\t\treturn ["claude", "codex", "muse", "opencode"].map(function(appId) {
\t\t\t\treturn { appId: appId, available: true };
\t\t\t});
\t\t}
\t\tif (cmd === "project_agent_pty_start" || cmd === "project_agent_pty_attach") {
\t\t\tif (cmd === "project_agent_pty_start" && state.projectAgentStartError) {
\t\t\t\tthrow new Error(state.projectAgentStartError);
\t\t\t}
\t\t\treturn {
\t\t\t\tappId: args.appId,
\t\t\t\tprojectPath: args.projectPath,
\t\t\t\tptyId: "project-pty-" + args.projectPath.split("/").pop(),
\t\t\t\trunning: true,
\t\t\t};
\t\t}
\t\tif (cmd === "project_webview_open") return false;
\t\tif (cmd === "send_to_agent_command" || cmd === "cancel_stream" || cmd === "frontend_log") return null;
\t\treturn undefined;
\t};
})();
`;

async function boot(page: Page, seedAdkPath = true) {
	await page.addInitScript(TAURI_MOCK);
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({
		content: seedAdkPath
			? SEED_ADK_PATH
			: 'localStorage.removeItem("naia-adk-path");',
	});
	await page.addInitScript(() => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "project-app-e2e",
				locale: "en",
				onboardingComplete: true,
			}),
		);
	});
	await page.goto("/", { waitUntil: "domcontentloaded" });
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 30_000 });
}

async function setCatalog(page: Page, catalog: unknown) {
	await page.evaluate((value) => {
		(window as any).__PROJECT_E2E__.result = value;
	}, catalog);
}

async function openProjectApp(page: Page) {
	await page.locator('button[data-app-id="projects"]').click();
	await expect(
		page.getByRole("heading", { name: "Choose a project", level: 1 }),
	).toBeVisible();
}

async function capture(page: Page, name: string) {
	await page
		.locator(".projects-app")
		.screenshot({ path: resolve(CAPTURE_DIR, name) });
}

test.describe("Project app — stage 3 local three-pane flow", () => {
	test("uses the saved naia-adk path without prompting and shows a single catalog entry point", async ({
		page,
	}) => {
		await boot(page);
		await setCatalog(page, READY_CATALOG);
		await openProjectApp(page);
		await expect(
			page.getByRole("button", { name: /Example App/ }),
		).toBeVisible();
		await expect(page.locator('button[data-app-id="projects"]')).toHaveCount(1);
		const calls = await page.evaluate(
			() => (window as any).__PROJECT_E2E__.calls,
		);
		expect(
			calls.filter(
				(call: { cmd: string }) => call.cmd === "plugin:dialog|open",
			),
		).toHaveLength(0);
		expect(
			calls.some((call: { cmd: string }) => call.cmd === "projects_scan_adk"),
		).toBe(true);
		await capture(page, "project-app-catalog.png");
	});

	test("asks once when the saved ADK path is unreadable, then stores the selected valid path", async ({
		page,
	}) => {
		await boot(page);
		await setCatalog(page, READY_CATALOG);
		await page.evaluate(() => {
			(window as any).__PROJECT_E2E__.failuresRemaining = 1;
		});
		await openProjectApp(page);
		await expect(page.getByRole("button", { name: /Example App/ })).toBeVisible(
			{ timeout: 30_000 },
		);
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem("naia-adk-path")))
			.toBe("/fixture/naia-adk");
		const state = await page.evaluate(() => (window as any).__PROJECT_E2E__);
		expect(state.dialogCount).toBe(1);
		expect(
			state.calls.filter(
				(call: { cmd: string }) => call.cmd === "projects_scan_adk",
			),
		).toHaveLength(2);
		expect(
			state.calls.filter(
				(call: { cmd: string }) => call.cmd === "projects_scan_adk",
			)[1].args,
		).toEqual({
			adkPath: "/fixture/naia-adk",
		});
	});

	test("shows loading while scanning the saved catalog", async ({ page }) => {
		await boot(page);
		await page.evaluate(() => {
			(window as any).__PROJECT_E2E__.pending = true;
		});
		await openProjectApp(page);
		await expect(
			page.locator(".projects-app output[aria-live='polite']"),
		).toContainText("Reading projects from naia-adk");
		await capture(page, "project-app-loading.png");
		await page.evaluate((catalog) => {
			const state = (window as any).__PROJECT_E2E__;
			state.pending = false;
			state.resolveScan(catalog);
		}, READY_CATALOG);
		await expect(
			page.getByRole("button", { name: /Example App/ }),
		).toBeVisible();
	});

	test("opens one project, hides search, and restores each project's stage when switching", async ({
		page,
	}) => {
		await boot(page);
		await setCatalog(page, READY_CATALOG);
		await openProjectApp(page);
		const search = page.getByRole("searchbox", { name: "Search projects" });
		await search.fill("octocat/Hello-World");
		await expect(
			page.getByRole("button", { name: /Example Library/ }),
		).toBeVisible();
		await page.getByRole("button", { name: /Example App/ }).click();
		await expect(
			page.getByRole("heading", { name: "Example App", level: 1 }),
		).toBeVisible();
		await expect(page.getByRole("searchbox")).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Open another project" }),
		).toBeVisible();
		await expect(page.locator(".projects-app").getByRole("tab")).toHaveCount(3);
		await page.getByRole("tab", { name: "Dashboard" }).click();
		await page.getByRole("button", { name: "Open another project" }).click();
		await expect(page.getByRole("searchbox")).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Back to Example App" }),
		).toBeVisible();
		await page.getByRole("button", { name: /Example Library/ }).click();
		await page.getByRole("tab", { name: "Internal Issues" }).click();
		await page.getByRole("button", { name: "Open another project" }).click();
		await page.getByRole("button", { name: /Example App/ }).click();
		await expect(page.getByRole("tab", { name: "Dashboard" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await expect(page.getByRole("tabpanel")).toContainText(
			"This project view opens in a separate window",
		);
		await expect(page.locator('button[data-app-id="projects"]')).toHaveCount(1);
		await capture(page, "project-app-opened.png");
	});

	test("reopens the last project and its stage after a shell reload", async ({
		page,
	}) => {
		await boot(page);
		await setCatalog(page, READY_CATALOG);
		await openProjectApp(page);
		await page.getByRole("button", { name: /Example Library/ }).click();
		await page.getByRole("tab", { name: "Dashboard" }).click();
		await page.reload();
		await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });
		await setCatalog(page, READY_CATALOG);
		await page.locator('button[data-app-id="projects"]').click();
		await expect(
			page.getByRole("heading", { name: "Example Library", level: 1 }),
		).toBeVisible();
		await expect(page.getByRole("tab", { name: "Dashboard" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});

	test("returns to the current project when the other-project list is canceled", async ({
		page,
	}) => {
		await boot(page);
		await setCatalog(page, READY_CATALOG);
		await openProjectApp(page);
		await page.getByRole("button", { name: /Example App/ }).click();
		await page.getByRole("button", { name: "Open another project" }).click();
		await page.getByRole("button", { name: "Back to Example App" }).click();
		await expect(
			page.getByRole("heading", { name: "Example App", level: 1 }),
		).toBeVisible();
		await expect(page.getByRole("searchbox")).toHaveCount(0);
	});

	test("shows the empty catalog and relative metadata errors", async ({
		page,
	}) => {
		await boot(page);
		await setCatalog(page, {
			projects: [],
			catalogErrors: [
				{
					path: "projects/team/projects/broken/project.yaml",
					reason: "missing_project_id",
				},
			],
		});
		await openProjectApp(page);
		await expect(
			page.getByRole("heading", { name: "No projects found" }),
		).toBeVisible();
		await expect(
			page.getByText("projects/team/projects/broken/project.yaml"),
		).toBeVisible();
		await expect(page.getByText("The project ID is missing.")).toBeVisible();
		await capture(page, "project-app-empty-and-error.png");
	});

	test("shows index repair guidance when no project metadata candidates exist", async ({
		page,
	}) => {
		await boot(page);
		await setCatalog(page, {
			projects: [],
			catalogErrors: [
				{
					path: ".agents/context/project-index.yaml",
					reason: "invalid_yaml",
				},
			],
		});
		await openProjectApp(page);

		await expect(
			page.getByRole("heading", { name: "No projects found" }),
		).toBeVisible();
		await expect(
			page.getByText(".agents/context/project-index.yaml"),
		).toBeVisible();
		await expect(page.getByText(/is invalid\./)).toBeVisible();
		await expect(page.getByText(/nested, non-empty project\.id/)).toBeVisible();
		await expect(page.getByText(/reset its path in Settings/)).toBeVisible();
		await capture(page, "project-app-empty-index-error.png");
	});

	test("reports scan entry, display-row, and file-size cutoffs", async ({
		page,
	}) => {
		await boot(page);
		await setCatalog(page, {
			...READY_CATALOG,
			catalogErrors: [
				{
					path: "projects/team/projects/large/project.yaml",
					reason: "file_too_large",
				},
			],
			truncation: {
				maxEntries: 200,
				scannedEntries: 200,
				moreEntriesAvailable: true,
				maxRows: 200,
				shownRows: 3,
				moreRowsAvailable: true,
				maxConfigFileBytes: 65536,
				oversizedFiles: [
					{
						file: "projects/team/projects/large/project.yaml",
						observedBytes: 70000,
					},
				],
			},
		});
		await openProjectApp(page);
		const notice = page.getByRole("status", {
			name: "Some project details were skipped",
		});
		await expect(notice).toContainText("200 of 200 directory entries");
		await expect(notice).toContainText("3 of 200 project and error rows");
		await expect(notice).toContainText("70000 bytes");
		await expect(page.locator(".projects-app [role='alert']")).toHaveCount(0);
		await capture(page, "project-app-truncated.png");
	});

	test("shows a recoverable path error after a canceled folder selection", async ({
		page,
	}) => {
		await boot(page);
		await page.evaluate(() => {
			(window as any).__PROJECT_E2E__.dialogPath = null;
			(window as any).__PROJECT_E2E__.failuresRemaining = 1;
		});
		await openProjectApp(page);
		await expect(page.getByRole("alert")).toContainText(
			"Choose a naia-adk folder containing a readable projects/",
		);
		await expect(page.getByRole("alert")).toContainText(
			"Settings > naia-adk path reset",
		);
		await capture(page, "project-app-path-error.png");
		await page.evaluate((catalog) => {
			const state = (window as any).__PROJECT_E2E__;
			state.dialogPath = "/fixture/naia-adk";
			state.result = catalog;
		}, READY_CATALOG);
		await page.getByRole("button", { name: "Choose folder again" }).click();
		await expect(
			page.getByRole("button", { name: /Example App/ }),
		).toBeVisible();
	});

	test("uses four fixed local agents, reattaches project sessions, and separates project webviews", async ({
		page,
	}) => {
		await boot(page);
		await setCatalog(page, READY_CATALOG);
		await openProjectApp(page);
		await page.getByRole("button", { name: /Example App/ }).click();
		const radios = page.locator(".projects-app__agent input[type=radio]");
		await expect(radios).toHaveCount(4);
		await expect(radios.locator(":checked")).toHaveCount(0);
		await page.getByRole("radio", { name: "Claude" }).check();
		await page.getByRole("button", { name: "Start Claude" }).click();
		await expect(
			page.getByText("Claude is running for this project."),
		).toBeVisible();
		let calls = await page.evaluate(
			() => (window as any).__PROJECT_E2E__.calls,
		);
		const start = calls.find(
			(call: { cmd: string }) => call.cmd === "project_agent_pty_start",
		);
		expect(start.args).toEqual({
			appId: "claude",
			projectPath: "/fixture/naia-adk/projects/team/projects/example-app",
			adapterRoot: "/fixture/adapter-root",
		});
		expect(JSON.stringify(start.args)).not.toMatch(/shell|argv|command/i);

		await page.getByRole("button", { name: "Open another project" }).click();
		await page.getByRole("button", { name: /Example Library/ }).click();
		await page.getByRole("tab", { name: "Dashboard" }).click();
		await expect(
			page.getByRole("heading", { name: "The configured address is invalid" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Open dashboard" }),
		).toHaveCount(0);
		await page.getByRole("tab", { name: "Internal Issues" }).click();
		await expect(
			page.getByRole("heading", { name: "This address is not configured" }),
		).toBeVisible();

		await page.getByRole("button", { name: "Open another project" }).click();
		await page.getByRole("button", { name: /Example App/ }).click();
		await expect
			.poll(async () => {
				const activeCalls = await page.evaluate(
					() => (window as any).__PROJECT_E2E__.calls,
				);
				return activeCalls.filter(
					(call: { cmd: string }) => call.cmd === "project_agent_pty_attach",
				).length;
			})
			.toBeGreaterThan(0);
		await expect(
			page.getByText("Claude is running for this project."),
		).toBeVisible();

		await page.getByRole("tab", { name: "Dashboard" }).click();
		await page.getByRole("button", { name: "Open dashboard" }).click();
		await expect(
			page.getByText(
				"The project window was not created in this test environment. The project URL remains configured.",
			),
		).toBeVisible();
		calls = await page.evaluate(() => (window as any).__PROJECT_E2E__.calls);
		const webview = calls.find(
			(call: { cmd: string }) => call.cmd === "project_webview_open",
		);
		expect(webview.args).toEqual({
			adapterRoot: "/fixture/adapter-root",
			projectPath: "/fixture/naia-adk/projects/team/projects/example-app",
			view: "dashboard",
		});
	});

	test("shows safe checkout recovery guidance when the agent start is rejected", async ({
		page,
	}) => {
		await boot(page);
		await setCatalog(page, READY_CATALOG);
		await page.evaluate(() => {
			(window as any).__PROJECT_E2E__.projectAgentStartError =
				"checkout_missing:checkouts/Hello-World";
		});
		await openProjectApp(page);
		await page.getByRole("button", { name: /Example App/ }).click();
		await page.getByRole("radio", { name: "Claude" }).check();
		await page.getByRole("button", { name: "Start Claude" }).click();

		const error = page.getByRole("alert");
		await expect(error).toContainText("The coding app could not start");
		await expect(error).toContainText(
			"The expected project checkout is missing.",
		);
		await expect(error).toContainText("checkouts/Hello-World");
		await expect(error).toContainText(
			"Create or clone the project checkout there yourself",
		);
		const calls = await page.evaluate(
			() => (window as any).__PROJECT_E2E__.calls,
		);
		const starts = calls.filter(
			(call: { cmd: string }) => call.cmd === "project_agent_pty_start",
		);
		expect(starts).toHaveLength(1);
		expect(starts[0].args).toEqual({
			appId: "claude",
			projectPath: READY_CATALOG.projects[0].projectPath,
			adapterRoot: READY_CATALOG.projects[0].adapterRoot,
		});
		expect(
			calls.some((call: { cmd: string }) => call.cmd === "pty_create"),
		).toBe(false);
	});

	test("keeps the project view usable at a narrow viewport with keyboard tabs", async ({
		page,
	}) => {
		await boot(page);
		await setCatalog(page, READY_CATALOG);
		await openProjectApp(page);
		await page.getByTitle("채팅 숨기기 (Ctrl+B)").click();
		await expect(page.locator(".naia-overlay")).toHaveCount(0);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.getByRole("button", { name: /Example App/ }).click();
		const coding = page.getByRole("tab", { name: "Coding Agent" });
		await coding.focus();
		await page.keyboard.press("ArrowRight");
		await expect(page.getByRole("tab", { name: "Dashboard" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await capture(page, "project-app-narrow.png");
		const overflow = await page
			.locator(".projects-app")
			.evaluate((node) => node.scrollWidth > node.clientWidth);
		expect(overflow).toBe(false);
	});
});
