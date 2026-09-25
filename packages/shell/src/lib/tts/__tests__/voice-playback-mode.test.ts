import { describe, expect, it } from "vitest";
import {
	BORDERLINE_RTF_CEILING,
	DEFAULT_PREROLL_MARGIN_RELATIVE,
	DEFAULT_PREROLL_MARGIN_SECONDS,
	REALTIME_RTF_CEILING,
	SentenceRateCalibrator,
	VoicePlaybackRtfTracker,
	buildSynthesisTargetKey,
	computePreRollSeconds,
	decidePlaybackMethod,
	effectivePreRollSeconds,
	estimateSentenceDurationSeconds,
	readRuntimeRealtimeHint,
} from "../voice-playback-mode";

describe("decidePlaybackMethod — 사용자 강제 선택 (mode !== auto)", () => {
	it("mode=streaming 이면 RTF 가 아무리 나빠도 항상 스트리밍이다", () => {
		// gap-review-7 (2026-09-25) 구멍 4-2: "스트리밍"을 강제해도 RTF 를 알면
		// 이제 pre-roll 공식을 그대로 적용한다(예전엔 0 으로 못박아 끊김
		// 방지를 포기했다). L=10, r=5 → 10*4 + (0.3 + 10*0.05) = 40.8.
		const decision = decidePlaybackMethod({
			mode: "streaming",
			rtf: 5,
			estimatedDurationSeconds: 10,
		});
		expect(decision).toEqual({
			method: "streaming",
			preRollSeconds: 40.8,
			reason: "user-forced-streaming",
		});
	});

	it("mode=streaming 은 RTF 를 몰라도 스트리밍이고, pre-roll 은 여유값만 쓴다", () => {
		// gap-review-7 구멍 4-2: RTF/길이를 모르면 computePreRollSeconds 가
		// 우아하게 여유값만 돌려준다(공식 적용 불가 상태의 안전한 폴백).
		const decision = decidePlaybackMethod({ mode: "streaming", rtf: null });
		expect(decision.method).toBe("streaming");
		expect(decision.preRollSeconds).toBe(DEFAULT_PREROLL_MARGIN_SECONDS);
	});

	it("mode=sentence 면 RTF 가 아무리 좋아도 항상 문장 방식이다", () => {
		const decision = decidePlaybackMethod({
			mode: "sentence",
			rtf: 0.1,
			explicitRealtime: true,
		});
		expect(decision).toEqual({
			method: "sentence",
			preRollSeconds: 0,
			reason: "user-forced-sentence",
		});
	});
});

