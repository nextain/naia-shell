/**
 * FR-VOICE.16 Phase 2a (#420): the 6GB local-voice scheduling concern,
 * extracted from ChatArea so unrelated component work can no longer regress it.
 *
 * Owns three tightly coupled pieces:
 *  - Half-duplex admission: VoxCPM2 owns one TensorRT execution context, so
 *    local sentence synthesis is single-flight. The tail releases as soon as a
 *    WAV is ready, letting the next sentence synthesize while the AudioQueue
 *    plays the previous one (low first-sentence latency without 429 storms).
 *  - Playback-window release (#688, Luke 2026-09-22):
 *    Supersedes FR-VOICE.19 (b) / #621 complete-then-play.
 *    Luke's decision (2026-09-22): 「음성은 문장 준비되는대로 바로 들려주게 해.
 *    재생은 문장 단위인가 ? 라이브 데모는 원래 단어 단위로해서 시간을 줄였거든.
 *    생성후 1초정도만 여유주고 플레이 하는건 어떨까 싶네.」
 *    Playback is held behind pausePlayback() at seq 0 and released when the
 *    first ready audio arrives:
 *    - On RTF>1 hardware (slower than realtime), a 1 s grace
 *      (LOCAL_VOICE_PLAYBACK_GRACE_MS = 1_000 ms) gives the next sentence a head
 *      start, so the gap between sentences shrinks.
 *    - On a realtime engine (RTF<=1 or first chunk <= 1 s), the grace would
 *      only add latency, so playback releases immediately.
 *    - Later sentences play back-to-back as soon as ready without extra hold.
 *    - Sentence failure releases immediately and clears any pending grace timer.
 *  - Generation fencing: a barge-in/new turn supersedes hold state, clears
 *    pending grace timers, and resets turn state. The GPU admission tail is
 *    deliberately NOT reset — aborting the WebView fetch does not prove VoxCPM2
 *    released its execution context.
 */

export const LOCAL_VOICE_PLAYBACK_GRACE_MS = 1_000;

export interface LocalVoiceSchedulerDeps {
	/** Hold AudioQueue playback while the prebuffer/warming window is open. */
	pausePlayback: () => void;
	/** Release AudioQueue playback when the window closes. */
	resumePlayback: () => void;
	/** Drive the "음성 모델 준비 중…" indicator. Kept for backwards compatibility and cleared on interrupt/release. */
	setWarmingVisible?: (visible: boolean) => void;
}

export interface SentenceResultVerdict {
	rtf: number;
	durationSeconds: number | null;
	/** Grace delay armed for this sentence if it was slower than realtime (#688). */
	graceMs: number;
}

export class LocalVoiceScheduler {
	private tail: Promise<void> = Promise.resolve();
	private graceTimer: ReturnType<typeof setTimeout> | null = null;
	private state = {
		generation: 0,
		sentenceCount: 0,
		streamFinished: false,
		released: false,
		lastRtf: 0,
	};

	constructor(private readonly deps: LocalVoiceSchedulerDeps) {}

	/** Current turn generation — capture per request, pass back to verdict/release. */
	get generation(): number {
		return this.state.generation;
	}

	/**
	 * Barge-in / new turn: clear pending grace timer, bump generation,
	 * reset turn state, and clear the indicator.
	 * The admission tail is kept on purpose (see module doc).
	 */
	interrupt(): void {
		this.clearGraceTimer();
		this.state = {
			generation: this.state.generation + 1,
			sentenceCount: 0,
			streamFinished: false,
			released: false,
			lastRtf: 0,
		};
		this.deps.setWarmingVisible?.(false);
	}

	/** seq 0 opens the playback window (pauses playback); later seqs count up. */
	noteSentence(seq: number): void {
		if (seq === 0) {
			this.clearGraceTimer();
			this.state.sentenceCount = 1;
			this.state.streamFinished = false;
			this.state.released = false;
			this.state.lastRtf = 0;
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
	 * Per-sentence RTF verdict (#688): measures RTF for every sentence.
	 * graceMs is LOCAL_VOICE_PLAYBACK_GRACE_MS when this result arms or would
	 * arm the grace (RTF>1 and not yet released), else 0.
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
		this.state.lastRtf = rtf;
		const willArmGrace =
			rtf > 1 && !this.state.released && this.graceTimer === null;
		const graceMs = willArmGrace ? LOCAL_VOICE_PLAYBACK_GRACE_MS : 0;
		return { rtf, durationSeconds, graceMs };
	}

	/**
	 * Whole-WAV host: onEnqueued releases playback when the first WAV lands.
	 * If the turn's last measured RTF > 1, release after 1 s grace; otherwise immediately.
	 * Later sentences do not re-hold.
	 */
	onEnqueued(generation: number, _seq: number): void {
		if (generation !== this.state.generation) return;
		if (this.state.released || this.graceTimer !== null) return;
		if (this.state.lastRtf > 1) {
			this.armGrace(generation);
		} else {
			this.release(generation);
		}
	}

	/**
	 * Streaming host: the first PCM chunk lands before the full WAV.
	 * elapsedSeconds <= 1 releases immediately; slower lands after 1 s grace.
	 * Later chunks/sentences do not re-hold.
	 */
	onFirstChunk(generation: number, elapsedSeconds: number): void {
		if (generation !== this.state.generation) return;
		if (this.state.released || this.graceTimer !== null) return;
		if (elapsedSeconds <= 1) {
			this.release(generation);
		} else {
			this.armGrace(generation);
		}
	}

	/** A failed sentence must never leave playback paused. */
	releaseOnFailure(generation: number): void {
		if (generation !== this.state.generation) return;
		this.release(generation);
	}

	/** Close the playback window and resume (generation-guarded). */
	release(generation: number): void {
		if (generation !== this.state.generation) return;
		if (this.state.released) return;
		this.clearGraceTimer();
		this.state.released = true;
		this.deps.setWarmingVisible?.(false);
		this.deps.resumePlayback();
	}

	/**
	 * Stream ended: no longer gates release (#688).
	 * Releases only if the window is still paused while nothing was noted (sentenceCount === 0).
	 */
	finishStream(): void {
		this.state.streamFinished = true;
		if (this.state.sentenceCount === 0 && !this.state.released) {
			this.release(this.state.generation);
		}
	}

	private armGrace(generation: number): void {
		this.clearGraceTimer();
		this.graceTimer = setTimeout(() => {
			this.graceTimer = null;
			if (generation === this.state.generation && !this.state.released) {
				this.release(generation);
			}
		}, LOCAL_VOICE_PLAYBACK_GRACE_MS);
	}

	private clearGraceTimer(): void {
		if (this.graceTimer !== null) {
			clearTimeout(this.graceTimer);
			this.graceTimer = null;
		}
	}
}
