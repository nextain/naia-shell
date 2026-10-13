import type { TarotReading } from "./reading";
import { nextUnrevealedCard, revealNextCard, revealedCards } from "./reading";

export interface TarotToolState {
	getReading: () => TarotReading | null;
	startReading: (question: string) => TarotReading;
	setReading: (reading: TarotReading) => void;
	onReveal?: () => void;
}

export interface TarotToolResult {
	status: "started" | "revealed" | "waiting" | "empty" | "complete";
	message: string;
	reading?: Record<string, unknown>;
}

function compactReading(reading: TarotReading): Record<string, unknown> {
	return {
		question: reading.question,
		cards: reading.cards
			.filter((item) => item.isFlipped)
			.map(({ card, position, isReversed }) => ({
				position: position.nameEn,
				positionKo: position.nameKr,
				card: card.nameEn,
				cardKo: card.nameKr,
				reversed: isReversed,
			})),
		remaining: reading.cards.filter((item) => !item.isFlipped).length,
	};
}

export function createTarotToolHandler(state: TarotToolState) {
	return (args: Record<string, unknown>): TarotToolResult => {
		const action = typeof args.action === "string" ? args.action : "status";
		if (action === "start_reading") {
			const question = typeof args.question === "string" ? args.question : "";
			const reading = state.startReading(question.trim().slice(0, 500));
			return {
				status: "started",
				message:
					"A local 10-card Celtic Cross reading is ready. The user reveals the cards in the app.",
				reading: compactReading(reading),
			};
		}
		if (!["reveal_next", "status", "get_context"].includes(action)) {
			return {
				status: "empty",
				message:
					"Unknown action. Use start_reading, reveal_next, status, or get_context.",
			};
		}
		const current = state.getReading();
		if (!current) {
			return {
				status: "empty",
				message: "No reading is open. Ask the user to start one in the app.",
			};
		}
		if (action === "reveal_next") {
			const next = nextUnrevealedCard(current);
			if (!next) {
				return {
					status: "complete",
					message: "All ten cards have been revealed.",
					reading: compactReading(current),
				};
			}
			const updated = revealNextCard(current);
			state.setReading(updated);
			const shown = revealedCards(updated);
			const revealed = shown[shown.length - 1];
			state.onReveal?.();
			return {
				status: "revealed",
				message:
					"Revealed one card in the app. Interpret it in its Celtic Cross position and invite the user to continue when ready.",
				reading: {
					question: updated.question,
					position: revealed.position.nameEn,
					positionKo: revealed.position.nameKr,
					card: revealed.card.nameEn,
					cardKo: revealed.card.nameKr,
					reversed: revealed.isReversed,
					keywords: revealed.card.keywords,
					cafeluaSymbols: revealed.card.objects.map(
						(item) => `${item.cafelua} (${item.meaning})`,
					),
					meaning: revealed.card[revealed.isReversed ? "reversed" : "upright"],
				},
			};
		}
		if (action === "get_context" || action === "status") {
			return {
				status: current.cards.every((item) => item.isFlipped)
					? "complete"
					: "waiting",
				message: `${revealedCards(current).length} of 10 cards revealed.`,
				reading: compactReading(current),
			};
		}
		return { status: "empty", message: "No reading is open." };
	};
}
