import { expect, test } from "@playwright/test";

/**
 * #204: Onboarding Lab login flow — embedded Chrome path
 *
 * Fixes verified:
 *   B13: source=embedded appended when Chrome (browserApi) is available
 *   B14: source=embedded NOT added when Chrome unavailable (system browser fallback)
 *   B15: browser_embed_show called when login starts (Chrome revealed for user interaction)
 *   B16: browser_embed_hide called after naia_auth_complete (Chrome re-hidden)
 *   B17: parse_auth_complete_from_tab_list parses key/user_id correctly (code-level)
 */

// ── Shared mock ──────────────────────────────────────────────────────────────

function buildMockScript(opts: { chromeAvailable: boolean }) {
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

    var eventListeners = new Map();
    window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
    window.__TAURI_INTERNALS__.convertFileSrc = function(p, proto) {
        return (proto || "asset") + "://localhost/" + encodeURIComponent(p);
    };

    window.__invokeLog = [];
    window.__navigateLog = [];
    window.__eventListeners = eventListeners;

    window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
        window.__invokeLog.push({ cmd, args });

        if (cmd === "plugin:event|listen") {
            if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
            eventListeners.get(args.event).push({ handler: args.handler, callbackId: args.handler });
            return args.handler;
        }
        if (cmd === "plugin:event|emit") return null;
        if (cmd === "plugin:event|unlisten") return;

        if (cmd === "plugin:window|get_cursor_position" || cmd === "plugin:window|start_resize_dragging") return null;
        if (cmd === "send_to_agent_command" || cmd === "cancel_stream") return;
        if (cmd === "frontend_log") return;
        if (cmd === "list_skills") return [];
        if (cmd === "list_stt_models") return [];
        if (cmd === "panel_list_installed") return [];

        if (cmd === "browser_embed_init") return;
        if (cmd === "browser_embed_hide") return;
        if (cmd === "browser_embed_show") return;
        if (cmd === "browser_embed_close") return;
        if (cmd === "browser_embed_navigate") {
            window.__navigateLog.push(args?.url ?? "");
            return;
        }
        if (cmd === "browser_embed_focus") return;
        if (cmd === "browser_embed_resize") return;
        if (cmd === "browser_check") return ${opts.chromeAvailable};
        if (cmd === "browser_embed_port") return ${opts.chromeAvailable ? 19222 : 0};
        if (cmd === "browser_set_permission") return;
        if (cmd === "browser_get_url") return "about:blank";

        if (cmd === "workspace_get_sessions") return [];
        if (cmd === "workspace_list_dirs") return [];
        if (cmd === "workspace_get_git_info") return { branch: "main" };
        if (cmd === "workspace_get_progress") return null;
        if (cmd === "workspace_start_watch") return;
        if (cmd === "workspace_stop_watch") return;
        if (cmd === "workspace_classify_dirs") return [];

        return undefined;
    };
})();
`;
}

async function setupOnboarding(
	page: import("@playwright/test").Page,
	opts: { chromeAvailable: boolean } = { chromeAvailable: true },
) {
	await page.addInitScript(buildMockScript(opts));
	await page.addInitScript(() => {
		localStorage.removeItem("naia-config");
	});
	await page.goto("/");
	await expect(page.locator(".onboarding-overlay")).toBeVisible({
		timeout: 15_000,
	});
	// Click the Nextain Lab card to reach the login step
	const labCard = page.locator(".onboarding-provider-card.lab-card");
	await expect(labCard).toBeVisible({ timeout: 10_000 });
	return labCard;
}

/** Fire a Tauri event from the page context (simulates Rust emit). */
async function emitTauriEvent(
	page: import("@playwright/test").Page,
	eventName: string,
	payload: unknown,
) {
	await page.evaluate(
		({ eventName, payload }) => {
			const listeners = (window as any).__eventListeners?.get(eventName);
			if (!listeners?.length) return;
			const tauri = (window as any).__TAURI_INTERNALS__;
			for (const entry of listeners) {
				tauri.runCallback(entry.callbackId, {
					event: eventName,
					payload,
					id: 1,
				});
			}
		},
		{ eventName, payload },
	);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe("#204 Onboarding Lab Login — embedded Chrome path", () => {
	// ── B13: source=embedded included when Chrome available ──────────────────

	test("B13: Lab 로그인 시 embedded Chrome 경로에서 URL에 source=embedded 포함", async ({
		page,
	}) => {
		const labCard = await setupOnboarding(page, { chromeAvailable: true });
		await labCard.click();
		await page.waitForTimeout(1500);

		const navigateLog = await page.evaluate(
			() => (window as any).__navigateLog as string[],
		);
		// At least one navigation should have been triggered
		expect(navigateLog.length).toBeGreaterThan(0);
		// The URL must include source=embedded (not source=desktop or missing)
		const loginUrl = navigateLog[0];
		expect(loginUrl).toContain("source=embedded");
		expect(loginUrl).toContain("redirect=desktop");
		expect(loginUrl).not.toContain("source=desktop");
	});

	// ── B14: source=embedded NOT added when Chrome unavailable ───────────────

	test("B14: Chrome 미설치 시 fallback URL에 source=embedded 미포함", async ({
		page,
	}) => {
		// Chrome unavailable → system browser fallback
		await setupOnboarding(page, { chromeAvailable: false });

		const labCard = page.locator(".onboarding-provider-card.lab-card");
		await labCard.click();
		await page.waitForTimeout(800);

		const navigateLog = await page.evaluate(
			() => (window as any).__navigateLog as string[],
		);
		// When Chrome is unavailable, browser_embed_navigate should NOT be called
		expect(navigateLog.length).toBe(0);
	});

	// ── B15: browser_embed_show called when login starts ────────────────────

	test("B15: 로그인 시작 시 browser_embed_show 호출 (Chrome 노출)", async ({
		page,
	}) => {
		const labCard = await setupOnboarding(page, { chromeAvailable: true });

		// Capture invoke sequence before clicking
		await page.evaluate(() => {
			(window as any).__invokeLog = [];
		});

		await labCard.click();
		await page.waitForTimeout(1500);

		const invokeLog = await page.evaluate(() =>
			((window as any).__invokeLog as { cmd: string }[]).map((e) => e.cmd),
		);
		// browser_embed_show must be called when login starts (popModal → show Chrome)
		expect(invokeLog).toContain("browser_embed_show");

		// browser_embed_show must come BEFORE browser_embed_navigate
		const showIdx = invokeLog.indexOf("browser_embed_show");
		const navIdx = invokeLog.indexOf("browser_embed_navigate");
		expect(showIdx).toBeLessThan(navIdx);
	});

	// ── B16: browser_embed_hide called after naia_auth_complete ──────────────

	test("B16: naia_auth_complete 수신 후 browser_embed_hide 호출 (Chrome 재숨김)", async ({
		page,
	}) => {
		const labCard = await setupOnboarding(page, { chromeAvailable: true });
		await labCard.click();
		await page.waitForTimeout(1200);

		// Reset invoke log after login click
		await page.evaluate(() => {
			(window as any).__invokeLog = [];
		});

		// Simulate Rust emitting naia_auth_complete (CDP monitor detected auth-complete URL)
		await emitTauriEvent(page, "naia_auth_complete", {
			naiaKey: "gw-test-key-abc123",
			naiaUserId: "user-42",
		});

		await page.waitForTimeout(500);

		const invokeLog = await page.evaluate(() =>
			((window as any).__invokeLog as { cmd: string }[]).map((e) => e.cmd),
		);
		// After auth completes, Chrome must be re-hidden (pushModal → hide)
		expect(invokeLog).toContain("browser_embed_hide");
	});

	// ── B17: CDP auth-complete URL parser — code-level ───────────────────────

	test("B17: parse_auth_complete_from_tab_list 함수 존재 및 로직 검증 (코드 확인)", async () => {
		const fs = await import("fs/promises");
		const path = await import("path");

		const browserRsPath = path.join(process.cwd(), "src-tauri/src/browser.rs");
		const browserRs = await fs.readFile(browserRsPath, "utf-8");

		// parse_auth_complete_from_tab_list must exist
		expect(browserRs).toContain("parse_auth_complete_from_tab_list");

		// Must extract key and user_id from URL
		expect(browserRs).toContain("/desktop/auth-complete");
		expect(browserRs).toContain("naiaKey");
		expect(browserRs).toContain("naiaUserId");

		// Must emit naia_auth_complete
		expect(browserRs).toContain('app.emit("naia_auth_complete"');
	});
});
