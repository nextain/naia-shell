import { describe, expect, it } from "vitest";
import {
	BORDERLINE_RTF_CEILING,
	DEFAULT_PREROLL_MARGIN_SECONDS,
	REALTIME_RTF_CEILING,
	VoicePlaybackRtfTracker,
	computePreRollSeconds,
	decidePlaybackMethod,
	effectivePreRollSeconds,
	estimateSentenceDurationSeconds,
	readRuntimeRealtimeHint,
} from "../voice-playback-mode";

describe("decidePlaybackMethod — 사용자 강제 선택 (mode !== auto)", () => {
	it("mode=streaming 이면 RTF 가 아무리 나빠도 항상 스트리밍이다", () => {
		const decision = decidePlaybackMethod({
			mode: "streaming",
			rtf: 5,
			estimatedDurationSeconds: 10,
		});
		expect(decision).toEqual({
			method: "streaming",
			preRollSeconds: 0,
			reason: "user-forced-streaming",
		});
	});

	it("mode=streaming 은 RTF 를 몰라도 스트리밍이다", () => {
		const decision = decidePlaybackMethod({ mode: "streaming", rtf: null });
		expect(decision.method).toBe("streaming");
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

	it("RTF=0.9(실시간보다 빠름) → pre-roll 없이 스트리밍", () => {
		const decision = decidePlaybackMethod({
			mode: "auto",
			rtf: 0.9,
			estimatedDurationSeconds: 4,
		});
		expect(decision).toEqual({
			method: "streaming",
			preRollSeconds: 0,
			reason: "rtf-realtime",
		});
	});

	it("RTF=1.0(경계, 포함) → pre-roll 없이 스트리밍", () => {
		const decision = decidePlaybackMethod({
			mode: "auto",
			rtf: REALTIME_RTF_CEILING,
			estimatedDurationSeconds: 4,
		});
		expect(decision.method).toBe("streaming");
		expect(decision.preRollSeconds).toBe(0);
	});

	it("RTF=1.1(실시간을 약간 넘음) → pre-roll 을 둔 스트리밍", () => {
		const decision = decidePlaybackMethod({
			mode: "auto",
			rtf: 1.1,
			estimatedDurationSeconds: 4,
		});
		expect(decision.method).toBe("streaming");
		expect(decision.reason).toBe("rtf-borderline-preroll");
		// L=4, r=1.1 → 4*(1.1-1) + 0.3 = 0.7
		expect(decision.preRollSeconds).toBeCloseTo(0.7, 5);
	});

	it("RTF=1.3(경계, 여전히 스트리밍+pre-roll)", () => {
		const decision = decidePlaybackMethod({
			mode: "auto",
			rtf: BORDERLINE_RTF_CEILING,
			estimatedDurationSeconds: 2,
		});
		expect(decision.method).toBe("streaming");
		expect(decision.reason).toBe("rtf-borderline-preroll");
		// L=2, r=1.3 → 2*0.3 + 0.3 = 0.9
		expect(decision.preRollSeconds).toBeCloseTo(0.9, 5);
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

describe("computePreRollSeconds — pre-roll ≈ L×(r−1)+여유", () => {
	it("정확한 값을 계산한다(변이 방지 — 근사가 아니라 정확히 비교)", () => {
		expect(computePreRollSeconds(10, 1.2, 0.3)).toBeCloseTo(2.3, 10);
		expect(computePreRollSeconds(3, 1.5, 0.5)).toBeCloseTo(2.0, 10);
	});

	it("기본 여유값(DEFAULT_PREROLL_MARGIN_SECONDS)을 쓴다", () => {
		expect(computePreRollSeconds(10, 1.2)).toBeCloseTo(
			10 * 0.2 + DEFAULT_PREROLL_MARGIN_SECONDS,
			10,
		);
	});

	it("RTF≤1 이면 여유값만 돌려준다(당길 필요 없음)", () => {
		expect(computePreRollSeconds(10, 1, 0.3)).toBe(0.3);
		expect(computePreRollSeconds(10, 0.5, 0.3)).toBe(0.3);
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

describe("VoicePlaybackRtfTracker — 세션 내 마지막 RTF 기억", () => {
	it("처음에는 모름(null)이다", () => {
		expect(new VoicePlaybackRtfTracker().get()).toBeNull();
	});

	it("elapsed/duration 으로 RTF 를 계산해 기억한다", () => {
		const tracker = new VoicePlaybackRtfTracker();
		tracker.record(3, 2);
		expect(tracker.get()).toBeCloseTo(1.5, 10);
	});

	it("이후 측정이 이전 값을 덮어쓴다", () => {
		const tracker = new VoicePlaybackRtfTracker();
		tracker.record(3, 2);
		tracker.record(1, 2);
		expect(tracker.get()).toBeCloseTo(0.5, 10);
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
