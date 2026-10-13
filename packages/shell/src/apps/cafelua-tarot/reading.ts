import { FALLBACK_TAROT_CARDS } from "./data/fallbackCards";
import { type DrawnCard, SPREAD_POSITIONS } from "./data/types";

export interface TarotReading {
	id: string;
	question: string;
	cards: DrawnCard[];
	createdAt: number;
}

export type RandomSource = () => number;

function randomIndex(random: RandomSource, length: number): number {
	const value = random();
	if (!Number.isFinite(value) || value < 0 || value >= 1) {
		throw new RangeError("The random source must return a value in [0, 1).");
	}
	return Math.floor(value * length);
}

export function drawCelticCross(
	question: string,
	random: RandomSource = Math.random,
	createdAt = Date.now(),
): TarotReading {
	if (FALLBACK_TAROT_CARDS.length !== 22 || SPREAD_POSITIONS.length !== 10) {
		throw new Error(
			"The Cafe Lua v2.0 deck must contain 22 cards and 10 positions.",
		);
	}
	const deck = [...FALLBACK_TAROT_CARDS];
	for (let index = deck.length - 1; index > 0; index -= 1) {
		const swap = randomIndex(random, index + 1);
		[deck[index], deck[swap]] = [deck[swap], deck[index]];
	}
	const cards = SPREAD_POSITIONS.map((position, index) => ({
		card: deck[index],
		position,
		isReversed: randomIndex(random, 2) === 1,
		isFlipped: false,
	}));
	return {
		id: `tarot-${createdAt}-${Math.floor(random() * 1_000_000)}`,
		question: question.trim().slice(0, 500),
		cards,
		createdAt,
	};
}

export function revealNextCard(reading: TarotReading): TarotReading {
	const index = reading.cards.findIndex((item) => !item.isFlipped);
	if (index < 0) return reading;
	const cards = reading.cards.map((item, cardIndex) =>
		cardIndex === index ? { ...item, isFlipped: true } : item,
	);
	return { ...reading, cards };
}

export function revealedCards(reading: TarotReading): DrawnCard[] {
	return reading.cards.filter((item) => item.isFlipped);
}

export function nextUnrevealedCard(reading: TarotReading): DrawnCard | null {
	return reading.cards.find((item) => !item.isFlipped) ?? null;
}
