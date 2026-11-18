import { FALLBACK_TAROT_CARDS } from "./data/fallbackCards";
import {
	type DrawnCard,
	type SpreadPosition,
	SPREAD_POSITIONS,
} from "./data/types";

export type TarotSpread = "one" | "three" | "celtic";

export const ONE_CARD_POSITION: SpreadPosition = {
	index: 0,
	nameKr: "핵심 조언",
	nameEn: "Core Guidance",
	description: "지금 마음을 비추는 한 장의 핵심 메시지",
};

export interface TarotReading {
	id: string;
	question: string;
	cards: DrawnCard[];
	createdAt: number;
	spread?: TarotSpread;
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
	spread: TarotSpread = "celtic",
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
	const positions =
		spread === "one"
			? [ONE_CARD_POSITION]
			: spread === "three"
				? [SPREAD_POSITIONS[4], SPREAD_POSITIONS[0], SPREAD_POSITIONS[5]]
				: [
						SPREAD_POSITIONS[0],
						SPREAD_POSITIONS[1],
						SPREAD_POSITIONS[3],
						SPREAD_POSITIONS[4],
						SPREAD_POSITIONS[2],
						...SPREAD_POSITIONS.slice(5),
					];
	const cards = positions.map((position, index) => ({
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
		spread,
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
