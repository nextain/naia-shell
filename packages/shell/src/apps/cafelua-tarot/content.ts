import { FALLBACK_TAROT_CARDS } from "./data/fallbackCards";
import {
	TAROT_STORY_EDITIONS,
	type TarotStoryEditionKey,
} from "./data/tarotStories";
import type { TarotCardMeta } from "./data/types";

export const STORY_AUTHORS: Record<TarotStoryEditionKey, string> = {
	fable: "Claude Fable 5.1",
	astra: "GPT-6 Astra",
};

export function cardById(cardId: number): TarotCardMeta | null {
	return FALLBACK_TAROT_CARDS.find((card) => card.id === cardId) ?? null;
}

export function storyForCard(edition: TarotStoryEditionKey, cardId: number) {
	return TAROT_STORY_EDITIONS[edition].chapters[cardId] ?? null;
}

export function validatePackagedContent(): boolean {
	return (
		FALLBACK_TAROT_CARDS.length === 22 &&
		FALLBACK_TAROT_CARDS.every((card, index) => card.id === index) &&
		TAROT_STORY_EDITIONS.fable.chapters.length === 22 &&
		TAROT_STORY_EDITIONS.astra.chapters.length === 22
	);
}
