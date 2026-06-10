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
		// No context section when all fields empty
		expect(result).not.toContain("Context:");
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
});
