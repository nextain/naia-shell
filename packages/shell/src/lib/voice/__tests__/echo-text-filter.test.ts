import { describe, expect, it } from "vitest";
import { isLikelySelfEcho } from "../echo-gate";

// 자기발화(에코) 텍스트 필터 계약 (2026-07-15 루크 지시: "일정 이상 유사도면 스킵").
// 1차 방어 = 재생 중 마이크 정지, 이 필터 = web-speech 지연 배달 누수의 2차 방어.
describe("isLikelySelfEcho — 파이프라인 자기발화 스킵", () => {
	const spoken = [
		"안녕하세요, 저는 나이아입니다. 오늘 행사 안내를 도와드릴게요.",
		"코스포 밋업데이는 오후 2시에 시작합니다.",
	];

	it("완전 동일 에코 → true", () => {
		expect(
			isLikelySelfEcho(
				"안녕하세요 저는 나이아입니다 오늘 행사 안내를 도와드릴게요",
				spoken,
			),
		).toBe(true);
	});

	it("문장 꼬리만 잡힌 부분 에코 → true (전형적 AEC 잔향)", () => {
		expect(isLikelySelfEcho("행사 안내를 도와드릴게요", spoken)).toBe(true);
		expect(isLikelySelfEcho("오후 2시에 시작합니다", spoken)).toBe(true);
	});

	it("STT 왜곡이 섞인 에코(문장부호/공백 차이 + 일부 오인식) → true", () => {
		expect(
			isLikelySelfEcho("안녕하세요. 저는 나이야입니다! 오늘 행사 안내를 도와드릴게요~", spoken),
		).toBe(true);
	});

	it("짧은 정상 확인 답변이 나이아 문장 안에 부분일치해도 → false (2026-07-15 리뷰: 삼킴 금지)", () => {
		// "좋아하세요?" 안에 "좋아"가 substring 으로 들어가지만 정상 답변이라 스킵 금지.
		const q = ["피자 좋아하세요?", "그래서 어떻게 생각하세요?"];
		expect(isLikelySelfEcho("좋아", q)).toBe(false);
		expect(isLikelySelfEcho("좋아요", q)).toBe(false);
		expect(isLikelySelfEcho("그래", q)).toBe(false);
		expect(isLikelySelfEcho("네", q)).toBe(false);
		expect(isLikelySelfEcho("알겠어", q)).toBe(false);
	});

	it("사용자의 정상 질문 → false (스킵 금지)", () => {
		expect(isLikelySelfEcho("나이아가 뭐야?", spoken)).toBe(false);
		expect(isLikelySelfEcho("넥스테인은 어떤 회사야", spoken)).toBe(false);
		expect(
			isLikelySelfEcho("점심은 어디서 먹을 수 있어? 근처 맛집 알려줘", spoken),
		).toBe(false);
	});

	it("발화와 주제가 겹치는 정상 후속질문 → false (유사도 60% 미만)", () => {
		expect(isLikelySelfEcho("행사 안내 말고 부스 위치 알려줘", spoken)).toBe(
			false,
		);
	});

	it("빈/초단문 transcript → false (오탐 방지)", () => {
		expect(isLikelySelfEcho("", spoken)).toBe(false);
		expect(isLikelySelfEcho("네", spoken)).toBe(false);
	});

	it("최근 발화 목록이 비면 항상 false", () => {
		expect(isLikelySelfEcho("안녕하세요 저는 나이아입니다", [])).toBe(false);
	});
});
