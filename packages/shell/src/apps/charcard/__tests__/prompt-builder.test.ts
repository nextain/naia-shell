import { describe, expect, it } from "vitest";
import type { NormalizedCharacterCard } from "../card-parser";
import { buildRoleplayPrompt } from "../prompt-builder";

function makeBaseCard(
	overrides: Partial<NormalizedCharacterCard> = {},
): NormalizedCharacterCard {
	return {
		specVersion: "v3",
		sourceFormat: "json",
		name: "루나",
		description: "{{char}}는 달빛 도서관의 사서이며 <USER>를 안내한다.",
		personality: "{{CHAR}}는 침착하고 <bot>이라는 별명도 있다.",
		scenario: "{{user}}가 밤늦게 도서관을 방문했다.",
		first_mes: "어서 오세요, {{user}}님. 저는 {{char}}입니다.",
		alternate_greetings: ["안녕하세요, <USER>! 두 번째 인사예요."],
		mes_example:
			"<START>\n{{user}}: 책 추천해 줘.\n{{char}}: 이 천문서를 읽어 보세요.\n<START>\n<USER>: 고마워.\n<BOT>: 천만에요!",
		system_prompt: "항상 정중하게 답하라.\n{{original}}\n추가 시스템 지시.",
		post_history_instructions: "{{char}}는 답할 때 미소를 짓는다.",
		creator: "Nextain",
		creator_notes: "",
		tags: [],
		character_book: {
			name: "도서관 설정집",
			description: "",
			entries: [
				{
					id: "disabled-1",
					name: "꺼진항목",
					comment: "",
					keys: ["금지된열쇠"],
					secondary_keys: [],
					content: "이 내용은 절대 들어가면 안 됩니다.",
					enabled: false,
					constant: true,
					insertion_order: 1,
					priority: 100,
				},
				{
					id: "trig-late",
					name: "일반나중",
					comment: "",
					keys: ["별빛열쇠"],
					secondary_keys: [],
					content: "별빛 열쇠에 대한 설명입니다.",
					enabled: true,
					constant: false,
					insertion_order: 20,
					priority: 10,
				},
				{
					id: "trig-early",
					name: "일반먼저",
					comment: "",
					keys: ["달빛열쇠"],
					secondary_keys: ["보조열쇠"],
					content: "{{char}}가 아끼는 달빛 열쇠입니다.",
					enabled: true,
					constant: false,
					insertion_order: 5,
					priority: 50,
				},
				{
					id: "const-1",
					name: "상시배경",
					comment: "",
					keys: [],
					secondary_keys: [],
					content: "도서관은 밤에만 문을 엽니다.",
					enabled: true,
					constant: true,
					insertion_order: 50,
					priority: 1,
				},
			],
		},
		rawJson: {},
		...overrides,
	};
}

describe("prompt-builder", () => {
	it("replaces {{char}}/<BOT> and {{user}}/<USER> case-insensitively and expands {{original}}", () => {
		const card = makeBaseCard();
		const res = buildRoleplayPrompt(card, {
			userName: "민수",
			selectedGreeting: card.alternate_greetings[0],
			locale: "ko",
		});

		expect(res.context.type).toBe("charcard");
		expect(res.character).toBe("루나");
		expect(res.user).toBe("민수");
		expect(res.roleplay).toContain('roleplaying as "루나"');
		expect(res.roleplay).toContain("do NOT introduce yourself as Naia");
		expect(res.roleplay).toContain(
			"루나는 달빛 도서관의 사서이며 민수를 안내한다.",
		);
		expect(res.roleplay).toContain("루나는 침착하고 루나이라는 별명도 있다.");
		expect(res.roleplay).toContain("항상 정중하게 답하라.");
		expect(res.roleplay).toContain("추가 시스템 지시.");
		expect(res.roleplay).not.toContain("{{original}}");
		expect(res.roleplay).toContain("안녕하세요, 민수! 두 번째 인사예요.");
		expect(res.roleplay).toContain("Example 1:");
		expect(res.roleplay).toContain("Example 2:");
		expect(res.roleplay).toContain("루나는 답할 때 미소를 짓는다.");
	});

	it("orders constant lorebook entries first, sorts triggered entries by insertion_order/priority, and omits disabled entries", () => {
		const card = makeBaseCard();
		const res = buildRoleplayPrompt(card, { userName: "지민" });

		expect(res.roleplay).not.toContain("이 내용은 절대 들어가면 안 됩니다.");
		const constIdx = res.roleplay.indexOf("도서관은 밤에만 문을 엽니다.");
		const earlyTrigIdx = res.roleplay.indexOf("루나가 아끼는 달빛 열쇠입니다.");
		const lateTrigIdx = res.roleplay.indexOf("별빛 열쇠에 대한 설명입니다.");

		expect(constIdx).toBeGreaterThan(-1);
		expect(earlyTrigIdx).toBeGreaterThan(constIdx);
		expect(lateTrigIdx).toBeGreaterThan(earlyTrigIdx);
	});

	it("enforces character budget by trimming triggered lorebook, then examples, then long fields", () => {
		const card = makeBaseCard({
			description: "설명 ".repeat(600),
			mes_example: `<START>\n${"예시대화 ".repeat(400)}`,
		});
		const res = buildRoleplayPrompt(card, {
			userName: "테스터",
			maxChars: 1200,
		});

		expect(res.roleplay.length).toBeLessThanOrEqual(1200);
		expect(res.truncated).toBe(true);
		expect(res.truncatedParts).toContain("lorebook_triggered");
		expect(res.truncatedParts).toContain("mes_example");
	});

	it("keeps <script> and HTML tags as plain text without any execution path", () => {
		const maliciousCard = makeBaseCard({
			description:
				'<script>window.__pwned = true;</script><img src="https://evil.invalid/x.png" onerror="alert(1)">',
		});
		const res = buildRoleplayPrompt(maliciousCard, { userName: "보안검증" });
		expect(res.roleplay).toContain("<script>window.__pwned = true;</script>");
		expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
	});
});
