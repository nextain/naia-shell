/**
 * FR-VOICE.16 Phase 2a (#420): the 6GB local-voice scheduling concern,
 * extracted from ChatArea so unrelated component work can no longer regress it.
 *
 * Owns three tightly coupled pieces (FR-VOICE.11/12 behavior preserved):
 *  - Half-duplex admission: VoxCPM2 owns one TensorRT execution context, so
 *    local sentence synthesis is single-flight. The tail releases as soon as a
 *    WAV is ready, letting the next sentence synthesize while the AudioQueue
 *    plays the previous one (low first-sentence latency without 429 storms).
 *  - Warming hold (FR-VOICE.19 #519): when synthesis is slower than realtime
 *    (RTF>1 — engine cold after boot/reinstall), playback stays held behind
 *    the "음성 모델 준비 중…" indicator instead of starting a starved stream.
 *    No fallback voice and no arbitrary timer cap (both by explicit decision,
 *    2026-08-31): the hold releases only when the engine proves realtime
 *    (some sentence lands with RTF<1), when the whole turn is synthesized
 *    (complete-then-play — every WAV ready, zero gaps by construction), or on
 *    a sentence failure (deadlock guard). The previous 5-second cap released
 *    a starved queue mid-warmup and produced the pause-then-crack underruns.
 *  - Generation fencing: a barge-in/new turn supersedes hold state, but the
 *    GPU admission tail is deliberately NOT reset — aborting the WebView fetch
 *    does not prove VoxCPM2 released its execution context.
 */

export interface LocalVoiceSchedulerDeps {
	/** Hold AudioQueue playback while the prebuffer/warming window is open. */
	pausePlayback: () => void;
	/** Release AudioQueue playback when the window closes. */
	resumePlayback: () => void;
	/** FR-VOICE.19: drive the "음성 모델 준비 중…" indicator for warming holds. */
	setWarmingVisible?: (visible: boolean) => void;
}

export interface SentenceResultVerdict {
	rtf: number;
	durationSeconds: number | null;
	/** True while playback is held behind engine warmup (FR-VOICE.19). */
	warmingHold: boolean;
}

export class LocalVoiceScheduler {
	private tail: Promise<void> = Promise.resolve();
	private state = {
		generation: 0,
		sentenceCount: 0,
		enqueuedCount: 0,
		streamFinished: false,
		holdActive: false,
		warmed: false,
		firstResultSeen: false,
	};
	/**
	 * gap-review-7 (2026-09-25) 구멍 4-1: `warmed` 가 실제로 유효한 합성 조건
	 * 묶음(호스트/GPU/엔진 기동 세대) — `interrupt()`(매 턴/새 대화/슬라이드
	 * 페이지)로는 더 이상 지워지지 않고, 이 키가 바뀔 때만 지워진다.
	 */
	private lastTargetKey: string | null = null;

	constructor(private readonly deps: LocalVoiceSchedulerDeps) {}

	/** Current turn generation — capture per request, pass back to verdict/release. */
	get generation(): number {
		return this.state.generation;
	}

	/**
	 * Barge-in / new turn: supersede the hold state and clear the indicator.
	 * The admission tail is kept on purpose (see module doc).
	 *
	 * gap-review-7 (2026-09-25) 구멍 4-1(가장 무거움): `warmed` 는 더 이상 여기서
	 * 지워지지 않는다. 예전 동작은 RTF 1.1 인 4060 에서 두 번째 턴부터 "자동"이
	 * RTF 를 알아서 실시간+미리채움을 고르는데도, 새 턴마다 `warmed=false` 로
	 * 되돌아가 첫 조각이 1초를 넘으면 대기 장치가 다시 열리고(complete-then-play)
	 * 미리채움 계산이 무의미해지는 문제였다 — 재생 방식은 사용자 설정이 아니라
	 * 첫 조각 도착 시간이 정하는 셈이었다. `warmed` 는 이제 `noteTarget()` 이
	 * 관리하는, RTF 추적기와 같은 수명(세션 + 합성 조건 묶음)을 따른다 — 대상이
	 * 안 바뀌면 턴이 바뀌어도 "엔진이 이미 몸풀렸다"는 사실을 그대로 믿는다.
	 */
	interrupt(): void {
		const warmed = this.state.warmed;
		this.state = {
			generation: this.state.generation + 1,
			sentenceCount: 0,
			enqueuedCount: 0,
			streamFinished: false,
			holdActive: false,
			warmed,
			firstResultSeen: false,
		};
		this.deps.setWarmingVisible?.(false);
	}

	/**
	 * gap-review-7 (2026-09-25) 구멍 2-1/4-1: 호출부(sentence-pipeline.ts)가
	 * `VoicePlaybackRtfTracker.noteTarget()` 과 같은 지점(문장 자신의 합성이
	 * 막 시작되려는 순간)에서, 같은 합성 조건 키(`buildSynthesisTargetKey`)로
	 * 이것도 함께 부른다. 키가 이전과 다르면(호스트/GPU/엔진 기동 세대 중
	 * 하나라도 바뀜) `warmed` 를 지운다 — 새로 뜬/바뀐 엔진이 실제로 빠른지
	 * 증명하기 전까지는 이전 엔진의 몸풀림 상태를 믿지 않는다.
	 */
	noteTarget(targetKey: string | null = null): void {
		if (targetKey !== this.lastTargetKey) {
			this.lastTargetKey = targetKey;
			this.state.warmed = false;
		}
	}

