import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("LocalVoiceScheduler (FR-VOICE.16 Phase 2a — #688 1s grace / ready playback semantics)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

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

	it("a failed sentence never leaves playback paused", () => {
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

	it("an unmeasurable first duration releases immediately on enqueue", () => {
		const { scheduler, resumePlayback } = make();
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		// duration unknown → rtf 0 → graceMs 0; releases immediately on enqueue.
		const verdict = scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 16,
			durationSeconds: null,
		});
		expect(verdict?.rtf).toBe(0);
		expect(verdict?.graceMs).toBe(0);
		scheduler.onEnqueued(scheduler.generation, 0);
		expect(resumePlayback).toHaveBeenCalledTimes(1);
	});

	it("a chunk from a superseded turn does not release the new one", () => {
		const { scheduler, resumePlayback } = make();
		scheduler.noteSentence(0);
		const stale = scheduler.generation;
		scheduler.interrupt();
		scheduler.noteSentence(0);
		scheduler.onFirstChunk(stale, 0.1);
		expect(resumePlayback).not.toHaveBeenCalled();
	});

	it("releases on finishStream when no sentence was noted", () => {
		const { scheduler, resumePlayback } = make();
		scheduler.finishStream();
		expect(resumePlayback).toHaveBeenCalledTimes(1);
	});

	it("#688: slower-than-realtime first sentence starts after a 1 s grace", () => {
		const { scheduler, resumePlayback } = make();
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		const verdict = scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 9.1,
			durationSeconds: 5.7,
		});
		expect(verdict?.rtf).toBeCloseTo(1.596, 2);
		expect(verdict?.graceMs).toBe(1_000);
		scheduler.onEnqueued(scheduler.generation, 0);
		expect(resumePlayback).not.toHaveBeenCalled();
		vi.advanceTimersByTime(999);
		expect(resumePlayback).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(resumePlayback).toHaveBeenCalledTimes(1);
	});

	it("#688: realtime synthesis starts immediately", () => {
		const { scheduler, resumePlayback } = make();
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		const verdict = scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 1,
			durationSeconds: 2,
		});
		expect(verdict?.rtf).toBe(0.5);
		expect(verdict?.graceMs).toBe(0);
		scheduler.onEnqueued(scheduler.generation, 0);
		expect(resumePlayback).toHaveBeenCalledTimes(1);
	});

	it("#688: later sentences never re-hold", () => {
		const { scheduler, pausePlayback, resumePlayback } = make();
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 1,
			durationSeconds: 2,
		});
		scheduler.onEnqueued(scheduler.generation, 0);
		expect(resumePlayback).toHaveBeenCalledTimes(1);

		const secondVerdict = scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 3.4,
			durationSeconds: 2,
		});
		expect(secondVerdict?.rtf).toBe(1.7);
		expect(secondVerdict?.graceMs).toBe(0);
		scheduler.onEnqueued(scheduler.generation, 1);
		expect(pausePlayback).toHaveBeenCalledTimes(1);
		expect(resumePlayback).toHaveBeenCalledTimes(1);
	});

	it("#688: the issue RTF series plays from the first sentence, not after the whole turn", () => {
		const { scheduler, resumePlayback } = make();
		const rtfs = [1.69, 1.73, 1.74, 1.82, 1.76];
		const durations = [2.06, 2.38, 2.7, 5.58, 2.7];
		for (let i = 0; i < rtfs.length; i++) scheduler.noteSentence(i);

		const durationSeconds = durations[0];
		const elapsedSeconds = rtfs[0] * durationSeconds;
		scheduler.onFirstChunk(scheduler.generation, elapsedSeconds);
		scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds,
			durationSeconds,
		});
		scheduler.onEnqueued(scheduler.generation, 0);

		expect(resumePlayback).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1000);
		expect(resumePlayback).toHaveBeenCalledTimes(1);

		// Later sentences arrive; queue continues without extra hold or finishStream
		for (let i = 1; i < rtfs.length; i++) {
			const dur = durations[i];
			const el = rtfs[i] * dur;
			scheduler.onFirstChunk(scheduler.generation, el);
			scheduler.onSentenceResult(scheduler.generation, {
				elapsedSeconds: el,
				durationSeconds: dur,
			});
			scheduler.onEnqueued(scheduler.generation, i);
		}
		expect(resumePlayback).toHaveBeenCalledTimes(1);
	});

	it("#688: streaming slow first chunk arms the grace; fast first chunk releases now", () => {
		// Slow first chunk
		const slow = make();
		slow.scheduler.noteSentence(0);
		slow.scheduler.onFirstChunk(slow.scheduler.generation, 3.5);
		expect(slow.resumePlayback).not.toHaveBeenCalled();
		vi.advanceTimersByTime(999);
		expect(slow.resumePlayback).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(slow.resumePlayback).toHaveBeenCalledTimes(1);

		// Fast first chunk
		const fast = make();
		fast.scheduler.noteSentence(0);
		fast.scheduler.onFirstChunk(fast.scheduler.generation, 0.5);
		expect(fast.resumePlayback).toHaveBeenCalledTimes(1);
	});

	it("#688: a failure during the grace releases immediately and the grace timer does not resume twice", () => {
		const { scheduler, resumePlayback } = make();
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 9.1,
			durationSeconds: 5.7,
		});
		scheduler.onEnqueued(scheduler.generation, 0);
		expect(resumePlayback).not.toHaveBeenCalled();

		vi.advanceTimersByTime(500);
		scheduler.releaseOnFailure(scheduler.generation);
		expect(resumePlayback).toHaveBeenCalledTimes(1);

		// Advancing past the original 1 s grace timer must not call resumePlayback again
		vi.advanceTimersByTime(1000);
		expect(resumePlayback).toHaveBeenCalledTimes(1);
	});

	it("#688: interrupt during the grace cancels it", () => {
		const { scheduler, resumePlayback } = make();
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		scheduler.onSentenceResult(scheduler.generation, {
			elapsedSeconds: 9.1,
			durationSeconds: 5.7,
		});
		scheduler.onEnqueued(scheduler.generation, 0);
		expect(resumePlayback).not.toHaveBeenCalled();

		vi.advanceTimersByTime(500);
		scheduler.interrupt();
		scheduler.noteSentence(0);

		vi.advanceTimersByTime(1000);
		expect(resumePlayback).not.toHaveBeenCalled();
	});

	it("#688: finishStream alone does not release a turn whose sentences are still synthesizing", () => {
		const { scheduler, resumePlayback } = make();
		scheduler.noteSentence(0);
		scheduler.noteSentence(1);
		scheduler.finishStream();
		expect(resumePlayback).not.toHaveBeenCalled();
	});
});
