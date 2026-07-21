import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const CODING_WORKER_TAURI_MOCK = `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__TAURI_INTERNALS__.metadata = {
		currentWindow: { label: "main" },
		currentWebview: { windowLabel: "main", label: "main" },
	};
	window.__TAURI_INTERNALS__.transformCallback = function() { return 1; };
	window.__TAURI_INTERNALS__.unregisterCallback = function() {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
	window.__TAURI_INTERNALS__.invoke = async function(cmd) {
		if (cmd === "plugin:event|listen") return 1;
		if (cmd === "plugin:event|unlisten") return null;
		if (cmd === "workspace_get_pty_agents") return {};
		return undefined;
	};
})();
`;

test.beforeEach(async ({ page }) => {
	await page.addInitScript({ content: CODING_WORKER_TAURI_MOCK });
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript({
		content: `localStorage.setItem("naia-chat-mode-v1", "app");
			localStorage.setItem("naia-config", JSON.stringify({
				onboardingComplete: true,
				provider: "codex",
				model: "gpt-5.4",
				apiKey: "",
				workspaceRoot: "D:\\\\course\\\\worker-root"
			}));`,
	});
	await page.goto("/");
	await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 15_000 });
});

test("UC-CODEX-WORKER-LIFECYCLE: unpaired worker API never fabricates a queued worker", async ({
	page,
}) => {
	await page.locator('button[data-panel-id="workspace"]').click();
	await expect(page.locator(".workspace-panel")).toBeVisible();

	await page.getByTestId("coding-workers-toggle").click();
	await expect(page.getByTestId("coding-workers")).toBeVisible();
	await expect(page.getByTestId("coding-worker-error")).toContainText(
		"Coding worker service is not connected yet.",
	);

	await page
		.getByTestId("coding-worker-worktree")
		.fill("D:\\course\\worker-one");
	await page.getByTestId("coding-worker-task").fill("Create a lesson outline");
	await page.getByTestId("coding-worker-start").click();

	await expect(page.getByTestId("coding-worker-error")).toContainText(
		"Coding worker service is not connected yet.",
	);
	await expect(
		page.locator('[data-testid^="coding-worker-worker-"]'),
	).toHaveCount(0);
});