describe("decidePlaybackMethod — mode=auto 판정 경계 (RTF 0.9 / 1.1 / 1.6 / 모름)", () => {
	it("런타임이 실시간을 명시적으로 알리면 RTF 와 무관하게 스트리밍한다", () => {
		const decision = decidePlaybackMethod({
			mode: "auto",
			explicitRealtime: true,
			rtf: 9,
		});
		expect(decision).toEqual({
			method: "streaming",
			preRollSeconds: 0,
			reason: "runtime-advertised-realtime",
		});
	});

	it("RTF 를 모르면(첫 측정 전) 안전한 문장 방식으로 시작한다", () => {
		const decision = decidePlaybackMethod({ mode: "auto", rtf: null });
		expect(decision).toEqual({
			method: "sentence",
			preRollSeconds: 0,
			reason: "rtf-unknown",
		});
	});

	it("RTF 가 undefined 여도 모름과 동일하게 문장 방식이다", () => {
		const decision = decidePlaybackMethod({ mode: "auto" });
		expect(decision.method).toBe("sentence");
		expect(decision.reason).toBe("rtf-unknown");
	});

	it("RTF=0.9(실시간보다 빠름) → 그래도 여유값은 문장 길이에 비례해 붙는다", () => {
		// gap-review-7 (2026-09-25) 구멍 3-1: 여유값이 이제 L 에 비례하는 몫을
		// 포함한다 — L=4, r=0.9 → 4*(-0.1) + (0.3 + 4*0.05) = -0.4 + 0.5 = 0.1.
		const decision = decidePlaybackMethod({
			mode: "auto",
			rtf: 0.9,
			estimatedDurationSeconds: 4,
		});
		expect(decision.method).toBe("streaming");
		expect(decision.reason).toBe("rtf-realtime");
		expect(decision.preRollSeconds).toBeCloseTo(0.1, 10);
	});

	it("RTF=1.0(경계, 포함) → 스트리밍이지만 pre-roll 은 여유값(공식과 연속)", () => {
		// gap-review-6 (2026-09-25): 예전엔 "실시간" 분기가 preRollSeconds 를 0 으로
		// 못박아서, RTF=1.0(여기)과 RTF=1.0001(borderline 분기, 공식 적용)
		// 사이에 0 → ≈margin 의 불연속 단절이 있었다. 이제 이 분기도 같은 공식을
		// 타므로 연속된다.
		// gap-review-7 구멍 3-1: 여유값이 L 비례 몫을 포함해 0.3 → 0.5 로
		// 바뀌었다. L=4, r=1.0 → 4*0 + (0.3 + 4*0.05) = 0.5.
		const decision = decidePlaybackMethod({
			mode: "auto",
			rtf: REALTIME_RTF_CEILING,
			estimatedDurationSeconds: 4,
		});
		expect(decision.method).toBe("streaming");
		expect(decision.preRollSeconds).toBeCloseTo(0.5, 10);
	});

	it("gap-review-6/7: RTF=0.95/1.0/1.0001 경계에서 pre-roll 이 끊기지 않는다", () => {
		// 설계 공식 max(0, L×(r−1)+여유+L×비례여유) 를 실시간 구간에도 그대로
		// 적용한 결과. L=5, margin=0.3, 비례여유=0.05 기준:
		// 0.95 → 5*(-0.05) + (0.3+0.25) = -0.25+0.55 = 0.3
		// 1.0  → 5*0       + 0.55            = 0.55
		// 1.0001 → 5*0.0001 + 0.55 = 0.5505 (≈연속)
		const below = decidePlaybackMethod({
			mode: "auto",
			rtf: 0.95,
			estimatedDurationSeconds: 5,
		});
		const at = decidePlaybackMethod({
			mode: "auto",
			rtf: 1.0,
			estimatedDurationSeconds: 5,
		});
		const above = decidePlaybackMethod({
			mode: "auto",
			rtf: 1.0001,
			estimatedDurationSeconds: 5,
		});
		expect(below.method).toBe("streaming");
		expect(below.preRollSeconds).toBeCloseTo(0.3, 10);
		expect(at.method).toBe("streaming");
		expect(at.preRollSeconds).toBeCloseTo(0.55, 10);
		expect(above.method).toBe("streaming");
		expect(above.preRollSeconds).toBeCloseTo(0.5505, 3);
		// 경계를 넘나들어도 값이 튀지 않는다(급격한 계단 없음).
		expect(Math.abs(at.preRollSeconds - below.preRollSeconds)).toBeLessThan(
			0.3,
		);
		expect(Math.abs(above.preRollSeconds - at.preRollSeconds)).toBeLessThan(
			0.01,
		);
	});

	it("RTF=1.1(실시간을 약간 넘음) → pre-roll 을 둔 스트리밍", () => {
		const decision = decidePlaybackMethod({
			mode: "auto",
			rtf: 1.1,
			estimatedDurationSeconds: 4,
		});
		expect(decision.method).toBe("streaming");
		expect(decision.reason).toBe("rtf-borderline-preroll");
		// gap-review-7 구멍 3-1: L=4, r=1.1 → 4*0.1 + (0.3 + 4*0.05) = 0.4+0.5 = 0.9
		expect(decision.preRollSeconds).toBeCloseTo(0.9, 5);
	});

	it("RTF=1.3(경계, 여전히 스트리밍+pre-roll)", () => {
		const decision = decidePlaybackMethod({
			mode: "auto",
			rtf: BORDERLINE_RTF_CEILING,
			estimatedDurationSeconds: 2,
		});
		expect(decision.method).toBe("streaming");
		expect(decision.reason).toBe("rtf-borderline-preroll");
		// gap-review-7 구멍 3-1: L=2, r=1.3 → 2*0.3 + (0.3 + 2*0.05) = 0.6+0.4 = 1.0
		expect(decision.preRollSeconds).toBeCloseTo(1.0, 5);
	});

	it("RTF=1.30001(경계를 살짝 넘음) → 문장 방식", () => {
		const decision = decidePlaybackMethod({
			mode: "auto",
			rtf: 1.30001,
			estimatedDurationSeconds: 2,
		});
		expect(decision).toEqual({
			method: "sentence",
			preRollSeconds: 0,
			reason: "rtf-slow",
		});
	});

	it("RTF=1.6(그보다 느림) → 문장 방식", () => {
		const decision = decidePlaybackMethod({
			mode: "auto",
			rtf: 1.6,
			estimatedDurationSeconds: 5,
		});
		expect(decision).toEqual({
			method: "sentence",
			preRollSeconds: 0,
			reason: "rtf-slow",
		});
	});
});

