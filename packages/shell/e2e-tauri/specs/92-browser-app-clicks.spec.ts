/**
 * 92 — Browser App: Click Blocking Regression
 *
 * Verifies that the browser app's error overlay does NOT block clicks on
 * other apps when the browser slot is inactive (opacity:0).
 *
 * Root cause (fixed):
 *   HRESULT(0x8007139F) race → status="error" → .browser-app__overlay--error
 *   rendered with pointer-events:auto → all apps beneath it become unclickable
 *   (all .content-app__slot elements are position:absolute;inset:0 — they stack).
 *
 * Fixes in place:
 *   1. browser_webview.rs — tokio Mutex serialises concurrent browser_wv_create
 *      calls; post-failure check recovers if race sibling won.
 *   2. global.css — .browser-app__overlay--error inherits pointer-events:none
 *      from parent; only .content-app__slot--active overrides to auto.
 *
 * These tests run in E2E mode (CAFE_DEBUG_E2E=1) where browser_wv_create
 * returns Ok immediately — so status stays "ready" and no error overlay is
 * rendered.  The CSS invariant tests use a synthetic overlay to verify that
 * the rule would also protect against future regressions.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { S } from "../helpers/selectors.js";

// 스크린샷 자리. 예전에는 `/tmp/browser-app-clicks` 를 그대로 썼는데, 그
// 디렉터리를 만드는 사람이 아무도 없어서 저장하는 순간 스펙이 죽었다
// ("directory doesn't exist"). 산출물 자리는 다른 스펙들과 같은 규약을
// 따르고, 없으면 만든다.
const SHOT = resolve(
	process.env.NAIA_E2E_ARTIFACTS_DIR
		? resolve(process.env.NAIA_E2E_ARTIFACTS_DIR)
		: resolve(process.cwd(), "e2e-tauri/.artifacts"),
	"browser-app-clicks",
);
mkdirSync(SHOT, { recursive: true });

/**
 * 브라우저 앱을 켜고, 실제로 켜졌는지 확인한다.
 *
 * 무음 클릭(`if (btn) btn.click()`)은 요소가 없을 때 실패를 숨긴다. 여기서는
 * 없으면 그 자리에서 말하고, 켜질 때까지 기다린다.
 */
async function activateBrowserApp(): Promise<void> {
	// 앱바 탭은 셸이 부팅을 마친 뒤에 그려진다. 예전에는 곧바로 찾아서
	// 없으면 그 자리에서 던졌고, 두 기계에서 똑같이 04 와 05 가 죽었다 —
	// 07 은 앞에서 800밀리초를 쉬는 바람에 우연히 지나갔다. 즉 결함은
	// 브라우저 앱이 아니라 **언제 찾느냐** 에 있었다.
	await (await $('.app-bar-tab[data-app-id="browser"]')).waitForExist({
		timeout: 30_000,
	});
	const pressed = await browser.execute(() => {
		const btn = document.querySelector(
			'.app-bar-tab[data-app-id="browser"]',
		) as HTMLButtonElement | null;
		if (!btn) return false;
		btn.click();
		return true;
	});
	if (!pressed) throw new Error("브라우저 앱 버튼을 찾지 못했다");

	await browser.waitUntil(
		async () =>
			browser.execute(() => {
				const slot = Array.from(
					document.querySelectorAll(".content-app__slot"),
				).find((s) => s.querySelector(".browser-app"));
				return Boolean(slot?.classList.contains("content-app__slot--active"));
			}),
		{
			timeout: 10_000,
			timeoutMsg: "브라우저 슬롯이 활성으로 바뀌지 않았다",
		},
	);
}

/** Return the .content-app__slot that wraps the browser app, or null. */
function getBrowserSlotInfo(): Promise<{
	found: boolean;
	isActive: boolean;
	slotPe: string;
	hasErrorOverlay: boolean;
	errorOverlayPe: string;
}> {
	return browser.execute(() => {
		const slots = Array.from(
			document.querySelectorAll(".content-app__slot"),
		);
		const browserSlot = slots.find((s) => s.querySelector(".browser-app"));
		if (!browserSlot) {
			return {
				found: false,
				isActive: false,
				slotPe: "n/a",
				hasErrorOverlay: false,
				errorOverlayPe: "n/a",
			};
		}
		const isActive = browserSlot.classList.contains(
			"content-app__slot--active",
		);
		const slotPe = window.getComputedStyle(browserSlot).pointerEvents;
		const errorOverlay = browserSlot.querySelector(
			".browser-app__overlay--error",
		);
		const errorOverlayPe = errorOverlay
			? window.getComputedStyle(errorOverlay).pointerEvents
			: "none (not present)";
		return {
			found: true,
			isActive,
			slotPe,
			hasErrorOverlay: !!errorOverlay,
			errorOverlayPe,
		};
	});
}

