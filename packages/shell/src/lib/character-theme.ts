import type { NormalizedCharacterCard } from "../apps/charcard/card-parser";
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
