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

/**
 * gap-review-7 (2026-09-25) 구멍 3-1: 여유값의 두 번째 성분 — 문장 길이(L)
 * 추정치 자체의 오차를 흡수하는 몫. 고정 0.3초만으로는 L 추정이 실제보다
 * 짧을 때(느린 참조 음성, 숫자·약어가 풀려 읽히는 경우 등) 문장이 길수록
 * 절대 오차도 커지는데 여유값은 그대로다 — 그래서 이 몫은 L 에 비례한다.
 * 값 0.05(5%)는 초기값이다: SentenceRateCalibrator 가 세션 실측으로
 * 초당 글자 수 자체를 보정하므로, 이 비례항은 "그래도 남는" 오차만 덮으면
 * 된다고 보고 작게 잡았다 — 실제 기기에서 끊김이 남으면 루크 확인 후 올린다.
 */
export const DEFAULT_PREROLL_MARGIN_RELATIVE = 0.05;

/** 문장 길이 추정에 쓰는 기본 발화 속도(초당 글자 수) — 아직 이 세션에서
 * 실측치가 없을 때만 쓰는 폴백. 정밀 측정값이 아니라 pre-roll 여유를 잡기
 * 위한 근사치다. gap-review-7 (3-1): 실측이 쌓이면 `SentenceRateCalibrator`
 * 가 이 값을 대신한다 — 아래 참고. */
export const DEFAULT_CHARS_PER_SECOND = 7;

/**
 * gap-review-8 (2026-09-25) 구멍 2-1: RTF 표본에 반영할 최소 문장 길이(초).
 * 짧은 문장은 고정 지연이 섞여 RTF를 왜곡해 5문장 동안 자동 모드를
 * 끌어내리는 문제를 방지하기 위해, 이보다 짧은 표본은 표본 목록에 더하지 않는다.
 */
export const MIN_RTF_SAMPLE_DURATION_SECONDS = 1.0;

/**
 * gap-review-8 (2026-09-25) 구멍 3-1: 문장 길이 보정기(SentenceRateCalibrator)
 * 이상치 필터링 경계 (초당 1~40자).
 */
export const MIN_CALIBRATED_CHARS_PER_SECOND = 1;
export const MAX_CALIBRATED_CHARS_PER_SECOND = 40;

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
 * 다시 앞지르지 않는 한 끊기지 않는다. r 나 L 을 몰라서 그 항을 아예 계산할 수
 * 없을 때만 여유값만 돌려준다(그래도 스케줄링 지터에는 대비해 둔다).
 *
 * gap-review-6 (2026-09-25): r≤1 을 "당길 필요 없음"으로 보고 공식 자체를
 * 건너뛰던 이전 버전은 r=1.0 에서 여유값(0.3s)이 그대로 나오는데 r=1.0001 에서는
 * (공식이 적용되어) 사실상 같은 값(≈0.3s)이 나오면서도, r=1.0 을 "실시간" 분기가
 * 아예 preRollSeconds=0 으로 하드코딩해 버려 둘 사이에 불연속 단절(0 → 0.3s)이
 * 생겼다. r≤1 구간에도 공식을 그대로 적용하면(L×(r−1) 항이 음수가 되어 여유값을
 * 깎고, 0 이하로는 클램프) 연속된 값이 나온다 — 예: L=5, r=0.95 → 0.05s,
 * r=1.0 → 0.3s, r=1.0001 → ≈0.3s.
 *
 * gap-review-7 (2026-09-25) 구멍 3-1: 여유값이 이제 L 에 비례하는 몫을 포함한다
 * — `marginSeconds + estimatedDurationSeconds × DEFAULT_PREROLL_MARGIN_RELATIVE`.
 * L 추정 자체가 짧게 틀렸을 때(느린 참조 음성 등) 그 오차는 L 에 비례해 커지므로,
 * 여유값도 L 에 비례해야 문장이 길어도 같은 비율로 안전하다. L 을 모르면(가드절)
 * 비례항을 계산할 근거가 없으므로 고정 여유값만 돌려준다.
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
		estimatedDurationSeconds <= 0
	) {
		return Math.max(0, marginSeconds);
	}
	const proportionalMargin =
		marginSeconds + estimatedDurationSeconds * DEFAULT_PREROLL_MARGIN_RELATIVE;
	return Math.max(0, estimatedDurationSeconds * (rtf - 1) + proportionalMargin);
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
 *   3. RTF ≤ 1.0 → 스트리밍 + pre-roll(공식값, 보통 여유값 근방 — gap-review-6).
 *   4. 1.0 < RTF ≤ 1.3 → 스트리밍 + pre-roll(같은 공식, 3번과 연속).
 *   5. RTF > 1.3 → 문장 방식.
 */
