import { describe, expect, it } from "vitest";
import { emotionTagsToChatText } from "../emotion-tags";

describe("emotionTagsToChatText", () => {
	it("maps known emotion tags to emoji", () => {
		expect(emotionTagsToChatText("[sigh] 오늘 피곤하셨겠어요.")).toBe(
			"😮‍💨 오늘 피곤하셨겠어요.",
		);
		expect(emotionTagsToChatText("정말요? [laughing] 처음 들어봐요.")).toBe(
			"정말요? 😄 처음 들어봐요.",
		);
	});

	it("strips functional / unknown tags without leaving double spaces", () => {
		expect(emotionTagsToChatText("음 [breath] 그러니까요.")).toBe(
			"음 그러니까요.",
		);
		expect(emotionTagsToChatText("[unknown_tag] 안녕하세요.")).toBe(
			"안녕하세요.",
		);
	});

	it("tidies whitespace before punctuation left by a stripped tag", () => {
		expect(emotionTagsToChatText("좋아요 [pause].")).toBe("좋아요.");
	});

	it("handles multiple tags in one string", () => {
		expect(
			emotionTagsToChatText("[chuckle] 네 [sigh] 알겠어요."),
		).toBe("😊 네 😮‍💨 알겠어요.");
	});

	it("passes through text with no tags unchanged", () => {
		expect(emotionTagsToChatText("그냥 평범한 문장입니다.")).toBe(
			"그냥 평범한 문장입니다.",
		);
	});

	it("returns empty/falsy input as-is", () => {
		expect(emotionTagsToChatText("")).toBe("");
	});
});
