import type { TarotReading } from "./reading";
import { nextUnrevealedCard, revealNextCard, revealedCards } from "./reading";

export interface TarotToolState {
	getReading: () => TarotReading | null;
	startReading: (question: string, spread: "celtic" | "three") => TarotReading;
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
		if (action === "start_reading") {
			if (
				args.spread !== undefined &&
				args.spread !== "celtic" &&
				args.spread !== "three"
			)
				throw new Error("Invalid spread");
			const spread = args.spread === "three" ? "three" : "celtic";
			const question =
				typeof args.question === "string"
					? args.question.trim().slice(0, 500)
					: "";
			if (!question)
				return {
					need_question: true,
					note: "Ask the user what their concern is and wait for their answer before starting.",
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
