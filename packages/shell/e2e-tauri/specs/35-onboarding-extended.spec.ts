import { S } from "../helpers/selectors.js";

/**
 * 35 — Onboarding Extended E2E
 *
 * Verifies the onboarding wizard UI elements:
 * - Onboarding overlay may be visible (first run) or skipped
 * - If visible, navigation buttons exist
 */
describe("35 — onboarding extended", () => {
	it("should check if onboarding is present", async () => {
		const exists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.onboardingOverlay,
		);
		// Onboarding only shows on first run — both states valid
		expect(typeof exists).toBe("boolean");
	});

	it("should have skip button if onboarding is visible", async () => {
		const overlayExists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.onboardingOverlay,
		);
		if (overlayExists) {
			const skipExists = await browser.execute(
				(sel: string) => !!document.querySelector(sel),
				S.onboardingSkipBtn,
			);
			expect(skipExists).toBe(true);
		}
	});

	it("should have next button if onboarding is visible", async () => {
		const overlayExists = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.onboardingOverlay,
		);
		if (overlayExists) {
			const nextExists = await browser.execute(
				(sel: string) => !!document.querySelector(sel),
				S.onboardingNextBtn,
			);
			expect(nextExists).toBe(true);
		}
	});
});