describe("computePreRollSeconds — pre-roll ≈ L×(r−1)+여유(+L×비례여유)", () => {
	it("정확한 값을 계산한다(변이 방지 — 근사가 아니라 정확히 비교)", () => {
		// gap-review-7 (2026-09-25) 구멍 3-1: 여유값이 이제 L 에 비례하는 몫
		// (DEFAULT_PREROLL_MARGIN_RELATIVE=0.05)을 포함한다.
		// (10,1.2,0.3) → 10*0.2 + (0.3 + 10*0.05) = 2.0 + 0.8 = 2.8
		// (3,1.5,0.5)  → 3*0.5  + (0.5 + 3*0.05)  = 1.5 + 0.65 = 2.15
		expect(computePreRollSeconds(10, 1.2, 0.3)).toBeCloseTo(2.8, 10);
		expect(computePreRollSeconds(3, 1.5, 0.5)).toBeCloseTo(2.15, 10);
	});

	it("기본 여유값(DEFAULT_PREROLL_MARGIN_SECONDS)에 L 비례 몫을 더해 쓴다", () => {
		expect(computePreRollSeconds(10, 1.2)).toBeCloseTo(
			10 * 0.2 +
				DEFAULT_PREROLL_MARGIN_SECONDS +
				10 * DEFAULT_PREROLL_MARGIN_RELATIVE,
			10,
		);
	});

	it("RTF<1 이면 공식이 여유값을 깎는다(RTF=1 이면 L 비례 여유만 남는다)", () => {
		// gap-review-6 (2026-09-25): 예전엔 rtf<=1 전체를 "여유값만 돌려준다"로
		// 특수 취급해 RTF=1.0 과 RTF=1.0001 사이에 불연속을 만들었다. 이제는
		// r=1 에서 L×(r−1) 항이 0 이 되어, 남는 건 여유값 + L 비례 몫뿐이다.
		// gap-review-7 구멍 3-1: (10,1,0.3) → 0 + (0.3+10*0.05) = 0.8.
		expect(computePreRollSeconds(10, 1, 0.3)).toBe(0.8);
		// L=10, r=0.5 → 10*(-0.5)+(0.3+0.5) = -5+0.8 = -4.2 → clamp 0.
		expect(computePreRollSeconds(10, 0.5, 0.3)).toBe(0);
	});

	it("예상 길이를 모르면 여유값만 돌려준다", () => {
		expect(computePreRollSeconds(null, 1.4, 0.3)).toBe(0.3);
		expect(computePreRollSeconds(undefined, 1.4, 0.3)).toBe(0.3);
	});

	it("RTF 를 모르면 여유값만 돌려준다", () => {
		expect(computePreRollSeconds(10, null, 0.3)).toBe(0.3);
		expect(computePreRollSeconds(10, undefined, 0.3)).toBe(0.3);
	});

	it("음수로 떨어지지 않는다(0 이하로 클램프)", () => {
		expect(computePreRollSeconds(10, 1.4, -100)).toBe(0);
	});

	it("길이가 0 이하이면 여유값만 돌려준다", () => {
		expect(computePreRollSeconds(0, 1.4, 0.3)).toBe(0.3);
		expect(computePreRollSeconds(-5, 1.4, 0.3)).toBe(0.3);
	});
});

