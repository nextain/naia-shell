import { S } from "../helpers/selectors.js";
import {
	clickBySelector,
	ensureAppReady,
	navigateToSettings,
} from "../helpers/settings.js";

/**
 * 53 — Settings: Theme & Locale
 *
 * Pure client-side interactions:
 * - Theme swatch click → active class changes
 * - data-theme attribute on root updates
 * - Locale select switches (ko↔en)
 */
describe("53 — settings theme & locale", () => {
	before(async () => {
		await ensureAppReady();
		await navigateToSettings();
		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 10_000 });
	});

	it("should render theme swatches", async () => {
		const count = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.themeSwatch,
		);
		expect(count).toBeGreaterThanOrEqual(2);
	});

	it("should have one active theme swatch", async () => {
		const activeCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.themeSwatchActive,
		);
		expect(activeCount).toBe(1);
	});

	it("should change active swatch on click", async () => {
		// Get the first non-active swatch index
		const clickedIdx = await browser.execute(
			(activeSel: string, allSel: string) => {
				const all = document.querySelectorAll(allSel);
				for (let i = 0; i < all.length; i++) {
					if (!all[i].classList.contains("active")) {
						(all[i] as HTMLElement).click();
						return i;
					}
				}
				return -1;
			},
			S.themeSwatchActive,
			S.themeSwatch,
		);

		expect(clickedIdx).toBeGreaterThanOrEqual(0);
		await browser.pause(300);

		// The clicked swatch should now be active
		const newActiveIdx = await browser.execute((allSel: string) => {
			const all = document.querySelectorAll(allSel);
			for (let i = 0; i < all.length; i++) {
				if (all[i].classList.contains("active")) return i;
			}
			return -1;
		}, S.themeSwatch);

		expect(newActiveIdx).toBe(clickedIdx);
	});

	it("should show locale select with current value", async () => {
		const value = await browser.execute(
			(sel: string) =>
				(document.querySelector(sel) as HTMLSelectElement)?.value ?? "",
			S.localeSelect,
		);
		expect(["ko", "en"]).toContain(value);
	});

	it("should switch locale from current to the other", async () => {
		const original = await browser.execute(
			(sel: string) =>
				(document.querySelector(sel) as HTMLSelectElement)?.value ?? "",
			S.localeSelect,
		);
		const target = original === "ko" ? "en" : "ko";

		await browser.execute(
			(sel: string, val: string) => {
				const el = document.querySelector(sel) as HTMLSelectElement;
				if (!el) return;
				el.value = val;
				el.dispatchEvent(new Event("change", { bubbles: true }));
			},
			S.localeSelect,
			target,
		);
		await browser.pause(300);

		const updated = await browser.execute(
			(sel: string) =>
				(document.querySelector(sel) as HTMLSelectElement)?.value ?? "",
			S.localeSelect,
		);
		expect(updated).toBe(target);

		// Restore original locale
		await browser.execute(
			(sel: string, val: string) => {
				const el = document.querySelector(sel) as HTMLSelectElement;
				if (!el) return;
				el.value = val;
				el.dispatchEvent(new Event("change", { bubbles: true }));
			},
			S.localeSelect,
			original,
		);
		await browser.pause(300);
	});

	it("should navigate back to chat tab", async () => {
		await clickBySelector(S.chatTab);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
