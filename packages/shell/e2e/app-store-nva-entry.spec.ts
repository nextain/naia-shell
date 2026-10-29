import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const TAURI_MOCK = `
(function() {
  window.__NAIA_OPENED_URLS = [];
  window.__NAIA_WINDOWS = [];
  window.__NAIA_CREATED_WINDOWS = [];
  window.__NAIA_WINDOW_FOCUS = [];
  window.__NAIA_INSTALLED_APPS = [];
  window.__NAIA_STORE_INSTALL_CALLS = [];
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
  window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
  var callbacks = new Map(); var nextCbId = 1;
  window.__TAURI_INTERNALS__.transformCallback = function(fn, once) { var id = nextCbId++; callbacks.set(id, function(d){ if(once) callbacks.delete(id); return fn && fn(d); }); return id; };
  window.__TAURI_INTERNALS__.unregisterCallback = function(id){ callbacks.delete(id); };
  window.__TAURI_INTERNALS__.runCallback = function(id, d){ var cb = callbacks.get(id); if (cb) cb(d); };
  var eventListeners = new Map();
  window.__NAIA_FIRE_EVENT = function(event, payload) { (eventListeners.get(event) || []).forEach(function(cb){ window.__TAURI_INTERNALS__.runCallback(cb, {event, id: 0, payload}); }); };
  window.__NAIA_EVENT_LISTENER_COUNT = function(event) { return (eventListeners.get(event) || []).length; };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
  window.__TAURI_INTERNALS__.convertFileSrc = function(p, proto){ return (proto||"asset") + "://localhost/" + encodeURIComponent(p); };
  window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
    if (cmd === "plugin:event|listen") { if(!eventListeners.has(args.event)) eventListeners.set(args.event, []); eventListeners.get(args.event).push(args.handler); return args.handler; }
    if (cmd === "plugin:event|emit" || cmd === "plugin:event|unlisten") return null;
    if (cmd === "plugin:store|get") return args && args.key === "naiaKey" ? ["e2e-mock-key", true] : [null, false];
    if (cmd === "plugin:window|get_all_windows") return window.__NAIA_WINDOWS;
    if (cmd === "plugin:webview|create_webview_window") { window.__NAIA_WINDOWS.push(args.options.label); window.__NAIA_CREATED_WINDOWS.push(args.options); return null; }
    if (cmd === "plugin:window|show") return null;
    if (cmd === "plugin:window|set_focus") { window.__NAIA_WINDOW_FOCUS.push(args.label); return null; }
    if (cmd === "focus_or_create_app_store_window") { if (!window.__NAIA_CREATED_WINDOWS.length) window.__NAIA_CREATED_WINDOWS.push(args); window.__NAIA_WINDOW_FOCUS.push("app-store"); return null; }
    if (cmd === "app_store_has_entitlement") return true;
    if (cmd === "app_install_store") { window.__NAIA_STORE_INSTALL_CALLS.push(args); if (window.__NAIA_STORE_INSTALL_CALLS.length === 1) return Promise.reject('PERMISSION_EXPANSION:["permissions: browser","host_permissions: https://example.com/*"]'); return { id: args.appId, name: "Demo App", path: "/tmp/demo" }; }
    if (cmd === "get_distribution_channel") return "standard";
    if (cmd === "app_list_installed") return window.__NAIA_INSTALLED_APPS || [];
    if (cmd === "app_verify_installed_store_app") return true;
    if (cmd === "plugin:opener|open_url") { window.__NAIA_OPENED_URLS.push(args.url); return null; }
    if (cmd === "write_naia_config") return null;
    return undefined;
  };
})();
`;

async function openShell(
	page: Page,
	installedApps: Array<Record<string, unknown>> = [],
): Promise<void> {
	await page.addInitScript(TAURI_MOCK);
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript((apps) => {
		(
			window as Window & { __NAIA_INSTALLED_APPS?: unknown[] }
		).__NAIA_INSTALLED_APPS = apps;
	}, installedApps);
	await page.addInitScript(() => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "deepseek-v4-flash",
				naiaKey: "e2e-mock-key",
				apiKey: "e2e-mock-key",
				enableTools: false,
				ttsEnabled: false,
				locale: "en",
				onboardingComplete: true,
			}),
		);
	});
	await page.route("**/v1/pricing", (route) =>
		route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
	);
	await page.route("**/v1/models", (route) =>
		route.fulfill({ status: 503, contentType: "application/json", body: "[]" }),
	);
	await page.goto("/", { waitUntil: "commit" });
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 30_000 });
}

