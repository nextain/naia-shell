import { describe, expect, it } from "vitest";
import { createInitialTableState } from "../domain";
import { gradeBlackjackCode } from "../grader";
import { REFERENCE_SOLUTION_CODE, STARTER_CODE_KO } from "../locales/messages";
import {
	type BlackjackStudioSnapshot,
	buildBlackjackContextPayload,
	handleBlackjackTutorToolCall,
} from "../tools";

function makeSnapshot(
	overrides?: Partial<BlackjackStudioSnapshot>,
): BlackjackStudioSnapshot {
	const baseTable = {
		...createInitialTableState(500),
		phase: "player_turn" as const,
		chips: 450,
		bet: 50,
		playerHand: [
			{ suit: "♠" as const, rank: "10" as const, value: 10 },
			{ suit: "♥" as const, rank: "6" as const, value: 6 },
		],
		dealerHand: [
			{ suit: "♦" as const, rank: "A" as const, value: 11 },
			{ suit: "♣" as const, rank: "9" as const, value: 9 },
		],
		playerScore: 16,
		dealerScore: 20,
	};

	return {
		currentStep: 2,
		openedHintsByStep: { 1: 0, 2: 1, 3: 0, 4: 0, 5: 0 },
		table: baseTable,
		gradeReport: gradeBlackjackCode(STARTER_CODE_KO),
		locale: "ko",
		...overrides,
	};
}

describe("skill_blackjack_tutor tool & context security", () => {
	it("NEVER exposes the dealer's hidden hole card or hidden total during player_turn", () => {
		const snapshot = makeSnapshot();
		const ctx = buildBlackjackContextPayload(snapshot);
		const serializedCtx = JSON.stringify(ctx);
		expect(serializedCtx).not.toContain("♦A");
		expect(ctx.data.dealerVisibleCard).toBe("♣9");
		expect(ctx.data.dealerHoleCardHidden).toBe(true);

		const statusRes = handleBlackjackTutorToolCall(
			{ action: "status" },
			{
				getSnapshot: () => snapshot,
				setStep: () => {},
				openNextHint: () => 1,
				runGrader: () => snapshot.gradeReport,
			},
		);
		expect(statusRes.ok).toBe(true);
		if (!statusRes.ok) return;
		const serializedStatus = JSON.stringify(statusRes.result);
		expect(serializedStatus).not.toContain('"rank":"A"');
		const game = statusRes.result.game as Record<string, unknown>;
		expect(game.dealerHand).toEqual([
			{ hidden: true },
			{ suit: "♣", rank: "9" },
		]);
		expect(game.dealerScore).toBeNull();
		expect(statusRes.result.teaching_style).toContain("소크라테스");
	});

	it("reveals full dealer hand once round_over is reached", () => {
		const base = makeSnapshot();
		const snapshot = makeSnapshot({
			table: { ...base.table, phase: "round_over", outcome: "lose" },
		});
		const statusRes = handleBlackjackTutorToolCall(
			{ action: "status" },
			{
				getSnapshot: () => snapshot,
				setStep: () => {},
				openNextHint: () => 1,
				runGrader: () => snapshot.gradeReport,
			},
		);
		expect(statusRes.ok).toBe(true);
		if (!statusRes.ok) return;
		const game = statusRes.result.game as Record<string, unknown>;
		expect(game.dealerHand).toEqual([
			{ suit: "♦", rank: "A" },
			{ suit: "♣", rank: "9" },
		]);
		expect(game.dealerScore).toBe(20);
	});

	it("supports lesson, goto, hint, and grade actions and rejects invalid args", () => {
		let stepState: 1 | 2 | 3 | 4 | 5 = 1;
		let hintLevel = 0;
		const controller = {
			getSnapshot: () =>
				makeSnapshot({
					currentStep: stepState,
					openedHintsByStep: { 1: hintLevel, 2: 0, 3: 0, 4: 0, 5: 0 },
				}),
			setStep: (s: 1 | 2 | 3 | 4 | 5) => {
				stepState = s;
			},
			openNextHint: () => {
				hintLevel = Math.min(3, hintLevel + 1);
				return hintLevel;
			},
			runGrader: () => gradeBlackjackCode(REFERENCE_SOLUTION_CODE),
		};

		const lesson = handleBlackjackTutorToolCall({ action: "lesson" }, controller);
		expect(lesson.ok).toBe(true);
		if (lesson.ok) {
			expect(lesson.result.step).toBe(1);
			expect(lesson.result.totalHints).toBe(3);
		}

		const hint = handleBlackjackTutorToolCall({ action: "hint" }, controller);
		expect(hint.ok).toBe(true);
		if (hint.ok) {
			expect(hint.result.openedLevel).toBe(1);
		}

		const gotoOk = handleBlackjackTutorToolCall(
			{ action: "goto", step: 4 },
			controller,
		);
		expect(gotoOk.ok).toBe(true);
		expect(stepState).toBe(4);

		const gotoBad = handleBlackjackTutorToolCall(
			{ action: "goto", step: 9 },
			controller,
		);
		expect(gotoBad.ok).toBe(false);

		const grade = handleBlackjackTutorToolCall({ action: "grade" }, controller);
		expect(grade.ok).toBe(true);
		if (grade.ok) {
			expect(grade.result.passedSteps).toEqual([1, 2, 3, 4, 5]);
		}

		const badAction = handleBlackjackTutorToolCall(
			{ action: "unknown" },
			controller,
		);
		expect(badAction.ok).toBe(false);
	});
});
