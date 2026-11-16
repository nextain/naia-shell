import { describe, expect, it } from "vitest";
import {
	REFERENCE_RULE_SET,
	adjustBet,
	createInitialTableState,
	createSafeRuleRunner,
	dealRound,
	hitPlayer,
	prepareNextBettingRound,
	referenceCreateDeck,
	referenceHandValue,
	referenceJudgeOutcome,
	referenceSettleChips,
	referenceShouldDealerHit,
	standPlayer,
} from "../domain";
import { compileLearnerRules, gradeBlackjackCode } from "../grader";
import {
	REFERENCE_SOLUTION_CODE,
	STARTER_CODE_EN,
	STARTER_CODE_KO,
} from "../locales/messages";

describe("Blackjack domain & auto-grader", () => {
	it("reference rules satisfy 52-card deck, flexible Aces, dealer 17, natural 21, and 2.5x payout", () => {
		const deck = referenceCreateDeck();
		expect(deck).toHaveLength(52);
		expect(new Set(deck.map((c) => `${c.suit}${c.rank}`)).size).toBe(52);

		expect(
			referenceHandValue([
				{ suit: "♠", rank: "A", value: 11 },
				{ suit: "♥", rank: "A", value: 11 },
				{ suit: "♦", rank: "9", value: 9 },
			]),
		).toBe(21);
		expect(
			referenceHandValue([
				{ suit: "♠", rank: "A", value: 11 },
				{ suit: "♥", rank: "9", value: 9 },
				{ suit: "♦", rank: "5", value: 5 },
			]),
		).toBe(15);

		expect(
			referenceShouldDealerHit([
				{ suit: "♠", rank: "10", value: 10 },
				{ suit: "♥", rank: "6", value: 6 },
			]),
		).toBe(true);
		expect(
			referenceShouldDealerHit([
				{ suit: "♠", rank: "10", value: 10 },
				{ suit: "♥", rank: "7", value: 7 },
			]),
		).toBe(false);

		expect(
			referenceJudgeOutcome(
				[
					{ suit: "♠", rank: "A", value: 11 },
					{ suit: "♥", rank: "K", value: 10 },
				],
				[
					{ suit: "♣", rank: "7", value: 7 },
					{ suit: "♦", rank: "7", value: 7 },
					{ suit: "♠", rank: "7", value: 7 },
				],
			),
		).toBe("blackjack");

		expect(referenceSettleChips(100, "blackjack")).toBe(250);
		expect(referenceSettleChips(100, "win")).toBe(200);
		expect(referenceSettleChips(100, "push")).toBe(100);
		expect(referenceSettleChips(100, "lose")).toBe(0);
	});

	it("starter scaffold compiles cleanly, keeps table playable, and leaves all 5 missions to complete", () => {
		for (const starter of [STARTER_CODE_KO, STARTER_CODE_EN]) {
			const report = gradeBlackjackCode(starter);
			expect(report.compileError).toBeNull();
			expect(report.passedSteps).toEqual([]);
			expect(report.totalChecks).toBe(16);
		}
	});

	it("reference solution passes 100% of unit checks across all 5 steps", () => {
		const report = gradeBlackjackCode(REFERENCE_SOLUTION_CODE);
		expect(report.compileError).toBeNull();
		expect(report.passedSteps).toEqual([1, 2, 3, 4, 5]);
		expect(report.passedChecks).toBe(report.totalChecks);
	});

	it("reports syntax errors cleanly and falls back gracefully when learner functions throw", () => {
		const broken = gradeBlackjackCode("function createDeck( { syntax error");
		expect(broken.compileError).toBeTruthy();
		expect(broken.passedChecks).toBe(0);

		const throwing = compileLearnerRules(`
			function createDeck() { throw new Error("boom"); }
			function handValue() { throw new Error("boom"); }
		`);
		const { rules, fallbacks } = createSafeRuleRunner(throwing.rules, "learner");
		expect(rules.createDeck()).toHaveLength(52);
		expect(
			rules.handValue([
				{ suit: "♠", rank: "10", value: 10 },
				{ suit: "♥", rank: "8", value: 8 },
			]),
		).toBe(18);
		expect(fallbacks).toContain("createDeck");
		expect(fallbacks).toContain("handValue");
	});

	it("runs a complete betting -> deal -> hit/stand -> round_over -> next round lifecycle", () => {
		let table = createInitialTableState(500);
		table = adjustBet(table, 50);
		expect(table.bet).toBe(100);

		table = dealRound(table, REFERENCE_RULE_SET, "reference", () => 0.42);
		expect(table.chips).toBe(400);
		expect(table.playerHand.length).toBeGreaterThanOrEqual(2);
		expect(table.dealerHand.length).toBeGreaterThanOrEqual(2);

		if (table.phase === "player_turn") {
			table = hitPlayer(table, REFERENCE_RULE_SET, "reference");
		}
		if (table.phase === "player_turn") {
			table = standPlayer(table, REFERENCE_RULE_SET, "reference");
		}
		expect(table.phase).toBe("round_over");
		expect(table.outcome).not.toBeNull();

		const reset = prepareNextBettingRound(table);
		expect(reset.phase).toBe("betting");
		expect(reset.playerHand).toHaveLength(0);
	});
});
