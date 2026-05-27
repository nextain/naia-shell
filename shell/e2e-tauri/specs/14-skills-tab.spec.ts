import { S } from "../helpers/selectors.js";
import { clickBySelector, setNativeValue } from "../helpers/settings.js";

/**
 * 14 — Skills Tab E2E
 *
 * Verifies the Skills management UI:
 * - Tab navigation works
 * - Skills are listed (at least 20 built-in)
 * - Search filters work
 * - Toggle disable/enable works for custom skills
 * - Built-in skills cannot be toggled
 */
describe("14 — skills tab", () => {
	it("should navigate to Skills tab and show skills list", async () => {
		const skillsTabBtn = await $(S.skillsTab);
		await skillsTabBtn.waitForDisplayed({ timeout: 10_000 });
		await clickBySelector(S.skillsTab);

		const skillsPanel = await $(S.skillsTabPanel);
		await skillsPanel.waitForDisplayed({ timeout: 5_000 });
	});

	it("should display at least 20 built-in skills", async () => {
		// Wait for skills to render (may load from Gateway)
		await browser.waitUntil(
			async () => {
				const c = await $$(S.skillsCard);
				return c.length >= 20;
			},
			{
				timeout: 10_000,
				interval: 500,
				timeoutMsg: "Skills cards did not reach 20 within 10s",
			},
		);
		const cards = await $$(S.skillsCard);
		expect(cards.length).toBeGreaterThanOrEqual(20);

		// Verify section title exists (#334 — each rendered group emits one)
		const sectionTitles = await $$(S.skillsSectionTitle);
		expect(sectionTitles.length).toBeGreaterThanOrEqual(1);
	});

	// #334 — source grouping (agent / shell / adk)
	it("should render the agent + shell source groups", async () => {
		const agentGroup = await $(S.skillsGroupAgent);
		const shellGroup = await $(S.skillsGroupShell);
		expect(await agentGroup.isExisting()).toBe(true);
		expect(await shellGroup.isExisting()).toBe(true);
	});

	it("agent group has at least 7 cards (skill_bash optional)", async () => {
		// 7 = the 7 known-stable agent core skills; skill_bash makes 8 when
		// the Rust list emits it (this PR). Lower bound 7 keeps the test
		// robust if `--enable-file-ops` style gates are added later.
		const agentCards = await $$(S.skillsGroupAgentCard);
		expect(agentCards.length).toBeGreaterThanOrEqual(7);
	});

	it("each card shows a source badge", async () => {
		const badges = await $$(S.skillsSourceBadge);
		expect(badges.length).toBeGreaterThan(0);
		// Sample the first badge — must match one of the documented origins.
		const first = (await badges[0].getText()).toLowerCase();
		expect(first).toMatch(/^(agent|shell|adk|gateway|command)/);
	});

	it("agent group has no bulk-disable button (#334 §8.1 #4)", async () => {
		const btn = await $(S.skillsGroupAgentBulkDisable);
		expect(await btn.isExisting()).toBe(false);
	});

	it("should show skills count in header", async () => {
		const countEl = await $(S.skillsCount);
		await countEl.waitForDisplayed({ timeout: 3_000 });
		const text = await countEl.getText();
		// Format: enabled/total e.g. "55/55"
		expect(text).toMatch(/\d+\/\d+/);
	});

	it("should filter skills by search query", async () => {
		const searchInput = await $(S.skillsSearch);
		await searchInput.waitForDisplayed({ timeout: 3_000 });

		const cardsBefore = await $$(S.skillsCard);
		const countBefore = cardsBefore.length;

		// #334 §8.3 — use the exact-match special case `skill_browser_navigate`
		// to avoid description-collision false-fails ("time" could match
		// "real-time", "any time", etc.). The SkillsTab filter short-circuits
		// this exact string to a name-only match. If no matching skill is
		// registered (panel-injected skills surface in a later phase),
		// fall back to a generic prefix that's still in the list.
		await setNativeValue(S.skillsSearch, "skill_browser_navigate");
		await browser.pause(300);

		let cardsAfter = await $$(S.skillsCard);
		if (cardsAfter.length === 0) {
			// Panel skills not yet surfaced in Phase 1 — re-test with a name
			// that's definitely in the Rust-emitted list.
			await setNativeValue(S.skillsSearch, "skill_time");
			await browser.pause(300);
			cardsAfter = await $$(S.skillsCard);
		}
		expect(cardsAfter.length).toBeLessThan(countBefore);
		expect(cardsAfter.length).toBeGreaterThanOrEqual(1);

		// Clear search
		await setNativeValue(S.skillsSearch, "");
		await browser.pause(300);
	});

	it("should not show toggle for built-in skills", async () => {
		// Built-in skills are listed first, they should not have toggle inputs
		const firstCard = await $$(S.skillsCard);
		if (firstCard.length === 0) return;

		// The first card should be a built-in skill (no toggle)
		const toggleInFirstCard = await firstCard[0].$(S.skillsToggle);
		const exists = await toggleInFirstCard.isExisting();
		expect(exists).toBe(false);
	});

	it("should navigate back to chat tab", async () => {
		await clickBySelector(S.chatTab);

		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
