import { test, expect } from "@playwright/test";

for (const scenario of [
 {name: "desktop-site phone", viewport: {width: 980, height: 2121}, screen: {width: 412, height: 892}, touch: true, mobile: true, zoom: 980/412},
 {name: "phone", viewport: {width: 412, height: 892}, screen: {width: 412, height: 892}, touch: true, mobile: true, zoom: 1},
 {name: "narrow PC", viewport: {width: 500, height: 800}, screen: {width: 500, height: 800}, touch: false, mobile: false, zoom: 1},
 {name: "PC", viewport: {width: 1920, height: 1080}, screen: {width: 1920, height: 1080}, touch: false, mobile: false, zoom: 1},
]) {
 test.describe(scenario.name, () => {
 test.use({viewport: scenario.viewport, hasTouch: scenario.touch});
 test("layout and settings", async ({ page }) => {
 await page.route(/^https?:\/\/(?!(?:localhost|127\.0\.0\.1)(?::|\/|$))/, route => route.abort());
 await page.route("**/v1/profile/balance", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ credits: 100 }) }));
 await page.addInitScript(() => localStorage.setItem("naia-kiosk-passcode-passed", "1"));
 await page.addInitScript(({width, height}) => {
  Object.defineProperty(screen, "width", { configurable: true, value: width });
  Object.defineProperty(screen, "height", { configurable: true, value: height });
 }, scenario.screen);
 await page.goto("/");
 if (scenario.mobile) await expect(page.locator("html")).toHaveAttribute("data-naia-mobile", "true");
 else await expect(page.locator("html")).not.toHaveAttribute("data-naia-mobile", "true");
 expect(await page.locator("html").evaluate(e => Number.parseFloat((e as HTMLElement).style.zoom) || 1)).toBeCloseTo(scenario.zoom);
 const enter = page.getByRole("button", { name: "들어가기", exact: true });
 await expect(enter).toBeEnabled();
 const entryMetrics = await page.locator(".kiosk-entry").evaluate((entry) => {
  const button = entry.querySelector(".kiosk-entry__actions button")!.getBoundingClientRect();
  return { entryHeight: entry.getBoundingClientRect().height, top: button.top, bottom: button.bottom, height: window.innerHeight };
 });
 expect(entryMetrics.top).toBeGreaterThanOrEqual(0);
 expect(entryMetrics.bottom).toBeLessThanOrEqual(entryMetrics.height);
 expect(entryMetrics.entryHeight).toBeLessThanOrEqual(entryMetrics.height + 1);
 await enter.click();
 await expect(page.getByTestId("kiosk-answer-source-gateway")).toHaveText("나이아 서버");
 await expect(page.getByTestId("kiosk-local-answer-toggle")).toContainText("내 기기(웹GPU)");
 await expect(page.locator(".splash-screen")).toHaveCount(0);
 if (scenario.viewport.width !== 1920) {
 const handle = page.locator(".web-mobile-sheet-handle");
 await expect(handle).toBeVisible();
 const sheetRatio = await page.locator(".naia-chat-area").evaluate(e => e.getBoundingClientRect().height / window.innerHeight);
 expect(sheetRatio).toBeGreaterThan(0.40);
 expect(sheetRatio).toBeLessThan(0.44);
 const font = await page.locator(".chat-message .message-content").first().evaluate(e => ({ size: getComputedStyle(e).fontSize, family: getComputedStyle(e).fontFamily }));
 expect(font.size).toBe("16px");
 expect(font.family).toContain("Pretendard");
 for (const [selector, size] of [[".nva-gesture-actions__button", "14px"], [".chat-input", "16px"], [".kiosk-answer-source .kiosk-local-answer-hint", "14px"]]) {
  const el = page.locator(selector).first();
  await expect(el).toHaveCount(1);
  const style = await el.evaluate(e => ({size: getComputedStyle(e).fontSize, family: getComputedStyle(e).fontFamily}));
  expect(style.size).toBe(size); expect(style.family).toContain("Pretendard");
 }
 const box = await handle.boundingBox();
 expect(box).not.toBeNull();
 await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
 await page.mouse.down();
 await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 - 180, { steps: 5 });
 const dragged = await page.evaluate(() => Number.parseFloat(document.documentElement.style.getPropertyValue("--mobile-sheet-drag-height")));
 expect(dragged).toBeGreaterThan(136);
 await page.mouse.up();
 await expect(page.locator(".naia-chat-area")).toHaveAttribute("data-mobile-sheet", "expanded");
 await expect(page.locator(".web-mobile-menu-trigger")).toBeVisible();
 const geometry = await page.evaluate(() => ({scroll: document.documentElement.scrollWidth, width: innerWidth}));
 // Chromium reports root scrollWidth in viewport pixels even when the root is zoomed.
 expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
 for (const selector of [".web-mobile-menu-trigger", ".naia-avatar-corner-trigger"]) {
  const rect = await page.locator(selector).evaluate(e => { const r=e.getBoundingClientRect(); return {left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:innerWidth, height:innerHeight}; });
  expect(rect.left).toBeGreaterThanOrEqual(0); expect(rect.right).toBeLessThanOrEqual(rect.width);
  expect(rect.top).toBeGreaterThanOrEqual(0); expect(rect.bottom).toBeLessThanOrEqual(rect.height);
 }
 await page.locator(".web-mobile-menu-trigger").click();
 if (scenario.name === "desktop-site phone") {
  const assertInViewport = async (selector: string) => {
   const element = page.locator(selector);
   await expect(element).toBeVisible();
   const rect = await element.evaluate(e => { const r = e.getBoundingClientRect(); return {left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight}; });
   expect(rect.left).toBeGreaterThanOrEqual(0); expect(rect.right).toBeLessThanOrEqual(rect.width);
   expect(rect.top).toBeGreaterThanOrEqual(0); expect(rect.bottom).toBeLessThanOrEqual(rect.height);
  };
  await assertInViewport(".web-mobile-menu-list");
  await page.locator(".web-mobile-menu-list button").filter({ hasText: "📁" }).click();
  await assertInViewport(".web-mobile-workspace-close");
  await page.locator(".web-mobile-workspace-close").click();
  await page.locator(".web-mobile-menu-trigger").click();
 }
 await page.getByRole("button", { name: /설정/ }).first().click();
 } else { await page.locator(".app-bar-settings").click(); }
 await expect(page.locator(".settings-tab-bar")).toBeVisible();
 const tabs = page.locator(".settings-tab-btn");
 for (const tab of await tabs.all()) {
  expect(await tab.evaluate(e => ({fits: e.scrollWidth <= e.clientWidth, overflow: getComputedStyle(e).textOverflow}))).toEqual({fits: true, overflow: "clip"});
 }
 const last = tabs.last();
 await last.scrollIntoViewIfNeeded();
 expect(await last.evaluate(e => { const a=e.getBoundingClientRect(), b=e.parentElement!.getBoundingClientRect(); return a.right <= b.right + 1 && a.left >= b.left - 1; })).toBe(true);
 await page.locator('[data-settings-tab="profile"]').click();
 if (scenario.viewport.width !== 1920) {
  expect(await page.locator('.settings-tab').evaluate(e => getComputedStyle(e).gridTemplateColumns.split(' ').length)).toBe(1);
 }
 for (const slot of ["main", "sub", "embedding"]) {
  const value = page.getByTestId(`slot-${slot}`).locator('.settings-summary-value');
  await expect(value).toHaveCount(1);
  await expect(value).toBeHidden();
 }
 await expect(page.locator(".lab-balance-row")).toBeHidden();
 await page.screenshot({ path: process.env.TMPDIR + `/i4-${scenario.name.replaceAll(" ", "-")}.png` });
 if (scenario.name === "desktop-site phone") {
 await page.evaluate(() => { Object.defineProperty(screen, "width", { configurable: true, value: 892 }); Object.defineProperty(screen, "height", { configurable: true, value: 412 }); });
 await page.setViewportSize({ width: 2121, height: 980 });
 await page.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
 await expect(page.locator("html")).not.toHaveAttribute("data-naia-mobile", "true");
 }
 });
 });
}
