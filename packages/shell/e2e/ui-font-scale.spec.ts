import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * Naia Shell E2E — 앱 전체 글자 크기 (UC-UI-FONT-SCALE-20261105, FR-UI-FONT-SCALE.1~3).
 *
 * 1. 저장된 `아주 크게`(1.5)로 시작하면 첫 화면부터 글자가 커져 있다.
 * 2. 1920·1280 폭에서 상단 앱 단추(🖥️🌐📁)가 음악 막대에 가려지지 않는다.
 * 3. BGM 앱 패널이 화면 안에 열린다(2026-11-04 x≈2377 사고 회귀).
 * 4. 설정 탭 줄(프로파일…일반)이 오른쪽에서 잘리지 않는다.
 * 5. 설정 › 일반에서 `작게`를 고르면 즉시 적용·저장된다.
 */

const TAURI_MOCK = `
(function () {
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
  window.__TAURI_INTERNALS__.metadata = {
    currentWindow: { label: "main" },
    currentWebview: { windowLabel: "main", label: "main" },
  };
  var callbacks = new Map(); var nextCbId = 1;
  window.__TAURI_INTERNALS__.transformCallback = function (fn, once) {
    var id = nextCbId++;
    callbacks.set(id, function (data) { if (once) callbacks.delete(id); return fn && fn(data); });
    return id;
  };
  window.__TAURI_INTERNALS__.unregisterCallback = function (id) { callbacks.delete(id); };
  window.__TAURI_INTERNALS__.runCallback = function (id, data) { var cb = callbacks.get(id); if (cb) cb(data); };
  var eventListeners = new Map();
  window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function () {};
  window.__E2E_UI_CONFIG_WRITES__ = [];
  window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
    if (cmd === "plugin:event|listen") {
      if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
      eventListeners.get(args.event).push(args.handler);
      return args.handler;
    }
    if (cmd === "plugin:event|emit" || cmd === "plugin:event|unlisten") return null;
    if (cmd === "secure_store_get") return "e2e-mock-key";
    if (cmd === "write_naia_config") return null;
    if (cmd === "write_naia_ui_config") {
      window.__E2E_UI_CONFIG_WRITES__.push(JSON.parse(args.json));
      return null;
    }
    if (cmd === "detect_gpu_vram") return null;
    if (cmd === "send_to_agent_command") return undefined;
    return undefined;
  };
})();
`;

async function boot(page: Page, uiFontScale: string) {
	await page.addInitScript(TAURI_MOCK);
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript((scale) => {
		if (sessionStorage.getItem("e2e-seeded")) return;
		sessionStorage.setItem("e2e-seeded", "1");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "e2e-mock-key",
				enableTools: false,
				locale: "ko",
				theme: "midnight",
				uiFontScale: scale,
				onboardingComplete: true,
			}),
		);
	}, uiFontScale);
	await page.goto("/");
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });
}

async function box(page: Page, selector: string) {
	const b = await page.locator(selector).first().boundingBox();
	expect(b, selector).not.toBeNull();
	return b as { x: number; y: number; width: number; height: number };
}

async function expectTopBarUsable(page: Page) {
	const viewport = page.viewportSize();
	if (!viewport) throw new Error("viewport");
	const pill = await box(page, ".bgm-player");
	const strip = await box(page, ".app-bar-tabs");
	// the tab strip and the music pill never overlap
	expect(strip.x + strip.width).toBeLessThanOrEqual(pill.x + 0.5);
	// the first three app tabs (🖥️🌐📁) are fully visible inside the strip
	const tabs = page.locator(".app-bar-tabs > .app-bar-tab");
	for (let i = 0; i < 3; i++) {
		const tab = await tabs.nth(i).boundingBox();
		expect(tab, `app tab ${i}`).not.toBeNull();
		if (!tab) continue;
		expect(tab.x).toBeGreaterThanOrEqual(strip.x - 0.5);
		expect(tab.x + tab.width).toBeLessThanOrEqual(strip.x + strip.width + 0.5);
	}
	// settings gear remains on screen
	const gear = await box(page, ".app-bar-settings");
	expect(gear.x + gear.width).toBeLessThanOrEqual(viewport.width + 0.5);
}

async function expectBgmPanelInside(page: Page) {
	const viewport = page.viewportSize();
	if (!viewport) throw new Error("viewport");
	await page.locator(".bgm-icon").click();
	const panel = page.locator(".bgm-yt-app:not(.bgm-yt-app--hidden)");
	await expect(panel).toBeVisible();
	// wait for the enter animation (scaleY) to settle
	await page.waitForTimeout(400);
	const b = await box(page, ".bgm-yt-app");
	expect(b.x).toBeGreaterThanOrEqual(0);
	expect(b.y).toBeGreaterThanOrEqual(0);
	expect(b.x + b.width).toBeLessThanOrEqual(viewport.width);
	expect(b.y).toBeLessThan(viewport.height);
	return panel;
}

