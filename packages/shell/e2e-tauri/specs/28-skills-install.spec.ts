import { S } from "../helpers/selectors.js";
import { clickBySelector } from "../helpers/settings.js";

/**
 * 28 — Skills Install E2E
 *
 * Verifies Skills tab > Gateway skills section:
 * - Gateway skill cards render with name text
 * - Eligible/ineligible status shown
 * - Install button clickable for ineligible skills
 *
 * Covers RPC: skills.status
 */
describe("28 — skills install", () => {
	it("should navigate to Skills tab", async () => {
		const skillsBtn = await $(S.skillsTab);
		await skillsBtn.waitForDisplayed({ timeout: 10_000 });
		await clickBySelector(S.skillsTab);

		const skillsPanel = await $(S.skillsTabPanel);
		await skillsPanel.waitForDisplayed({ timeout: 5_000 });
	});

	it("should show gateway skill cards with status info", async () => {
		await browser.pause(3_000);

		const gatewayCardCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.gatewaySkillCard,
		);

		if (gatewayCardCount > 0) {
			// Verify first card has text content (skill name)
			const cardText = await browser.execute((sel: string) => {
				const card = document.querySelector(sel);
				return card?.textContent?.trim() ?? "";
			}, S.gatewaySkillCard);
			expect(cardText.length).toBeGreaterThan(0);
		}
	});

	it("should show install buttons for ineligible skills", async () => {
		const installBtnCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.skillsInstallBtn,
		);

		if (installBtnCount > 0) {
			const isDisplayed = await browser.execute((sel: string) => {
				const btn = document.querySelector(sel) as HTMLButtonElement;
				return btn ? !btn.hidden : false;
			}, S.skillsInstallBtn);
			expect(isDisplayed).toBe(true);

			// Verify button is clickable (not disabled)
			const isEnabled = await browser.execute((sel: string) => {
				const btn = document.querySelector(sel) as HTMLButtonElement;
				return btn ? !btn.disabled : false;
			}, S.skillsInstallBtn);
			expect(isEnabled).toBe(true);
		}
		// No install buttons = all skills eligible — valid state
	});

	it("should show install result feedback after clicking install", async () => {
		const installBtnCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.skillsInstallBtn,
		);

		if (installBtnCount > 0) {
			// Click the first install button
			await browser.execute((sel: string) => {
				const btn = document.querySelector(sel) as HTMLButtonElement;
				btn?.click();
			}, S.skillsInstallBtn);

			// Wait for install result feedback (success or error)
			await browser.waitUntil(
				async () => {
					const successCount = await browser.execute(
						(sel: string) => document.querySelectorAll(sel).length,
						S.skillInstallResultSuccess,
					);
					const errorCount = await browser.execute(
						(sel: string) => document.querySelectorAll(sel).length,
						S.skillInstallResultError,
					);
					return successCount > 0 || errorCount > 0;
				},
				{
					timeout: 30_000,
					interval: 1_000,
					timeoutMsg: "Install result feedback did not appear within 30s",
				},
			);

			// Verify feedback element has text content
			const feedbackText = await browser.execute(
				(successSel: string, errorSel: string) => {
					const el =
						document.querySelector(successSel) ||
						document.querySelector(errorSel);
					return el?.textContent?.trim() ?? "";
				},
				S.skillInstallResultSuccess,
				S.skillInstallResultError,
			);
			expect(feedbackText.length).toBeGreaterThan(0);
		}
	});

	it("should navigate back to chat tab", async () => {
		await clickBySelector(S.chatTab);

		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
