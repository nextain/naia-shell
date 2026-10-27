/** Locale-specific extensions applied after the common LLM-to-speech rules. */
import { normalizeKoreanNumbers } from "./ko-number-reading";

export interface TtsTextRule {
	readonly locale: "fallback" | "ko" | "en" | "ja" | "zh";
	transformInlineCode(content: string): string;
	/** 숫자를 그 locale의 자연 발화 표기로 바꾼다 (#540). 기본은 무변환. */
	normalizeNumbers(text: string): string;
}

const identity = (text: string) => text;

const makeRule = (
	locale: TtsTextRule["locale"],
	normalizeNumbers: (text: string) => string = identity,
): TtsTextRule =>
	Object.freeze({
		locale,
		// Inline code is meaningful prose in every currently supported locale.
		// Providers should receive its content, never the Markdown backticks.
		transformInlineCode: (content: string) => content,
		normalizeNumbers,
	});

export const ttsTextRuleRegistry = Object.freeze({
	// 로컬 음성은 voice 이름이 BCP-47이 아니어서 fallback으로 온다. 본문에
	// 한글이 있으면 한국어 문장이므로 한국어 숫자 읽기를 적용한다 (#540).
	fallback: makeRule("fallback", (text) =>
		/[가-힣]/.test(text) ? normalizeKoreanNumbers(text) : text,
	),
	ko: makeRule("ko", normalizeKoreanNumbers),
	en: makeRule("en"),
	ja: makeRule("ja"),
	zh: makeRule("zh"),
});

export function resolveTtsTextRule(locale?: string): TtsTextRule {
	const language = locale?.trim().toLowerCase().split(/[-_]/, 1)[0];
	if (language && language in ttsTextRuleRegistry) {
		return ttsTextRuleRegistry[language as keyof typeof ttsTextRuleRegistry];
	}
	return ttsTextRuleRegistry.fallback;
}

/** The canonical TTS payload normalizer shared by every voice provider. */
export const ttsTextFilter = Object.freeze({
	filter(input: string, locale?: string): string {
		const rule = resolveTtsTextRule(locale);
		const structural = input
			.replace(/```[\s\S]*?(?:```|$)/g, " ")
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
			// Horizontal whitespace only after the tag (same rule as lib/vrm/expression.ts).
			.replace(/\[(?:HAPPY|SAD|ANGRY|SURPRISED|NEUTRAL|THINK)][ \t]*/gi, "")
			.replace(/`([^`]*)`/g, (_match, content: string) =>
				rule.transformInlineCode(content),
			)
			.replace(/(?:https?:\/\/|www\.)[^\s<>()]+/gi, " ")
			.replace(/(^|\n)\s{0,3}(?:#{1,6}|>|[-+*])\s+/g, "$1");
		// 숫자 읽기는 %·℃ 같은 기호 단위를 소비하므로 기호 제거보다 먼저 온다.
		return rule
			.normalizeNumbers(structural)
			.replace(
				/(?:^|\s)(?:[:;=8xX]-?[)(DPp/\\]|\^_\^|[TtㅠㅜoO]_[TtㅠㅜoO])(?=\s|$)/g,
				" ",
			)
			.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
			// 카오모지 구성 문자 — IPA·발음기호 확장, 수식·결합 기호, 이체 선택자 (#540).
			.replace(
				/[ɐ-ʯᴀ-ᶿʰ-˿̀-ͯ︀-️⃐-⃿]/gu,
				"",
			)
			// 반각 가나 구두점·문자와 불릿 (#540). 정상 한·영·일·중 본문은 여기 없음.
			.replace(/[｡-･ｰﾞﾟ•‣⁃◦·∙]/g, " ")
			.replace(/[ｦ-ﾝ]/g, "")
			.replace(/[★☆◆◇■□●○◎※▶▷◀◁✓✔✕✖✦✧]/g, " ")
			// 남은 기타 기호(♥·→·▽ 등 \p{So})와 수식 기호(´ ﾟ 등 \p{Sk})는 발화 대상이 아니다 (#540).
			.replace(/[\p{So}\p{Sk}]/gu, " ")
			// 조각 자모 나열(ㅋㅋ·ㅠㅠ)은 음절이 아니어서 발화할 수 없다 (#540).
			.replace(/[ㄱ-ㅎㅏ-ㅣ]+/g, " ")
			.replace(/[*_~]/g, "")
			// 장식 문자를 걷어낸 뒤 남는 빈 괄호 잔재 (#540).
			.replace(/[(（[]\s*[)）\]]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	},
});
