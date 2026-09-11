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

	constructor(private readonly deps: LocalVoiceSchedulerDeps) {}

	/** Current turn generation — capture per request, pass back to verdict/release. */
	get generation(): number {
		return this.state.generation;
	}

	/**
	 * Barge-in / new turn: supersede the hold state and clear the indicator.
	 * The admission tail is kept on purpose (see module doc).
	 */
	interrupt(): void {
		this.state = {
			generation: this.state.generation + 1,
			sentenceCount: 0,
			enqueuedCount: 0,
			streamFinished: false,
			holdActive: false,
			warmed: false,
			firstResultSeen: false,
		};
		this.deps.setWarmingVisible?.(false);
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
	 */
	onFirstChunk(generation: number, elapsedSeconds: number): void {
		if (generation !== this.state.generation) return;
		if (elapsedSeconds <= 1) {
			this.state.warmed = true;
			this.state.firstResultSeen = true;
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
