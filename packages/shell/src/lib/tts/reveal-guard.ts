/**
 * 음성 진행 표시 해제 판정 (#520, #571).
 *
 * 이 파일은 한때 두 가지를 판정했다 — 재생을 앞질러 **본문을 드러낼지**(#511
 * 정체 공개)와 화면 마스크를 언제 풀지(#513/#520). 둘 다 답 텍스트가 음성 뒤에
 * 숨어 있다는 전제 위에 있었다.
 *
 * #571 에서 그 전제를 버렸다. 답 텍스트는 도착하는 대로 그려진다. 그래서 "언제
 * 드러낼까" 라는 질문 자체가 없어졌고, 정체 공개 판정도 함께 사라졌다. 남은
 * 질문은 하나다 — **음성 진행 표시를 언제 내리는가.**
 */

export interface VoiceTailReleaseInput {
	/** 이 턴의 텍스트 동기화가 살아 있는가. */
	active: boolean;
	/** 해제 타이머를 걸 때의 세대. */
	armedGeneration: number;
	/** 지금 세대. */
	currentGeneration: number;
	/** LLM 이 끝났는가. 아직이면 해제할 시점이 아니다. */
	llmFinished: boolean;
	/** 워밍업 홀드가 열려 있는가. */
	warmingHold: boolean;
}

export type VoiceTailReleaseDecision =
	/** 조건이 깨졌다. 해제하지 않고 끝낸다. */
	| { action: "stop" }
	/** 홀드 중이다. 해제를 미루고 타이머를 다시 건다. */
	| { action: "rearm" }
	/** 음성 진행 표시를 내린다. */
	| { action: "release" };

/**
 * 음성 진행 표시를 언제 내리는가.
 *
 * 재생이 영영 오지 않아도 "음성 처리 중…" 이 화면에 남아 있지 않게, LLM 이
 * 끝나고 일정 시간이 지나면 표시를 내린다. 워밍업 홀드가 열려 있는 동안은
 * 음성이 정말 오는 중이므로 타이머를 다시 건다.
 *
 * 이 재걸기가 예전에는 본문까지 붙잡았다(#571). 지금은 표시만 붙잡는다 —
 * 본문은 이 판정과 무관하게 이미 그려져 있으므로, 홀드가 길어져도 사용자가
 * 잃는 것은 "말하는 중" 표시가 조금 늦게 사라지는 것뿐이다.
 */
export function decideVoiceTailRelease(
	input: VoiceTailReleaseInput,
): VoiceTailReleaseDecision {
	if (
		!input.active ||
		input.armedGeneration !== input.currentGeneration ||
		!input.llmFinished
	) {
		return { action: "stop" };
	}
	if (input.warmingHold) return { action: "rearm" };
	return { action: "release" };
}

/** #688 — a pipeline stage ("tts"/"render") is shown only while this turn still has unspoken sentences whose reveal will clear it. */
export function acceptPipelineOutputStage(sync: { active: boolean; pending: number }): boolean {
	return sync.active && sync.pending > 0;
}

