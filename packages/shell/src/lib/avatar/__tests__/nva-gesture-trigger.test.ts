import { describe, expect, it, vi } from "vitest";
import type { NvaManifest } from "../nva-core";
import { driveGestures, parseGestureTriggers } from "../nva-gesture-trigger";

const M: NvaManifest = {
	nva_version: "0.2",
	canvas: { width: 400, height: 700, fps: 25 },
	animations: {
		idle: { clip: "i.webm", loop: true, can_talk: false },
		speak: {
			clip: "s.webm",
			loop: true,
			can_talk: true,
			face_bbox: [0.2, 0.3, 0.4],
		},
		"gesture-1": {
			clip: "g1.webm",
			loop: false,
			can_talk: false,
			label: "물방울",
			intent: "playful",
			triggers: ["장난", "환기"],
		},
		"gesture-2": {
			clip: "g2.webm",
			loop: false,
			can_talk: false,
			label: "하트",
			intent: "affection",
			triggers: ["축하", "감사", "사랑"],
		},
	},
};

describe("parseGestureTriggers — LLM 마커 → gesture key", () => {
	it("key 마커", () => {
		const r = parseGestureTriggers("[[gesture:gesture-1]]", M);
		expect(r.gestures.map((g) => g.key)).toEqual(["gesture-1"]);
		expect(r.cleanText).toBe("");
	});
	it("label 마커 + 텍스트 정리", () => {
		const r = parseGestureTriggers("안녕 [[gesture:하트]] 반가워", M);
		expect(r.gestures.map((g) => g.key)).toEqual(["gesture-2"]);
		expect(r.cleanText).toBe("안녕 반가워"); // 마커 제거 + 연속 공백 축약
	});
	it("짧은 alias [[g:...]]", () => {
		expect(parseGestureTriggers("[[g:물방울]]", M).gestures[0]?.key).toBe(
			"gesture-1",
		);
	});
	it("triggers[] 매칭", () => {
		expect(parseGestureTriggers("[[gesture:축하]]", M).gestures[0]?.key).toBe(
			"gesture-2",
		);
	});
	it("intent 매칭 + 대소문자 무시", () => {
		expect(
			parseGestureTriggers("[[gesture:AFFECTION]]", M).gestures[0]?.key,
		).toBe("gesture-2");
	});
	it("미해석 마커 = 트리거 안 함 + 텍스트에서 제거", () => {
		const r = parseGestureTriggers("전 [[gesture:xyz]] 후", M);
		expect(r.gestures).toEqual([]);
		expect(r.cleanText).toBe("전 후");
	});
	it("비-gesture 애니(idle/speak)는 트리거 안 함", () => {
		expect(parseGestureTriggers("[[gesture:idle]]", M).gestures).toEqual([]);
		expect(parseGestureTriggers("[[gesture:speak]]", M).gestures).toEqual([]);
	});
	it("복수 마커 = 등장 순서", () => {
		const r = parseGestureTriggers("A [[g:물방울]] B [[gesture:하트]] C", M);
		expect(r.gestures.map((g) => g.key)).toEqual(["gesture-1", "gesture-2"]);
		expect(r.cleanText).toBe("A B C");
	});
	it("빈/무마커 텍스트", () => {
		expect(parseGestureTriggers("그냥 인사", M)).toEqual({
			cleanText: "그냥 인사",
			gestures: [],
		});
		expect(parseGestureTriggers("", M)).toEqual({
			cleanText: "",
			gestures: [],
		});
	});
});

describe("driveGestures — 순차 트리거 + 예외 격리", () => {
	it("순서대로 player.gesture 호출", async () => {
		const calls: string[] = [];
		const player = { gesture: async (k: string) => void calls.push(k) };
		const fired = await driveGestures(player, [
			{ key: "gesture-1", matched: "물방울" },
			{ key: "gesture-2", matched: "하트" },
		]);
		expect(calls).toEqual(["gesture-1", "gesture-2"]);
		expect(fired).toBe(2);
	});
	it("gesture() throw 는 격리하고 계속", async () => {
		const player = {
			gesture: vi
				.fn()
				.mockRejectedValueOnce(new Error("unknown"))
				.mockResolvedValueOnce(undefined),
		};
		const fired = await driveGestures(player, [
			{ key: "bad", matched: "bad" },
			{ key: "gesture-2", matched: "하트" },
		]);
		expect(player.gesture).toHaveBeenCalledTimes(2); // 첫 실패에도 다음 진행
		expect(fired).toBe(1); // 성공 1건만 카운트
	});
});
