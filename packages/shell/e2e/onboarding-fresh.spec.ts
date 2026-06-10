/**
 * Fresh onboarding flow E2E test.
 * Covers: agentName → userName → speechStyle → character → background → provider → complete
 * Verifies: localStorage config saved correctly, each step renders, blob URL flow.
 */
import { expect, test } from "@playwright/test";
import { TAURI_BASE_MOCK_FALLBACK } from "./helpers/tauri-base-mock";

const MOCK_ADK_PATH = "/home/user/naia-adk";
const MOCK_BG_FILES = ["anime-rainbow-landscape.jpg", "background-space.png"];
const MOCK_VRM_FILES = ["03-OL_Woman.vrm", "04-Hood_Boy.vrm"];
// Minimal valid 1x1 PNG bytes (used as mock binary payload for read_local_binary)
const MINI_PNG = [
	137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
	0, 0, 0, 1, 8, 2, 0, 0, 0, 144, 119, 83, 222, 0, 0, 0, 12, 73, 68, 65, 84,
	8, 215, 99, 248, 207, 192, 0, 0, 0, 2, 0, 1, 226, 33, 188, 51, 0, 0, 0, 0,
	73, 69, 78, 68, 174, 66, 96, 130,
];

function buildMockScript() {
	return `
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
    window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
    window.__eventListeners = new Map();
    window.__TAURI_INTERNALS__.convertFileSrc = function(p) {
        return "http://asset.localhost/" + encodeURIComponent(p);
    };

    var BG_FILES = ${JSON.stringify(MOCK_BG_FILES)};
    var VRM_FILES = ${JSON.stringify(MOCK_VRM_FILES)};
    var MINI_PNG = new Uint8Array(${JSON.stringify(MINI_PNG)});

    window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
        if (cmd === "plugin:event|listen") {
            var evt = args.event;
            if (!window.__eventListeners.has(evt)) window.__eventListeners.set(evt, []);
            window.__eventListeners.get(evt).push({ callbackId: args.handler });
            return args.handler;
        }
        if (cmd === "plugin:event|emit" || cmd === "plugin:event|unlisten") return null;
        if (cmd === "frontend_log") return;
        if (cmd === "list_skills") return [];
        if (cmd === "list_stt_models") return [];
        if (cmd === "panel_list_installed") return [];
        if (cmd === "plugin:window|get_cursor_position" || cmd === "plugin:window|start_resize_dragging") return null;
        if (cmd === "plugin:window|is_maximized") return false;
        if (cmd === "plugin:window|show") return;
        if (cmd === "plugin:updater|check") return null;
        if (cmd === "copy_bundled_assets") return;
        if (cmd === "list_naia_assets") {
            var sub = args && args.subdir;
            if (sub === "background") return BG_FILES;
            if (sub === "vrm-files") return VRM_FILES;
            if (sub === "bgm-musics") return ["Afternoon Whispers.mp3"];
            return [];
        }
        if (cmd === "read_local_binary") {
            // Return minimal PNG bytes for any file (enough to create a blob URL)
            return Array.from(MINI_PNG);
        }
        if (cmd === "get_linked_channels") return [];
        if (cmd === "get_lab_user_info") return null;
        if (cmd === "get_memory_facts") return [];
        if (cmd === "workspace_get_sessions") return [];
        if (cmd === "workspace_classify_dirs") return [];
        return undefined;
    };
})();
`;
}

async function setupFreshOnboarding(page: import("@playwright/test").Page) {
	await page.addInitScript(buildMockScript());
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript(() => {
		localStorage.setItem("naia-adk-path", "/home/user/naia-adk");
		localStorage.removeItem("naia-config");
	});
	await page.goto("/");
	// Splash screen dismisses after 5s timeout (avatar won't load in test env).
	// Then onboarding-panel renders inside right-content--onboarding.
	await expect(page.locator(".onboarding-panel")).toBeVisible({
		timeout: 15_000,
	});
}

async function clickNext(page: import("@playwright/test").Page) {
	const btn = page.getByRole("button", { name: /다음|Next/i });
	await expect(btn).toBeEnabled({ timeout: 5_000 });
	await btn.click();
	// Wait for the 300ms transition lock
	await page.waitForTimeout(400);
}

test.describe("Fresh onboarding flow", () => {
	test("agentName step is first", async ({ page }) => {
		await setupFreshOnboarding(page);
		await expect(page.locator('input[placeholder="Naia"]')).toBeVisible({
			timeout: 5_000,
		});
		await expect(
			page.getByRole("button", { name: /다음|Next/i }),
		).toBeEnabled();
	});

	test("walks agentName → userName → speechStyle → character → background → provider", async ({
		page,
	}) => {
		await setupFreshOnboarding(page);

		// agentName
		await page.locator('input[placeholder="Naia"]').fill("TestBot");
		await clickNext(page);

		// userName
		await expect(page.locator('input[placeholder="Luke"]')).toBeVisible({
			timeout: 5_000,
		});
		await page.locator('input[placeholder="Luke"]').fill("Tester");
		await clickNext(page);

		// speechStyle
		await clickNext(page);

		// character (VRM) — shows items from mocked list_naia_assets
		await expect(page.locator(".onboarding-step__avatar-item").first()).toBeVisible({
			timeout: 8_000,
		});
		await clickNext(page);

		// background — shows items from mocked list_naia_assets + read_local_binary → blob URL
		await expect(page.locator(".onboarding-step__bg-card").first()).toBeVisible({
			timeout: 10_000,
		});
		// Background thumbnails should be img elements with blob: or http: src
		const bgImg = page.locator(".onboarding-step__bg-img").first();
		await expect(bgImg).toBeVisible({ timeout: 8_000 });
		const imgSrc = await bgImg.getAttribute("src");
		expect(imgSrc).toBeTruthy();
		// blob URL if read_local_binary succeeded, asset URL as fallback
		expect(imgSrc!.startsWith("blob:") || imgSrc!.includes("asset.localhost")).toBe(true);
		await clickNext(page);

		// provider step — shows "나중에 설정" skip link
		await expect(page.getByText(/나중에 설정/)).toBeVisible({ timeout: 5_000 });
	});

	test("completes onboarding and saves config to localStorage", async ({
		page,
	}) => {
		await setupFreshOnboarding(page);

		// Walk through all steps quickly
		await page.locator('input[placeholder="Naia"]').fill("Mochi");
		await clickNext(page);
		await page.locator('input[placeholder="Luke"]').fill("Luke");
		await clickNext(page);
		await clickNext(page); // speechStyle
		await clickNext(page); // character
		// background — wait for blob URL to load before advancing
		await expect(page.locator(".onboarding-step__bg-card").first()).toBeVisible({
			timeout: 10_000,
		});
		await clickNext(page);
		// provider — skip
		await page.getByText(/나중에 설정/).click();
		await page.waitForTimeout(400);
		// complete step — "시작하기" button
		const startBtn = page.getByRole("button", { name: /시작하기|Get Started/i });
		await expect(startBtn).toBeVisible({ timeout: 5_000 });
		await startBtn.click();
		// Wait for the 1200ms onComplete delay
		await page.waitForTimeout(1500);

		// Verify config saved
		const config = await page.evaluate(() =>
			JSON.parse(localStorage.getItem("naia-config") || "{}"),
		);
		expect(config.onboardingComplete).toBe(true);
		expect(config.agentName).toBe("Mochi");
		expect(config.userName).toBe("Luke");
		expect(config.persona).toContain("Mochi");
	});
});
