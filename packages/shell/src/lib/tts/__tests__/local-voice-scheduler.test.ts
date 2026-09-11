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
});
