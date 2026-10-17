import { describe, expect, it } from "vitest";
import {
	EMPTY_SLIDE_PRESENTER_STATE,
	boundedDeckContext,
	narrationForPage,
	parseSlideSpeakerNotes,
	presentationRangeForNotes,
	reduceSlidePresenter,
} from "../slide-presenter";

describe("slide presenter state", () => {
	it("plays page videos in order, then requests the next page narration", () => {
		let state = reduceSlidePresenter(EMPTY_SLIDE_PRESENTER_STATE, {
			type: "loaded",
			totalPages: 2,
			videoCues: [
				{
					id: "7-1",
					page: 1,
					order: 1,
					fileName: "first.mp4",
					available: true,
				},
				{
					id: "7-2",
					page: 1,
					order: 2,
					fileName: "second.webm",
					available: true,
				},
			],
		});
		state = reduceSlidePresenter(state, { type: "start" });
		const speechGeneration = state.generation;
		state = reduceSlidePresenter(state, {
			type: "speech-requested",
			generation: speechGeneration,
		});
		state = reduceSlidePresenter(state, {
			type: "speech-finished",
			generation: speechGeneration,
		});
		expect(state).toMatchObject({
			page: 1,
			mode: "presenting",
			speech: "idle",
			activeVideoIndex: 0,
		});
		const firstVideoGeneration = state.generation;
		state = reduceSlidePresenter(state, {
			type: "video-ended",
			generation: firstVideoGeneration,
			index: 0,
		});
		expect(state).toMatchObject({
			page: 1,
			activeVideoIndex: 1,
			speech: "idle",
		});
		const secondVideoGeneration = state.generation;
		state = reduceSlidePresenter(state, {
			type: "video-ended",
			generation: secondVideoGeneration,
			index: 1,
		});
		expect(state).toMatchObject({
			page: 2,
			mode: "presenting",
			speech: "requested",
			activeVideoIndex: null,
		});
	});

	it("waits for a last-range-page video before completion or repeat", () => {
		for (const repeat of [false, true]) {
			let state = reduceSlidePresenter(EMPTY_SLIDE_PRESENTER_STATE, {
				type: "loaded",
				totalPages: 2,
				range: { start: 2, end: 2 },
				videoCues: [
					{
						id: "last",
						page: 2,
						order: 1,
						fileName: "last.mp4",
						available: true,
					},
				],
			});
			if (repeat)
				state = reduceSlidePresenter(state, { type: "toggle-repeat" });
			state = reduceSlidePresenter(state, { type: "start" });
			const speechGeneration = state.generation;
			state = reduceSlidePresenter(state, {
				type: "speech-requested",
				generation: speechGeneration,
			});
			state = reduceSlidePresenter(state, {
				type: "speech-finished",
				generation: speechGeneration,
			});
			expect(state.activeVideoIndex).toBe(0);
			state = reduceSlidePresenter(state, {
				type: "video-ended",
				generation: state.generation,
				index: 0,
			});
			expect(state).toMatchObject(
				repeat
					? { mode: "presenting", page: 2, speech: "requested" }
					: { mode: "completed", page: 2, speech: "idle" },
			);
		}
	});

	it("pauses and resumes video without creating a narration request", () => {
		let state = reduceSlidePresenter(EMPTY_SLIDE_PRESENTER_STATE, {
			type: "loaded",
			totalPages: 1,
			videoCues: [
				{
					id: "clip",
					page: 1,
					order: 1,
					fileName: "clip.mp4",
					available: true,
				},
			],
		});
		state = reduceSlidePresenter(state, { type: "start" });
		const speechGeneration = state.generation;
		state = reduceSlidePresenter(state, {
			type: "speech-requested",
			generation: speechGeneration,
		});
		state = reduceSlidePresenter(state, {
			type: "speech-finished",
			generation: speechGeneration,
		});
		state = reduceSlidePresenter(state, { type: "pause" });
		expect(state).toMatchObject({
			mode: "paused",
			activeVideoIndex: 0,
			speech: "idle",
		});
		state = reduceSlidePresenter(state, { type: "resume" });
		expect(state).toMatchObject({
			mode: "presenting",
			activeVideoIndex: 0,
			speech: "idle",
		});
	});

	it("maps next, previous, goto and question actions around an active video", () => {
		let state = reduceSlidePresenter(EMPTY_SLIDE_PRESENTER_STATE, {
			type: "loaded",
			totalPages: 3,
			videoCues: [
				{
					id: "first",
					page: 1,
					order: 1,
					fileName: "one.mp4",
					available: true,
				},
				{
					id: "second",
					page: 1,
					order: 2,
					fileName: "two.mp4",
					available: true,
				},
			],
		});
		state = reduceSlidePresenter(state, { type: "start" });
		const generation = state.generation;
		state = reduceSlidePresenter(state, {
			type: "speech-requested",
			generation,
		});
		state = reduceSlidePresenter(state, {
			type: "speech-finished",
			generation,
		});
		state = reduceSlidePresenter(state, { type: "next" });
		expect(state).toMatchObject({
			page: 1,
			activeVideoIndex: 1,
			speech: "idle",
		});
		state = reduceSlidePresenter(state, { type: "previous" });
		expect(state).toMatchObject({
			page: 1,
			activeVideoIndex: null,
			speech: "requested",
		});
		const secondSpeechGeneration = state.generation;
		state = reduceSlidePresenter(state, {
			type: "speech-requested",
			generation: secondSpeechGeneration,
		});
		state = reduceSlidePresenter(state, {
			type: "speech-finished",
			generation: secondSpeechGeneration,
		});
		state = reduceSlidePresenter(state, { type: "question" });
		expect(state).toMatchObject({ mode: "answering", activeVideoIndex: 0 });
		state = reduceSlidePresenter(state, { type: "resume" });
		expect(state).toMatchObject({
			mode: "presenting",
			activeVideoIndex: 0,
			speech: "idle",
		});
		state = reduceSlidePresenter(state, { type: "goto", page: 3 });
		expect(state).toMatchObject({
			page: 3,
			activeVideoIndex: null,
			speech: "requested",
		});
	});

	it("ignores stale video ended and error results and skips a failed clip", () => {
		let state = reduceSlidePresenter(EMPTY_SLIDE_PRESENTER_STATE, {
			type: "loaded",
			totalPages: 2,
			videoCues: [
				{ id: "bad", page: 1, order: 1, fileName: "bad.mp4", available: true },
				{
					id: "good",
					page: 1,
					order: 2,
					fileName: "good.mp4",
					available: true,
				},
			],
		});
		state = reduceSlidePresenter(state, { type: "start" });
		const speechGeneration = state.generation;
		state = reduceSlidePresenter(state, {
			type: "speech-requested",
			generation: speechGeneration,
		});
		state = reduceSlidePresenter(state, {
			type: "speech-finished",
			generation: speechGeneration,
		});
		const staleGeneration = state.generation;
		state = reduceSlidePresenter(state, {
			type: "video-failed",
			generation: staleGeneration,
			index: 0,
			error: "play_rejected",
		});
		expect(state.activeVideoIndex).toBe(1);
		expect(
			reduceSlidePresenter(state, {
				type: "video-ended",
				generation: staleGeneration,
				index: 0,
			}),
		).toBe(state);
		const currentGeneration = state.generation;
		state = reduceSlidePresenter(state, {
			type: "video-failed",
			generation: currentGeneration,
			index: 1,
			error: "decode_failed",
		});
		expect(state).toMatchObject({
			page: 2,
			speech: "requested",
			activeVideoIndex: null,
		});
	});

	it("completes or repeats only the configured range, not Appendix pages", () => {
		for (const repeat of [false, true]) {
			let state = reduceSlidePresenter(EMPTY_SLIDE_PRESENTER_STATE, {
				type: "loaded",
				totalPages: 5,
				range: { start: 2, end: 3 },
			});
			if (repeat)
				state = reduceSlidePresenter(state, { type: "toggle-repeat" });
			state = reduceSlidePresenter(state, { type: "start" });
			expect(state.page).toBe(2);
			for (const page of [2, 3]) {
				expect(state.page).toBe(page);
				const generation = state.generation;
				state = reduceSlidePresenter(state, {
					type: "speech-requested",
					generation,
				});
				state = reduceSlidePresenter(state, {
					type: "speech-finished",
					generation,
				});
			}
			expect(state).toMatchObject(
				repeat
					? { page: 2, mode: "presenting" }
					: { page: 3, mode: "completed" },
			);
		}
	});

	it("pauses for range edits and manual Appendix navigation, invalidating late audio", () => {
		let state = reduceSlidePresenter(EMPTY_SLIDE_PRESENTER_STATE, {
			type: "loaded",
			totalPages: 5,
		});
		state = reduceSlidePresenter(state, { type: "start" });
		const generation = state.generation;
		state = reduceSlidePresenter(state, {
			type: "speech-requested",
			generation,
		});
		state = reduceSlidePresenter(state, {
			type: "set-range",
			start: 2,
			end: 3,
		});
		expect(state).toMatchObject({
			page: 2,
			mode: "paused",
			rangeStart: 2,
			rangeEnd: 3,
		});
		expect(
			reduceSlidePresenter(state, { type: "speech-finished", generation }),
		).toBe(state);
		state = reduceSlidePresenter(state, { type: "resume" });
		state = reduceSlidePresenter(state, { type: "goto", page: 5 });
		expect(state).toMatchObject({ page: 5, mode: "paused", speech: "idle" });
		state = reduceSlidePresenter(state, { type: "resume" });
		expect(state).toMatchObject({
			page: 2,
			mode: "presenting",
			speech: "requested",
		});
	});

	it("bounds range input, rejects non-finite values, and resets for a new deck", () => {
		let state = reduceSlidePresenter(EMPTY_SLIDE_PRESENTER_STATE, {
			type: "loaded",
			totalPages: 5,
		});
		state = reduceSlidePresenter(state, {
			type: "set-range",
			start: -5,
			end: 99,
		});
		expect(state).toMatchObject({ rangeStart: 1, rangeEnd: 5 });
		expect(
			reduceSlidePresenter(state, {
				type: "set-range",
				start: Number.NaN,
				end: 4,
			}),
		).toBe(state);
		state = reduceSlidePresenter(state, {
			type: "set-range",
			start: 4,
			end: 2,
		});
		expect(state).toMatchObject({ rangeStart: 4, rangeEnd: 4 });
		state = reduceSlidePresenter(state, { type: "load" });
		state = reduceSlidePresenter(state, { type: "loaded", totalPages: 2 });
		expect(state).toMatchObject({ rangeStart: 1, rangeEnd: 2, repeat: false });
	});
	it.each([1, 3])(
		"repeats a %i-page deck with fresh generations",
		(totalPages) => {
			let state = reduceSlidePresenter(EMPTY_SLIDE_PRESENTER_STATE, {
				type: "loaded",
				totalPages,
			});
			expect(state.repeat).toBe(false);
			state = reduceSlidePresenter(state, { type: "toggle-repeat" });
			state = reduceSlidePresenter(state, { type: "start" });
			for (let step = 0; step < totalPages * 3; step++) {
				expect(state.page).toBe((step % totalPages) + 1);
				const generation = state.generation;
				state = reduceSlidePresenter(state, {
					type: "speech-requested",
					generation,
				});
				state = reduceSlidePresenter(state, {
					type: "speech-finished",
					generation,
				});
				expect(state).toMatchObject({
					mode: "presenting",
					speech: "requested",
					repeat: true,
				});
				expect(state.generation).toBeGreaterThan(generation);
				expect(
					reduceSlidePresenter(state, { type: "speech-finished", generation }),
				).toBe(state);
			}
			expect(state.page).toBe(1);
		},
	);

	it("turns repeat off without interrupting current narration", () => {
		let state = reduceSlidePresenter(EMPTY_SLIDE_PRESENTER_STATE, {
			type: "loaded",
			totalPages: 1,
		});
		state = reduceSlidePresenter(state, { type: "toggle-repeat" });
		state = reduceSlidePresenter(state, { type: "start" });
		const generation = state.generation;
		state = reduceSlidePresenter(state, {
			type: "speech-requested",
			generation,
		});
		state = reduceSlidePresenter(state, { type: "toggle-repeat" });
		expect(state).toMatchObject({
			generation,
			speech: "speaking",
			repeat: false,
		});
		state = reduceSlidePresenter(state, {
			type: "speech-finished",
			generation,
		});
		expect(state.mode).toBe("completed");
	});

	it.each([
		"pause",
		"stop",
		"question",
		"speech-cancelled",
		"speech-failed",
	] as const)("never loops after %s", (type) => {
		let state = reduceSlidePresenter(EMPTY_SLIDE_PRESENTER_STATE, {
			type: "loaded",
			totalPages: 1,
		});
		state = reduceSlidePresenter(state, { type: "toggle-repeat" });
		state = reduceSlidePresenter(state, { type: "start" });
		const generation = state.generation;
		state = reduceSlidePresenter(state, {
			type: "speech-requested",
			generation,
		});
		state = reduceSlidePresenter(
			state,
			type === "speech-failed"
				? { type, generation, error: "failed" }
				: { type, generation },
		);
		expect(
			reduceSlidePresenter(state, { type: "speech-finished", generation }),
		).toBe(state);
		expect(state.mode).not.toBe("presenting");
	});

	it("loads, presents, advances once, and completes at the final slide", () => {
		let state = reduceSlidePresenter(EMPTY_SLIDE_PRESENTER_STATE, {
			type: "load",
		});
		state = reduceSlidePresenter(state, { type: "loaded", totalPages: 2 });
		state = reduceSlidePresenter(state, { type: "start" });
		const firstGeneration = state.generation;
		expect(state).toMatchObject({
			mode: "presenting",
			page: 1,
			speech: "requested",
		});

		state = reduceSlidePresenter(state, {
			type: "speech-requested",
			generation: firstGeneration,
		});
		state = reduceSlidePresenter(state, {
			type: "speech-finished",
			generation: firstGeneration,
		});
		expect(state).toMatchObject({
			mode: "presenting",
			page: 2,
			speech: "requested",
		});

		const secondGeneration = state.generation;
		state = reduceSlidePresenter(state, {
			type: "speech-requested",
			generation: secondGeneration,
		});
		state = reduceSlidePresenter(state, {
			type: "speech-finished",
			generation: secondGeneration,
		});
		expect(state).toMatchObject({ mode: "completed", page: 2, speech: "idle" });
	});

	it("invalidates a late completion after pause or navigation", () => {
		let state = reduceSlidePresenter(EMPTY_SLIDE_PRESENTER_STATE, {
			type: "loaded",
			totalPages: 3,
		});
		state = reduceSlidePresenter(state, { type: "start" });
		const staleGeneration = state.generation;
		state = reduceSlidePresenter(state, {
			type: "speech-requested",
			generation: staleGeneration,
		});
		state = reduceSlidePresenter(state, { type: "pause" });
		state = reduceSlidePresenter(state, {
			type: "speech-finished",
			generation: staleGeneration,
		});
		expect(state).toMatchObject({ mode: "paused", page: 1, speech: "idle" });

		state = reduceSlidePresenter(state, { type: "goto", page: 99 });
		expect(state.page).toBe(3);
	});

	it("pauses a correlated cancelled narration instead of remaining speaking", () => {
		let state = reduceSlidePresenter(EMPTY_SLIDE_PRESENTER_STATE, {
			type: "loaded",
			totalPages: 3,
		});
		state = reduceSlidePresenter(state, { type: "start" });
		const generation = state.generation;
		state = reduceSlidePresenter(state, {
			type: "speech-requested",
			generation,
		});
		state = reduceSlidePresenter(state, {
			type: "speech-cancelled",
			generation,
		});
		expect(state).toMatchObject({ mode: "paused", speech: "idle" });
	});

	it("pauses for a question and resumes from the same page", () => {
		let state = reduceSlidePresenter(EMPTY_SLIDE_PRESENTER_STATE, {
			type: "loaded",
			totalPages: 5,
		});
		state = reduceSlidePresenter(state, { type: "goto", page: 3 });
		state = reduceSlidePresenter(state, { type: "start" });
		state = reduceSlidePresenter(state, { type: "question" });
		expect(state).toMatchObject({
			mode: "answering",
			page: 3,
			resumeAfterAnswer: true,
		});
		state = reduceSlidePresenter(state, { type: "resume" });
		expect(state).toMatchObject({
			mode: "presenting",
			page: 3,
			speech: "requested",
		});
	});
});

