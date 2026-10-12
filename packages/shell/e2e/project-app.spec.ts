import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const CAPTURE_DIR = resolve(
	process.cwd(),
	"../..",
	".agy-work/756-s1/captures",
);
mkdirSync(CAPTURE_DIR, { recursive: true });

const READY_CATALOG = {
	projects: [
		{
			directoryName: "naia-shell",
			projectId: "naia-shell",
			name: "Naia Shell",
			repository: "nextain/naia-shell",
			issueTracker: "github",
			profile: "server",
			configErrors: [],
		},
		{
			directoryName: "naia-adk",
			projectId: "naia-adk",
			name: "Naia ADK",
			repository: "nextain/naia-adk",
			issueTracker: "github",
			profile: "server",
			configErrors: [],
		},
	],
};

const TAURI_MOCK = `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__TAURI_INTERNALS__.metadata = {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" },
	};
	var callbacks = new Map();
	var callbackId = 1;
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) {
		var id = callbackId++;
		callbacks.set(id, function(data) {
			if (once) callbacks.delete(id);
			return fn && fn(data);
		});
		return id;
	};
	window.__TAURI_INTERNALS__.unregisterCallback = function(id) { callbacks.delete(id); };
	window.__TAURI_INTERNALS__.convertFileSrc = function(path, protocol) {
		return (protocol || "asset") + "://localhost/" + encodeURIComponent(path);
	};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
	var state = window.__PROJECT_E2E__ = {
		calls: [],
		checkoutPath: "/fixture/naia-pj-adk",
		result: { projects: [] },
		pending: false,
		failuresRemaining: 0,
	};
	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		state.calls.push({ cmd: cmd, args: args || null });
		if (cmd === "plugin:event|listen") return args.handler;
		if (cmd === "plugin:event|emit" || cmd === "plugin:event|unlisten") return null;
		if (cmd === "plugin:dialog|open") return state.checkoutPath;
		if (cmd === "projects_scan_checkout") {
			if (state.pending) return new Promise(function(resolve) { state.resolveScan = resolve; });
			if (state.failuresRemaining > 0) {
				state.failuresRemaining--;
				throw new Error("checkout cannot be read");
			}
			return state.result;
		}
		if (cmd === "send_to_agent_command" || cmd === "cancel_stream" || cmd === "frontend_log") return null;
		return undefined;
	};
})();
`;

async function boot(page: Page) {
	await page.addInitScript(TAURI_MOCK);
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
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
	await page.goto("/");
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });
	await page.locator('button[data-app-id="projects"]').click();
	await expect(
		page.getByRole("heading", { name: "Choose a project", level: 1 }),
	).toBeVisible();
}

async function chooseCheckout(page: Page) {
	await page.getByRole("button", { name: "Choose checkout" }).click();
}

async function capture(page: Page, name: string) {
	await page
		.locator(".projects-app")
		.screenshot({ path: resolve(CAPTURE_DIR, name) });
}

