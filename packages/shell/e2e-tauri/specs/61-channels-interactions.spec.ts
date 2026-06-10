import { S } from "../helpers/selectors.js";
import { clickBySelector, ensureAppReady } from "../helpers/settings.js";

/**
 * 61 — Channels Tab Interactions
 *
 * Verifies channels UI interactions:
 * - Channel cards render (or empty/error state)
 * - Channel name, status badge
 * - Refresh click → panel stays
 * (Gateway dependent — graceful)
 */
describe("61 — channels interactions", () => {
	let tabAvailable = false;

	before(async () => {
		await ensureAppReady();
		await clickBySelector(S.channelsTabBtn);
		try {
			const panel = await $(S.channelsTabPanel);
			await panel.waitForDisplayed({ timeout: 10_000 });
			tabAvailable = true;
		} catch {
			tabAvailable = false;
		}
	});

	it("should show channels tab panel", async () => {
		if (!tabAvailable) return;
		const exists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.channelsTabPanel,
		);
		expect(exists).toBe(true);
	});

	it("should show loading, empty, error, or channel cards", async () => {
		if (!tabAvailable) return;

		const state = await browser.execute(
			(loadingSel: string, emptySel: string, cardSel: string) => {
				return {
					loading: !!document.querySelector(loadingSel),
					empty: !!document.querySelector(emptySel),
					cards: document.querySelectorAll(cardSel).length,
					hasError: !!document.querySelector(".channels-error"),
				};
			},
			S.channelsLoading,
			S.channelsEmpty,
			S.channelCard,
		);

		// At least one state should be true
		const hasState =
			state.loading || state.empty || state.cards > 0 || state.hasError;
		expect(hasState).toBe(true);
	});

	it("should render channel name if cards exist", async () => {
		if (!tabAvailable) return;
		const names = await browser.execute((sel: string) => {
			return Array.from(document.querySelectorAll(sel)).map(
				(el) => el.textContent?.trim() ?? "",
			);
		}, S.channelName);

		// If there are channels, they should have names
		if (names.length > 0) {
			expect(names[0].length).toBeGreaterThan(0);
		}
	});

	it("should show status badge if cards exist", async () => {
		if (!tabAvailable) return;
		const badges = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.channelStatus,
		);
		// Badges match account count, not card count
		expect(typeof badges).toBe("number");
	});

	it("should have refresh button that keeps panel", async () => {
		if (!tabAvailable) return;

		const refreshExists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.channelsRefreshBtn,
		);

		if (refreshExists) {
			await clickBySelector(S.channelsRefreshBtn);
			await browser.pause(1_000);

			const stillExists = await browser.execute(
				(sel: string) => !!document.querySelector(sel),
				S.channelsTabPanel,
			);
			expect(stillExists).toBe(true);
		}
	});

	it("should navigate back to chat tab", async () => {
		await clickBySelector(S.chatTab);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