describe("effectivePreRollSeconds — gap-review-2: 이미 쌓인 만큼을 뺀 실제 지연", () => {
	it("적대검수 2회차 재현 수치: 목표 pre-roll 1.34s, 이미 1.3s 쌓임 → 0.04s (3.34s 아님)", () => {
		// 첫 문장 2s 재생 중 둘째 문장(5s, RTF=1.2)이 완성 직전까지 합성되어
		// 1.3초 분량이 이미 버퍼에 쌓인 상태로 차례가 옴. 목표 pre-roll은
		// L=5, r=1.2, margin=0.3 → 5*0.2+0.3 = 1.3... 실제 좌표는 예시로
		// margin 포함 1.34s를 목표로 가정.
		const target = 1.34;
		const alreadyBuffered = 1.3;
		expect(
			effectivePreRollSeconds(target, alreadyBuffered, 5, false),
		).toBeCloseTo(0.04, 10);
	});

	it("합성이 끝났으면(ended) 쌓인 양과 무관하게 항상 0", () => {
		expect(effectivePreRollSeconds(2, 0, 5, true)).toBe(0);
		expect(effectivePreRollSeconds(2, 100, 5, true)).toBe(0);
	});

	it("쌓인 양이 예상 길이 이상이면(문장 전체가 이미 버퍼에 있음) 0", () => {
		expect(effectivePreRollSeconds(1.3, 5, 5, false)).toBe(0);
		expect(effectivePreRollSeconds(1.3, 6, 5, false)).toBe(0);
	});

	it("아무것도 안 쌓였으면(0) 목표값을 그대로 쓴다", () => {
		expect(effectivePreRollSeconds(1.3, 0, 5, false)).toBeCloseTo(1.3, 10);
	});

	it("일부만 쌓였으면 목표에서 쌓인 만큼을 정확히 뺀다(변이 방지 — 근사 아닌 정확 비교)", () => {
		expect(effectivePreRollSeconds(2.0, 0.75, 5, false)).toBeCloseTo(1.25, 10);
	});

	it("쌓인 양이 목표를 넘지만 예상 길이에는 못 미치면 0으로 클램프(음수 금지)", () => {
		// expectedDurationSeconds=null(모름)이라 "쌓인 양 ≥ expected" 단축 조건이
		// 적용되지 않는 경로도 직접 검증 — 그래도 음수로 떨어지면 안 된다.
		expect(effectivePreRollSeconds(0.5, 3, null, false)).toBe(0);
	});

	it("expectedDurationSeconds 를 모르면(null/undefined) '쌓인 양≥예상 길이' 단축 없이 뺄셈만 적용", () => {
		expect(effectivePreRollSeconds(1.3, 0.5, null, false)).toBeCloseTo(0.8, 10);
		expect(effectivePreRollSeconds(1.3, 0.5, undefined, false)).toBeCloseTo(
			0.8,
			10,
		);
	});

	it("alreadyBufferedSeconds 가 유효하지 않으면(NaN/음수) 0으로 취급 — 목표값을 그대로 쓴다", () => {
		expect(effectivePreRollSeconds(1.3, Number.NaN, 5, false)).toBeCloseTo(
			1.3,
			10,
		);
		expect(effectivePreRollSeconds(1.3, -2, 5, false)).toBeCloseTo(1.3, 10);
	});

	it("gap-review-7 (2026-09-25) 구멍 3-1(M11 변이 방지): 문장 전체가 이미 버퍼에 있으면(쌓인 양=예상 길이) 목표 pre-roll 이 그보다 커도 지름길 없이는 새어나올 차이를 0으로 막는다", () => {
		// M11: "쌓인 양≥예상 길이 → 0" 지름길을 지워도 기존 시험은 다 통과했다
		// (기존 시험은 target ≤ buffered 인 경우만 다뤄, 뺄셈 공식만으로도
		// 우연히 0이 나왔기 때문). target(5) > expected(3)=buffered(3) 인
		// 경계에서만 지름길의 존재가 드러난다: 지름길이 없으면 5-3=2초를 더
		// 기다리는 오류가 생긴다 — 재생할 것이 남아있지 않은데도.
		expect(effectivePreRollSeconds(5, 3, 3, false)).toBe(0);
	});

	it("expectedDurationSeconds 가 0/음수/비유한이면 '쌓인 양≥예상 길이' 단축을 적용하지 않는다", () => {
		expect(effectivePreRollSeconds(0.5, 10, 0, false)).toBe(0); // 뺄셈만으로도 0
		expect(effectivePreRollSeconds(1.3, 0.5, 0, false)).toBeCloseTo(0.8, 10);
		expect(effectivePreRollSeconds(1.3, 0.5, -5, false)).toBeCloseTo(0.8, 10);
		expect(
			effectivePreRollSeconds(1.3, 0.5, Number.POSITIVE_INFINITY, false),
		).toBeCloseTo(0.8, 10);
	});
});

