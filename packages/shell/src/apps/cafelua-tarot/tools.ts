import type { TarotReading, TarotSpread } from "./reading";
import { nextUnrevealedCard, revealNextCard, revealedCards } from "./reading";

function isValidSpread(value: unknown): value is TarotSpread {
	return value === "one" || value === "three" || value === "celtic";
}

export interface TarotToolState {
	getReading: () => TarotReading | null;
	getPreferredSpread?: () => TarotSpread;
	setPreferredSpread?: (spread: TarotSpread) => void;
	startReading: (question: string, spread: TarotSpread) => TarotReading;
	setReading: (reading: TarotReading) => void;
	onReveal?: () => void;
	finish: () => void;
	openStory: (
		card: string | number | undefined,
		part: 1 | 2,
	) => Record<string, unknown>;
	readAloud: () => Record<string, unknown>;
	stopReading: () => Record<string, unknown>;
	status: () => Record<string, unknown>;
}
export type TarotToolResult = Record<string, unknown>;

function cardResult(
	item: TarotReading["cards"][number],
	index: number,
	total: number,
) {
	return {
		number: index + 1,
		total,
		position: item.position.nameEn,
		position_ko: item.position.nameKr,
		position_meaning: item.position.description,
		card: item.card.nameEn,
		card_ko: item.card.nameKr,
		card_number: item.card.id,
		reversed: item.isReversed,
		keywords: item.card.keywords,
		meaning: item.card[item.isReversed ? "reversed" : "upright"],
		cafelua_prop: item.card.objects
			.map((o) => `${o.cafelua}: ${o.meaning}`)
			.join("; "),
	};
}
export function createTarotToolHandler(state: TarotToolState) {
	return (args: Record<string, unknown>): TarotToolResult => {
		const action = args.action;
		if (action === "select_spread") {
			if (!isValidSpread(args.spread)) throw new Error("Invalid spread");
			state.setPreferredSpread?.(args.spread);
			return {
				preferred_spread: args.spread,
				available_spreads: ["one", "three", "celtic"],
				note: "Spread preference updated on the table. Now ask the user's concern if not yet stated, then call start_reading.",
			};
		}
		if (action === "start_reading") {
			if (args.spread !== undefined && !isValidSpread(args.spread))
				throw new Error("Invalid spread");
			const preferred = state.getPreferredSpread?.() ?? "celtic";
			const spread: TarotSpread = isValidSpread(args.spread)
				? args.spread
				: preferred;
			if (isValidSpread(args.spread)) {
				state.setPreferredSpread?.(args.spread);
			}
			const question =
				typeof args.question === "string"
					? args.question.trim().slice(0, 500)
					: "";
			if (!question)
				return {
					need_question: true,
					need_spread: args.spread === undefined,
					preferred_spread: spread,
					available_spreads: ["one", "three", "celtic"],
					note: "Ask the user both what is on their mind AND which spread style they want: 'one' (1-card focus), 'three' (3-card Past/Present/Future), or 'celtic' (10-card Celtic Cross, full traditional reading). Wait for their answer before starting.",
				};
			const reading = state.startReading(question, spread);
			return {
				spread,
				total: reading.cards.length,
				positions: reading.cards.map((x) => ({
					name: x.position.nameEn,
					name_ko: x.position.nameKr,
					meaning: x.position.description,
				})),
			};
		}
		if (action === "open_story") {
			if (args.part !== undefined && args.part !== 1 && args.part !== 2)
				throw new Error("Invalid part");
			if (
				args.card !== undefined &&
				typeof args.card !== "string" &&
				typeof args.card !== "number"
			)
				throw new Error("Invalid card");
			const result = state.openStory(
				args.card as string | number | undefined,
				args.part === 2 ? 2 : 1,
			);
			const addNote = (value: TarotToolResult) => ({
				...value,
				note: "To read it, call read_aloud. Never write story text from memory.",
			});
			return result instanceof Promise
				? (result.then(addNote) as unknown as TarotToolResult)
				: addNote(result);
		}
		if (action === "read_aloud") return state.readAloud();
		if (action === "stop_reading") return state.stopReading();
		if (action === "status") return state.status();
		const current = state.getReading();
		if (!current) throw new Error("No reading has started");
		if (action === "reveal_next") {
			if (!nextUnrevealedCard(current))
				throw new Error("All cards have been revealed");
			const next = revealNextCard(current);
			state.setReading(next);
			state.onReveal?.();
			const shown = revealedCards(next);
			const remaining = next.cards.length - shown.length;
			return {
				...cardResult(
					shown[shown.length - 1],
					shown.length - 1,
					next.cards.length,
				),
				revealed: shown.length,
				remaining,
				all_revealed: remaining === 0,
				...(remaining > 0
					? {
							note: "Interpret only this card. Do not name, guess, or interpret unrevealed cards. Wait for the user before the next reveal.",
						}
					: {}),
			};
		}
		if (action === "get_reading" || action === "finish") {
			if (action === "finish") {
				if (nextUnrevealedCard(current))
					throw new Error("Reveal all cards before finishing");
				state.finish();
			}
			const revealed = revealedCards(current).length;
			const remaining = current.cards.length - revealed;
			return {
				...(remaining
					? {
							incomplete: true,
							revealed,
							remaining,
							note: "Not all cards are revealed. Do not synthesize; reveal the next card when the user is ready.",
						}
					: { all_revealed: true }),
				cards: revealedCards(current).map((item, index) =>
					cardResult(item, index, current.cards.length),
				),
			};
		}
		throw new Error("Unknown action");
	};
}
