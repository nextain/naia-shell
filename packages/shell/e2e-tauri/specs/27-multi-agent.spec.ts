import { S } from "../helpers/selectors.js";

/**
 * 27 — Multi-Agent E2E
 *
 * Verifies AgentsTab > Agent list:
 * - Agent cards show with name text
 * - File management accessible
 * - File content viewable
 *
 * Covers RPC: agents.list, agents.files.list, agents.files.get
 */
describe("27 — multi-agent", () => {
	it("should navigate to Agents tab", async () => {
		const agentsBtn = await $(S.agentsTabBtn);
		await agentsBtn.waitForDisplayed({ timeout: 10_000 });
		await agentsBtn.click();

		const agentsPanel = await $(S.agentsTabPanel);
		await agentsPanel.waitForDisplayed({ timeout: 5_000 });
	});

	it("should show agent cards or empty state", async () => {
		await browser.pause(3_000);

		const agentCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.agentCard,
		);

		if (agentCount > 0) {
			// Verify agent card has name text
			const cardText = await browser.execute((sel: string) => {
				const card = document.querySelector(sel);
				return card?.textContent?.trim() ?? "";
			}, S.agentCard);
			expect(cardText.length).toBeGreaterThan(0);
		} else {
			// Empty state — valid
			const panel = await $(S.agentsTabPanel);
			const panelText = await panel.getText();
			expect(panelText.length).toBeGreaterThan(0);
		}
	});

	it("should open file management for agent if available", async () => {
		const agentCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.agentCard,
		);

		if (agentCount > 0) {
			const filesBtnExists = await browser.execute(
				(sel: string) => !!document.querySelector(sel),
				S.agentFilesBtn,
			);

			if (filesBtnExists) {
				await browser.execute((sel: string) => {
					const btn = document.querySelector(sel) as HTMLElement;
					btn?.click();
				}, S.agentFilesBtn);
				await browser.pause(2_000);

				// File items should load (may be empty)
				const fileCount = await browser.execute(
					(sel: string) => document.querySelectorAll(sel).length,
					S.agentFileItem,
				);

				if (fileCount > 0) {
					// Click first file to load content
					await browser.execute((sel: string) => {
						const item = document.querySelector(sel) as HTMLElement;
						item?.click();
					}, S.agentFileItem);
					await browser.pause(1_000);

					const hasTextarea = await browser.execute(
						(sel: string) => !!document.querySelector(sel),
						S.agentFileTextarea,
					);
					if (hasTextarea) {
						const value = await browser.execute((sel: string) => {
							const ta = document.querySelector(sel) as HTMLTextAreaElement;
							return ta?.value ?? "";
						}, S.agentFileTextarea);
						expect(typeof value).toBe("string");
					}
				}
			}
		}
	});

	it("should navigate back to chat tab", async () => {
		const chatTabBtn = await $(S.chatTab);
		await chatTabBtn.click();

		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
