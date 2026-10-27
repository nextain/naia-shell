import { describe, expect, it } from "vitest";
import { resolveTtsTextRule, ttsTextFilter } from "../text-filter";

describe("ttsTextFilter", () => {
	it("removes Markdown emphasis before speech without changing the words", () => {
		expect(
			ttsTextFilter.filter("이건 **중요한** 내용이고 __확인__해 주세요."),
		).toBe("이건 중요한 내용이고 확인해 주세요.");
	});

	it("keeps link labels but removes URLs, code fences, emotion tags, and emoji", () => {
		expect(
			ttsTextFilter.filter(
				"[HAPPY] [문서](https://example.com)를 보세요 😊\n```ts\nconst x = 1;\n```",
			),
		).toBe("문서를 보세요");
	});

	it("keeps a word boundary after an inline emotion tag", () => {
		expect(ttsTextFilter.filter("있어요[HAPPY] 음악은 계속해서 흘러가요")).toBe(
			"있어요 음악은 계속해서 흘러가요",
		);
	});

	it("leaves no leading space for start / line-start / consecutive tags", () => {
		expect(ttsTextFilter.filter("[HAPPY] 안녕하세요")).toBe("안녕하세요");
		expect(ttsTextFilter.filter("첫줄\n[HAPPY] 안녕")).toBe("첫줄 안녕");
		expect(ttsTextFilter.filter("[HAPPY][SAD] 안녕")).toBe("안녕");
	});

	it("removes Markdown list markers while preserving natural punctuation", () => {
		expect(ttsTextFilter.filter("- 첫 번째\n- 두 번째, 맞죠?")).toBe(
			"첫 번째 두 번째, 맞죠?",
		);
	});

	it("uses locale rules with a deterministic fallback", () => {
		expect(resolveTtsTextRule("ko-KR").locale).toBe("ko");
		expect(resolveTtsTextRule("en-US").locale).toBe("en");
		expect(resolveTtsTextRule("fr-FR").locale).toBe("fallback");
	});

	it("drops fenced code and Mermaid payloads, including an unclosed fence", () => {
		expect(
			ttsTextFilter.filter(
				"설명입니다.\n```mermaid\ngraph TD; A-->B\n```\n결론입니다.",
				"ko-KR",
			),
		).toBe("설명입니다. 결론입니다.");
		expect(ttsTextFilter.filter("앞부분\n```js\nalert('secret')", "ko")).toBe(
			"앞부분",
		);
	});

	it("removes raw URLs, decorative symbols, emoji, and common emoticons", () => {
		expect(
			ttsTextFilter.filter(
				"★ 안내 :-) https://example.com/a?q=1 또는 www.example.org 확인 😊",
				"ko",
			),
		).toBe("안내 또는 확인");
	});

	it("keeps multilingual meaning, numbers, punctuation, and inline-code text", () => {
		expect(
			ttsTextFilter.filter(
				"# 결과\n한국어, English, 日本語, 中文: `npm run build`는 42% 완료!",
				"ja-JP",
			),
		).toBe("결과 한국어, English, 日本語, 中文: npm run build는 42% 완료!");
	});

	it("does not synthesize a payload that becomes empty", () => {
		expect(ttsTextFilter.filter("[THINK] 😊 https://example.com", "en")).toBe(
			"",
		);
	});
});
