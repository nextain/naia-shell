import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// Web (browser) edition screen checks for requirement bundle A
// (R8, R6, R1, R2, R5, R12). Each viewport boots the web shell once and runs the
// checks in order on the same page.
test.skip(process.env.NAIA_E2E_WEB !== "1" || process.env.VITE_NAIA_WEB_LLM !== "fake", "requires web runtime and fake model");

const SHOT_DIR = process.env.NAIA_E2E_SHOT_DIR;
const TAROT_PACKAGE_ICON = process.env.NAIA_E2E_TAROT_ICON;
const FIXTURE_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#3b2a5a"/><circle cx="32" cy="30" r="14" fill="#f4d58d"/></svg>';
const ICON_SVG = TAROT_PACKAGE_ICON && existsSync(TAROT_PACKAGE_ICON) ? readFileSync(TAROT_PACKAGE_ICON, "utf8") : FIXTURE_ICON;
const GREETING = "어서 와요! 저는 시계공 틴커예요.\n\n오늘은 어떤 이야기를 해 볼까요?";

// A hosted mini app whose own menu button sits in its top-right corner — the
// spot the shell close button used to cover (R5).
const TAROT_HTML = `<!doctype html><html><body style="margin:0;background:#1c1530;color:#fff;font:14px sans-serif">
<header style="display:flex;justify-content:space-between;align-items:center;height:44px;padding:0 8px">
<b>Cafe Lua</b><button id="menu" style="width:36px;height:36px">☰</button></header>
<p id="hit">idle</p>
<script>document.getElementById("menu").onclick=()=>{document.getElementById("hit").textContent="menu-open"}</script>
</body></html>`;

// Minimal stand-in for the hosted character-card bundle: the start button
// pushes the same `naia-app:context` payload the real app sends.
const CHARCARD_HTML = `<!doctype html><html><body style="margin:0;background:#101826;color:#fff;font:14px sans-serif">
<button id="start" style="margin:60px 12px;padding:10px 16px">이 캐릭터로 대화 시작</button>
<script>
const greeting = ${JSON.stringify(GREETING)};
document.getElementById("start").onclick = () => {
	const roleplay = "[Character]\\nTinker\\n\\n[Opening Greeting — You have already started the conversation with this message]\\n" + greeting + "\\n\\n[Safety Rule]\\nroleplay only";
	window.parent.postMessage({ type: "naia-app:context", context: { type: "charcard", data: { roleplay, character: "Tinker", user: "나", specVersion: "v3", truncated: false, truncatedParts: [] } } }, "*");
};
</script></body></html>`;

async function shot(page: Page, name: string, width: number) {
	if (!SHOT_DIR) return;
	mkdirSync(SHOT_DIR, { recursive: true });
	await page.screenshot({ path: `${SHOT_DIR}/${name}-${width}.png` });
}

// Narrow portrait windows hide the top bar by design and reach apps through
// the ☰ menu, so the checks drive whichever control a user of that size has.
function isPortrait(page: Page) {
	const size = page.viewportSize();
	return Boolean(size && size.height > size.width);
}

async function openSettings(page: Page) {
	if (isPortrait(page)) {
		await page.locator(".web-mobile-menu-trigger").click();
		await page.locator(".web-mobile-menu-list button", { hasText: "⚙" }).click();
	} else {
		await page.locator(".app-bar-settings").click();
	}
	await expect(page.locator(".settings-tab-btn").nth(1)).toBeVisible({ timeout: 60_000 });
}

async function openInstalledApp(page: Page, appId: string) {
	const tab = page.locator(`.app-bar-tab[data-app-id="${appId}"]`);
	// The portrait top bar is hidden; a dispatched click stands in for the
	// desktop-width tab press so the app still mounts.
	if (await tab.isVisible()) await tab.click();
	else await tab.dispatchEvent("click");
}

async function closeSettings(page: Page) {
	await page.locator(".app-bar-settings").dispatchEvent("click");
	// Settings stays mounted (hidden) after closing, so check the toggle state.
	await expect(page.locator(".app-bar-settings--active")).toHaveCount(0);
}

