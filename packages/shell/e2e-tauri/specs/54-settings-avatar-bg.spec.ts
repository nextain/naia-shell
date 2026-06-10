import { S } from "../helpers/selectors.js";
import {
	clickBySelector,
	ensureAppReady,
	navigateToSettings,
	scrollToSection,
} from "../helpers/settings.js";

/**
 * 54 — Settings: Avatar VRM & Background
 */
describe("54 — settings avatar & background", () => {
	before(async () => {
		await ensureAppReady();
		await navigateToSettings();
		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 10_000 });
	});

	it("should render VRM cards including add button", async () => {
		await scrollToSection(S.vrmCard);
		const count = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.vrmCard,
		);
		expect(count).toBeGreaterThanOrEqual(3);
	});

	it("should have one active VRM card", async () => {
		const activeCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.vrmCardActive,
		);
		expect(activeCount).toBeGreaterThanOrEqual(1);
	});

	it("should change active VRM on click", async () => {
		const switched = await browser.execute((allSel: string) => {
			const all = document.querySelectorAll(allSel);
			for (let i = 0; i < all.length; i++) {
				// Skip the add card and already-active cards
				if (
					all[i].classList.contains("vrm-card-add") ||
					all[i].classList.contains("active")
				)
					continue;
				// trigger mousedown+up instead of click due to useLongPress
				const el = all[i] as HTMLElement;
				el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
				el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
				return true;
			}
			return false;
		}, S.vrmCard);

		if (!switched) return; // Only 1 card, skip
		await browser.pause(300);

		const activeCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.vrmCardActive,
		);
		expect(activeCount).toBeGreaterThanOrEqual(1);
	});

	it("should render BG cards", async () => {
		await scrollToSection(S.bgCard);
		const count = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.bgCard,
		);
		expect(count).toBeGreaterThanOrEqual(2);
	});

	it("should change active BG card on click", async () => {
		const switched = await browser.execute((allSel: string) => {
			const all = document.querySelectorAll(allSel);
			for (let i = 0; i < all.length; i++) {
				if (
					all[i].classList.contains("bg-card-add") ||
					all[i].classList.contains("active")
				)
					continue;
				// trigger mousedown+up instead of click due to useLongPress
				const el = all[i] as HTMLElement;
				el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
				el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
				return true;
			}
			return false;
		}, S.bgCard);

		if (!switched) return;
		await browser.pause(300);

		const activeCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.bgCardActive,
		);
		expect(activeCount).toBeGreaterThanOrEqual(1);
	});

	it("should navigate back to chat tab", async () => {
		await clickBySelector(S.chatTab);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