describe("92 — Browser App: Click Blocking Regression", () => {
	before(async () => {
		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 15_000 });
		// 화면 뿌리가 떴다는 것과 부팅이 끝났다는 것은 다르다. 앱바가
		// 채워지는 것은 그 뒤다.
		await (await $('[data-app-boot-complete="true"]')).waitForExist({
			timeout: 30_000,
		});
		// Give keepAlive apps time to mount and initWebview to resolve.
		await browser.pause(1_500);
	});

	// ── 01: No error overlay in E2E mode ────────────────────────────────────

	it("01 — no browser-app__overlay--error rendered in E2E mode", async () => {
		// In E2E mode browser_wv_create returns Ok() → status="ready" → no error overlay.
		const hasError = await browser.execute(
			() => !!document.querySelector(".browser-app__overlay--error"),
		);
		expect(hasError).toBe(false);

		await browser.saveScreenshot(`${SHOT}/01-no-error-overlay.png`);
	});

	// ── 02: Inactive browser slot must be pointer-events:none ───────────────

	it("02 — inactive browser app slot has pointer-events:none", async () => {
		// Activate workspace so browser slot is inactive.
		await browser.execute(() => {
			const btn = document.querySelector(
				'.app-bar-tab[data-app-id="workspace"]',
			) as HTMLButtonElement | null;
			if (btn) btn.click();
		});
		await browser.pause(400);

		const info = await getBrowserSlotInfo();
		expect(info.found).toBe(true);
		expect(info.isActive).toBe(false);
		// Inactive slot MUST be pointer-events:none — this is the CSS gate that
		// prevents children from intercepting clicks even if they override PE.
		expect(info.slotPe).toBe("none");

		await browser.saveScreenshot(`${SHOT}/02-inactive-slot-pe-none.png`);
	});

	// ── 03: CSS invariant — synthetic error overlay in inactive slot ─────────

	it("03 — synthetic error overlay in inactive browser slot has pointer-events:none", async () => {
		// Activate workspace so browser slot is inactive.
		await browser.execute(() => {
			const btn = document.querySelector(
				'.app-bar-tab[data-app-id="workspace"]',
			) as HTMLButtonElement | null;
			if (btn) btn.click();
		});
		await browser.pause(400);

		// Inject a synthetic .browser-app__overlay--error into the inactive
		// browser slot and verify computed pointer-events is "none".
		// This directly tests the CSS rule introduced to fix the regression.
		const result = await browser.execute(() => {
			const slots = Array.from(
				document.querySelectorAll(".content-app__slot"),
			);
			const browserSlot = slots.find((s) =>
				s.querySelector(".browser-app"),
			);
			if (!browserSlot) return { found: false, pe: "n/a", isActive: false };

			const isActive = browserSlot.classList.contains(
				"content-app__slot--active",
			);

			// Create a synthetic overlay identical to the real error overlay.
			const synthetic = document.createElement("div");
			synthetic.className =
				"browser-app__overlay browser-app__overlay--error __e2e_synthetic";
			browserSlot.appendChild(synthetic);

			const pe = window.getComputedStyle(synthetic).pointerEvents;

			// Clean up immediately.
			synthetic.remove();

			return { found: true, pe, isActive };
		});

		expect(result.found).toBe(true);
		// Must be inactive for this test to be meaningful.
		expect(result.isActive).toBe(false);
		// The CSS fix: error overlay inside an INACTIVE slot must be pointer-events:none.
		// If someone accidentally re-adds `pointer-events:auto` to
		// .browser-app__overlay--error unconditionally, this test will fail.
		expect(result.pe).toBe("none");
	});

	// ── 04: CSS invariant — error overlay in ACTIVE slot gets pointer-events:auto

	it("04 — error overlay in active browser slot gets pointer-events:auto", async () => {
		// Activate the browser app.
		//
		// 예전에는 `if (btn) btn.click()` 로 눌렀는데, 버튼이 없으면 아무 일도
		// 일어나지 않고 그 사실이 어디에도 남지 않는다. 그러면 뒤의 단정이
		// "슬롯이 활성이 아니다" 로 애매하게 실패하고, 원인이 버튼을 못 찾은
		// 것인지 활성화가 안 된 것인지 알 수 없다.
		await activateBrowserApp();

		// Inject a synthetic overlay into the now-active browser slot.
		const result = await browser.execute(() => {
			const slots = Array.from(
				document.querySelectorAll(".content-app__slot"),
			);
			const browserSlot = slots.find((s) =>
				s.querySelector(".browser-app"),
			);
			if (!browserSlot) return { found: false, pe: "n/a", isActive: false };

			const isActive = browserSlot.classList.contains(
				"content-app__slot--active",
			);

			const synthetic = document.createElement("div");
			synthetic.className =
				"browser-app__overlay browser-app__overlay--error __e2e_synthetic";
			browserSlot.appendChild(synthetic);

			const pe = window.getComputedStyle(synthetic).pointerEvents;
			synthetic.remove();

			return { found: true, pe, isActive };
		});

		expect(result.found).toBe(true);
		// The browser slot should now be active.
		expect(result.isActive).toBe(true);
		// When the slot IS active, the error overlay must intercept clicks so the
		// user can interact with the retry button etc.
		expect(result.pe).toBe("auto");

		await browser.saveScreenshot(`${SHOT}/04-active-slot-overlay-pe-auto.png`);
	});

	// ── 05: Switching browser→workspace leaves browser slot inactive ─────────

	it("05 — switching from browser to workspace leaves browser non-blocking", async () => {
		// Activate browser first.
		await browser.execute(() => {
			const btn = document.querySelector(
				'.app-bar-tab[data-app-id="browser"]',
			) as HTMLButtonElement | null;
			if (btn) btn.click();
		});
		await browser.pause(400);

		// Then switch to workspace.
		await browser.execute(() => {
			const btn = document.querySelector(
				'.app-bar-tab[data-app-id="workspace"]',
			) as HTMLButtonElement | null;
			if (btn) btn.click();
		});
		await browser.pause(500);

		// Verify workspace slot is active.
		const workspaceActive = await browser.execute(() => {
			const slots = Array.from(
				document.querySelectorAll(".content-app__slot"),
			);
			// 워크스페이스 화면이 Herdr 통합으로 바뀌면서 `.workspace-app` 은 더
			// 이상 그려지지 않는다(그 클래스가 사는 파일이 진입점에서 닿지
			// 않는다 — #554). 이 단정이 재려는 것은 "워크스페이스로 옮기면
			// 브라우저가 클릭을 막지 않는다" 이지 옛 클래스의 존재가 아니다.
			// 지금 실제로 그려지는 표면을 집는다. 두 형태를 다 보는 것은
			// #554 결정에 따라 옛 화면이 돌아올 수 있기 때문이다.
			const wsSlot = slots.find(
				(s) =>
					s.querySelector(".herdr-workspace__main") ??
					s.querySelector(".workspace-app"),
			);
			return wsSlot?.classList.contains("content-app__slot--active") ?? false;
		});
		expect(workspaceActive).toBe(true);

		// Verify browser slot is NOT blocking (pointer-events:none).
		const info = await getBrowserSlotInfo();
		expect(info.found).toBe(true);
		expect(info.isActive).toBe(false);
		expect(info.slotPe).toBe("none");

		// Error overlay (if it somehow exists) must also be non-blocking.
		if (info.hasErrorOverlay) {
			expect(info.errorOverlayPe).toBe("none");
		}

		await browser.saveScreenshot(`${SHOT}/05-workspace-active-browser-inactive.png`);
	});

	// ── 06: elementFromPoint in workspace area returns workspace element ──────

	it("06 — document.elementFromPoint in workspace area hits workspace, not browser overlay", async () => {
		// Activate workspace.
		await browser.execute(() => {
			const btn = document.querySelector(
				'.app-bar-tab[data-app-id="workspace"]',
			) as HTMLButtonElement | null;
			if (btn) btn.click();
		});
		await browser.pause(500);

		// Inject a synthetic error overlay into the inactive browser slot, then
		// check that elementFromPoint at the center of the content area does NOT
		// return that overlay — it must be blocked by pointer-events:none.
		const result = await browser.execute(() => {
			const slots = Array.from(
				document.querySelectorAll(".content-app__slot"),
			);
			const browserSlot = slots.find((s) =>
				s.querySelector(".browser-app"),
			);
			if (!browserSlot) return { found: false, hitClass: "n/a" };

			// Add a synthetic overlay styled to fill the entire viewport area so
			// elementFromPoint is guaranteed to hit it if pointer-events is auto.
			const synthetic = document.createElement("div");
			synthetic.className =
				"browser-app__overlay browser-app__overlay--error __e2e_synthetic";
			// Force it to cover the entire viewport (override any inherited sizing).
			synthetic.style.cssText =
				"position:fixed;inset:0;z-index:9999;background:transparent;";
			browserSlot.appendChild(synthetic);

			// Sample point at the center of the viewport.
			const cx = window.innerWidth / 2;
			const cy = window.innerHeight / 2;
			const hit = document.elementFromPoint(cx, cy);

			synthetic.remove();

			// Return the class string of whatever element was hit.
			return {
				found: true,
				hitClass: hit ? hit.className : "(null)",
				hitTag: hit ? hit.tagName : "(null)",
			};
		});

		expect(result.found).toBe(true);

		// The synthetic overlay has class __e2e_synthetic — it must NOT be the hit.
		// If pointer-events was inadvertently auto, it would be the topmost element.
		const hitsSyntheticOverlay =
			typeof result.hitClass === "string" &&
			result.hitClass.includes("__e2e_synthetic");
		expect(hitsSyntheticOverlay).toBe(false);

		await browser.saveScreenshot(`${SHOT}/06-elementfrompoint-not-blocked.png`);
	});

	// ── 07: Browser app tab click shows browser app ─────────────────────

	it("07 — clicking browser tab activates browser slot", async () => {
		// Start from workspace.
		await browser.execute(() => {
			const btn = document.querySelector(
				'.app-bar-tab[data-app-id="workspace"]',
			) as HTMLButtonElement | null;
			if (btn) btn.click();
		});
		await browser.pause(300);

		// Click browser tab.
		const clicked = await browser.execute(() => {
			const btn = document.querySelector(
				'.app-bar-tab[data-app-id="browser"]',
			) as HTMLButtonElement | null;
			if (btn) {
				btn.click();
				return true;
			}
			return false;
		});
		expect(clicked).toBe(true);
		await browser.pause(500);

		// Browser slot must now be active.
		const info = await getBrowserSlotInfo();
		expect(info.found).toBe(true);
		expect(info.isActive).toBe(true);
		expect(info.slotPe).toBe("auto");

		await browser.saveScreenshot(`${SHOT}/07-browser-tab-active.png`);
	});

	// ── 08: Browser app status is "ready" in E2E mode (no WebView2 error) ─

	it("08 — browser app has status ready (no error state) in E2E mode", async () => {
		// Activate browser app to trigger initWebview if not yet run.
		await browser.execute(() => {
			const btn = document.querySelector(
				'.app-bar-tab[data-app-id="browser"]',
			) as HTMLButtonElement | null;
			if (btn) btn.click();
		});
		await browser.pause(800);

		// No error overlay should exist — browser_wv_create returns Ok in E2E mode.
		const errorState = await browser.execute(() => {
			const errorOverlay = document.querySelector(
				".browser-app__overlay--error",
			);
			if (errorOverlay) {
				return {
					hasError: true,
					text: (errorOverlay as HTMLElement).innerText?.slice(0, 200) ?? "",
				};
			}
			return { hasError: false, text: "" };
		});

		if (errorState.hasError) {
			// Fail with a descriptive message showing the actual error text.
			throw new Error(
				`Browser app in error state (E2E mode should prevent this): ${errorState.text}`,
			);
		}
		expect(errorState.hasError).toBe(false);

		await browser.saveScreenshot(`${SHOT}/08-browser-ready-no-error.png`);
	});

	async function readNativePageInfo(): Promise<{ url: string; title: string }> {
		return browser.execute(async () => {
			const internals = (
				window as Window & {
					__TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> };
				}
			).__TAURI_INTERNALS__;
			if (!internals) {
				return { url: "", title: "" };
			}
			try {
				const value = await internals.invoke("browser_wv_page_info");
				const [urlValue, titleValue] = Array.isArray(value) ? value : ["", ""];
				return { url: String(urlValue ?? ""), title: String(titleValue ?? "") };
			} catch {
				return { url: "", title: "" };
			}
		});
	}

	async function navigateFromAddressBar(
		url: string,
		screenshotName: string,
		expectedTitle: string,
	) {
		await activateBrowserApp();
		const addressBar = await $(
			"input.browser-app__url-input",
		);
		await addressBar.waitForDisplayed({ timeout: 10_000 });
		await addressBar.click();
		await addressBar.setValue(url);
		await browser.keys("Enter");

		await browser.waitUntil(
			async () =>
				(await (await $("input.browser-app__url-input")).getValue()) === url,
			{
				timeout: 30_000,
				timeoutMsg: `주소 표시줄이 ${url} 로 갱신되지 않았다`,
			},
		);
		await browser.waitUntil(
			async () => {
				const info = await readNativePageInfo();
				return info.url.startsWith(url) && info.title.includes(expectedTitle);
			},
			{
				timeout: 30_000,
				timeoutMsg: `native child WebView did not load ${url} with title ${expectedTitle}`,
			},
		);
		const info = await readNativePageInfo();
		console.log(`[item8] loaded url=${info.url} title=${info.title}`);
		// The page itself is a native child WebView, so the screenshot is the
		// rendered-surface evidence rather than a DOM query in the shell page.
		await browser.saveScreenshot(`${SHOT}/${screenshotName}`);
	}

	it("09 — address bar navigates to example.com and renders the page", async () => {
		await navigateFromAddressBar(
			"https://example.com",
			"09-example-com-rendered.png",
			"Example Domain",
		);
	});

	it("10 — address bar navigates to Wikipedia and renders the page", async () => {
		await navigateFromAddressBar(
			"https://www.wikipedia.org",
			"10-wikipedia-rendered.png",
			"Wikipedia",
		);
	});
});
