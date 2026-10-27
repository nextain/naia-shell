import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../lib/types";
import { toSendHistory } from "../../stores/chat";

function msg(
	role: ChatMessage["role"],
	content: string,
	extra?: Partial<ChatMessage>,
): ChatMessage {
	return {
		id: `m-${role}-${content.slice(0, 8)}`,
		role,
		content,
		timestamp: 0,
		...extra,
	};
}

describe("toSendHistory (chat-stream-join)", () => {
	it("passes user/assistant turns through in order", () => {
		const history = toSendHistory([
			msg("user", "라디오 dj모드로 진행해"),
			msg("assistant", "아, 설명이 부족했네요~"),
		]);
		expect(history).toEqual([
			{ role: "user", content: "라디오 dj모드로 진행해" },
			{ role: "assistant", content: "아, 설명이 부족했네요~" },
		]);
	});

	it("drops failure notices (retry affordances are not conversation)", () => {
		const history = toSendHistory([
			msg("user", "라디오 dj모드로 진행해"),
			msg("assistant", "부분 답", { toolCalls: undefined }),
			msg("assistant", "", {
				failure: { detail: "boom", retryText: "라디오 dj모드로 진행해" },
			}),
		]);
		expect(history).toEqual([
			{ role: "user", content: "라디오 dj모드로 진행해" },
			{ role: "assistant", content: "부분 답" },
		]);
	});

	it("drops blank assistant rows (voice recordEmpty / empty failures)", () => {
		const history = toSendHistory([
			msg("user", "안녕"),
			msg("assistant", "   "),
			msg("assistant", "반가워요"),
		]);
		expect(history).toEqual([
			{ role: "user", content: "안녕" },
			{ role: "assistant", content: "반가워요" },
		]);
	});
});
