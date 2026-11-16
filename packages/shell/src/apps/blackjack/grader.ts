import { Logger } from "../../lib/logger";
import type { BlackjackRuleSet, Card, Rank, Suit } from "./domain";
import { SUITS, RANKS } from "./domain";
import type { BlackjackMessageKey } from "./locales/messages";

const TAG = "BlackjackGrader";

export interface GradeUnitCheck {
	id: string;
	step: 1 | 2 | 3 | 4 | 5;
	labelKey: BlackjackMessageKey;
	passed: boolean;
	detail: string;
}

export interface StepGradeSummary {
	step: 1 | 2 | 3 | 4 | 5;
	passed: boolean;
	checks: GradeUnitCheck[];
}

export interface BlackjackGradeReport {
	compileError: string | null;
	compiledRules: Partial<BlackjackRuleSet> | null;
	steps: StepGradeSummary[];
	passedSteps: Array<1 | 2 | 3 | 4 | 5>;
	passedChecks: number;
	totalChecks: number;
}

function card(rank: Rank, suit: Suit = "♠"): Card {
	const value =
		rank === "A"
			? 11
			: rank === "J" || rank === "Q" || rank === "K"
				? 10
				: Number(rank);
	return { suit, rank, value };
}

export function compileLearnerRules(code: string): {
	rules: Partial<BlackjackRuleSet> | null;
	error: string | null;
} {
	Logger.debug(TAG, "compiling learner blackjack rules", {
		codeLength: code.length,
	});
	try {
		const factory = new Function(
			"window",
			`"use strict";\n${code}\nreturn {\n  createDeck: typeof createDeck === "function" ? createDeck : undefined,\n  handValue: typeof handValue === "function" ? handValue : undefined,\n  canPlayerHit: typeof canPlayerHit === "function" ? canPlayerHit : undefined,\n  shouldDealerHit: typeof shouldDealerHit === "function" ? shouldDealerHit : undefined,\n  judgeOutcome: typeof judgeOutcome === "function" ? judgeOutcome : undefined,\n  settleChips: typeof settleChips === "function" ? settleChips : undefined\n};`,
		) as (win: Record<string, unknown>) => Partial<BlackjackRuleSet>;
		const sandboxWindow: Record<string, unknown> = {};
		const rules = factory(sandboxWindow);
		return { rules, error: null };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		Logger.warn(TAG, "failed to compile learner blackjack code", { error: msg });
		return { rules: null, error: msg };
	}
}

