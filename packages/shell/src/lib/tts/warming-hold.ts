/**
 * 워밍업 홀드 상태 (#519, #520).
 *
 * 로컬 음성 엔진이 아직 기동 중이면 합성은 실패가 아니라 대기다. synthesize 가
 * `naia:voice-model-preparing` 로 그 사실을 알리고, 채팅 화면은 "음성 모델 준비
 * 중…" 을 띄운다.
 *
 * 이 상태를 알아야 하는 곳이 채팅 화면만이 아니다. 문장 파이프라인에도 텍스트를
 * 언제 드러낼지 정하는 시한이 있고, 그 시한이 홀드를 모르면 엔진이 올라오기도
 * 전에 텍스트가 음성을 앞지른다. 그래서 상태를 한곳에서 읽는다.
 */

let warming = false;
/**
 * gap-review-7 (2026-09-25) 구멍 2-1/4-1: 엔진이 "다시 기동 중"이라고 알려온
 * 횟수. `naia:voice-model-preparing`(detail:true) 는 direct 루프백 엔진이
 * 연결이 끊겨(TypeError) 재시도하는 정확히 그 순간에만 쏜다(synthesize.ts) —
 * 즉 엔진이 새로 뜨거나 죽었다 살아난 신호다. 이 세대 번호를
 * `buildSynthesisTargetKey` 가 합성 조건 키에 포함해, RTF 캐시(2-1)와
 * warming-hold 의 `warmed` 상태(4-1)를 엔진 재기동 시 함께 무효화한다.
 */
let engineBootGeneration = 0;

if (typeof window !== "undefined") {
	window.addEventListener("naia:voice-model-preparing", (event) => {
		const value = !!(event as CustomEvent<boolean>).detail;
		warming = value;
	});
	window.addEventListener("naia:voice-engine-boot-retry", () => {
		engineBootGeneration++;
	});
}

/** 로컬 음성 엔진이 기동 중이라 재생이 의도적으로 멈춰 있는가. */
export function isVoiceWarmingHold(): boolean {
	return warming;
}

/** gap-review-7 구멍 2-1: 엔진 재기동 세대 번호 — 합성 조건 키에 섞어 넣는다. */
export function getVoiceEngineBootGeneration(): number {
	return engineBootGeneration;
}

/** 테스트용 — 이벤트 없이 상태를 세운다. */
export function setVoiceWarmingHoldForTest(value: boolean): void {
	warming = value;
}

/** 테스트용 — 엔진 재기동 세대를 이벤트 없이 올린다. */
export function bumpVoiceEngineBootGenerationForTest(): void {
	engineBootGeneration++;
}

/** 테스트용 — 엔진 재기동 세대를 초기화한다. */
export function resetVoiceEngineBootGenerationForTest(): void {
	engineBootGeneration = 0;
}