	/** seq 0 opens the playback window (pauses playback); later seqs count up. */
	noteSentence(seq: number): void {
		if (seq === 0) {
			this.state.sentenceCount = 1;
			this.state.enqueuedCount = 0;
			this.deps.pausePlayback();
		} else {
			this.state.sentenceCount++;
		}
	}

	/** Half-duplex admission: run the job strictly behind the previous one. */
	schedule<T>(job: () => Promise<T>): Promise<T> {
		const run = this.tail.then(job);
		// A failed or interrupted sentence must not poison the queue — this tail
		// only gates the next job; the caller still observes its own rejection.
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * Per-sentence RTF verdict (FR-VOICE.19: every local sentence, not only the
	 * first). RTF>1 on the first measurable result opens the warming hold;
	 * any later RTF<1 proves the engine warmed and releases it.
	 */
	onSentenceResult(
		generation: number,
		measured: { elapsedSeconds: number; durationSeconds: number | null },
	): SentenceResultVerdict | null {
		if (generation !== this.state.generation) return null;
		const { elapsedSeconds, durationSeconds } = measured;
		const rtf =
			durationSeconds && durationSeconds > 0
				? elapsedSeconds / durationSeconds
				: 0;
		const firstResult = !this.state.firstResultSeen;
		this.state.firstResultSeen = true;
		if (rtf > 0 && rtf <= 1) {
			// Realtime synthesis observed — the engine is warm. Streaming is safe
			// for this and every following sentence of the turn.
			this.state.warmed = true;
			if (this.state.holdActive) this.release(generation);
		} else if (
			rtf > 1 &&
			!this.state.warmed &&
			firstResult &&
			(!this.state.streamFinished || this.state.sentenceCount > 1)
		) {
			// Cold engine with more speech coming: hold playback behind the
			// preparing indicator. A finished one-sentence answer never holds —
			// its single complete WAV plays gaplessly via finishStream().
			this.state.holdActive = true;
			this.deps.setWarmingVisible?.(true);
		}
		return { rtf, durationSeconds, warmingHold: this.state.holdActive };
	}

	/**
	 * After enqueue. Outside a hold, the first sentence releases playback
	 * immediately (FR-VOICE.11 low-latency path). Inside a warming hold, only
	 * "every noted sentence is synthesized after stream end" releases —
	 * complete-then-play (FR-VOICE.19 release condition b).
	 */
	onEnqueued(generation: number, _seq: number): void {
		if (generation !== this.state.generation) return;
		this.state.enqueuedCount++;
		if (!this.state.holdActive) {
			this.release(generation);
			return;
		}
		this.maybeReleaseCompletedTurn();
	}

	/**
	 * Streaming host (2026-09-11): the first PCM chunk of a sentence is the
	 * enqueue signal — audio exists, so playback may start now instead of after
	 * the whole WAV. A first chunk that lands within a second proves the engine
	 * realtime (release condition a) without waiting for the sentence's RTF.
	 *
	 * A slow first chunk (elapsed>1) on a still-cold engine must OPEN the
	 * warming hold when more speech is coming — never resume a starved queue.
	 * onFirstChunk can fire before onSentenceResult's RTF verdict (#621); the
	 * previous `!holdActive → release` path made complete-then-play unreachable
	 * on RTF>1 hardware (e.g. windows_trt_6g on RTX 4060 8GB).
	 */
	onFirstChunk(
		generation: number,
		elapsedSeconds: number,
		rtfInformedPreRoll = false,
	): void {
		if (generation !== this.state.generation) return;
		if (elapsedSeconds <= 1 || rtfInformedPreRoll) {
			this.state.warmed = true;
			this.state.firstResultSeen = true;
		} else if (
			!this.state.warmed &&
			(!this.state.streamFinished || this.state.sentenceCount > 1)
		) {
			// Cold engine, more speech coming: arm the hold (mirrors the RTF>1
			// branch of onSentenceResult). Do not fall through to resume.
			this.state.holdActive = true;
			this.state.firstResultSeen = true;
			this.deps.setWarmingVisible?.(true);
		}
		if (!this.state.holdActive || this.state.warmed) this.release(generation);
	}

	/** A failed sentence must never leave playback paused (release condition c). */
	releaseOnFailure(generation: number): void {
		if (generation !== this.state.generation) return;
		this.release(generation);
	}

	/** Close the playback window and resume (generation-guarded). */
	release(generation: number): void {
		if (generation !== this.state.generation) return;
		this.state.holdActive = false;
		this.deps.setWarmingVisible?.(false);
		this.deps.resumePlayback();
	}

	/** Stream ended: a one-sentence answer (or a fully synthesized turn) plays. */
	finishStream(): void {
		this.state.streamFinished = true;
		if (this.state.sentenceCount <= 1 && !this.state.holdActive) {
			this.release(this.state.generation);
			return;
		}
		this.maybeReleaseCompletedTurn();
	}

	private maybeReleaseCompletedTurn(): void {
		if (
			this.state.holdActive &&
			this.state.streamFinished &&
			this.state.enqueuedCount >= this.state.sentenceCount
		) {
			this.release(this.state.generation);
		}
	}
}