describe("estimateSentenceDurationSeconds — 글자 수 기반 근사", () => {
	it("글자 수 / 초당 글자 수", () => {
		expect(estimateSentenceDurationSeconds("1234567", 7)).toBeCloseTo(1, 10);
		expect(estimateSentenceDurationSeconds("12345678901234", 7)).toBeCloseTo(
			2,
			10,
		);
	});

	it("앞뒤 공백은 제외한다", () => {
		expect(estimateSentenceDurationSeconds("  1234567  ", 7)).toBeCloseTo(
			1,
			10,
		);
	});

	it("빈 문자열/공백뿐이면 0", () => {
		expect(estimateSentenceDurationSeconds("", 7)).toBe(0);
		expect(estimateSentenceDurationSeconds("   ", 7)).toBe(0);
	});

	it("charsPerSecond 를 생략하면 기본값을 쓴다", () => {
		expect(estimateSentenceDurationSeconds("abcdefg")).toBeCloseTo(1, 10);
	});

	it("유효하지 않은 charsPerSecond(0/음수)면 0을 돌려준다", () => {
		expect(estimateSentenceDurationSeconds("hello", 0)).toBe(0);
		expect(estimateSentenceDurationSeconds("hello", -3)).toBe(0);
	});
});

describe("readRuntimeRealtimeHint — 오늘의 voxcpm2-tensorrt /health 는 신호가 없다", () => {
	it("실제 voxcpm2-tensorrt health_payload 모양(capabilities:['tts'] 고정)에는 null", () => {
		// src/voxcpm2_tensorrt/http_server.py health_payload() 의 실제 반환 모양.
		const health = {
			ok: true,
			ready: true,
			service: "voxcpm2-tensorrt",
			capabilities: ["tts"],
			warming: false,
			model: "voxcpm2",
			profile: "windows_trt_6g",
			watermark: true,
		};
		expect(readRuntimeRealtimeHint(health)).toBeNull();
	});

	it("capabilities 에 realtime 이 있으면 true", () => {
		expect(readRuntimeRealtimeHint({ capabilities: ["tts", "realtime"] })).toBe(
			true,
		);
	});

	it("capabilities 에 realtime_watermark 가 있어도 true", () => {
		expect(
			readRuntimeRealtimeHint({ capabilities: ["realtime_watermark"] }),
		).toBe(true);
	});

	it("boolean realtime 필드를 우선 읽는다", () => {
		expect(readRuntimeRealtimeHint({ realtime: false })).toBe(false);
		expect(readRuntimeRealtimeHint({ realtime: true })).toBe(true);
	});

	it("null/undefined/원시값/빈 객체는 null", () => {
		expect(readRuntimeRealtimeHint(null)).toBeNull();
		expect(readRuntimeRealtimeHint(undefined)).toBeNull();
		expect(readRuntimeRealtimeHint("realtime")).toBeNull();
		expect(readRuntimeRealtimeHint({})).toBeNull();
	});
});

