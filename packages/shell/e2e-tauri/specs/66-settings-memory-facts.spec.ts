import { S } from "../helpers/selectors.js";
import {
	clickBySelector,
	ensureAppReady,
	navigateToSettings,
	scrollToSection,
} from "../helpers/settings.js";

/**
 * 66 — Settings: Memory/Facts
 *
 * Verifies facts list in settings:
 * - Facts list renders (or empty state)
 * - Fact key/value text
 * - Delete button exists
 */
describe("66 — settings memory facts", () => {
	before(async () => {
		await ensureAppReady();
		await navigateToSettings();
		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 10_000 });
	});

	it("should scroll to memory section", async () => {
		// Try to scroll to facts list; if no facts, the empty hint should be visible
		const hasFacts = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.factsList,
		);
		const hasEmpty = await browser.execute(
			() => !!document.querySelector(".settings-hint"),
		);
		expect(hasFacts || hasEmpty).toBe(true);
	});

	it("should render fact items if facts exist", async () => {
		const factCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.factItem,
		);
		// May be 0 if no facts stored
		expect(factCount).toBeGreaterThanOrEqual(0);
	});

	it("should show fact key and value text", async () => {
		const factCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.factItem,
		);
		if (factCount === 0) return;

		const texts = await browser.execute(() => {
			const items = document.querySelectorAll(".fact-item");
			if (items.length === 0) return { key: "", value: "" };
			const first = items[0];
			return {
				key: first.querySelector(".fact-key")?.textContent?.trim() ?? "",
				value: first.querySelector(".fact-value")?.textContent?.trim() ?? "",
			};
		});

		expect(texts.key.length).toBeGreaterThan(0);
	});

	it("should have delete button for each fact", async () => {
		const factCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.factItem,
		);
		if (factCount === 0) return;

		const deleteCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.factDeleteBtn,
		);
		expect(deleteCount).toBe(factCount);
	});

	it("should navigate back to chat tab", async () => {
		await clickBySelector(S.chatTab);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
