/**
 * FR-VOICE.22 (2026-09-25): "음성 재생 방식" — 자동/스트리밍/문장.
 *
 * 배경(`.agents/work/naia-res/studio-impl/voice-streaming-regression-20260925.md`):
 * 셸의 로컬 음성(naia-local-voice, voxcpm2-tensorrt)은 PCM 스트림을 받는 대로
 * 재생할 수 있지만, 엔진이 실시간(RTF≤1)보다 느리면 스트리밍이 끊긴다. 반대로
 * 문장 전체가 합성될 때까지 기다리면 끊기지는 않지만 첫 소리가 늦다(느린
 * 하드웨어에서 문장당 3~17초 관측, 9/22). 루크 방향: 실시간이 안 되면 문장
 * 단위 옵션이 있어야 하고, 재생 방식은 기본적으로 옵션이어야 한다(9/25).
 *
 * 이 모듈은 그 결정을 순수 함수로 뽑아낸 것이다 — 설정값과 측정치(RTF)만
 * 받아 "스트리밍" 또는 "문장" 중 어느 쪽으로 재생할지, 스트리밍이라면 얼마나
 * 미리 버퍼를 쌓고 시작할지(pre-roll)를 반환한다. 실제 오디오 타임라인 적용은
 * `voice/audio-queue.ts`(`PcmStreamSource.startDelaySeconds`)가 맡는다.
 *
 * 실시간이 필요한 곳은 셸의 슬라이드 발표·대화뿐이다(9/25 루크 범위 확정).
 * 스튜디오 음성은 이 결정과 무관하게 항상 일반(비스트리밍) 합성을 쓴다.
 */

/** 사용자가 고르는 세 값. 기본값은 "auto". */
export type VoicePlaybackMode = "auto" | "streaming" | "sentence";

/** 실제로 어느 방식으로 재생하는가 — 사용자 선택 세 값과 달리 "auto" 는 없다. */
export type VoicePlaybackMethod = "streaming" | "sentence";

/**
 * RTF(Real-Time Factor) 판정 경계.
 *
 * - RTF ≤ REALTIME: 합성이 재생보다 빠르거나 같다 — pre-roll 없이 바로 스트리밍.
 * - REALTIME < RTF ≤ BORDERLINE: 실시간을 "약간" 넘는다(9/25 루크: "4060은
 *   가속 하면 1을 조금 넘는걸로 측정") — 스트리밍은 가능하지만 pre-roll 로
 *   앞당겨 쌓아야 끊기지 않는다.
 * - RTF > BORDERLINE, 또는 RTF 를 모름: 문장 방식(완성 후 재생)으로 떨어진다.
 */
export const REALTIME_RTF_CEILING = 1.0;
export const BORDERLINE_RTF_CEILING = 1.3;

/** pre-roll 계산의 안전 여유(초). 스케줄링 지터를 흡수한다. */
export const DEFAULT_PREROLL_MARGIN_SECONDS = 0.3;

/** 문장 길이 추정에 쓰는 기본 발화 속도(초당 글자 수). 정밀 측정값이 아니라
 * pre-roll 여유를 잡기 위한 근사치 — 실제 합성 시간과의 오차는 여유값이
 * 흡수한다. */
export const DEFAULT_CHARS_PER_SECOND = 7;

export interface PlaybackDecisionInput {
	mode: VoicePlaybackMode;
	/**
	 * 런타임이 직접 알리는 실시간 가능 신호(예: /health 의 capabilities 에
	 * "realtime"/"realtime_watermark" 종류가 있거나 prime/probe 결과가 실시간을
	 * 보증하는 경우). 2026-09-25 기준 voxcpm2-tensorrt `/health` 는 이런 필드를
	 * 내보내지 않는다(`health_payload()` 는 `capabilities: ["tts"]` 고정,
	 * `speech_kind`/realtime 신호는 게이트웨이 쪽 리소스 등록에만 있고 셸까지
	 * 오지 않는다) — 그래서 실전에서는 항상 null 이고 rtf 폴백으로 떨어진다.
	 * 미래에 런타임이 이 신호를 보내면 `readRuntimeRealtimeHint` 로 채운다.
	 */
	explicitRealtime?: boolean | null;
	/** 가장 최근에 측정한 RTF(elapsedSeconds / durationSeconds). 아직 한 번도
	 * 측정하지 못했으면 null/undefined — "모름" 으로 취급한다. */
	rtf?: number | null;
	/** pre-roll 계산에 쓰는, 지금 합성하려는 문장의 예상 길이(초). */
	estimatedDurationSeconds?: number | null;
	/** pre-roll 여유(초). 생략하면 DEFAULT_PREROLL_MARGIN_SECONDS. */
	marginSeconds?: number;
}