function runCheck(
	id: string,
	step: 1 | 2 | 3 | 4 | 5,
	labelKey: BlackjackMessageKey,
	fn: () => { passed: boolean; detail: string },
): GradeUnitCheck {
	try {
		const { passed, detail } = fn();
		return { id, step, labelKey, passed, detail };
	} catch (err) {
		return {
			id,
			step,
			labelKey,
			passed: false,
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

export function gradeBlackjackCode(code: string): BlackjackGradeReport {
	const { rules, error } = compileLearnerRules(code);

	const checks: GradeUnitCheck[] = [
		runCheck("s1_count", 1, "bj.gradeCheck.s1_count", () => {
			if (!rules?.createDeck) {
				return { passed: false, detail: "createDeck is not defined" };
			}
			const deck = rules.createDeck();
			const len = Array.isArray(deck) ? deck.length : -1;
			return {
				passed: len === 52,
				detail: `length=${len} (expected 52)`,
			};
		}),
		runCheck("s1_unique", 1, "bj.gradeCheck.s1_unique", () => {
			if (!rules?.createDeck) {
				return { passed: false, detail: "createDeck is not defined" };
			}
			const deck = rules.createDeck();
			if (!Array.isArray(deck)) {
				return { passed: false, detail: "deck is not an array" };
			}
			const keys = new Set<string>();
			for (const c of deck) {
				if (
					c &&
					(SUITS as readonly string[]).includes(c.suit) &&
					(RANKS as readonly string[]).includes(c.rank)
				) {
					keys.add(`${c.suit}${c.rank}`);
				}
			}
			return {
				passed: keys.size === 52,
				detail: `uniqueValidCards=${keys.size}/52`,
			};
		}),
		runCheck("s1_values", 1, "bj.gradeCheck.s1_values", () => {
			if (!rules?.createDeck) {
				return { passed: false, detail: "createDeck is not defined" };
			}
			const deck = rules.createDeck();
			if (!Array.isArray(deck) || deck.length === 0) {
				return { passed: false, detail: "empty deck" };
			}
			const allValid = deck.every((c) => {
				if (!c) return false;
				if (c.rank === "A") return c.value === 11 || c.value === 1;
				if (c.rank === "J" || c.rank === "Q" || c.rank === "K") {
					return c.value === 10;
				}
				return c.value === Number(c.rank);
			});
			return {
				passed: allValid && deck.length === 52,
				detail: allValid ? "card values valid" : "card point mapping mismatch",
			};
		}),

		runCheck("s2_basic", 2, "bj.gradeCheck.s2_basic", () => {
			if (!rules?.handValue) {
				return { passed: false, detail: "handValue is not defined" };
			}
			const v1 = rules.handValue([card("10"), card("7", "♥")]);
			const v2 = rules.handValue([card("K"), card("Q", "♦")]);
			return {
				passed: v1 === 17 && v2 === 20,
				detail: `[10,7]=${v1}, [K,Q]=${v2}`,
			};
		}),
		runCheck("s2_ace11", 2, "bj.gradeCheck.s2_ace11", () => {
			if (!rules?.handValue) {
				return { passed: false, detail: "handValue is not defined" };
			}
			const v1 = rules.handValue([card("A"), card("8", "♥")]);
			const v2 = rules.handValue([card("A"), card("K", "♣")]);
			return {
				passed: v1 === 19 && v2 === 21,
				detail: `[A,8]=${v1}, [A,K]=${v2}`,
			};
		}),
		runCheck("s2_ace1", 2, "bj.gradeCheck.s2_ace1", () => {
			if (!rules?.handValue) {
				return { passed: false, detail: "handValue is not defined" };
			}
			const v1 = rules.handValue([card("A"), card("9", "♥"), card("5", "♦")]);
			const v2 = rules.handValue([card("A"), card("A", "♥"), card("9", "♣")]);
			return {
				passed: v1 === 15 && v2 === 21,
				detail: `[A,9,5]=${v1} (expected 15), [A,A,9]=${v2} (expected 21)`,
			};
		}),
		runCheck("s2_canHit", 2, "bj.gradeCheck.s2_canHit", () => {
			if (!rules?.canPlayerHit) {
				return { passed: false, detail: "canPlayerHit is not defined" };
			}
			const under = rules.canPlayerHit([card("10"), card("6", "♥")]);
			const at21 = rules.canPlayerHit([card("A"), card("K", "♦")]);
			const over = rules.canPlayerHit([
				card("10"),
				card("8", "♥"),
				card("5", "♣"),
			]);
			return {
				passed: under === true && at21 === false && over === false,
				detail: `16->${String(under)}, 21->${String(at21)}, 23->${String(over)}`,
			};
		}),

		runCheck("s3_hit16", 3, "bj.gradeCheck.s3_hit16", () => {
			if (!rules?.shouldDealerHit) {
				return { passed: false, detail: "shouldDealerHit is not defined" };
			}
			const at12 = rules.shouldDealerHit([card("9"), card("3", "♥")]);
			const at16 = rules.shouldDealerHit([card("10"), card("6", "♦")]);
			return {
				passed: at12 === true && at16 === true,
				detail: `12->${String(at12)}, 16->${String(at16)}`,
			};
		}),
		runCheck("s3_stand17", 3, "bj.gradeCheck.s3_stand17", () => {
			if (!rules?.shouldDealerHit) {
				return { passed: false, detail: "shouldDealerHit is not defined" };
			}
			const at17 = rules.shouldDealerHit([card("10"), card("7", "♥")]);
			const soft17 = rules.shouldDealerHit([card("A"), card("6", "♣")]);
			const at20 = rules.shouldDealerHit([card("K"), card("Q", "♦")]);
			return {
				passed: at17 === false && soft17 === false && at20 === false,
				detail: `17->${String(at17)}, A+6->${String(soft17)}, 20->${String(at20)}`,
			};
		}),

		runCheck("s4_bust", 4, "bj.gradeCheck.s4_bust", () => {
			if (!rules?.judgeOutcome) {
				return { passed: false, detail: "judgeOutcome is not defined" };
			}
			const res = rules.judgeOutcome(
				[card("10"), card("8", "♥"), card("6", "♣")],
				[card("10", "♦"), card("7", "♠")],
			);
			return {
				passed: res === "bust",
				detail: `24 vs 17 -> ${String(res)}`,
			};
		}),
		runCheck("s4_natural", 4, "bj.gradeCheck.s4_natural", () => {
			if (!rules?.judgeOutcome) {
				return { passed: false, detail: "judgeOutcome is not defined" };
			}
			const soloNatural = rules.judgeOutcome(
				[card("A"), card("K", "♥")],
				[card("7", "♣"), card("7", "♦"), card("7", "♠")],
			);
			const mutualNatural = rules.judgeOutcome(
				[card("A"), card("K", "♥")],
				[card("A", "♦"), card("Q", "♣")],
			);
			const threeCard21 = rules.judgeOutcome(
				[card("7"), card("7", "♥"), card("7", "♦")],
				[card("10", "♣"), card("9", "♠")],
			);
			return {
				passed:
					soloNatural === "blackjack" &&
					mutualNatural === "push" &&
					threeCard21 === "win",
				detail: `naturalVs3Card21=${String(soloNatural)}, mutual=${String(mutualNatural)}, 3card21Vs19=${String(threeCard21)}`,
			};
		}),
		runCheck("s4_dealerBust", 4, "bj.gradeCheck.s4_dealerBust", () => {
			if (!rules?.judgeOutcome) {
				return { passed: false, detail: "judgeOutcome is not defined" };
			}
			const res = rules.judgeOutcome(
				[card("10"), card("8", "♥")],
				[card("10", "♣"), card("6", "♦"), card("8", "♠")],
			);
			return {
				passed: res === "win",
				detail: `18 vs 24 -> ${String(res)}`,
			};
		}),
		runCheck("s4_compare", 4, "bj.gradeCheck.s4_compare", () => {
			if (!rules?.judgeOutcome) {
				return { passed: false, detail: "judgeOutcome is not defined" };
			}
			const win = rules.judgeOutcome(
				[card("10"), card("9", "♥")],
				[card("10", "♣"), card("8", "♦")],
			);
			const lose = rules.judgeOutcome(
				[card("10"), card("7", "♥")],
				[card("10", "♣"), card("9", "♦")],
			);
			const push = rules.judgeOutcome(
				[card("10"), card("8", "♥")],
				[card("9", "♣"), card("9", "♦")],
			);
			return {
				passed: win === "win" && lose === "lose" && push === "push",
				detail: `19v18=${String(win)}, 17v19=${String(lose)}, 18v18=${String(push)}`,
			};
		}),

		runCheck("s5_bjPayout", 5, "bj.gradeCheck.s5_bjPayout", () => {
			if (!rules?.settleChips) {
				return { passed: false, detail: "settleChips is not defined" };
			}
			const p100 = rules.settleChips(100, "blackjack");
			const p20 = rules.settleChips(20, "blackjack");
			return {
				passed: p100 === 250 && p20 === 50,
				detail: `bet100->${String(p100)} (expected 250), bet20->${String(p20)} (expected 50)`,
			};
		}),
		runCheck("s5_winPayout", 5, "bj.gradeCheck.s5_winPayout", () => {
			if (!rules?.settleChips) {
				return { passed: false, detail: "settleChips is not defined" };
			}
			const p100 = rules.settleChips(100, "win");
			return {
				passed: p100 === 200,
				detail: `bet100->${String(p100)} (expected 200)`,
			};
		}),
		runCheck("s5_pushLose", 5, "bj.gradeCheck.s5_pushLose", () => {
			if (!rules?.settleChips) {
				return { passed: false, detail: "settleChips is not defined" };
			}
			const push = rules.settleChips(100, "push");
			const lose = rules.settleChips(100, "lose");
			const bust = rules.settleChips(100, "bust");
			return {
				passed: push === 100 && lose === 0 && bust === 0,
				detail: `push=${String(push)}, lose=${String(lose)}, bust=${String(bust)}`,
			};
		}),
	];

	const stepNumbers: ReadonlyArray<1 | 2 | 3 | 4 | 5> = [1, 2, 3, 4, 5];
	const steps: StepGradeSummary[] = stepNumbers.map((step) => {
		const stepChecks = checks.filter((c) => c.step === step);
		return {
			step,
			passed: !error && stepChecks.length > 0 && stepChecks.every((c) => c.passed),
			checks: stepChecks,
		};
	});

	const passedSteps = steps.filter((s) => s.passed).map((s) => s.step);
	const passedChecks = error ? 0 : checks.filter((c) => c.passed).length;

	return {
		compileError: error,
		compiledRules: rules,
		steps,
		passedSteps,
		passedChecks,
		totalChecks: checks.length,
	};
}
