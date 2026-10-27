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
			const reading = state.startReading(
				typeof args.question === "string"
					? args.question.trim().slice(0, 500)
					: "",
				spread,
			);
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
			return state.openStory(
				args.card as string | number | undefined,
				args.part === 2 ? 2 : 1,
			);
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
			return cardResult(
				shown[shown.length - 1],
				shown.length - 1,
				next.cards.length,
			);
		}
		if (action === "get_reading" || action === "finish") {
			if (action === "finish") {
				if (nextUnrevealedCard(current))
					throw new Error("Reveal all cards before finishing");
				state.finish();
			}
			return {
				cards: revealedCards(current).map((item, index) =>
					cardResult(item, index, current.cards.length),
				),
			};
		}
		throw new Error("Unknown action");
	};
}
