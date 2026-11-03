import {
	parseCharacterCardJsonText,
	type NormalizedCharacterCard,
} from "../apps/charcard/card-parser";
import { buildRoleplayPrompt } from "../apps/charcard/prompt-builder";
import type { AppConfig } from "./config";
import { Logger } from "./logger";

export interface CharacterTheme {
	version: 1;
	id: string;
	name: string;
	nvaModel: string;
	ttsProvider: NonNullable<AppConfig["ttsProvider"]>;
	ttsVoice: string;
	backgroundVideo?: string;
}

export function characterCardPatch(
	card: NormalizedCharacterCard,
	userName?: string,
	locale?: string,
) {
	Logger.debug("CharacterTheme", "build card settings", {
		spec: card.specVersion,
	});
	const prompt = buildRoleplayPrompt(card, { userName, locale });
	return {
		patch: {
			persona: prompt.roleplay,
			agentName: prompt.character,
			personaDisabled: false,
		},
		greeting: prompt.greeting,
		truncated: prompt.truncated,
	};
}

export function themePatch(theme: CharacterTheme) {
	Logger.debug("CharacterTheme", "build theme settings", {
		version: theme.version,
	});
	return {
		avatarProvider: "naia-video-avatar" as const,
		nvaModel: theme.nvaModel,
		ttsProvider: theme.ttsProvider,
		ttsVoice: theme.ttsVoice,
		backgroundVideo: theme.backgroundVideo,
	};
}

/** Revalidate persisted shell preferences; never turn arbitrary JSON into config. */
export function readCharacterThemes(value: unknown): CharacterTheme[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is CharacterTheme => {
			if (!item || typeof item !== "object") return false;
			const t = item as CharacterTheme;
			return (
				t.version === 1 &&
				typeof t.id === "string" &&
				t.id.length <= 100 &&
				typeof t.name === "string" &&
				t.name.length > 0 &&
				t.name.length <= 80 &&
				typeof t.nvaModel === "string" &&
				/^[a-zA-Z0-9_-]+$/.test(t.nvaModel) &&
				["edge", "nextain", "naia-local-voice", "browser", "vllm"].includes(
					t.ttsProvider,
				) &&
				typeof t.ttsVoice === "string" &&
				t.ttsVoice.length <= 300 &&
				(t.backgroundVideo === undefined ||
					(typeof t.backgroundVideo === "string" &&
						!/[\\/]/.test(t.backgroundVideo)))
			);
		})
		.slice(0, 30);
}

/** Workspace-owned library; source bytes preserve PNG artwork and unknown metadata. */
export interface SavedCharacterCard {
	version: 1;
	id: string;
	name: string;
	rawJson: Record<string, unknown>;
	greeting: string;
	sourceName: string;
	sourceBase64: string;
	themeId?: string;
}
export const CARD_LIBRARY_MAX_BYTES = 2_000_000;
export function readCharacterLibrary(value: unknown): SavedCharacterCard[] {
	Logger.debug("CharacterTheme", "read card library");
	if (
		!Array.isArray(value) ||
		value.length > 30 ||
		JSON.stringify(value).length > CARD_LIBRARY_MAX_BYTES
	)
		return [];
	const ids = new Set<string>();
	return value.filter((item): item is SavedCharacterCard => {
		if (!item || typeof item !== "object") return false;
		const c = item as SavedCharacterCard;
		if (
			c.version !== 1 ||
			typeof c.id !== "string" ||
			!/^[\w-]{1,100}$/.test(c.id) ||
			ids.has(c.id) ||
			typeof c.name !== "string" ||
			typeof c.greeting !== "string" ||
			c.greeting.length > 24_000 ||
			typeof c.sourceName !== "string" ||
			typeof c.sourceBase64 !== "string" ||
			!/^[A-Za-z0-9+/]*={0,2}$/.test(c.sourceBase64) ||
			(c.themeId !== undefined && typeof c.themeId !== "string")
		)
			return false;
		const parsed = parseCharacterCardJsonText(
			JSON.stringify(c.rawJson),
			"json",
		);
		if (!parsed.ok || parsed.card.name !== c.name) return false;
		ids.add(c.id);
		return true;
	});
}
export function libraryCard(
	value: SavedCharacterCard,
): NormalizedCharacterCard {
	Logger.debug("CharacterTheme", "restore library card", { id: value.id });
	const parsed = parseCharacterCardJsonText(
		JSON.stringify(value.rawJson),
		"json",
	);
	if (!parsed.ok) throw new Error("invalid saved card");
	return parsed.card;
}
export { cardGreeting } from "./character-greeting";
