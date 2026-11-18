import { describe, expect, it } from "vitest";
import {
	drawCelticCross,
	nextUnrevealedCard,
	revealNextCard,
} from "../reading";

function seededRandom() {
	let state = 17;
	return () => {
		state = (state * 16_807) % 2_147_483_647;
		return (state - 1) / 2_147_483_646;
	};
}

describe("Cafe Lua Tarot local reading", () => {
	it("draws ten unique cards in Celtic Cross positions and includes both orientations", () => {
		const reading = drawCelticCross("A question", seededRandom(), 100);
		expect(reading.cards).toHaveLength(10);
		expect(new Set(reading.cards.map((item) => item.card.id)).size).toBe(10);
		expect(reading.cards.map((item) => item.position.index)).toEqual([
			0, 1, 3, 4, 2, 5, 6, 7, 8, 9,
		]);
		expect(reading.cards.some((item) => item.isReversed)).toBe(true);
		expect(reading.cards.some((item) => !item.isReversed)).toBe(true);
		expect(reading.cards.every((item) => !item.isFlipped)).toBe(true);
	});

	it("reveals only the next card and never changes an exhausted spread", () => {
		const start = drawCelticCross("", () => 0, 200);
		const one = revealNextCard(start);
		expect(one.cards.filter((item) => item.isFlipped)).toHaveLength(1);
		expect(nextUnrevealedCard(one)?.position.index).toBe(1);
		const complete = {
			...one,
			cards: one.cards.map((item) => ({ ...item, isFlipped: true })),
		};
		expect(revealNextCard(complete)).toBe(complete);
	});

	it("bounds the optional question and rejects an invalid random source", () => {
		expect(drawCelticCross("x".repeat(700), () => 0, 1).question).toHaveLength(
			500,
		);
		expect(() => drawCelticCross("", () => 1)).toThrow(RangeError);
	});

	it("supports one-card focus and three-card spreads while keeping celtic as default", () => {
		const def = drawCelticCross("default", seededRandom(), 10);
		expect(def.spread).toBe("celtic");
		expect(def.cards).toHaveLength(10);

		const one = drawCelticCross("focus", seededRandom(), 20, "one");
		expect(one.spread).toBe("one");
		expect(one.cards).toHaveLength(1);
		expect(one.cards[0]?.position.nameEn).toBe("Core Guidance");

		const three = drawCelticCross("flow", seededRandom(), 30, "three");
		expect(three.spread).toBe("three");
		expect(three.cards).toHaveLength(3);
	});
});
