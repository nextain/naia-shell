import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../persona";

const ctx = {
	userName: "루크",
	honorific: "마스터",
	speechStyle: "polite" as const,
	locale: "ko",
	agentName: "알파",
};

describe("페르소나 사용 안 함", () => {
	it("끄면 성격에 해당하는 것이 프롬프트에 없다", () => {
		const p = buildSystemPrompt("You are Naia (낸), a friendly AI.", ctx, true);
		expect(p).not.toContain("Naia");
		expect(p).not.toContain("루크");
		expect(p).not.toContain("마스터");
		expect(p).not.toContain("알파");
	});

	it("끄더라도 응답 언어 지시는 남는다", () => {
		const p = buildSystemPrompt("아무 페르소나", ctx, true);
		expect(p).toMatch(/Respond in/i);
	});

	it("켜면 기존대로 페르소나가 들어간다", () => {
		const p = buildSystemPrompt("You are Naia (낸), a friendly AI.", ctx, false);
		expect(p).toContain("루크");
	});

	it("페르소나를 비워도 기본 페르소나가 들어간다 — 이것이 이 이슈의 원인", () => {
		const p = buildSystemPrompt("", ctx, false);
		expect(p).toContain("warm and capable AI agent");
	});

	it("끄면 그 기본 페르소나조차 안 들어간다", () => {
		const p = buildSystemPrompt("", ctx, true);
		expect(p).not.toContain("warm and capable AI agent");
	});

	describe("#752 비활성 경로 호칭 규칙", () => {
		const SENTENCE_A =
			'Never address the user with any title or nickname, such as "친구", "친구야", "friend", "buddy", or "pal". If you know the user\'s name, use it; otherwise, speak directly without addressing them.';
		const SENTENCE_B =
			'Do not address the user with any other title or nickname, such as "친구", "친구야", "friend", "buddy", or "pal"; use only the form given above.';

		function extractAddressingLine(prompt: string): string | undefined {
			return prompt
				.split("\n")
				.map((line) => line.trim())
				.find((line) =>
					line.startsWith("Never address the user with any title or nickname") ||
					line.startsWith("Do not address the user with any other title or nickname"),
				);
		}

		it("persona 비활성 + context 있음: 문장 A 가 들어가고 문장 B 는 들어가지 않는다", () => {
			const p = buildSystemPrompt(undefined, ctx, true);
			expect(extractAddressingLine(p)).toBe(SENTENCE_A);
			expect(p).toContain(SENTENCE_A);
			expect(p).not.toContain(SENTENCE_B);
		});

		it("persona 비활성 + context undefined: 문장 A 가 들어가고 문장 B 는 들어가지 않는다", () => {
			const p = buildSystemPrompt(undefined, undefined, true);
			expect(extractAddressingLine(p)).toBe(SENTENCE_A);
			expect(p).toContain(SENTENCE_A);
			expect(p).not.toContain(SENTENCE_B);
		});

		it("persona 비활성 + context 빈 객체({}): 문장 A 가 들어가고 문장 B 는 들어가지 않는다", () => {
			const p = buildSystemPrompt(undefined, {}, true);
			expect(extractAddressingLine(p)).toBe(SENTENCE_A);
			expect(p).toContain(SENTENCE_A);
			expect(p).not.toContain(SENTENCE_B);
		});
	});
});