describe("slide speaker notes", () => {
	it("derives a range from valid authored pages including leading-zero headings", () => {
		const notes = parseSlideSpeakerNotes(
			"## 01. Cover · 00:00–00:17\nFirst\n## 02. Closing\nLast\n## 99. Outside PDF\nOther",
		);
		expect(presentationRangeForNotes(notes, 4)).toEqual({ start: 1, end: 2 });
		expect(presentationRangeForNotes(new Map(), 4)).toEqual({
			start: 1,
			end: 4,
		});
		expect(
			presentationRangeForNotes(
				new Map([
					[0, "invalid"],
					[2, " "],
					[3, "valid"],
				]),
				4,
			),
		).toEqual({ start: 3, end: 3 });
	});
	it("maps numbered level-two headings to slide notes", () => {
		const notes = parseSlideSpeakerNotes(
			"# Deck\n\n## 1. Cover\n\nHello.\n\n## 2. Market\n\nLine one.\nLine two.\n\n## Questions\n\nNot a slide.",
		);
		expect(notes.get(1)).toBe("Hello.");
		expect(notes.get(2)).toBe("Line one.\nLine two.");
		expect(notes.size).toBe(2);
	});

	it("prefers authored notes and bounds the deck context", () => {
		const notes = new Map([[1, "Authored narration"]]);
		expect(narrationForPage(1, notes, ["PDF text"])).toBe("Authored narration");
		expect(narrationForPage(2, notes, ["PDF text", "Second page"])).toBe(
			"Second page",
		);
		expect(boundedDeckContext(["a".repeat(200)], notes, 80)).toHaveLength(80);
	});

	it("keeps an authored-empty note empty instead of falling back to PDF text", () => {
		const notes = parseSlideSpeakerNotes("## 1.\n\n## 3.\nThird");
		expect(notes.has(1)).toBe(true);
		expect(narrationForPage(1, notes, ["PDF text 1"])).toBe("");
		expect(narrationForPage(2, notes, ["PDF text 1", "PDF text 2"])).toBe(
			"PDF text 2",
		);
		expect(presentationRangeForNotes(notes, 4)).toEqual({ start: 3, end: 3 });
	});
});