describe("VoicePlaybackRtfTracker — 세션 내 보수적 RTF 기억(최근 N개 중 최댓값)", () => {
	it("처음에는 모름(null)이다", () => {
		expect(new VoicePlaybackRtfTracker().get()).toBeNull();
	});

	it("elapsed/duration 으로 RTF 를 계산해 기억한다", () => {
		const tracker = new VoicePlaybackRtfTracker();
		tracker.record(3, 2);
		expect(tracker.get()).toBeCloseTo(1.5, 10);
	});

	it("gap-review-7 (2026-09-25) 구멍 2-1: 낙관적인 이전 표본이 느린 새 표본으로 사라지지 않는다 — 최댓값을 쓴다", () => {
		// 예전엔 "마지막 측정만" 기억해 느린 표본 뒤에 우연히 빠른 표본이
		// 오면 전체 판정이 낙관적으로 되돌아갔다. 이제는 최근 표본 중
		// 최댓값(가장 느린 값)을 쓴다 — 첫 문장이 빠르게 측정돼도 둘째
		// 문장이 느리면 그 느림이 계속 반영된다.
		const tracker = new VoicePlaybackRtfTracker();
		tracker.record(3, 2); // rtf 1.5
		tracker.record(1, 2); // rtf 0.5 — 더 빠름, 최댓값은 그대로 1.5
		expect(tracker.get()).toBeCloseTo(1.5, 10);
	});

	it("구멍 2-1: 창(윈도우) 크기(5)를 넘으면 가장 오래된 표본이 밀려난다", () => {
		const tracker = new VoicePlaybackRtfTracker();
		tracker.record(10, 1); // rtf 10 — 가장 느림, 하지만 곧 밀려난다
		tracker.record(1, 1);
		tracker.record(1, 1);
		tracker.record(1, 1);
		tracker.record(1, 1);
		tracker.record(1, 1); // 6번째 — 창(5) 를 넘겨 rtf=10 표본이 밀려남
		expect(tracker.get()).toBeCloseTo(1, 10);
	});

	it("구멍 2-1: noteTarget 으로 합성 대상(호스트/GPU/엔진 세대)이 바뀌면 표본을 지운다", () => {
		const tracker = new VoicePlaybackRtfTracker();
		tracker.record(3, 1, "host-a|gpu=0|gen=0"); // rtf 3
		tracker.noteTarget("host-b|gpu=0|gen=0"); // 다른 호스트 — 무효화
		expect(tracker.get()).toBeNull();
		tracker.record(1, 1, "host-b|gpu=0|gen=0");
		expect(tracker.get()).toBeCloseTo(1, 10);
	});

	it("구멍 2-1: record 자체에 준 target 이 바뀌어도 같은 효과(noteTarget 을 먼저 부른 것과 동일)", () => {
		const tracker = new VoicePlaybackRtfTracker();
		tracker.record(3, 1, "gpu=0");
		tracker.record(2, 1, "gpu=1"); // GPU 만 바뀜 — 이전 표본 무효
		expect(tracker.get()).toBeCloseTo(2, 10);
	});

	it("구멍 2-1: 같은 target 이면 표본이 유지된다(엔진 재기동/GPU 변경이 없으면 누적)", () => {
		const tracker = new VoicePlaybackRtfTracker();
		tracker.record(1, 1, "host|gpu=0|gen=0");
		tracker.record(3, 1, "host|gpu=0|gen=0"); // 같은 target — 누적, 최댓값 3
		expect(tracker.get()).toBeCloseTo(3, 10);
	});

	it("길이 0/음수 측정은 무시하고 이전 값을 지키지 않는다(=아직 없으면 null)", () => {
		const tracker = new VoicePlaybackRtfTracker();
		tracker.record(3, 0);
		expect(tracker.get()).toBeNull();
		tracker.record(3, -1);
		expect(tracker.get()).toBeNull();
	});

	it("유효하지 않은 측정은 이미 있던 값을 보존한다(지우지 않는다)", () => {
		const tracker = new VoicePlaybackRtfTracker();
		tracker.record(2, 2);
		expect(tracker.get()).toBeCloseTo(1, 10);
		tracker.record(3, null);
		expect(tracker.get()).toBeCloseTo(1, 10);
	});

	it("duration 을 모르면(null) 무시한다", () => {
		const tracker = new VoicePlaybackRtfTracker();
		tracker.record(3, null);
		expect(tracker.get()).toBeNull();
	});

	it("reset 으로 모름 상태로 되돌린다", () => {
		const tracker = new VoicePlaybackRtfTracker();
		tracker.record(3, 2);
		tracker.reset();
		expect(tracker.get()).toBeNull();
	});
});

