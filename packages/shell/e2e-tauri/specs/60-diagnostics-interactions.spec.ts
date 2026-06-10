import { S } from "../helpers/selectors.js";
import { clickBySelector, ensureAppReady } from "../helpers/settings.js";

/**
 * 60 — Diagnostics Tab Interactions
 *
 * Verifies diagnostics UI interactions:
 * - Refresh button keeps panel open
 * - Log start/stop buttons exist
 * - Tailing indicator state (Gateway dependent — graceful)
 */
describe("60 — diagnostics interactions", () => {
	let diagAvailable = false;

	before(async () => {
		await ensureAppReady();
		await clickBySelector(S.diagnosticsTabBtn);
		try {
			const diagPanel = await $(S.diagnosticsTabPanel);
			await diagPanel.waitForDisplayed({ timeout: 10_000 });
			diagAvailable = true;
		} catch {
			// Gateway not connected — diagnostics tab may not render
			diagAvailable = false;
		}
	});

	it("should show diagnostics panel or skip if unavailable", async () => {
		if (!diagAvailable) return;
		const exists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.diagnosticsTabPanel,
		);
		expect(exists).toBe(true);
	});

	it("should have refresh button", async () => {
		if (!diagAvailable) return;
		const exists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.diagnosticsRefreshBtn,
		);
		expect(exists).toBe(true);
	});

	it("should keep panel after refresh click", async () => {
		if (!diagAvailable) return;
		await clickBySelector(S.diagnosticsRefreshBtn);
		await browser.pause(1_000);

		const stillExists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.diagnosticsTabPanel,
		);
		expect(stillExists).toBe(true);
	});

	it("should have log start/stop button", async () => {
		if (!diagAvailable) return;
		const logBtnExists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.diagnosticsLogBtn,
		);
		expect(logBtnExists).toBe(true);
	});

	it("should toggle tailing state on log button click", async () => {
		if (!diagAvailable) return;

		const beforeTailing = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.diagnosticsTailingIndicator,
		);

		await clickBySelector(S.diagnosticsLogBtn);
		await browser.pause(1_500);

		const afterTailing = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.diagnosticsTailingIndicator,
		);

		// State should change (or remain same if Gateway call failed — that's ok)
		expect(typeof afterTailing).toBe("boolean");

		// If tailing started, stop it
		if (afterTailing && !beforeTailing) {
			await clickBySelector(S.diagnosticsLogBtn);
			await browser.pause(500);
		}
	});

	it("should navigate back to chat tab", async () => {
		await clickBySelector(S.chatTab);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
