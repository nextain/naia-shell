import { describe, expect, it } from "vitest";
import { parseCharacterCardJsonText } from "../../apps/charcard/card-parser";
import {
	type CharacterTheme,
	characterCardPatch,
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
