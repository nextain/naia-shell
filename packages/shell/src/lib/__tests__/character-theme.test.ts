import { describe, expect, it } from "vitest";
import { parseCharacterCardJsonText } from "../../apps/charcard/card-parser";
import {
	type CharacterTheme,
	characterCardPatch,
	cardGreeting,
	libraryCard,
	readCharacterLibrary,
	CARD_LIBRARY_MAX_BYTES,
	readCharacterThemes,
	themePatch,
} from "../character-theme";
import { buildSystemPrompt } from "../persona";

const theme: CharacterTheme = {
	version: 1,
	id: "theme-1",
	name: "Garden",
	nvaModel: "naia",
	ttsProvider: "edge",
	ttsVoice: "ko-KR-SunHiNeural",
	backgroundVideo: "garden.webp",
};
describe("UC-B2C-026 character settings", () => {
	it.each(["v2", "v3"])(
		"injects %s persona, greeting and examples through the shell prompt",
		(version) => {
			const result = parseCharacterCardJsonText(
				JSON.stringify({
					spec: `chara_card_${version}`,
					spec_version: version === "v2" ? "2.0" : "3.0",
					data: {
						name: "나무",
						description: "정원사",
						personality: "따뜻함",
						scenario: "온실",
						first_mes: "안녕 {{user}}!",
						mes_example: "{{char}}: 꽃을 돌봐요",
					},
				}),
				"json",
			);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const { patch, greeting } = characterCardPatch(result.card, "루크", "ko");
			expect(greeting).toBe("안녕 루크!");
			const prompt = buildSystemPrompt(
				patch.persona,
				{ userName: "루크", agentName: patch.agentName },
				patch.personaDisabled,
			);
			for (const part of [
				"정원사",
				"따뜻함",
				"온실",
				"안녕 루크!",
				"나무: 꽃을 돌봐요",
			])
				expect(prompt).toContain(part);
			expect(patch.personaDisabled).toBe(false);
		},
	);
	it("applies the whole theme without altering model, credentials or persona", () => {
		const config = {
			provider: "ollama",
			model: "local",
			apiKey: "",
			persona: "gardener",
		};
		expect({ ...config, ...themePatch(theme) }).toEqual({
			...config,
			avatarProvider: "naia-video-avatar",
			nvaModel: "naia",
			ttsProvider: "edge",
			ttsVoice: "ko-KR-SunHiNeural",
			backgroundVideo: "garden.webp",
		});
	});
	it("rejects malformed stored preferences and unsafe asset paths", () => {
		expect(readCharacterThemes(null)).toEqual([]);
		expect(
			readCharacterThemes([
				theme,
				{ ...theme, nvaModel: "../escape" },
				{ ...theme, backgroundVideo: "https://example.org/bg" },
				{ ...theme, ttsProvider: "unknown" },
			]),
		).toEqual([theme]);
	});
});

const raw = {
	spec: "chara_card_v2",
	spec_version: "2.0",
	data: {
		name: "Garden",
		description: "Kind",
		first_mes: "Hello {{user}}",
		extensions: { unknown: "preserve me" },
	},
};
const saved = {
	version: 1 as const,
	id: "card-1",
	name: "Garden",
	greeting: "Hello Luke",
	rawJson: raw,
	sourceName: "garden.json",
	sourceBase64: btoa(JSON.stringify(raw)),
	themeId: "theme-1",
};
describe("UC-B2C-026-R2 library", () => {
	it("round trips original bytes and unknown fields through persisted preferences", () => {
		const restored = readCharacterLibrary(JSON.parse(JSON.stringify([saved])));
		expect(restored).toEqual([saved]);
		expect(atob(restored[0].sourceBase64)).toBe(JSON.stringify(raw));
		expect(libraryCard(restored[0]).rawJson).toEqual(raw);
	});
	it("rejects damaged, duplicate and oversized libraries", () => {
		expect(
			readCharacterLibrary([
				{ ...saved, rawJson: {} },
				saved,
				saved,
				{ ...saved, id: "../escape" },
			]),
		).toEqual([saved]);
		expect(readCharacterLibrary(Array(31).fill(saved))).toEqual([]);
		expect(
			readCharacterLibrary([
				{ ...saved, sourceBase64: "A".repeat(CARD_LIBRARY_MAX_BYTES) },
			]),
		).toEqual([]);
	});
	it("greets only for a valid selected card, with substitutions and disabled persona respected", () => {
		const cfg = {
			provider: "ollama",
			model: "local",
			apiKey: "",
			userName: "Luke",
			uiPreferences: { b2cActiveCardId: saved.id, b2cCardLibrary: [saved] },
		};
		expect(cardGreeting(cfg)).toBe("Hello Luke");
		expect(cardGreeting({ ...cfg, personaDisabled: true })).toBe("");
		expect(
			cardGreeting({
				...cfg,
				uiPreferences: { b2cActiveCardId: "missing", b2cCardLibrary: [saved] },
			}),
		).toBe("");
	});
});
