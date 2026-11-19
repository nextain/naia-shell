import type { AppConfig } from "./config";
import type { SavedCharacterCard } from "./character-theme";
import { Logger } from "./logger";

/** The parsed/normalized card stays lazy-loaded with Settings, outside the chat bundle. */
export function activeCharacterCard(
	config: AppConfig | null | undefined,
): SavedCharacterCard | undefined {
	if (!config || config.personaDisabled) return undefined;
	const cards = config.uiPreferences?.b2cCardLibrary;
	const id = config.uiPreferences?.b2cActiveCardId;
	if (!Array.isArray(cards) || cards.length > 30 || typeof id !== "string")
		return undefined;
	return cards.find((card): card is SavedCharacterCard => {
		if (!card || typeof card !== "object") return false;
		const raw = card.rawJson;
		const data = raw?.data ?? raw;
		return (
			card.version === 1 &&
			card.id === id &&
			typeof card.name === "string" &&
			typeof card.greeting === "string" &&
			card.greeting.length <= 24_000 &&
			raw &&
			typeof raw === "object" &&
			data &&
			data.name === card.name &&
			typeof card.sourceBase64 === "string"
		);
	});
}

export function cardGreeting(config: AppConfig | null): string {
	Logger.debug("CharacterGreeting", "resolve new conversation greeting");
	return activeCharacterCard(config)?.greeting ?? "";
}