test.describe("Project app — stage 1", () => {
	test("shows the basic state and a clear checkout action", async ({
		page,
	}) => {
		await boot(page);
		await expect(
			page.getByRole("heading", { name: "Choose a naia-pj-adk checkout" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Choose checkout" }),
		).toBeVisible();
		await capture(page, "project-app-basic.png");
	});

	test("shows loading while the selected checkout is being scanned", async ({
		page,
	}) => {
		await boot(page);
		await page.evaluate(() => {
			(window as any).__PROJECT_E2E__.pending = true;
		});
		await chooseCheckout(page);
		await expect(
			page.locator(".projects-app output[aria-live='polite']"),
		).toContainText("Reading projects and configuration");
		await capture(page, "project-app-loading.png");
	});

	test("searches by repository, opens a project, and keeps its title in all three views", async ({
		page,
	}) => {
		await boot(page);
		await page.evaluate((result) => {
			(window as any).__PROJECT_E2E__.result = result;
		}, READY_CATALOG);
		await chooseCheckout(page);
		const search = page.getByRole("searchbox", { name: "Search projects" });
		await expect(search).toBeVisible();
		await search.fill("nextain/naia-shell");
		await expect(
			page.getByRole("button", { name: /Naia Shell/ }),
		).toBeVisible();
		await expect(page.getByRole("button", { name: /Naia ADK/ })).toHaveCount(0);
		await page.getByRole("button", { name: /Naia Shell/ }).click();
		await expect(
			page.getByRole("heading", { name: "Naia Shell", level: 1 }),
		).toBeVisible();
		for (const label of ["Coding Agent", "Dashboard", "Internal Issues"]) {
			const tab = page.getByRole("tab", { name: label });
			await tab.click();
			await expect(tab).toHaveAttribute("aria-selected", "true");
			await expect(
				page.getByRole("heading", { name: "Naia Shell", level: 1 }),
			).toBeVisible();
			await expect(page.getByRole("tabpanel")).toContainText(
				"stage 1 placeholder",
			);
		}
		await capture(page, "project-app-success.png");
		await page.getByRole("tab", { name: "Coding Agent" }).focus();
		await page.keyboard.press("ArrowRight");
		await expect(page.getByRole("tab", { name: "Dashboard" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});

	test("shows an actionable empty state when no project exists", async ({
		page,
	}) => {
		await boot(page);
		await page.evaluate(() => {
			(window as any).__PROJECT_E2E__.result = { projects: [] };
		});
		await chooseCheckout(page);
		await expect(
			page.getByRole("heading", { name: "No projects found" }),
		).toBeVisible();
		await expect(
			page.getByText(/Check the checkout's projects\//),
		).toBeVisible();
		await capture(page, "project-app-empty.png");
	});

	test("blocks invalid local configuration and recovers after choosing a readable checkout", async ({
		page,
	}) => {
		await boot(page);
		await page.evaluate(() => {
			(window as any).__PROJECT_E2E__.result = {
				projects: [
					{
						directoryName: "broken-local",
						projectId: "broken-local",
						name: "Broken Local Project",
						repository: null,
						issueTracker: null,
						profile: "local",
						configErrors: [
							{ file: "profiles/local/profile.yaml", reason: "invalid_yaml" },
						],
					},
				],
			};
		});
		await chooseCheckout(page);
		await expect(page.getByText("profiles/local/profile.yaml")).toBeVisible();
		await expect(
			page.getByText(
				"This project has a configuration problem and cannot be opened.",
			),
		).toBeVisible();
		await capture(page, "project-app-config-error.png");

		await page.evaluate((result) => {
			(window as any).__PROJECT_E2E__.checkoutPath = "/fixture/second-checkout";
			(window as any).__PROJECT_E2E__.result = result;
		}, READY_CATALOG);
		await page.getByRole("button", { name: "Change checkout" }).click();
		await page.getByRole("button", { name: /Naia Shell/ }).click();
		await expect(
			page.getByRole("heading", { name: "Naia Shell", level: 1 }),
		).toBeVisible();
	});

	test("keeps project selection usable at a narrow viewport", async ({
		page,
	}) => {
		await boot(page);
		await page.getByTitle("채팅 숨기기 (Ctrl+B)").click();
		await expect(page.locator(".naia-overlay")).toHaveCount(0);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.evaluate((result) => {
			(window as any).__PROJECT_E2E__.result = result;
		}, READY_CATALOG);
		await chooseCheckout(page);
		await page.getByRole("button", { name: /Naia Shell/ }).click();
		await expect(
			page.getByRole("heading", { name: "Naia Shell", level: 1 }),
		).toBeVisible();
		await capture(page, "project-app-narrow.png");
		await expect(page.locator(".projects-app__layout")).toHaveCSS(
			"grid-template-columns",
			/\d+px/,
		);
		const overflow = await page
			.locator(".projects-app")
			.evaluate((node) => node.scrollWidth > node.clientWidth);
		expect(overflow).toBe(false);
	});
});
