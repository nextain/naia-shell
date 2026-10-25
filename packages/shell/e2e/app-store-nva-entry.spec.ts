import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const TAURI_MOCK = `
(function() {
  window.__NAIA_OPENED_URLS = [];
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
  window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
  var callbacks = new Map(); var nextCbId = 1;
  window.__TAURI_INTERNALS__.transformCallback = function(fn, once) { var id = nextCbId++; callbacks.set(id, function(d){ if(once) callbacks.delete(id); return fn && fn(d); }); return id; };
  window.__TAURI_INTERNALS__.unregisterCallback = function(id){ callbacks.delete(id); };
  window.__TAURI_INTERNALS__.runCallback = function(id, d){ var cb = callbacks.get(id); if (cb) cb(d); };
  var eventListeners = new Map();
  window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
  window.__TAURI_INTERNALS__.convertFileSrc = function(p, proto){ return (proto||"asset") + "://localhost/" + encodeURIComponent(p); };
  window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
    if (cmd === "plugin:event|listen") { if(!eventListeners.has(args.event)) eventListeners.set(args.event, []); eventListeners.get(args.event).push(args.handler); return args.handler; }
    if (cmd === "plugin:event|emit" || cmd === "plugin:event|unlisten") return null;
    if (cmd === "get_distribution_channel") return "standard";
    if (cmd === "plugin:opener|open_url") { window.__NAIA_OPENED_URLS.push(args.url); return null; }
    if (cmd === "write_naia_config") return null;
    return undefined;
  };
})();
`;

async function openShell(page: Page): Promise<void> {
	await page.addInitScript(TAURI_MOCK);
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript(() => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "deepseek-v4-flash",
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
	await page.goto("/");
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });
}

test.describe("0.2.4 App Store and NVA entry points", () => {
	test("opens the store and shows the NVA creator without narrow-screen overflow", async ({
		page,
	}) => {
		await openShell(page);

		const storeButton = page.getByRole("button", { name: "App Store" });
		await expect(storeButton).toBeVisible();
		await expect(storeButton).toHaveAttribute("title", "App Store");
		await storeButton.click();
		const openedUrls = () =>
			page.evaluate(
				() =>
					(
						window as unknown as {
							__NAIA_OPENED_URLS: string[];
						}
					).__NAIA_OPENED_URLS,
			);
		await expect.poll(openedUrls).toHaveLength(1);
		expect((await openedUrls())[0]).toMatch(/\/en\/apps$/);
		await storeButton.focus();
		await expect(storeButton).toBeFocused();
		await page.keyboard.press("Enter");
		await expect.poll(openedUrls).toHaveLength(2);

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
		await expect.poll(openedUrls).toHaveLength(3);
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
});
