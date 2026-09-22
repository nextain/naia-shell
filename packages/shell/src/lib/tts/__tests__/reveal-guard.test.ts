import { describe, expect, it } from "vitest";
import {
	acceptPipelineOutputStage,
	decideVoiceTailRelease,
	type VoiceTailReleaseInput,
} from "../reveal-guard";

describe("음성 진행 표시 해제 판정", () => {
	const base: VoiceTailReleaseInput = {
		active: true,
		armedGeneration: 3,
		currentGeneration: 3,
		llmFinished: true,
		warmingHold: false,
	};

	it("조건이 갖춰지면 표시를 내린다", () => {
		expect(decideVoiceTailRelease(base)).toEqual({ action: "release" });
	});

	it("홀드 중에는 내리지 않고 타이머를 다시 건다", () => {
		expect(decideVoiceTailRelease({ ...base, warmingHold: true })).toEqual({
			action: "rearm",
		});
	});

	// #571 — 이 재걸기는 예전에 본문까지 붙잡았다. 지금 붙잡는 것은 표시뿐이다.
	// 그 계약은 ChatArea 쪽에서 "홀드가 열려 있어도 본문은 DOM 에 있다" 로 잰다.
	it("턴이 바뀌면 홀드 여부와 무관하게 멈춘다", () => {
		expect(
			decideVoiceTailRelease({
				...base,
				currentGeneration: 4,
				warmingHold: true,
			}),
		).toEqual({ action: "stop" });
	});

	it("LLM 이 아직 안 끝났으면 내릴 시점이 아니다", () => {
		expect(decideVoiceTailRelease({ ...base, llmFinished: false })).toEqual({
			action: "stop",
		});
	});

	it("동기화가 죽었으면 멈춘다", () => {
		expect(decideVoiceTailRelease({ ...base, active: false })).toEqual({
			action: "stop",
		});
	});
});

describe("acceptPipelineOutputStage (#688)", () => {
	it("accepts a pipeline output stage only while active and pending > 0", () => {
		expect(acceptPipelineOutputStage({ active: true, pending: 1 })).toBe(true);
		expect(acceptPipelineOutputStage({ active: true, pending: 2 })).toBe(true);
	});

	it("rejects a stage when sync is inactive or pending is 0", () => {
		expect(acceptPipelineOutputStage({ active: false, pending: 1 })).toBe(false);
		expect(acceptPipelineOutputStage({ active: true, pending: 0 })).toBe(false);
		expect(acceptPipelineOutputStage({ active: false, pending: 0 })).toBe(false);
	});
});

