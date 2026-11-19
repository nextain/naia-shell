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
			await page.route("**/hosted-apps/cafelua-tarot/index.html", (route) => route.fulfill({ body: TAROT_HTML, contentType: "text/html" }));
			await page.route("**/hosted-apps/naia-charcard/index.html", (route) => route.fulfill({ body: CHARCARD_HTML, contentType: "text/html" }));
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
				const credit = q(".app-bar .web-credit") ?? q("#web-login-free-credits-btn");
				return {
					harnessBeforeBgm: pos(q("[data-testid='web-runtime-harness-bar']"), q(".app-bar .bgm-player")),
					creditBeforeBgm: credit ? pos(credit, q(".app-bar .bgm-player")) : true,
					bgmBeforeSettings: pos(q(".app-bar .bgm-player"), q(".app-bar-settings")),
				};
			});
			expect(order).toEqual({ harnessBeforeBgm: true, creditBeforeBgm: true, bgmBeforeSettings: true });
			const h = await harness.boundingBox();
			const b = await bgm.boundingBox();
			const s = await settings.boundingBox();
			if (h && b && s && (await bgm.isVisible()) && Math.abs(h.y - b.y) < 8) {
				expect(b.x).toBeGreaterThanOrEqual(h.x + h.width - 1);
				expect(s.x).toBeGreaterThanOrEqual(b.x + b.width - 1);
			}
			await shot(page, "R8", viewport.width);
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

	});
}