export interface PlaybackDecision {
	method: VoicePlaybackMethod;
	/** 스트리밍 시작 전 쌓아 둘 시간(초). sentence 방식이면 항상 0. */
	preRollSeconds: number;
	/** 판정 근거 — 로그/테스트용. */
	reason:
		| "user-forced-streaming"
		| "user-forced-sentence"
		| "runtime-advertised-realtime"
		| "rtf-unknown"
		| "rtf-realtime"
		| "rtf-borderline-preroll"
		| "rtf-slow";
}

/**
 * pre-roll ≈ L×(r−1) + 여유.
 *
 * L(estimatedDurationSeconds) 초 분량을 RTF r 로 합성하면 실제로는 L×r 초가
 * 걸린다. 그 차이(L×(r−1))만큼 재생 시작을 늦춰 미리 쌓아 두면, 합성이 재생을
 * 다시 앞지르지 않는 한 끊기지 않는다. r≤1 이거나 L 을 모르면 여유값만 돌려준다
 * (L 을 모르는 채로 L×(r−1) 항을 계산할 수 없으므로 — 그래도 스케줄링 지터에는
 * 대비해 둔다).
 */
export function computePreRollSeconds(
	estimatedDurationSeconds: number | null | undefined,
	rtf: number | null | undefined,
	marginSeconds: number = DEFAULT_PREROLL_MARGIN_SECONDS,
): number {
	if (
		rtf == null ||
		!Number.isFinite(rtf) ||
		estimatedDurationSeconds == null ||
		!Number.isFinite(estimatedDurationSeconds) ||
		estimatedDurationSeconds <= 0 ||
		rtf <= 1
	) {
		return Math.max(0, marginSeconds);
	}
	return Math.max(0, estimatedDurationSeconds * (rtf - 1) + marginSeconds);
}

/**
 * 아직 합성하지 않은 문장의 예상 길이(초) — 글자 수 기반 근사치.
 * 공백만 있거나 빈 문자열이면 0.
 */
export function estimateSentenceDurationSeconds(
	text: string,
	charsPerSecond: number = DEFAULT_CHARS_PER_SECOND,
): number {
	const length = text.trim().length;
	if (length <= 0 || !Number.isFinite(charsPerSecond) || charsPerSecond <= 0)
		return 0;
	return length / charsPerSecond;
}

/**
 * 세 방식 중 실제로 무엇을 쓸지 결정한다. "streaming"/"sentence" 는 사용자가
 * 명시적으로 고른 값이라 측정과 무관하게 그대로 따른다(강제 오버라이드) —
 * 사용자가 "스트리밍"을 골랐다면 느려도 스트리밍을 시도하고, "문장"을 골랐다면
 * 빨라도 항상 완성 후 재생한다. "auto" 만 아래 순서로 판정한다:
 *
 *   1. 런타임이 실시간을 명시적으로 알리면 → 스트리밍, pre-roll 없음.
 *   2. RTF 를 모르면(첫 측정 전) → 문장 방식(안전 쪽 기본값).
 *   3. RTF ≤ 1.0 → 스트리밍, pre-roll 없음.
 *   4. 1.0 < RTF ≤ 1.3 → 스트리밍 + pre-roll.
 *   5. RTF > 1.3 → 문장 방식.
 */
export function decidePlaybackMethod(
	input: PlaybackDecisionInput,
): PlaybackDecision {
	if (input.mode === "streaming")
		return {
			method: "streaming",
			preRollSeconds: 0,
			reason: "user-forced-streaming",
		};
	if (input.mode === "sentence")
		return {
			method: "sentence",
			preRollSeconds: 0,
			reason: "user-forced-sentence",
		};

	// mode === "auto"
	if (input.explicitRealtime === true)
		return {
			method: "streaming",
			preRollSeconds: 0,
			reason: "runtime-advertised-realtime",
		};

	const rtf = input.rtf;
	if (rtf == null || !Number.isFinite(rtf))
		return { method: "sentence", preRollSeconds: 0, reason: "rtf-unknown" };

	if (rtf <= REALTIME_RTF_CEILING)
		return { method: "streaming", preRollSeconds: 0, reason: "rtf-realtime" };

	if (rtf <= BORDERLINE_RTF_CEILING)
		return {
			method: "streaming",
			preRollSeconds: computePreRollSeconds(
				input.estimatedDurationSeconds,
				rtf,
				input.marginSeconds,
			),
			reason: "rtf-borderline-preroll",
		};

	return { method: "sentence", preRollSeconds: 0, reason: "rtf-slow" };
}