async function expectSettingsTabsInside(page: Page) {
	const viewport = page.viewportSize();
	if (!viewport) throw new Error("viewport");
	const bar = await box(page, ".settings-tab-bar");
	const buttons = page.locator(".settings-tab-btn");
	const count = await buttons.count();
	expect(count).toBeGreaterThanOrEqual(9);
	for (let i = 0; i < count; i++) {
		const b = await buttons.nth(i).boundingBox();
		expect(b, `settings tab ${i}`).not.toBeNull();
		if (!b) continue;
		expect(b.x + b.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
		expect(b.x + b.width).toBeLessThanOrEqual(viewport.width + 0.5);
	}
}

for (const viewport of [
	{ width: 1920, height: 1080 },
	{ width: 1280, height: 720 },
]) {
	test(`아주 크게 — ${viewport.width}px 상단 막대·BGM 패널·설정 탭 줄이 화면 안에 있다`, async ({
		page,
	}, testInfo) => {
		await page.setViewportSize(viewport);
		await boot(page, "xlarge");

		const root = page.locator("html");
		await expect(root).toHaveAttribute("data-ui-font-scale", "xlarge");
		// .app-bar-tab-icon is 14px at 1.0 → 21px at 1.5
		await expect(page.locator(".app-bar-tab-icon").first()).toHaveCSS(
			"font-size",
			"21px",
		);

		await expectTopBarUsable(page);
		await expectBgmPanelInside(page);
		await page.screenshot({
			path: testInfo.outputPath(`xlarge-${viewport.width}-bgm.png`),
		});
		await page.locator(".bgm-app-close").click();

		await page.locator(".app-bar-settings").click();
		await expect(page.locator(".settings-tab-bar")).toBeVisible();
		await expectSettingsTabsInside(page);
		await page.locator('[data-settings-tab="general"]').click();
		await expect(page.getByTestId("ui-font-scale-section")).toBeVisible();
		await page.screenshot({
			path: testInfo.outputPath(`xlarge-${viewport.width}-settings.png`),
		});
	});
}

test("설정 › 일반에서 고른 글자 크기가 즉시 적용·저장된다", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await boot(page, "normal");
	await expect(page.locator("html")).toHaveAttribute(
		"data-ui-font-scale",
		"normal",
	);
	await page.locator(".app-bar-settings").click();
	await page.locator('[data-settings-tab="general"]').click();

	const group = page.getByRole("radiogroup", { name: "글자 크기" });
	await expect(group).toBeVisible();
	await expect(group.getByRole("radio")).toHaveText([
		"작게",
		"보통",
		"크게",
		"아주 크게",
	]);
	await expect(page.getByTestId("ui-font-scale-normal")).toHaveAttribute(
		"aria-checked",
		"true",
	);

	// keyboard: focus the selected option, ArrowRight → 크게
	await page.getByTestId("ui-font-scale-normal").focus();
	await page.keyboard.press("ArrowRight");
	await expect(page.getByTestId("ui-font-scale-large")).toBeFocused();
	await expect(page.locator("html")).toHaveAttribute(
		"data-ui-font-scale",
		"large",
	);
	await page.getByTestId("ui-font-scale-section").screenshot({
		path: testInfo.outputPath("font-scale-focus.png"),
	});

	await page.getByTestId("ui-font-scale-small").click();
	await expect(page.locator("html")).toHaveAttribute(
		"data-ui-font-scale",
		"small",
	);
	const scaleVar = await page.evaluate(() =>
		getComputedStyle(document.documentElement)
			.getPropertyValue("--ui-font-scale")
			.trim(),
	);
	expect(scaleVar).toBe("0.9");
	const stored = await page.evaluate(
		() => JSON.parse(localStorage.getItem("naia-config") || "{}").uiFontScale,
	);
	expect(stored).toBe("small");
	// the debounced file sync writes the choice into ui-config.json
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const writes = (
						window as unknown as {
							__E2E_UI_CONFIG_WRITES__?: Array<Record<string, unknown>>;
						}
					).__E2E_UI_CONFIG_WRITES__;
					return writes?.at(-1)?.uiFontScale ?? null;
				}),
			{ timeout: 10_000 },
		)
		.toBe("small");

	// survives a reload (startup applies the stored scale)
	await page.reload();
	await expect(page.locator(".chat-app")).toBeVisible({ timeout: 15_000 });
	await expect(page.locator("html")).toHaveAttribute(
		"data-ui-font-scale",
		"small",
	);

	// narrow window: the radio group wraps inside the settings column.
	// As in thinking-settings.spec, hide the chat panel first so the settings
	// app gets the full 360px (the panel alone is 320px wide).
	if (!(await page.locator(".settings-tab-bar").isVisible())) {
		await page.locator(".app-bar-settings").click();
	}
	await page.locator('[data-settings-tab="general"]').click();
	const hideNaiaBtn = page.getByRole("button", { name: /채팅 숨기기/i });
	if (await hideNaiaBtn.isVisible()) await hideNaiaBtn.click();
	await page.setViewportSize({ width: 360, height: 740 });
	const section = page.getByTestId("ui-font-scale-section");
	await expect(section).toBeVisible();
	const sectionBox = await section.boundingBox();
	expect(sectionBox).not.toBeNull();
	if (sectionBox)
		expect(sectionBox.x + sectionBox.width).toBeLessThanOrEqual(360);
	await section.screenshot({
		path: testInfo.outputPath("font-scale-narrow.png"),
	});
});
