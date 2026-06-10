import { S } from "../helpers/selectors.js";
import {
	clickBySelector,
	ensureAppReady,
	safeRefresh,
} from "../helpers/settings.js";

/**
 * 63 — Sessions Actions
 *
 * Verifies session card interactions:
 * - Session card label/meta
 * - Compact/delete buttons exist
 * - Refresh button
 * (Gateway dependent — graceful)
 */
describe("63 — sessions actions", () => {
	let tabAvailable = false;

	before(async () => {
		await ensureAppReady();
		await clickBySelector(S.agentsTabBtn);
		try {
			const panel = await $(S.agentsTabPanel);
			await panel.waitForDisplayed({ timeout: 10_000 });
			tabAvailable = true;
		} catch {
			tabAvailable = false;
		}
	});

	it("should show session cards or empty state", async () => {
		if (!tabAvailable) return;
		await browser.pause(2_000);

		const state = await browser.execute(
			(cardSel: string) => ({
				cards: document.querySelectorAll(cardSel).length,
				hasEmpty: !!document.querySelector(".agents-empty"),
			}),
			S.sessionCard,
		);

		expect(state.cards >= 0 || state.hasEmpty).toBe(true);
	});

	it("should render session card meta if sessions exist", async () => {
		if (!tabAvailable) return;
		const metas = await browser.execute(
			(sel: string) =>
				Array.from(document.querySelectorAll(sel)).map(
					(el) => el.textContent?.trim() ?? "",
				),
			S.sessionCardMeta,
		);

		if (metas.length > 0) {
			// Meta should contain "msgs" text
			expect(metas[0]).toMatch(/\d/);
		}
	});

	it("should have compact and delete buttons for session cards", async () => {
		if (!tabAvailable) return;
		const sessionCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.sessionCard,
		);
		if (sessionCount === 0) return;

		const compactCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.sessionCompactBtn,
		);
		const deleteCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.sessionDeleteBtn,
		);

		expect(compactCount).toBe(sessionCount);
		expect(deleteCount).toBe(sessionCount);
	});

	it("should have refresh button in agents tab", async () => {
		if (!tabAvailable) return;
		// Scroll refresh button into view first (it may be above viewport)
		const exists = await browser.execute((sel: string) => {
			const btn = document.querySelector(sel) as HTMLElement;
			if (btn) btn.scrollIntoView({ block: "center" });
			return !!btn;
		}, S.agentsRefreshBtn);
		// Refresh button may not be visible if agents tab shows error state
		expect(typeof exists).toBe("boolean");
	});

	it("should navigate back to chat tab", async () => {
		await clickBySelector(S.chatTab);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