export function decidePlaybackMethod(
	input: PlaybackDecisionInput,
): PlaybackDecision {
	if (input.mode === "streaming")
		// gap-review-7 (2026-09-25) 구멍 4-2: 예전엔 강제 스트리밍이 RTF 를 알아도
		// 항상 preRollSeconds=0 이었다 — 요구 정의("실시간 방식 = max(0, L×(r−1)+
		// 여유)만큼 쌓은 뒤 재생")와 어긋났고, RTF>1 기기에서 "스트리밍"을 고르면
		// 매 문장이 끊겼다(M21 변이가 이 0 을 못박아 뒀었다). computePreRollSeconds
		// 는 rtf/L 을 모르면 이미 여유값만 돌려주므로, 모를 때와 알 때를 가릴 필요
		// 없이 항상 그대로 호출하면 된다. 설정 화면 "끊길 수 있다" 문구와 이 동작이
		// 다르므로 루크 확인이 오면 조정한다.
		return {
			method: "streaming",
			preRollSeconds: computePreRollSeconds(
				input.estimatedDurationSeconds,
				input.rtf,
				input.marginSeconds,
			),
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
		// gap-review-6 (2026-09-25): 더 이상 0 으로 못박지 않는다 — computePreRollSeconds
		// 의 공식을 그대로 태워, RTF=1.0 경계에서 borderline 분기(바로 아래)가 주는
		// 값과 연속되게 한다(둘 다 결국 같은 공식을 부른다).
		return {
			method: "streaming",
			preRollSeconds: computePreRollSeconds(
				input.estimatedDurationSeconds,
				rtf,
				input.marginSeconds,
			),
			reason: "rtf-realtime",
		};

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
 * gap-review-7 (2026-09-25) 구멍 2-1: 표본 몇 개를 기억할지. 표본 하나만 쓰면
 * 턴의 첫 문장(재생 경합이 없어 낙관적)이 뒤 문장(이전 문장 재생 + NVA 렌더링과
 * GPU 를 나눠 쓰며 더 느려짐)보다 빠르게 측정되기 쉽고, 마지막 값만 남기면 그
 * 낙관적인 값이 그대로 다음 판정에 쓰인다. 최근 N 개를 보수적으로(최댓값) 묶으면
 * 한 번이라도 느린 표본이 나왔을 때 그 사실을 몇 문장 더 기억한다.
 */
const RTF_SAMPLE_WINDOW = 5;

/**
 * 세션에 걸쳐 최근 측정한 RTF 표본들을 기억하는 작은 상태 보관소. "자동" 모드의
 * 첫 문장은 RTF 를 모르므로 문장 방식으로 시작하고, 그 문장의 실측 RTF 를 여기
 * 기록해 다음 문장부터 스트리밍 여부를 다시 판정한다.
 *
 * gap-review-7 구멍 2-1: 표본은 이제 "값 하나"가 아니라 "최근 N 개 중 최댓값"
 * 이다(RTF_SAMPLE_WINDOW). 최댓값을 쓰는 이유는 안전 쪽으로 보수적이기
 * 때문이다 — 최근에 한 번이라도 예상보다 느렸다면(경합, 콜드스타트 잔재 등)
 * 그 사실을 몇 문장 더 반영해 pre-roll 을 넉넉히 잡는다.
 */
export class VoicePlaybackRtfTracker {
	private samples: number[] = [];
	/**
	 * gap-review-6 (2026-09-25): the synthesis target `samples` was actually
	 * measured against. `null` when no target has been noted yet.
	 * gap-review-7 (2026-09-25) 구멍 2-1: 호출부(sentence-pipeline.ts)가 이제 이
	 * 문자열에 호스트 주소뿐 아니라 GPU 번호와 엔진 기동 세대까지 합성해 넘긴다
	 * (buildSynthesisTargetKey) — 이 클래스 입장에서는 여전히 "문자열이 달라지면
	 * 무효화"만 하면 되므로 이 타입/로직은 그대로다.
	 */
	private lastTarget: string | null = null;

	/**
	 * gap-review-6: applies target-change invalidation shared by
	 * `noteTarget()` and `record()` — a target swap (switching
	 * `vllmTtsHost`/GPU/엔진 기동 세대 — gap-review-7) means the OLD
	 * measurements say nothing about how fast the NEW target actually is, so
	 * they must be treated as "unknown" until the new target's own sentences
	 * are measured, not silently carried over.
	 */
	private applyTarget(target: string | null): void {
		if (target !== this.lastTarget) {
			this.lastTarget = target;
			this.samples = [];
		}
	}

	/**
	 * gap-review-6: call with the CURRENT synthesis target before reading
	 * `get()` at decision time. This catches a target swap even before this
	 * sentence's own `record()` would run — without it, the FIRST sentence
	 * sent to a newly-swapped-to target would still read the old target's
	 * stale RTF and could stream with zero pre-roll on a host that has never
	 * actually been measured.
	 */
	noteTarget(target: string | null = null): void {
		this.applyTarget(target);
	}

	/** elapsedSeconds/durationSeconds 로 RTF 를 계산해 표본에 더한다. 유효하지
	 * 않은 측정(길이 0/음수, 유한하지 않음)은 무시한다 — 기존 표본을 지우지
	 * 않는다. 창(RTF_SAMPLE_WINDOW)을 넘으면 가장 오래된 표본을 버린다.
	 * gap-review-6: `target` 이 이전과 다르면(예: vllmTtsHost 변경) 기록 전에
	 * "모름" 상태로 먼저 되돌린다 — 호출부가 target 을 안 넘기면(기본값 null)
	 * 기존 동작(target 무관, 세션 내내 이어짐)과 동일하다. */
	record(
		elapsedSeconds: number,
		durationSeconds: number | null,
		target: string | null = null,
	): void {
		this.applyTarget(target);
		if (
			durationSeconds == null ||
			!Number.isFinite(durationSeconds) ||
			durationSeconds < MIN_RTF_SAMPLE_DURATION_SECONDS ||
			!Number.isFinite(elapsedSeconds) ||
			elapsedSeconds < 0
		)
			return;
		this.samples.push(elapsedSeconds / durationSeconds);
		if (this.samples.length > RTF_SAMPLE_WINDOW) this.samples.shift();
	}

	/**
	 * VL-review1 추정값 부류: 최근 창(최대 5개)의 중앙값(상위 중앙값)을 반환한다.
	 * 최댓값 하나에 의해 짧은 문장의 부푼 RTF가 창 전체에 남아 방식을 문장 재생으로
	 * 끌어내리는 문제를 방지하면서도, 적은 표본(1~2개)에서는 안전성을 보존한다.
	 */
	get(): number | null {
		if (this.samples.length === 0) return null;
		const sorted = [...this.samples].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		return sorted[mid];
	}

	/** 새 세션/바지인 — 엔진 상태가 이어질 이유가 없는 새 턴에서 호출한다. */
	reset(): void {
		this.samples = [];
		this.lastTarget = null;
	}
}

/**
 * gap-review-7 (2026-09-25) 구멍 2-1: RTF/warming 캐시를 무효화할 "합성 조건
 * 묶음" 키. 호스트 주소 하나만 보면 다음이 새지 않는다 — 음성 카드(GPU) 를
 * 바꿔도 호스트는 그대로고, 엔진이 재기동해도 주소는 그대로다. 세 값을 하나의
 * 문자열로 합쳐 `VoicePlaybackRtfTracker.noteTarget`/`LocalVoiceScheduler.
 * noteTarget` 에 공통으로 넘기면, 셋 중 하나라도 바뀔 때 두 캐시가 함께
 * 무효화된다.
 */
export function buildSynthesisTargetKey(
	host: string | null | undefined,
	gpuIndex: number | null | undefined,
	engineBootGeneration: number,
): string {
	return `${host ?? ""}|gpu=${gpuIndex ?? ""}|gen=${engineBootGeneration}`;
}

/** 최근 글자 속도 표본 창 크기 (범위 내 튀는 이상치가 세션 끝까지 남지 않도록 제한). */
export const CALIBRATOR_SAMPLE_WINDOW = 10;

/**
 * gap-review-7 (2026-09-25) 구멍 3-1: 문장 길이(L) 추정에 쓰는 초당 글자 수를
 * 고정값(DEFAULT_CHARS_PER_SECOND) 대신 이 세션에서 실제로 관측한
 * (글자 수, 합성 오디오 길이) 쌍으로 보정한다.
 *
 * VL-review1 추정값 부류: 범위(1~40자/초) 안의 튀는 값 하나가 세션 끝까지 누적 평균에
 * 남아 예상 길이를 왜곡하지 않도록, 최근 N개(CALIBRATOR_SAMPLE_WINDOW) 창의
 * 오디오 길이 가중 평균을 사용한다.
 */
export class SentenceRateCalibrator {
	private samples: Array<{ chars: number; seconds: number }> = [];
	private lastVoiceKey: string | null = null;

	/**
	 * gap-review-8 (2026-09-25) 구멍 3-1: 목소리나 참조 음성이 변경되면
	 * 발화 속도 통계를 리셋한다.
	 */
	noteVoiceIdentity(key: string | null = null): void {
		if (key !== this.lastVoiceKey) {
			this.lastVoiceKey = key;
			this.samples = [];
		}
	}

	record(charLength: number, durationSeconds: number | null | undefined): void {
		if (
			charLength <= 0 ||
			durationSeconds == null ||
			!Number.isFinite(durationSeconds) ||
			durationSeconds <= 0
		)
			return;
		const rate = charLength / durationSeconds;
		if (
			rate < MIN_CALIBRATED_CHARS_PER_SECOND ||
			rate > MAX_CALIBRATED_CHARS_PER_SECOND
		)
			return;
		this.samples.push({ chars: charLength, seconds: durationSeconds });
		if (this.samples.length > CALIBRATOR_SAMPLE_WINDOW) {
			this.samples.shift();
		}
	}

	/** 보정된 초당 글자 수(최근 창 오디오 길이 가중 평균), 또는 표본이 아직 없으면 null. */
	get(): number | null {
		if (this.samples.length === 0) return null;
		const totalChars = this.samples.reduce((sum, s) => sum + s.chars, 0);
		const totalSeconds = this.samples.reduce((sum, s) => sum + s.seconds, 0);
		return totalSeconds > 0 ? totalChars / totalSeconds : null;
	}

	reset(): void {
		this.samples = [];
		this.lastVoiceKey = null;
	}
}
