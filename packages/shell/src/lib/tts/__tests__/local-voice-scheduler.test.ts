import { describe, expect, it, vi } from "vitest";
import { LocalVoiceScheduler } from "../local-voice-scheduler";

function make() {
	const pausePlayback = vi.fn();
	const resumePlayback = vi.fn();
	const setWarmingVisible = vi.fn();
	const scheduler = new LocalVoiceScheduler({
		pausePlayback,
		resumePlayback,
		setWarmingVisible,
	});
	return { scheduler, pausePlayback, resumePlayback, setWarmingVisible };
}

describe("LocalVoiceScheduler (FR-VOICE.16 Phase 2a — FR-VOICE.11/12/19 semantics)", () => {
	it("keeps local synthesis single-flight and in order", async () => {
		const { scheduler } = make();
		const order: string[] = [];
		let releaseFirst!: () => void;
		const first = scheduler.schedule(
			() =>
				new Promise<void>((res) => {
					order.push("first-start");
					releaseFirst = () => {
						order.push("first-done");
						res();
					};
				}),
		);
		const second = scheduler.schedule(async () => {
			order.push("second-start");
		});
		await Promise.resolve();
		expect(order).toEqual(["first-start"]);
		releaseFirst();
		await first;
		await second;
		expect(order).toEqual(["first-start", "first-done", "second-start"]);
	});

	it("a rejected job does not poison the admission tail", async () => {
		const { scheduler } = make();
		const failing = scheduler.schedule(() => Promise.reject(new Error("boom")));
		await expect(failing).rejects.toThrow("boom");
		await expect(scheduler.schedule(async () => "next")).resolves.toBe("next");
	});

	it("seq 0 opens the playback window by pausing playback", () => {
		const { scheduler, pausePlayback } = make();
		scheduler.noteSentence(0);
		expect(pausePlayback).toHaveBeenCalledTimes(1);
		scheduler.noteSentence(1);
		expect(pausePlayback).toHaveBeenCalledTimes(1);
	});

	it("FR-VOICE.19: RTF>1 with more speech coming opens a warming hold with the preparing indicator", () => {
		const { scheduler, setWarmingVisible, resumePlayback } = make();
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		const verdict = scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 16,
			durationSeconds: 2,
		});
		expect(verdict?.rtf).toBe(8);
		expect(verdict?.warmingHold).toBe(true);
		expect(setWarmingVisible).toHaveBeenCalledWith(true);
		// Enqueuing later sentences does NOT release a warming hold (no
		// second-sentence release, no timer cap — the old 5s cap caused the
		// starved-queue underrun).
		scheduler.onEnqueued(scheduler.generation, 0);
		scheduler.onEnqueued(scheduler.generation, 1);
		expect(resumePlayback).not.toHaveBeenCalled();
	});

	it("does not hold a finished one-sentence answer or realtime-fast synthesis", () => {
		const { scheduler, resumePlayback } = make();
		scheduler.noteSentence(0);
		scheduler.finishStream();
		expect(
			scheduler.onSentenceResult(scheduler.generation, {
				elapsedSeconds: 16,
				durationSeconds: 2,
			})?.warmingHold,
		).toBe(false);
		// The single complete WAV plays as soon as it lands.
		scheduler.onEnqueued(scheduler.generation, 0);
		expect(resumePlayback).toHaveBeenCalled();

		const fast = make();
		fast.scheduler.noteSentence(0);
		fast.scheduler.noteSentence(1);
		expect(
			fast.scheduler.onSentenceResult(fast.scheduler.generation, {
				elapsedSeconds: 1,
				durationSeconds: 2,
			})?.warmingHold,
		).toBe(false);
		fast.scheduler.onEnqueued(fast.scheduler.generation, 0);
		expect(fast.resumePlayback).toHaveBeenCalledTimes(1);
	});

	it("FR-VOICE.19 release (a): a later sentence at RTF<1 proves the engine warmed", () => {
		const { scheduler, resumePlayback, setWarmingVisible } = make();
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 16,
			durationSeconds: 2,
		});
		scheduler.onEnqueued(scheduler.generation, 0);
		expect(resumePlayback).not.toHaveBeenCalled();
		scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 1,
			durationSeconds: 3,
		});
		expect(resumePlayback).toHaveBeenCalledTimes(1);
		expect(setWarmingVisible).toHaveBeenLastCalledWith(false);
	});

	it("FR-VOICE.19 release (b): stream end + every sentence synthesized plays the complete turn", () => {
		const { scheduler, resumePlayback } = make();
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		scheduler.noteSentence(2);
		scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 16,
			durationSeconds: 2,
		});
		scheduler.onEnqueued(scheduler.generation, 0);
		scheduler.finishStream();
		scheduler.onEnqueued(scheduler.generation, 1);
		expect(resumePlayback).not.toHaveBeenCalled(); // 2 of 3 synthesized
		scheduler.onEnqueued(scheduler.generation, 2);
		expect(resumePlayback).toHaveBeenCalledTimes(1);
	});

	it("FR-VOICE.19 release (c): a failed sentence never leaves playback paused", () => {
		const { scheduler, resumePlayback, setWarmingVisible } = make();
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 16,
			durationSeconds: 2,
		});
		scheduler.releaseOnFailure(scheduler.generation);
		expect(resumePlayback).toHaveBeenCalledTimes(1);
		expect(setWarmingVisible).toHaveBeenLastCalledWith(false);
	});

	it("interrupt fences the old generation and clears the preparing indicator", () => {
		const { scheduler, resumePlayback, setWarmingVisible } = make();
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 16,
			durationSeconds: 2,
		});
		const staleGeneration = scheduler.generation;
		scheduler.interrupt();
		expect(setWarmingVisible).toHaveBeenLastCalledWith(false);
		expect(
			scheduler.onSentenceResult(staleGeneration, {
				elapsedSeconds: 16,
				durationSeconds: 2,
			}),
		).toBeNull();
		scheduler.release(staleGeneration);
		scheduler.releaseOnFailure(staleGeneration);
		scheduler.onEnqueued(staleGeneration, 0);
		expect(resumePlayback).not.toHaveBeenCalled();
	});

	it("an unmeasurable first duration neither holds nor blocks later warm detection from holding", () => {
		const { scheduler, resumePlayback } = make();
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		// duration unknown → rtf 0 → cannot judge warmth; no hold (conservative).
		const verdict = scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 16,
			durationSeconds: null,
		});
		expect(verdict?.rtf).toBe(0);
		expect(verdict?.warmingHold).toBe(false);
		scheduler.onEnqueued(scheduler.generation, 0);
		expect(resumePlayback).toHaveBeenCalledTimes(1);
	});

	it("FR-VOICE.20: the first streamed chunk releases playback before the sentence finishes", () => {
		const { scheduler, resumePlayback, setWarmingVisible } = make();
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 16,
			durationSeconds: 2,
		});
		expect(resumePlayback).not.toHaveBeenCalled();
		// Audio exists the moment the first chunk lands, and it landed fast —
		// that is the realtime proof, without waiting for the sentence's RTF.
		scheduler.onFirstChunk(scheduler.generation, 0.35);
		expect(resumePlayback).toHaveBeenCalledTimes(1);
		expect(setWarmingVisible).toHaveBeenLastCalledWith(false);
	});

	it("FR-VOICE.20: a slow first chunk keeps the warming hold closed", () => {
		const { scheduler, resumePlayback, setWarmingVisible } = make();
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 16,
			durationSeconds: 2,
		});
		scheduler.onFirstChunk(scheduler.generation, 4);
		expect(resumePlayback).not.toHaveBeenCalled();
		expect(setWarmingVisible).toHaveBeenLastCalledWith(true);
	});

	it("FR-VOICE.20: outside a hold the first chunk releases the seq-0 playback window", () => {
		const { scheduler, resumePlayback } = make();
		scheduler.noteSentence(0);
		scheduler.onFirstChunk(scheduler.generation, 0.2);
		expect(resumePlayback).toHaveBeenCalledTimes(1);
	});

	it("FR-VOICE.20: a chunk from a superseded turn does not release the new one", () => {
		const { scheduler, resumePlayback } = make();
		scheduler.noteSentence(0);
		const stale = scheduler.generation;
		scheduler.interrupt();
		scheduler.noteSentence(0);
		scheduler.onFirstChunk(stale, 0.1);
		expect(resumePlayback).not.toHaveBeenCalled();
	});

	/**
	 * Device e2e follows merge on win-rtx4060.
	 * #621: on RTF>1 streaming-host hardware the first chunk arrives before the
	 * per-sentence RTF verdict. A slow first chunk must open the warming hold
	 * (not resume a starved cold queue) so complete-then-play remains reachable.
	 */
	it("#621: slow first chunk before RTF verdict opens the hold instead of starving-resume", () => {
		const { scheduler, resumePlayback, setWarmingVisible } = make();
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		// Streaming host order: first chunk lands before onSentenceResult.
		scheduler.onFirstChunk(scheduler.generation, 3.5);
		expect(setWarmingVisible).toHaveBeenCalledWith(true);
		expect(resumePlayback).not.toHaveBeenCalled();
		scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 3.5,
			durationSeconds: 3.5 / 1.69,
		});
		expect(resumePlayback).not.toHaveBeenCalled();
	});

	it("#621: issue RTF series (1.69..1.76) releases once via complete-then-play", () => {
		const { scheduler, resumePlayback, setWarmingVisible } = make();
		const rtfs = [1.69, 1.73, 1.74, 1.82, 1.76];
		const durations = [2.06, 2.38, 2.7, 5.58, 2.7];
		for (let i = 0; i < rtfs.length; i++) scheduler.noteSentence(i);
		// Stream can end after the first sentence while the rest are still synthesizing.
		for (let i = 0; i < rtfs.length; i++) {
			const durationSeconds = durations[i];
			const elapsedSeconds = rtfs[i] * durationSeconds;
			// Real streaming order: first chunk, then full-sentence RTF, then enqueue.
			scheduler.onFirstChunk(scheduler.generation, elapsedSeconds);
			scheduler.onSentenceResult(scheduler.generation, {
				elapsedSeconds,
				durationSeconds,
			});
			if (i === 0) scheduler.finishStream();
			scheduler.onEnqueued(scheduler.generation, i);
			if (i < rtfs.length - 1) {
				expect(resumePlayback).not.toHaveBeenCalled();
			}
		}
		expect(setWarmingVisible).toHaveBeenCalledWith(true);
		expect(resumePlayback).toHaveBeenCalledTimes(1);
		expect(setWarmingVisible).toHaveBeenLastCalledWith(false);
	});

	it("#621: interleaved finishStream after all enqueues still releases once", () => {
		const { scheduler, resumePlayback } = make();
		const rtfs = [1.69, 1.73, 1.74, 1.82, 1.76];
		const durations = [2.06, 2.38, 2.7, 5.58, 2.7];
		for (let i = 0; i < rtfs.length; i++) scheduler.noteSentence(i);
		for (let i = 0; i < rtfs.length; i++) {
			const durationSeconds = durations[i];
			const elapsedSeconds = rtfs[i] * durationSeconds;
			scheduler.onFirstChunk(scheduler.generation, elapsedSeconds);
			scheduler.onSentenceResult(scheduler.generation, {
				elapsedSeconds,
				durationSeconds,
			});
			scheduler.onEnqueued(scheduler.generation, i);
		}
		expect(resumePlayback).not.toHaveBeenCalled();
		scheduler.finishStream();
		expect(resumePlayback).toHaveBeenCalledTimes(1);
	});

	it("#621: a later RTF<1 still releases via condition (a) after a slow first chunk", () => {
		const { scheduler, resumePlayback, setWarmingVisible } = make();
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		scheduler.onFirstChunk(scheduler.generation, 3.4);
		expect(resumePlayback).not.toHaveBeenCalled();
		scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 3.4,
			durationSeconds: 2,
		});
		scheduler.onEnqueued(scheduler.generation, 0);
		scheduler.onFirstChunk(scheduler.generation, 0.4);
		scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 0.8,
			durationSeconds: 2,
		});
		expect(resumePlayback).toHaveBeenCalledTimes(1);
		expect(setWarmingVisible).toHaveBeenLastCalledWith(false);
	});

	it("gap-review-7 (2026-09-25) 구멍 4-1(최우선): interrupt()(턴/새 대화/슬라이드 페이지 경계)는 warmed 를 지우지 않는다 — 같은 합성 대상이면 다음 턴도 엔진이 이미 몸풀렸다고 믿는다", () => {
		const { scheduler, resumePlayback, setWarmingVisible } = make();
		// 턴 1: 실시간 결과로 warmed=true 확정.
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 1,
			durationSeconds: 2,
		});
		// 바지인/새 턴 — 예전 동작이면 여기서 warmed 가 지워졌다.
		scheduler.interrupt();
		// 턴 2: 같은 대상, 느린 첫 조각(4s>1s) — 예전 동작이면 콜드로 오판해
		// "음성 모델 준비 중" 대기 장치를 다시 연다. 이제는 warmed 가 살아
		// 있어 열지 않고, 즉시 재생을 푼다.
		scheduler.noteSentence(0);
		scheduler.onFirstChunk(scheduler.generation, 4);
		expect(setWarmingVisible).not.toHaveBeenCalledWith(true);
		expect(resumePlayback).toHaveBeenCalled();
	});

	it("구멍 4-1/2-1: noteTarget 으로 합성 대상이 바뀌면 warmed 가 무효화되어 대기 장치가 다시 열릴 수 있다", () => {
		const { scheduler, resumePlayback, setWarmingVisible } = make();
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 1,
			durationSeconds: 2,
		});
		scheduler.interrupt();
		// 엔진 재기동/GPU 변경/호스트 교체 — 합성 조건 키가 바뀐다.
		scheduler.noteTarget("host-b|gpu=0|gen=1");
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		scheduler.onFirstChunk(scheduler.generation, 4);
		expect(setWarmingVisible).toHaveBeenCalledWith(true);
		expect(resumePlayback).not.toHaveBeenCalled();
	});

	it("구멍 4-1: 같은 합성 대상으로 다시 noteTarget 을 불러도 warmed 를 지우지 않는다", () => {
		const { scheduler, resumePlayback, setWarmingVisible } = make();
		scheduler.noteTarget("host|gpu=0|gen=0");
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 1,
			durationSeconds: 2,
		});
		scheduler.interrupt();
		scheduler.noteTarget("host|gpu=0|gen=0"); // 같은 키 — 그대로 유지
		scheduler.noteSentence(0);
		scheduler.onFirstChunk(scheduler.generation, 4);
		expect(setWarmingVisible).not.toHaveBeenCalledWith(true);
		expect(resumePlayback).toHaveBeenCalled();
	});

	it("gap-review-8 구멍 4-1: RTF 아는 pre-roll 문장은 elapsedSeconds>1 이어도 warming hold 를 열지 않고 warmed 유지", () => {
		const { scheduler, resumePlayback, setWarmingVisible } = make();
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		// Cold engine initially (warmed = false), slow first chunk (1.5s > 1s),
		// but rtfInformedPreRoll = true.
		scheduler.onFirstChunk(scheduler.generation, 1.5, true);
		expect(setWarmingVisible).not.toHaveBeenCalledWith(true);
		expect(resumePlayback).toHaveBeenCalledTimes(1);
	});
});
