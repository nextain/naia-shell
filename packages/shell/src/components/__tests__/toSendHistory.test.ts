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

	it("drops the failed user turn with its retry affordance", () => {
		const history = toSendHistory([
			msg("user", "라디오 dj모드로 진행해"),
			msg("assistant", "", {
				failure: { detail: "boom", retryText: "라디오 dj모드로 진행해" },
			}),
		]);
		expect(history).toEqual([]);
	});

	it("drops the failed attempt's partial assistant with the failure notice", () => {
		// 실패 차례의 부분 답을 그대로 보내면 모델이 문장 중간부터 이어서
		// ("는건 …") 답을 시작하기 쉽다. 화면에는 남기되 전송 기록에서는 뺀다.
		const history = toSendHistory([
			msg("user", "라디오 dj모드로 진행해"),
			msg("assistant", "아, 설명이 부족했네요~ 라디오 DJ 모드는"),
			msg("assistant", "", {
				failure: { detail: "boom", retryText: "라디오 dj모드로 진행해" },
			}),
		]);
		expect(history).toEqual([]);
	});

	it("keeps an earlier completed answer before a failed retry", () => {
		const history = toSendHistory([
			msg("user", "아침 음악 틀어줘"),
			msg("assistant", "Summer Morning Jazz 틀어드렸어요"),
			msg("user", "라디오 dj모드로 진행해"),
			msg("assistant", "아, 설명이"),
			msg("assistant", "", {
				failure: { detail: "boom", retryText: "라디오 dj모드로 진행해" },
			}),
		]);
		expect(history).toEqual([
			{ role: "user", content: "아침 음악 틀어줘" },
			{ role: "assistant", content: "Summer Morning Jazz 틀어드렸어요" },
		]);
	});

	it("drops every row from a failed user turn even when partial tool calls intervene", () => {
		const history = toSendHistory([
			msg("user", "이전 성공한 질문"),
			msg("assistant", "이전 성공한 답"),
			msg("user", "실패한 질문"),
			msg("assistant", "부분 답 앞쪽", {
				toolCalls: [
					{
						toolCallId: "tc1",
						toolName: "music_tool",
						args: {},
						status: "success",
						output: "playing",
					},
				],
			}),
			msg("assistant", "부분 답 뒤쪽"),
			msg("assistant", "", {
				failure: { detail: "boom", retryText: "실패한 질문" },
			}),
		]);

		expect(history).toEqual([
			{ role: "user", content: "이전 성공한 질문" },
			{ role: "assistant", content: "이전 성공한 답" },
		]);
	});

	it("keeps the new retry input after dropping the original failed turn", () => {
		const history = toSendHistory([
			msg("user", "라디오 dj모드로 진행해"),
			msg("assistant", "아, 설명이 부족했네요~"),
			msg("assistant", "", {
				failure: { detail: "boom", retryText: "라디오 dj모드로 진행해" },
			}),
			msg("user", "라디오 dj모드로 진행해"),
		]);
		expect(history).toEqual([
			{ role: "user", content: "라디오 dj모드로 진행해" },
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