describe("buildSynthesisTargetKey — gap-review-7 구멍 2-1: 합성 조건 키", () => {
	it("호스트/GPU/엔진 세대가 모두 같으면 같은 키다", () => {
		expect(buildSynthesisTargetKey("host", 0, 1)).toBe(
			buildSynthesisTargetKey("host", 0, 1),
		);
	});

	it("호스트만 달라도 다른 키다", () => {
		expect(buildSynthesisTargetKey("host-a", 0, 1)).not.toBe(
			buildSynthesisTargetKey("host-b", 0, 1),
		);
	});

	it("GPU 인덱스만 달라도 다른 키다", () => {
		expect(buildSynthesisTargetKey("host", 0, 1)).not.toBe(
			buildSynthesisTargetKey("host", 1, 1),
		);
	});

	it("엔진 기동 세대만 달라도 다른 키다(엔진 재기동)", () => {
		expect(buildSynthesisTargetKey("host", 0, 1)).not.toBe(
			buildSynthesisTargetKey("host", 0, 2),
		);
	});

	it("null/undefined 를 안전하게 다룬다", () => {
		expect(() => buildSynthesisTargetKey(null, null, 0)).not.toThrow();
		expect(() =>
			buildSynthesisTargetKey(undefined, undefined, 0),
		).not.toThrow();
	});
});

describe("SentenceRateCalibrator — gap-review-7 구멍 3-1: 세션 실측으로 L 추정 보정", () => {
	it("처음에는 모름(null) — 호출부가 DEFAULT_CHARS_PER_SECOND 로 폴백한다", () => {
		expect(new SentenceRateCalibrator().get()).toBeNull();
	});

	it("누적 글자수/누적 시간의 평균을 쓴다(윈도우 아님, 대상 키에 안 묶임)", () => {
		const calibrator = new SentenceRateCalibrator();
		calibrator.record(70, 10); // 7자/초
		expect(calibrator.get()).toBeCloseTo(7, 10);
		calibrator.record(30, 10); // 누적 100자/20초 = 5자/초
		expect(calibrator.get()).toBeCloseTo(5, 10);
	});

	it("길이 0/이하 또는 유효하지 않은 시간은 무시한다", () => {
		const calibrator = new SentenceRateCalibrator();
		calibrator.record(0, 10);
		expect(calibrator.get()).toBeNull();
		calibrator.record(10, 0);
		expect(calibrator.get()).toBeNull();
		calibrator.record(10, null);
		expect(calibrator.get()).toBeNull();
	});

	it("reset 으로 모름 상태로 되돌린다", () => {
		const calibrator = new SentenceRateCalibrator();
		calibrator.record(70, 10);
		calibrator.reset();
		expect(calibrator.get()).toBeNull();
	});
});

describe("통합 — auto 판정에 tracker 값을 그대로 흘려 쓰는 흐름", () => {
	it("문장1(모름→문장), 문장2(측정된 RTF 로 재판정)", () => {
		const tracker = new VoicePlaybackRtfTracker();
		const first = decidePlaybackMethod({ mode: "auto", rtf: tracker.get() });
		expect(first.method).toBe("sentence");

		// 문장1 합성 결과: 2초 걸렸는데 오디오는 2.5초 분량 → RTF 0.8(실시간).
		tracker.record(2, 2.5);
		const second = decidePlaybackMethod({
			mode: "auto",
			rtf: tracker.get(),
			estimatedDurationSeconds: 3,
		});
		expect(second.method).toBe("streaming");
		expect(second.preRollSeconds).toBe(0);
	});
});
