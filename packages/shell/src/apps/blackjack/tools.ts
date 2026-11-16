import { Logger } from "../../lib/logger";
import type { BlackjackTableState, Card } from "./domain";
import type { BlackjackGradeReport } from "./grader";
import {
	blackjackText,
	getStepCurriculum,
	getTeachingStyleGuide,
} from "./locales/messages";

const TAG = "BlackjackTools";

export type BlackjackTutorAction =
	| "status"
	| "lesson"
	| "goto"
	| "hint"
	| "grade";

export interface SanitizedDealerView {
	visibleCards: Array<{ suit: string; rank: string } | { hidden: true }>;
	dealerTotal: number | null;
	holeCardHidden: boolean;
}

export interface BlackjackStudioSnapshot {
	currentStep: 1 | 2 | 3 | 4 | 5;
	openedHintsByStep: Record<number, number>;
	table: BlackjackTableState;
	gradeReport: BlackjackGradeReport;
	locale: string;
}

export interface BlackjackTutorController {
	getSnapshot: () => BlackjackStudioSnapshot;
	setStep: (step: 1 | 2 | 3 | 4 | 5) => void;
	openNextHint: (step: 1 | 2 | 3 | 4 | 5) => number;
	runGrader: () => BlackjackGradeReport;
}

export function sanitizeDealerHand(
	table: BlackjackTableState,
): SanitizedDealerView {
	if (table.phase === "player_turn" && table.dealerHand.length > 0) {
		const visibleCards: Array<
			{ suit: string; rank: string } | { hidden: true }
		> = [{ hidden: true }];
		for (const c of table.dealerHand.slice(1)) {
			visibleCards.push({ suit: c.suit, rank: c.rank });
		}
		return {
			visibleCards,
			dealerTotal: null,
			holeCardHidden: true,
		};
	}

	return {
		visibleCards: table.dealerHand.map((c: Card) => ({
			suit: c.suit,
			rank: c.rank,
		})),
		dealerTotal: table.dealerHand.length > 0 ? table.dealerScore : null,
		holeCardHidden: false,
	};
}

export function buildBlackjackContextPayload(snapshot: BlackjackStudioSnapshot): {
	type: "blackjack_studio";
	data: Record<string, unknown>;
} {
	const dealerView = sanitizeDealerHand(snapshot.table);
	const secondCard =
		snapshot.table.dealerHand.length > 1
			? `${snapshot.table.dealerHand[1]!.suit}${snapshot.table.dealerHand[1]!.rank}`
			: null;

	return {
		type: "blackjack_studio",
		data: {
			step: snapshot.currentStep,
			passedSteps: snapshot.gradeReport.passedSteps,
			passedChecks: snapshot.gradeReport.passedChecks,
			totalChecks: snapshot.gradeReport.totalChecks,
			gamePhase: snapshot.table.phase,
			chips: snapshot.table.chips,
			bet: snapshot.table.bet,
			playerScore: snapshot.table.playerScore,
			playerCards: snapshot.table.playerHand.map((c) => `${c.suit}${c.rank}`),
			dealerVisibleCard:
				snapshot.table.phase === "player_turn"
					? secondCard
					: snapshot.table.dealerHand.map((c) => `${c.suit}${c.rank}`),
			dealerHoleCardHidden: dealerView.holeCardHidden,
		},
	};
}

export function handleBlackjackTutorToolCall(
	rawArgs: unknown,
	controller: BlackjackTutorController,
): { ok: true; result: Record<string, unknown> } | { ok: false; error: string } {
	if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
		return { ok: false, error: "Invalid arguments: expected an object" };
	}
	const args = rawArgs as Record<string, unknown>;
	const action = args.action;
	if (
		action !== "status" &&
		action !== "lesson" &&
		action !== "goto" &&
		action !== "hint" &&
		action !== "grade"
	) {
		return {
			ok: false,
			error: `Unsupported skill_blackjack_tutor action: ${String(action)}`,
		};
	}

	Logger.debug(TAG, "handling skill_blackjack_tutor call", { action });
	const snapshot = controller.getSnapshot();
	const curriculum = getStepCurriculum(snapshot.locale);
	const teachingStyle = getTeachingStyleGuide(snapshot.locale);

	if (action === "status") {
		const dealer = sanitizeDealerHand(snapshot.table);
		return {
			ok: true,
			result: {
				action: "status",
				step: snapshot.currentStep,
				passedSteps: snapshot.gradeReport.passedSteps,
				passedChecks: snapshot.gradeReport.passedChecks,
				totalChecks: snapshot.gradeReport.totalChecks,
				game: {
					phase: snapshot.table.phase,
					chips: snapshot.table.chips,
					bet: snapshot.table.bet,
					playerHand: snapshot.table.playerHand.map((c) => ({
						suit: c.suit,
						rank: c.rank,
					})),
					playerScore: snapshot.table.playerScore,
					dealerHand: dealer.visibleCards,
					dealerScore: dealer.dealerTotal,
					dealerHoleCardHidden: dealer.holeCardHidden,
					outcome: snapshot.table.outcome,
				},
				teaching_style: teachingStyle,
			},
		};
	}

	if (action === "lesson") {
		const currentLesson =
			curriculum[snapshot.currentStep - 1] ?? curriculum[0]!;
		const openedCount = snapshot.openedHintsByStep[snapshot.currentStep] ?? 0;
		return {
			ok: true,
			result: {
				action: "lesson",
				step: currentLesson.step,
				title: currentLesson.title,
				mission: currentLesson.missionSummary,
				socraticQuestion: currentLesson.socraticQuestion,
				openedHints: currentLesson.hints.slice(0, openedCount),
				totalHints: currentLesson.hints.length,
				teaching_style: teachingStyle,
			},
		};
	}

	if (action === "goto") {
		const rawStep = Number(args.step);
		if (!Number.isInteger(rawStep) || rawStep < 1 || rawStep > 5) {
			return {
				ok: false,
				error: "Parameter 'step' must be an integer between 1 and 5",
			};
		}
		const targetStep = rawStep as 1 | 2 | 3 | 4 | 5;
		controller.setStep(targetStep);
		const targetLesson = curriculum[targetStep - 1]!;
		return {
			ok: true,
			result: {
				action: "goto",
				step: targetStep,
				title: targetLesson.title,
				socraticQuestion: targetLesson.socraticQuestion,
				teaching_style: teachingStyle,
			},
		};
	}

	if (action === "hint") {
		const step = snapshot.currentStep;
		const nextLevel = controller.openNextHint(step);
		const lesson = curriculum[step - 1]!;
		return {
			ok: true,
			result: {
				action: "hint",
				step,
				openedLevel: nextLevel,
				hint: lesson.hints[nextLevel - 1] ?? lesson.hints[lesson.hints.length - 1],
				openedHints: lesson.hints.slice(0, nextLevel),
				teaching_style: teachingStyle,
			},
		};
	}

	const report = controller.runGrader();
	return {
		ok: true,
		result: {
			action: "grade",
			compileError: report.compileError,
			passedSteps: report.passedSteps,
			passedChecks: report.passedChecks,
			totalChecks: report.totalChecks,
			checks: report.steps.flatMap((s) =>
				s.checks.map((c) => ({
					id: c.id,
					step: c.step,
					label: blackjackText(c.labelKey, undefined, snapshot.locale),
					passed: c.passed,
					detail: c.detail,
				})),
			),
			teaching_style: teachingStyle,
		},
	};
}
