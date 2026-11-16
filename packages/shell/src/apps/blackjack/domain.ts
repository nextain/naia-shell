import { Logger } from "../../lib/logger";

const TAG = "BlackjackDomain";

export type Suit = "♠" | "♥" | "♦" | "♣";
export type Rank =
	| "A"
	| "2"
	| "3"
	| "4"
	| "5"
	| "6"
	| "7"
	| "8"
	| "9"
	| "10"
	| "J"
	| "Q"
	| "K";

export interface Card {
	suit: Suit;
	rank: Rank;
	value: number;
}

export type RoundOutcome = "blackjack" | "win" | "lose" | "push" | "bust";
export type GamePhase = "betting" | "player_turn" | "round_over";
export type ExecutionMode = "learner" | "reference";

export interface BlackjackRuleSet {
	createDeck: () => Card[];
	handValue: (cards: readonly Card[]) => number;
	canPlayerHit: (cards: readonly Card[]) => boolean;
	shouldDealerHit: (dealerCards: readonly Card[]) => boolean;
	judgeOutcome: (
		playerCards: readonly Card[],
		dealerCards: readonly Card[],
	) => RoundOutcome;
	settleChips: (bet: number, outcome: RoundOutcome) => number;
}

export interface BlackjackTableState {
	phase: GamePhase;
	chips: number;
	bet: number;
	deck: Card[];
	playerHand: Card[];
	dealerHand: Card[];
	playerScore: number;
	dealerScore: number;
	outcome: RoundOutcome | null;
	lastPayout: number;
	fallbackFunctions: string[];
}

export const SUITS: readonly Suit[] = ["♠", "♥", "♦", "♣"];
export const RANKS: readonly Rank[] = [
	"A",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"10",
	"J",
	"Q",
	"K",
];

const VALID_OUTCOMES = new Set<RoundOutcome>([
	"blackjack",
	"win",
	"lose",
	"push",
	"bust",
]);

export function referenceCreateDeck(): Card[] {
	const deck: Card[] = [];
	for (const suit of SUITS) {
		for (const rank of RANKS) {
			const value =
				rank === "A"
					? 11
					: rank === "J" || rank === "Q" || rank === "K"
						? 10
						: Number(rank);
			deck.push({ suit, rank, value });
		}
	}
	return deck;
}

export function referenceHandValue(cards: readonly Card[]): number {
	let total = 0;
	let aces = 0;
	for (const card of cards) {
		if (card.rank === "A") {
			aces += 1;
			total += 11;
		} else if (card.rank === "J" || card.rank === "Q" || card.rank === "K") {
			total += 10;
		} else {
			total += Number(card.rank);
		}
	}
	while (total > 21 && aces > 0) {
		total -= 10;
		aces -= 1;
	}
	return total;
}

export function referenceCanPlayerHit(cards: readonly Card[]): boolean {
	return referenceHandValue(cards) < 21;
}

export function referenceShouldDealerHit(dealerCards: readonly Card[]): boolean {
	return referenceHandValue(dealerCards) < 17;
}

export function referenceJudgeOutcome(
	playerCards: readonly Card[],
	dealerCards: readonly Card[],
): RoundOutcome {
	const playerScore = referenceHandValue(playerCards);
	const dealerScore = referenceHandValue(dealerCards);
	if (playerScore > 21) return "bust";
	const playerNatural = playerCards.length === 2 && playerScore === 21;
	const dealerNatural = dealerCards.length === 2 && dealerScore === 21;
	if (playerNatural && dealerNatural) return "push";
	if (playerNatural) return "blackjack";
	if (dealerNatural) return "lose";
	if (dealerScore > 21) return "win";
	if (playerScore > dealerScore) return "win";
	if (playerScore < dealerScore) return "lose";
	return "push";
}

export function referenceSettleChips(
	bet: number,
	outcome: RoundOutcome,
): number {
	if (outcome === "blackjack") return Math.floor(bet * 2.5);
	if (outcome === "win") return bet * 2;
	if (outcome === "push") return bet;
	return 0;
}

export const REFERENCE_RULE_SET: BlackjackRuleSet = {
	createDeck: referenceCreateDeck,
	handValue: referenceHandValue,
	canPlayerHit: referenceCanPlayerHit,
	shouldDealerHit: referenceShouldDealerHit,
	judgeOutcome: referenceJudgeOutcome,
	settleChips: referenceSettleChips,
};

export function isValidCard(raw: unknown): raw is Card {
	if (typeof raw !== "object" || raw === null) return false;
	const obj = raw as Record<string, unknown>;
	return (
		typeof obj.suit === "string" &&
		(SUITS as readonly string[]).includes(obj.suit) &&
		typeof obj.rank === "string" &&
		(RANKS as readonly string[]).includes(obj.rank)
	);
}

