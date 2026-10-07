import { describe, expect, it } from "vitest";
import { DEFAULT_PERSONA, buildSystemPrompt } from "../persona";

describe("buildSystemPrompt", () => {
	it("uses DEFAULT_PERSONA when no persona provided", () => {
		const result = buildSystemPrompt();
		expect(result).toContain("Naia");
		expect(result).toContain("Emotion tags (for Shell avatar only):");
	});

	it("uses custom persona when provided", () => {
		const result = buildSystemPrompt("You are Beta.");
		expect(result).toContain("You are Beta.");
		expect(result).toContain("Emotion tags (for Shell avatar only):");
		expect(result).not.toContain(DEFAULT_PERSONA);
	});

	it("replaces Naia with agentName in default persona", () => {
		const result = buildSystemPrompt(undefined, { agentName: "Mochi" });
		expect(result).toContain("You are Mochi");
		expect(result).not.toContain("You are Naia");
	});

	it("replaces Naia with agentName in custom persona", () => {
		const result = buildSystemPrompt(
			"You are Naia (낸), my custom companion.",
			{ agentName: "Mochi" },
		);
		expect(result).toContain("You are Mochi");
		expect(result).not.toContain("You are Naia");
	});

	it("does not modify persona when agentName is not set", () => {
		const result = buildSystemPrompt();
		expect(result).toContain("You are Naia (낸)");
	});

	it("injects userName from context", () => {
		const result = buildSystemPrompt(undefined, { userName: "Luke" });
		expect(result).toContain("Luke");
		expect(result).toContain("Address them by name");
	});

	it("does not inject summaries (handled by Agent MemorySystem)", () => {
		const result = buildSystemPrompt(undefined, {
			userName: "Luke",
		});
		expect(result).not.toContain("Recent conversation summaries");
	});

	it("does not have facts field in MemoryContext", () => {
		// Facts are now handled by Agent MemorySystem, not Shell persona
		const result = buildSystemPrompt(undefined, {
			userName: "Luke",
		});
		expect(result).not.toContain("Known facts");
	});

	it("injects honorific into system prompt", () => {
		const result = buildSystemPrompt(undefined, {
			userName: "Luke",
			honorific: "오빠",
		});
		expect(result).toContain("오빠");
		expect(result).toContain("Luke");
	});

	it("injects casual speechStyle into system prompt", () => {
		const result = buildSystemPrompt(undefined, { speechStyle: "casual" });
		expect(result).toContain("Speak casually in Korean (반말)");
		expect(result).toContain("Do NOT use 존댓말");
	});

	it("injects formal speechStyle into system prompt", () => {
		const result = buildSystemPrompt(undefined, { speechStyle: "formal" });
		expect(result).toContain("Speak politely in Korean (존댓말)");
		expect(result).toContain("Do NOT use 반말");
	});

	it("does not inject honorific/speechStyle when not set", () => {
		const result = buildSystemPrompt(undefined, { userName: "Luke" });
		expect(result).not.toContain("Call the user");
		expect(result).not.toContain("Speak casually");
		expect(result).not.toContain("Speak politely");
	});

	it("handles empty context gracefully", () => {
		const result = buildSystemPrompt(undefined, {});
		expect(result).toContain("Context:\nNever address the user with any title or nickname");
	});

	it("combines all context fields", () => {
		const result = buildSystemPrompt(undefined, {
			userName: "Luke",
		});
		expect(result).toContain("Luke");
	});

	describe("locale-aware prompt", () => {
		it("adds English instruction when locale is 'en'", () => {
			const result = buildSystemPrompt(undefined, { locale: "en" });
			expect(result).toContain("Respond in English");
		});

		it("adds Korean instruction when locale is 'ko'", () => {
			const result = buildSystemPrompt(undefined, { locale: "ko" });
			expect(result).toContain("Respond in Korean");
		});

		it("does not add locale instruction when locale is undefined", () => {
			const result = buildSystemPrompt(undefined, {});
			expect(result).not.toContain("Respond in");
		});

		it("skips speechStyle when locale has no formality distinction", () => {
			const result = buildSystemPrompt(undefined, {
				locale: "en",
				speechStyle: "casual",
			});
			expect(result).not.toContain("Speak casually");
			expect(result).toContain("Respond in English");
		});

		it("applies speechStyle when locale is Korean", () => {
			const result = buildSystemPrompt(undefined, {
				locale: "ko",
				speechStyle: "casual",
			});
			expect(result).toContain("반말");
			expect(result).toContain("Respond in Korean");
		});

		it("applies speechStyle for Japanese locale", () => {
			const result = buildSystemPrompt(undefined, {
				locale: "ja",
				speechStyle: "formal",
			});
			expect(result).toContain("敬語");
			expect(result).toContain("Respond in Japanese");
		});

		it("applies speechStyle for German locale", () => {
			const result = buildSystemPrompt(undefined, {
				locale: "de",
				speechStyle: "casual",
			});
			expect(result).toContain("'du'");
			expect(result).toContain("Respond in German");
		});

		it("maps all supported locales to language names", () => {
			for (const locale of ["ja", "zh", "fr", "de", "ru", "es"]) {
				const result = buildSystemPrompt(undefined, { locale });
				expect(result).toContain("Respond in");
			}
		});

		it("uses locale-appropriate emotion example for English", () => {
			const result = buildSystemPrompt(undefined, { locale: "en" });
			expect(result).toContain("Good morning");
			expect(result).not.toContain("좋은 아침이에요");
		});

		it("uses Korean emotion example for Korean locale", () => {
			const result = buildSystemPrompt(undefined, { locale: "ko" });
			expect(result).toContain("좋은 아침이에요");
		});

		it("uses locale-appropriate emotion example for Japanese", () => {
			const result = buildSystemPrompt(undefined, { locale: "ja" });
			expect(result).toContain("おはようございます");
		});

		it("skips honorific when locale has no formality distinction", () => {
			const result = buildSystemPrompt(undefined, {
				locale: "en",
				userName: "Luke",
				honorific: "오빠",
			});
			expect(result).not.toContain("오빠");
		});

		it("applies honorific when locale is Korean", () => {
			const result = buildSystemPrompt(undefined, {
				locale: "ko",
				userName: "Luke",
				honorific: "오빠",
			});
			expect(result).toContain("오빠");
			expect(result).toContain("Luke");
		});

		it("applies honorific for Japanese locale", () => {
			const result = buildSystemPrompt(undefined, {
				locale: "ja",
				userName: "Luke",
				honorific: "先輩",
			});
			expect(result).toContain("先輩");
			expect(result).toContain("Luke");
		});
	});

	describe("#752 호칭 규칙", () => {
		const SENTENCE_A =
			'Never address the user with any title or nickname, such as "친구", "친구야", "friend", "buddy", or "pal". If you know the user\'s name, use it; otherwise, speak directly without addressing them.';
		const SENTENCE_B =
			'Do not address the user with any other title or nickname, such as "친구", "친구야", "friend", "buddy", or "pal"; use only the form given above.';

		function extractAddressingLine(prompt: string): string | undefined {
			return prompt
				.split("\n")
				.map((line) => line.trim().replace(/^- /, ""))
				.find((line) =>
					line.startsWith("Never address the user with any title or nickname") ||
					line.startsWith("Do not address the user with any other title or nickname"),
				);
		}

		it("호칭 없음(ko 반말): 문장 A 가 들어가고 문장 B 는 들어가지 않는다", () => {
			const result = buildSystemPrompt(undefined, {
				locale: "ko",
				speechStyle: "casual",
			});
			expect(extractAddressingLine(result)).toBe(SENTENCE_A);
			expect(result).toContain(SENTENCE_A);
			expect(result).not.toContain(SENTENCE_B);
			expect(result).not.toContain("companion");
			expect(result).not.toContain("friendly AI");
		});

		it("호칭 없음(en): 문장 A 가 들어가고 문장 B 는 들어가지 않는다", () => {
			const result = buildSystemPrompt(undefined, {
				locale: "en",
			});
			expect(extractAddressingLine(result)).toBe(SENTENCE_A);
			expect(result).toContain(SENTENCE_A);
			expect(result).not.toContain(SENTENCE_B);
		});

		it("호칭 지정(ko → B): 문장 B 가 호칭 줄 바로 다음에 들어가고 문장 A 는 들어가지 않는다", () => {
			const result = buildSystemPrompt(undefined, {
				locale: "ko",
				userName: "민수",
				honorific: "님",
			});
			const expected = 'Address the user as "님 민수" or "민수님" as appropriate for Korean.';
			expect(result).toContain(expected);
			expect(result).toContain(`${expected}\n${SENTENCE_B}`);
			expect(extractAddressingLine(result)).toBe(SENTENCE_B);
			expect(result).not.toContain(SENTENCE_A);
		});

		it("호칭 지정(locale 없음 → B): 문장 B 가 호칭 줄 바로 다음에 들어가고 문장 A 는 들어가지 않는다", () => {
			const result = buildSystemPrompt(undefined, {
				userName: "민수",
				honorific: "님",
			});
			const expected = 'Address the user as "님 민수" or "민수님" as appropriate for the user\'s language.';
			expect(result).toContain(expected);
			expect(result).toContain(`${expected}\n${SENTENCE_B}`);
			expect(extractAddressingLine(result)).toBe(SENTENCE_B);
			expect(result).not.toContain(SENTENCE_A);
		});

		it("호칭만 있고 이름 없음(locale 'ko', 호칭 '님' → B): 문장 B 가 들어가고 문장 A 는 들어가지 않는다", () => {
			const result = buildSystemPrompt(undefined, {
				locale: "ko",
				honorific: "님",
			});
			const expected = 'Address the user as "님 " or "님" as appropriate for Korean.';
			expect(result).toContain(expected);
			expect(result).toContain(`${expected}\n${SENTENCE_B}`);
			expect(extractAddressingLine(result)).toBe(SENTENCE_B);
			expect(result).not.toContain(SENTENCE_A);
		});

		it("호칭 지정(ja → B): 문장 B 가 호칭 줄 바로 다음에 들어가고 문장 A 는 들어가지 않는다", () => {
			const result = buildSystemPrompt(undefined, {
				locale: "ja",
				userName: "민수",
				honorific: "さん",
			});
			const expected = 'Address the user as "さん 민수" or "민수さん" as appropriate for Japanese.';
			expect(result).toContain(expected);
			expect(result).toContain(`${expected}\n${SENTENCE_B}`);
			expect(extractAddressingLine(result)).toBe(SENTENCE_B);
			expect(result).not.toContain(SENTENCE_A);
		});

		it("호칭 지정(en, 호칭 줄 없음 → A): formality 없는 locale은 호칭 줄이 생략되므로 문장 A 가 들어가고 B 는 들어가지 않는다", () => {
			const result = buildSystemPrompt(undefined, {
				locale: "en",
				userName: "민수",
				honorific: "님",
			});
			expect(result).not.toContain("Address the user as");
			expect(extractAddressingLine(result)).toBe(SENTENCE_A);
			expect(result).toContain(SENTENCE_A);
			expect(result).not.toContain(SENTENCE_B);
		});

		it("이름만 있음(이름 줄+A): 이름 줄이 출력되고 문장 A 가 들어가며 문장 B 는 들어가지 않는다", () => {
			const result = buildSystemPrompt(undefined, {
				locale: "ko",
				userName: "민수",
			});
			expect(result).toContain('The user\'s name is "민수"');
			expect(extractAddressingLine(result)).toBe(SENTENCE_A);
			expect(result).toContain(SENTENCE_A);
			expect(result).not.toContain(SENTENCE_B);
		});

		it("context 없음(undefined): buildSystemPrompt(undefined, undefined) 의 Context 에 문장 A 가 들어가고 B 는 들어가지 않는다", () => {
			const result = buildSystemPrompt(undefined, undefined);
			expect(extractAddressingLine(result)).toBe(SENTENCE_A);
			expect(result).toContain(SENTENCE_A);
			expect(result).not.toContain(SENTENCE_B);
		});

		it("빈 객체 context({}): buildSystemPrompt(undefined, {}) 의 Context 에 문장 A 가 들어가고 B 는 들어가지 않는다", () => {
			const result = buildSystemPrompt(undefined, {});
			expect(extractAddressingLine(result)).toBe(SENTENCE_A);
			expect(result).toContain(SENTENCE_A);
			expect(result).not.toContain(SENTENCE_B);
		});

		it("DEFAULT_PERSONA 첫 줄 exact toBe 및 성격 항목 보존, companion/friendly AI 없음", () => {
			const lines = DEFAULT_PERSONA.split("\n");
			expect(lines[0]).toBe(
				"You are Naia (낸), a warm and capable AI agent living inside Naia.",
			);
			expect(DEFAULT_PERSONA).toContain("Personality:");
			expect(DEFAULT_PERSONA).toContain("- Warm, curious, slightly playful");
			expect(DEFAULT_PERSONA).toContain("- Speaks naturally in the user's preferred language");
			expect(DEFAULT_PERSONA).toContain("- Gives concise, helpful answers");
			expect(DEFAULT_PERSONA).toContain("- Shows genuine interest in the user's activities");
			expect(DEFAULT_PERSONA).toContain(
				"Keep responses concise (1-3 sentences for casual chat, longer for complex topics).",
			);
			expect(DEFAULT_PERSONA).not.toContain("companion");
			expect(DEFAULT_PERSONA).not.toContain("friendly AI");
		});
	});
});