test.describe("0.2.4 App Store and NVA entry points", () => {
	test("keeps one focused store window, refreshes app lists on store events, and shows the NVA creator", async ({
		page,
	}) => {
		await openShell(page);

		const storeButton = page.getByRole("button", { name: "App Store" });
		await expect(storeButton).toBeVisible();
		await expect(storeButton).toHaveAttribute("title", "App Store");
		await page.setViewportSize({ width: 360, height: 800 });
		await storeButton.focus();
		const storeButtonBounds = await storeButton.boundingBox();
		expect(storeButtonBounds).not.toBeNull();
		expect(storeButtonBounds!.x).toBeGreaterThanOrEqual(0);
		expect(storeButtonBounds!.x + storeButtonBounds!.width).toBeLessThanOrEqual(360);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth),
		).toBeLessThanOrEqual(360);
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.keyboard.press("Enter");
		const storeWindows = () =>
			page.evaluate(() => (window as any).__NAIA_CREATED_WINDOWS);
		await expect.poll(storeWindows).toHaveLength(1);
		const [storeWindow] = await storeWindows();
		expect(storeWindow.url).toMatch(/^https:\/\/(?:www|dev)\.naia\.land\/en\/apps$/);
		const storeUrl = new URL(storeWindow.url);
		expect(storeUrl.protocol).toBe("https:");
		expect(storeUrl.pathname).toBe("/en/apps");
		await expect(storeButton).toBeFocused();
		await page.keyboard.press("Enter");
		await expect.poll(storeWindows).toHaveLength(1);
		await expect
			.poll(() =>
				page.evaluate(() => (window as any).__NAIA_WINDOW_FOCUS.length),
			)
			.toBeGreaterThan(1);
		await expect
			.poll(() =>
				page.evaluate(() =>
					(window as any).__NAIA_EVENT_LISTENER_COUNT("installed-apps-changed"),
				),
			)
			.toBeGreaterThan(0);

		await page.evaluate(() => {
			(window as any).__NAIA_INSTALLED_APPS = [
				{
					id: "land.naia.demo",
					name: "Demo App",
					version: "1.0.0",
					htmlEntry: "/tmp/demo/index.html",
				},
			];
		});
		await page.evaluate(() =>
			(window as any).__NAIA_FIRE_EVENT("installed-apps-changed", null),
		);
		await expect(page.getByTitle("Demo App")).toBeVisible();
		await page.evaluate(() => {
			(window as any).__NAIA_INSTALLED_APPS = [];
		});
		const countBeforeCloseEvent = await page.evaluate(
			() => (window as any).__NAIA_INSTALLED_APPS.length,
		);
		await page.evaluate(() =>
			(window as any).__NAIA_FIRE_EVENT("app-store-closed", null),
		);
		await expect(page.getByTitle("Demo App")).toHaveCount(0);
		expect(countBeforeCloseEvent).toBe(0);

		await page.evaluate(() => (window as any).__NAIA_FIRE_EVENT("app_install_requested", {
			appId: "land.naia.demo", name: "Demo App", state: "one-time-state", storeOrigin: "https://dev.naia.land",
		}));
		await expect(page.getByTestId("app-install-product")).toBeVisible();
		await page.getByRole("button", { name: "설치" }).click();
		const permissions = page.getByTestId("permission-expansion");
		await expect(permissions).toBeVisible();
		await expect(permissions).toContainText("permissions: browser");
		await page.getByRole("button", { name: /Allow these permissions/ }).click();
		await expect.poll(() => page.evaluate(() => (window as any).__NAIA_STORE_INSTALL_CALLS.length)).toBe(2);
		expect(await page.evaluate(() => (window as any).__NAIA_STORE_INSTALL_CALLS.map((call: any) => call.allowPermissionExpansion))).toEqual([false, true]);

		await page.getByRole("button", { name: /^(Settings|설정)$/ }).click();
		await page.locator('[data-settings-tab="avatar"]').click();
		const createAvatar = page.getByRole("button", {
			name: "Create NVA avatar",
		});
		await expect(createAvatar).toBeVisible();
		await expect(
			page.getByText("Make a personal video avatar in Naia Video Studio."),
		).toBeVisible();
		await createAvatar.focus();
		await expect(createAvatar).toBeFocused();
		await page.keyboard.press("Enter");
		const openedUrls = () =>
			page.evaluate(() => (window as any).__NAIA_OPENED_URLS);
		await expect.poll(openedUrls).toHaveLength(1);
		expect((await openedUrls()).slice(-1)[0]).toMatch(
			/\/en\/studio\/nva\/create$/,
		);

		await page.setViewportSize({ width: 360, height: 800 });
		await expect(createAvatar).toBeVisible();
		const layout = await page.evaluate(() => {
			const action = document
				.querySelector(".settings-nva-create__button")!
				.getBoundingClientRect();
			return {
				viewportWidth: window.innerWidth,
				pageWidth: document.documentElement.scrollWidth,
				actionRight: action.right,
				actionLeft: action.left,
			};
		});
		expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewportWidth);
		expect(layout.actionLeft).toBeGreaterThanOrEqual(0);
		expect(layout.actionRight).toBeLessThanOrEqual(layout.viewportWidth);
	});

	test("renders a Store app SVG icon as a contained image at narrow width", async ({
		page,
	}) => {
		await openShell(page, [
			{
				id: "visual-store-icon",
				name: "Visual Store Icon",
				store_signature_verified: true,
				iconSvg:
					'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="red"/></svg>',
			},
		]);
		const button = page.locator(
			'.app-bar-tab[data-app-id="visual-store-icon"]',
		);
		const icon = button.locator("img.app-bar-tab-icon--svg");
		await expect(button).toBeVisible();
		await expect(icon).toHaveAttribute("alt", "");
		await expect(icon).toHaveAttribute("src", /^data:image\/svg\+xml,/);
		await page.setViewportSize({ width: 360, height: 800 });
		const bounds = await icon.boundingBox();
		expect(bounds).not.toBeNull();
		expect(bounds!.width).toBe(16);
		expect(bounds!.height).toBe(16);
	});
});