export function shuffleCards(
	cards: readonly Card[],
	random: () => number = Math.random,
): Card[] {
	const copy = cards.map((card) => ({ ...card }));
	for (let i = copy.length - 1; i > 0; i -= 1) {
		const j = Math.floor(random() * (i + 1));
		const tmp = copy[i]!;
		copy[i] = copy[j]!;
		copy[j] = tmp;
	}
	return copy;
}

function recordFallback(list: string[], fnName: string): void {
	if (!list.includes(fnName)) {
		list.push(fnName);
	}
}

export function createSafeRuleRunner(
	learner: Partial<BlackjackRuleSet> | null,
	mode: ExecutionMode,
): {
	rules: BlackjackRuleSet;
	fallbacks: string[];
} {
	const fallbacks: string[] = [];
	if (mode === "reference" || !learner) {
		return { rules: REFERENCE_RULE_SET, fallbacks };
	}

	const rules: BlackjackRuleSet = {
		createDeck() {
			try {
				if (typeof learner.createDeck === "function") {
					const out = learner.createDeck();
					if (Array.isArray(out) && out.length >= 10 && out.every(isValidCard)) {
						return out.map((c) => ({
							suit: c.suit,
							rank: c.rank,
							value:
								typeof c.value === "number" && Number.isFinite(c.value)
									? c.value
									: c.rank === "A"
										? 11
										: c.rank === "J" || c.rank === "Q" || c.rank === "K"
											? 10
											: Number(c.rank),
						}));
					}
				}
			} catch (err) {
				Logger.debug(TAG, "learner createDeck threw, using reference", {
					error: String(err),
				});
			}
			recordFallback(fallbacks, "createDeck");
			return referenceCreateDeck();
		},

		handValue(cards) {
			try {
				if (typeof learner.handValue === "function") {
					const val = learner.handValue(cards.map((c) => ({ ...c })));
					if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
						return val;
					}
				}
			} catch (err) {
				Logger.debug(TAG, "learner handValue threw, using reference", {
					error: String(err),
				});
			}
			recordFallback(fallbacks, "handValue");
			return referenceHandValue(cards);
		},

		canPlayerHit(cards) {
			try {
				if (typeof learner.canPlayerHit === "function") {
					const val = learner.canPlayerHit(cards.map((c) => ({ ...c })));
					if (typeof val === "boolean") {
						return val;
					}
				}
			} catch (err) {
				Logger.debug(TAG, "learner canPlayerHit threw, using reference", {
					error: String(err),
				});
			}
			recordFallback(fallbacks, "canPlayerHit");
			return referenceCanPlayerHit(cards);
		},

		shouldDealerHit(dealerCards) {
			try {
				if (typeof learner.shouldDealerHit === "function") {
					const val = learner.shouldDealerHit(
						dealerCards.map((c) => ({ ...c })),
					);
					if (typeof val === "boolean") {
						return val;
					}
				}
			} catch (err) {
				Logger.debug(TAG, "learner shouldDealerHit threw, using reference", {
					error: String(err),
				});
			}
			recordFallback(fallbacks, "shouldDealerHit");
			return referenceShouldDealerHit(dealerCards);
		},

		judgeOutcome(playerCards, dealerCards) {
			try {
				if (typeof learner.judgeOutcome === "function") {
					const val = learner.judgeOutcome(
						playerCards.map((c) => ({ ...c })),
						dealerCards.map((c) => ({ ...c })),
					);
					if (typeof val === "string" && VALID_OUTCOMES.has(val as RoundOutcome)) {
						return val as RoundOutcome;
					}
				}
			} catch (err) {
				Logger.debug(TAG, "learner judgeOutcome threw, using reference", {
					error: String(err),
				});
			}
			recordFallback(fallbacks, "judgeOutcome");
			return referenceJudgeOutcome(playerCards, dealerCards);
		},

		settleChips(bet, outcome) {
			try {
				if (typeof learner.settleChips === "function") {
					const val = learner.settleChips(bet, outcome);
					if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
						return Math.floor(val);
					}
				}
			} catch (err) {
				Logger.debug(TAG, "learner settleChips threw, using reference", {
					error: String(err),
				});
			}
			recordFallback(fallbacks, "settleChips");
			return referenceSettleChips(bet, outcome);
		},
	};

	return { rules, fallbacks };
}

export function createInitialTableState(initialChips = 500): BlackjackTableState {
	return {
		phase: "betting",
		chips: initialChips,
		bet: 50,
		deck: [],
		playerHand: [],
		dealerHand: [],
		playerScore: 0,
		dealerScore: 0,
		outcome: null,
		lastPayout: 0,
		fallbackFunctions: [],
	};
}

export function adjustBet(
	state: BlackjackTableState,
	delta: number | "reset",
): BlackjackTableState {
	if (state.phase !== "betting") return state;
	const available = Math.max(10, state.chips);
	if (delta === "reset") {
		return { ...state, bet: Math.min(10, available) };
	}
	const nextBet = Math.max(10, Math.min(available, state.bet + delta));
	return { ...state, bet: nextBet };
}