for (const viewport of [
	{ width: 1280, height: 720 },
	{ width: 390, height: 844 },
]) {
	test.describe.serial(`web screen bundle A (${viewport.width}x${viewport.height})`, () => {
		let context: BrowserContext;
		let page: Page;

		test.beforeAll(async ({ browser }) => {
			test.setTimeout(600_000);
			context = await browser.newContext({ viewport, locale: "ko-KR" });
			page = await context.newPage();
			await page.route("**/web-adk/*.json", async (route) => {
				const response = await route.fetch();
				const bundle = await response.json();
				const agents = bundle.files.find((file: { path: string }) => file.path === "AGENTS.md");
				await route.fulfill({ json: { ...bundle, files: agents ? [agents] : [], dirs: [] } });
			});
			await page.route("**/hosted-apps/cafelua-tarot/app.json", (route) => route.fulfill({ json: { id: "land.naia.cafelua-tarot", iconUrl: "icon.svg" } }));
			await page.route("**/hosted-apps/cafelua-tarot/icon.svg", (route) => route.fulfill({ body: ICON_SVG, contentType: "image/svg+xml" }));
			await page.route("**/hosted-apps/cafelua-tarot/index.html", (route) => route.fulfill({ body: TAROT_HTML, contentType: "text/html; charset=utf-8" }));
			await page.route("**/hosted-apps/naia-charcard/index.html", (route) => route.fulfill({ body: CHARCARD_HTML, contentType: "text/html; charset=utf-8" }));
			await page.addInitScript(() => {
				if (!localStorage.getItem("naia-config")) localStorage.setItem("naia-config", JSON.stringify({ provider: "webllm", model: "Qwen3-4B-q4f32_1-MLC", ttsEnabled: false, locale: "ko" }));
				if (!localStorage.getItem("naia-web-llm-model")) localStorage.setItem("naia-web-llm-model", "Qwen3-4B-q4f32_1-MLC");
			});
			await page.goto("/");
			await page.getByTestId("web-workspace-start-default").click();
			await expect.poll(() => page.evaluate(() => window.__NAIA_WEB_ADK_STATUS__?.().phase), { timeout: 180_000 }).toBe("ready");
			await expect(page.locator(isPortrait(page) ? ".web-mobile-menu-trigger" : ".app-bar-settings")).toBeVisible({ timeout: 60_000 });
		});

		test.afterAll(async () => {
			await context?.close();
		});

		test(`R8: YouTube music player sits after the web status pills and credit (${viewport.width})`, async () => {
			test.setTimeout(180_000);
			const bar = page.locator(".app-bar");
			const harness = bar.getByTestId("web-runtime-harness-bar");
			const bgm = bar.locator(".bgm-player").first();
			const settings = bar.locator(".app-bar-settings");
			await expect(harness).toHaveCount(1);
			await expect(bgm).toHaveCount(1);
			const order = await page.evaluate(() => {
				const q = (s: string) => document.querySelector(s);
				const pos = (a: Element | null, b: Element | null) =>
					a && b ? Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) : null;
				const credit = q(".app-bar .web-credit") ?? q("[data-testid='web-login-free-credits-btn']");
				return {
					harnessBeforeBgm: pos(q("[data-testid='web-runtime-harness-bar']"), q(".app-bar .bgm-player")),
					creditBeforeBgm: pos(credit, q(".app-bar .bgm-player")),
					settingsBeforeBgm: pos(q(".app-bar-settings"), q(".app-bar .bgm-player")),
				};
			});
			expect(order).toEqual({ harnessBeforeBgm: true, creditBeforeBgm: true, settingsBeforeBgm: true });
			if (isPortrait(page)) {
				await expect(bgm).toBeHidden();
				await expect(page.locator(".web-mobile-menu-trigger")).toBeVisible();
			} else {
				const h = await harness.boundingBox();
				const b = await bgm.boundingBox();
				const s = await settings.boundingBox();
				if (!h || !b || !s) throw new Error("missing app bar geometry");
				expect(s.x).toBeGreaterThanOrEqual(h.x + h.width - 1);
				expect(b.x).toBeGreaterThanOrEqual(s.x + s.width - 1);
				expect(b.x + b.width).toBeLessThanOrEqual(viewport.width);
			}
			await shot(page, "R8", viewport.width);
		});

		test(`R6: web app bar uses the same package icon as the desktop app (${viewport.width})`, async () => {
			test.setTimeout(180_000);
			const tarotTab = page.locator('.app-bar-tab[data-app-id="land.naia.cafelua-tarot"]');
			await expect(tarotTab).toHaveCount(1, { timeout: 60_000 });
			const img = tarotTab.locator("img.app-bar-tab-icon--svg");
			await expect(img).toHaveCount(1);
			const src = await img.getAttribute("src");
			expect(decodeURIComponent((src ?? "").replace(/^data:image\/svg\+xml,/, ""))).toBe(ICON_SVG);
			// Packages without a package icon keep their emoji fallback.
			await expect(page.locator('.app-bar-tab[data-app-id="land.naia.charcard"] .app-bar-tab-icon')).toHaveText("🃏");
			if (await tarotTab.isVisible()) {
				await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
				await page.locator(".app-bar").screenshot({ path: SHOT_DIR ? `${SHOT_DIR}/R6-${viewport.width}.png` : undefined });
			} else {
				await shot(page, "R6", viewport.width);
			}
		});

		test(`R1: web brain provider list only offers providers that run in the browser (${viewport.width})`, async () => {
			test.setTimeout(180_000);
			await openSettings(page);
			await page.locator(".settings-tab-btn").nth(1).click();
			const select = page.locator("#provider-select");
			await expect(select).toBeVisible({ timeout: 30_000 });
			const values = await select.locator("option").evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
			expect(values.sort()).toEqual(["nextain", "webllm"]);
			for (const hidden of ["ollama", "vllm", "codex", "claude-code-cli", "grok"]) {
				expect(values).not.toContain(hidden);
			}
			await select.scrollIntoViewIfNeeded();
			await shot(page, "R1", viewport.width);
		});

		test(`R2: settings apply button is a readable, aligned primary button (${viewport.width})`, async () => {
			test.setTimeout(180_000);
			const save = page.locator(".settings-save-btn:visible").first();
			await save.scrollIntoViewIfNeeded();
			await expect(save).toBeVisible();
			const style = await save.evaluate((el) => {
				const cs = getComputedStyle(el);
				const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
				const lum = ([r, g, b]: number[]) => {
					const f = (v: number) => {
						const s = v / 255;
						return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
					};
					return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
				};
				const fg = lum(parse(cs.color));
				const bg = lum(parse(cs.backgroundColor));
				const r = el.getBoundingClientRect();
				return {
					contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05),
					height: r.height,
					radius: Number.parseFloat(cs.borderTopLeftRadius),
					shadow: cs.boxShadow,
					wraps: el.scrollHeight > el.clientHeight + 2,
					insideViewport: r.left >= 0 && r.right <= window.innerWidth,
				};
			});
			expect(style.contrast).toBeGreaterThanOrEqual(4.5);
			expect(style.height).toBeGreaterThanOrEqual(36);
			expect(style.radius).toBeLessThanOrEqual(10);
			expect(style.shadow).toBe("none");
			expect(style.wraps).toBe(false);
			expect(style.insideViewport).toBe(true);
			await save.focus();
			await shot(page, "R2", viewport.width);
			await closeSettings(page);
		});

		test(`R5: hosted app menu is not covered by the shell close button (${viewport.width})`, async () => {
			test.setTimeout(180_000);
			// Narrow portrait windows show only the companion and chat (existing
			// layout, web-mode.css), so installed app screens are not on screen there.
			test.skip(isPortrait(page), "portrait layout does not show installed app screens");
			await openInstalledApp(page, "land.naia.cafelua-tarot");
			const titlebar = page.getByTestId("active-app-titlebar");
			const close = page.getByTestId("active-app-close-btn");
			await expect(titlebar).toBeVisible({ timeout: 60_000 });
			await expect(titlebar).toContainText("카페루아 타로");
			const frameEl = page.locator('iframe[src*="/hosted-apps/cafelua-tarot/"]');
			await expect(frameEl).toBeVisible({ timeout: 60_000 });
			const c = await close.boundingBox();
			const f = await frameEl.boundingBox();
			if (!c || !f) throw new Error("missing app geometry");
			expect(c.y + c.height).toBeLessThanOrEqual(f.y + 1);
			const frame = page.frameLocator('iframe[src*="/hosted-apps/cafelua-tarot/"]');
			await frame.locator("#menu").click();
			await expect(frame.locator("#hit")).toHaveText("menu-open");
			await shot(page, "R5", viewport.width);
			await close.click();
			await expect(titlebar).toHaveCount(0);
		});

		test(`R12: starting a character card opens chat with the card greeting (${viewport.width})`, async () => {
			test.setTimeout(180_000);
			if (isPortrait(page)) {
				await page.locator(".web-mobile-menu-trigger").click();
				await page.getByTestId("web-character-card-mobile-btn").click();
			} else {
				await page.getByTestId("web-character-card-quick-btn").click();
			}
			const frameSelector = 'iframe[src*="/hosted-apps/naia-charcard/"]';
			const frame = page.frameLocator(frameSelector);
			const start = frame.locator("#start");
			const first = page.locator(".chat-message").first();
			// The fixture button exists as soon as the frame parses, which can be a
			// moment before the shell attaches its context listener on load; press
			// again until the shell reacts (repeats of the same card are ignored).
			await expect(async () => {
				if (await start.isVisible()) await start.click();
				await expect(first).toContainText("어서 와요! 저는 시계공 틴커예요.", { timeout: 5_000 });
			}).toPass({ timeout: 90_000 });
			const wrapper = page.locator(".naia-chat-wrapper");
			await expect(wrapper).not.toHaveClass(/naia-chat-wrapper--hidden/);
			await expect(first).toBeVisible();
			await expect(first).toContainText("오늘은 어떤 이야기를 해 볼까요?");
			await expect(page.locator(".chat-message")).toHaveCount(1);
			await expect(page.locator(".naia-chat-area .chat-input")).toBeFocused();
			const cardFrame = page.locator(frameSelector);
			if (isPortrait(page)) await expect(cardFrame).toBeHidden();
			else await expect(cardFrame).toBeVisible();
			await shot(page, "R12", viewport.width);
			if (isPortrait(page)) {
				await page.locator(".web-mobile-menu-trigger").click();
				await page.getByTestId("web-character-card-mobile-btn").click();
				await expect(cardFrame).toBeVisible();
				await expect(first).toContainText("오늘은 어떤 이야기를 해 볼까요?");
			}
		});
	});
}