/**
 * 실제로 재생을 늦출 시간 — pre-roll 목표에서 "이미 쌓인 만큼"을 뺀 나머지.
 *
 * 적대검수 2회차(2026-09-25) 발견: `decidePlaybackMethod` 가 돌려주는
 * `preRollSeconds` 는 "이 문장의 합성이 지금 막 시작된다면" 가정한 목표값이다.
 * 그런데 실제로는 앞 문장이 재생되는 동안에도 이 문장의 합성이 이미 진행되고
 * 있어서(half-duplex 스케줄러가 순서대로 GPU 를 돌린다), 이 문장의 차례가
 * 왔을 때는 목표보다 더 많이 — 심지어 문장 전체가 — 이미 버퍼에 쌓여 있을 수
 * 있다. 쌓인 만큼을 무시하고 목표값을 그대로 지연에 더하면(예: 목표 1.3초인데
 * 이미 문장 전체가 끝나 있어도 1.3초를 통째로 더 기다림) 필요 없는 공백이
 * 생긴다. 합성이 끝났거나(ended) 예상 길이만큼 이미 쌓였으면 지연은 0이다.
 */
export function effectivePreRollSeconds(
	targetPreRollSeconds: number,
	alreadyBufferedSeconds: number,
	expectedDurationSeconds: number | null | undefined,
	ended: boolean,
): number {
	if (ended) return 0;
	if (
		expectedDurationSeconds != null &&
		Number.isFinite(expectedDurationSeconds) &&
		expectedDurationSeconds > 0 &&
		Number.isFinite(alreadyBufferedSeconds) &&
		alreadyBufferedSeconds >= expectedDurationSeconds
	) {
		return 0;
	}
	const buffered =
		Number.isFinite(alreadyBufferedSeconds) && alreadyBufferedSeconds > 0
			? alreadyBufferedSeconds
			: 0;
	return Math.max(0, targetPreRollSeconds - buffered);
}

/**
 * 런타임 /health(또는 start_voxcpm2 ready) 페이로드에서 실시간 가능 신호를
 * 읽는다. 구조를 넓게 인식해 두지만(capabilities 배열의 "realtime"/
 * "realtime_watermark" 종류, 또는 boolean `realtime` 필드), 2026-09-25 기준
 * `voxcpm2-tensorrt` 의 `health_payload()`/`ready_payload()` 는 이런 필드를
 * 전혀 내보내지 않는다 — `capabilities` 는 언제나 `["tts"]` 고정이다. 그래서
 * 지금은 항상 null 을 돌려주고, `decidePlaybackMethod` 는 RTF 폴백으로
 * 떨어진다. 런타임이 이 신호를 추가하면 이 함수만 채우면 된다(호출부 변경 불필요).
 */
export function readRuntimeRealtimeHint(health: unknown): boolean | null {
	if (!health || typeof health !== "object") return null;
	const body = health as {
		realtime?: unknown;
		capabilities?: unknown;
	};
	if (typeof body.realtime === "boolean") return body.realtime;
	if (Array.isArray(body.capabilities)) {
		const kinds = body.capabilities.filter(
			(value): value is string => typeof value === "string",
		);
		if (kinds.includes("realtime") || kinds.includes("realtime_watermark"))
			return true;
	}
	return null;
}

/**
 * 세션(턴)에 걸쳐 마지막으로 측정한 RTF 를 기억하는 작은 상태 보관소.
 * "자동" 모드의 첫 문장은 RTF 를 모르므로 문장 방식으로 시작하고, 그 문장의
 * 실측 RTF 를 여기 기록해 다음 문장부터 스트리밍 여부를 다시 판정한다.
 */
export class VoicePlaybackRtfTracker {
	private lastRtf: number | null = null;

	/** elapsedSeconds/durationSeconds 로 RTF 를 계산해 기록한다. 유효하지 않은
	 * 측정(길이 0/음수, 유한하지 않음)은 무시한다 — 이전 값을 지우지 않는다. */
	record(elapsedSeconds: number, durationSeconds: number | null): void {
		if (
			durationSeconds == null ||
			!Number.isFinite(durationSeconds) ||
			durationSeconds <= 0 ||
			!Number.isFinite(elapsedSeconds) ||
			elapsedSeconds < 0
		)
			return;
		this.lastRtf = elapsedSeconds / durationSeconds;
	}

	get(): number | null {
		return this.lastRtf;
	}

	/** 새 세션/바지인 — 엔진 상태가 이어질 이유가 없는 새 턴에서 호출한다. */
	reset(): void {
		this.lastRtf = null;
	}
}