export function dealRound(
	state: BlackjackTableState,
	learner: Partial<BlackjackRuleSet> | null,
	mode: ExecutionMode,
	random: () => number = Math.random,
): BlackjackTableState {
	Logger.debug(TAG, "dealing new blackjack round", { mode, bet: state.bet });
	const bankroll = state.chips <= 0 ? 500 : state.chips;
	const wager = Math.max(10, Math.min(bankroll, state.bet));
	const { rules, fallbacks } = createSafeRuleRunner(learner, mode);

	const rawDeck = shuffleCards(rules.createDeck(), random);
	const playerHand = [rawDeck[0]!, rawDeck[2]!];
	const dealerHand = [rawDeck[1]!, rawDeck[3]!];
	const remainingDeck = rawDeck.slice(4);
	const chipsAfterBet = bankroll - wager;

	const playerScore = rules.handValue(playerHand);
	const dealerScore = rules.handValue(dealerHand);

	if (playerScore >= 21 || !rules.canPlayerHit(playerHand)) {
		return finishDealerAndSettle(
			{
				phase: "player_turn",
				chips: chipsAfterBet,
				bet: wager,
				deck: remainingDeck,
				playerHand,
				dealerHand,
				playerScore,
				dealerScore,
				outcome: null,
				lastPayout: 0,
				fallbackFunctions: [...fallbacks],
			},
			rules,
			fallbacks,
		);
	}

	return {
		phase: "player_turn",
		chips: chipsAfterBet,
		bet: wager,
		deck: remainingDeck,
		playerHand,
		dealerHand,
		playerScore,
		dealerScore,
		outcome: null,
		lastPayout: 0,
		fallbackFunctions: [...fallbacks],
	};
}

function finishDealerAndSettle(
	state: BlackjackTableState,
	rules: BlackjackRuleSet,
	fallbacks: string[],
): BlackjackTableState {
	const deck = [...state.deck];
	const dealerHand = [...state.dealerHand];
	const playerScore = rules.handValue(state.playerHand);

	if (playerScore <= 21 && !(state.playerHand.length === 2 && playerScore === 21)) {
		let guard = 0;
		while (deck.length > 0 && guard < 10 && rules.shouldDealerHit(dealerHand)) {
			dealerHand.push(deck.shift()!);
			guard += 1;
		}
	}

	const dealerScore = rules.handValue(dealerHand);
	const outcome = rules.judgeOutcome(state.playerHand, dealerHand);
	const payout = rules.settleChips(state.bet, outcome);

	return {
		...state,
		phase: "round_over",
		deck,
		dealerHand,
		playerScore,
		dealerScore,
		outcome,
		lastPayout: payout,
		chips: state.chips + payout,
		fallbackFunctions: [...fallbacks],
	};
}

export function hitPlayer(
	state: BlackjackTableState,
	learner: Partial<BlackjackRuleSet> | null,
	mode: ExecutionMode,
): BlackjackTableState {
	if (state.phase !== "player_turn" || state.deck.length === 0) return state;
	const { rules, fallbacks } = createSafeRuleRunner(learner, mode);
	for (const fn of state.fallbackFunctions) {
		recordFallback(fallbacks, fn);
	}
	if (!rules.canPlayerHit(state.playerHand)) {
		return finishDealerAndSettle(state, rules, fallbacks);
	}

	const [drawn, ...restDeck] = state.deck;
	if (!drawn) return state;
	const playerHand = [...state.playerHand, drawn];
	const playerScore = rules.handValue(playerHand);

	const updated: BlackjackTableState = {
		...state,
		deck: restDeck,
		playerHand,
		playerScore,
		fallbackFunctions: [...fallbacks],
	};

	if (playerScore >= 21 || !rules.canPlayerHit(playerHand)) {
		return finishDealerAndSettle(updated, rules, fallbacks);
	}
	return updated;
}

export function standPlayer(
	state: BlackjackTableState,
	learner: Partial<BlackjackRuleSet> | null,
	mode: ExecutionMode,
): BlackjackTableState {
	if (state.phase !== "player_turn") return state;
	const { rules, fallbacks } = createSafeRuleRunner(learner, mode);
	for (const fn of state.fallbackFunctions) {
		recordFallback(fallbacks, fn);
	}
	return finishDealerAndSettle(state, rules, fallbacks);
}

export function prepareNextBettingRound(
	state: BlackjackTableState,
): BlackjackTableState {
	const replenished = state.chips < 10 ? 500 : state.chips;
	return {
		...state,
		phase: "betting",
		chips: replenished,
		bet: Math.min(state.bet, replenished),
		playerHand: [],
		dealerHand: [],
		playerScore: 0,
		dealerScore: 0,
		outcome: null,
		lastPayout: 0,
		fallbackFunctions: [],
	};
}
