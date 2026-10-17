import { parseSlideScript } from "./slide-script";

export type SlidePresenterMode =
	| "empty"
	| "loading"
	| "ready"
	| "presenting"
	| "paused"
	| "answering"
	| "completed"
	| "error";

export interface SlideVideoCue {
	id: string;
	page: number;
	order: number;
	fileName: string;
	available: boolean;
}

export interface SlidePresenterState {
	mode: SlidePresenterMode;
	page: number;
	totalPages: number;
	rangeStart: number;
	rangeEnd: number;
	generation: number;
	speech: "idle" | "requested" | "speaking";
	resumeAfterAnswer: boolean;
	repeat: boolean;
	videoCues: SlideVideoCue[];
	activeVideoIndex: number | null;
	videoAttempt: number;
	error?: string;
}

export type SlidePresenterAction =
	| { type: "load" }
	| {
			type: "loaded";
			totalPages: number;
			range?: { start: number; end: number };
			videoCues?: SlideVideoCue[];
	  }
	| { type: "set-video-cues"; videoCues: SlideVideoCue[] }
	| { type: "set-range"; start: number; end: number }
	| { type: "fail"; error: string }
	| { type: "start" }
	| { type: "pause" }
	| { type: "resume" }
	| { type: "stop" }
	| { type: "toggle-repeat" }
	| { type: "next" }
	| { type: "previous" }
	| { type: "goto"; page: number }
	| { type: "question" }
	| { type: "speech-requested"; generation: number }
	| { type: "speech-finished"; generation: number }
	| { type: "speech-cancelled"; generation: number }
	| { type: "video-ended"; generation: number; index: number }
	| { type: "video-failed"; generation: number; index: number; error: string }
	| { type: "speech-failed"; generation: number; error: string };

export const EMPTY_SLIDE_PRESENTER_STATE: SlidePresenterState = {
	mode: "empty",
	page: 1,
	totalPages: 0,
	rangeStart: 1,
	rangeEnd: 0,
	generation: 0,
	speech: "idle",
	resumeAfterAnswer: false,
	repeat: false,
	videoCues: [],
	activeVideoIndex: null,
	videoAttempt: 0,
};

function boundedPage(page: number, totalPages: number): number {
	if (totalPages <= 0) return 1;
	if (!Number.isFinite(page)) return 1;
	return Math.min(totalPages, Math.max(1, Math.trunc(page)));
}

function boundedRange(start: number, end: number, totalPages: number) {
	const rangeStart = boundedPage(start, totalPages);
	return {
		rangeStart,
		rangeEnd: Math.max(rangeStart, boundedPage(end, totalPages)),
	};
}

export function presentationRangeForNotes(
	notes: ReadonlyMap<number, string>,
	totalPages: number,
) {
	const pages = [...notes]
		.filter(
			([page, note]) =>
				Number.isInteger(page) &&
				page >= 1 &&
				page <= totalPages &&
				note.trim(),
		)
		.map(([page]) => page);
	return pages.length
		? { start: Math.min(...pages), end: Math.max(...pages) }
		: { start: 1, end: totalPages };
}

function isInPresentationRange(state: SlidePresenterState, page: number) {
	return page >= state.rangeStart && page <= state.rangeEnd;
}

function navigate(
	state: SlidePresenterState,
	requested: number,
): SlidePresenterState {
	if (state.totalPages === 0) return state;
	const page = boundedPage(requested, state.totalPages);
	const presenting = state.mode === "presenting";
	const inRange = isInPresentationRange(state, page);
	return {
		...invalidateSpeech(state, {
			page,
			activeVideoIndex: null,
			mode: presenting && !inRange ? "paused" : state.mode,
		}),
		speech: presenting && inRange ? "requested" : "idle",
	};
}

function invalidateSpeech(
	state: SlidePresenterState,
	overrides: Partial<SlidePresenterState>,
): SlidePresenterState {
	return {
		...state,
		...overrides,
		generation: state.generation + 1,
		speech: "idle",
	};
}

function nextAvailableVideoIndex(
	state: SlidePresenterState,
	page: number,
	afterIndex = -1,
): number | null {
	for (let index = afterIndex + 1; index < state.videoCues.length; index++) {
		const cue = state.videoCues[index];
		if (cue.page === page && cue.available) return index;
	}
	return null;
}

function beginVideo(
	state: SlidePresenterState,
	index: number,
	mode: SlidePresenterMode = "presenting",
): SlidePresenterState {
	const cue = state.videoCues[index];
	return invalidateSpeech(state, {
		page: cue.page,
		mode,
		activeVideoIndex: index,
		videoAttempt: state.videoAttempt + 1,
		error: undefined,
	});
}

function finishPage(state: SlidePresenterState): SlidePresenterState {
	if (state.page >= state.rangeEnd) {
		if (state.repeat) {
			return {
				...invalidateSpeech(state, {
					page: state.rangeStart,
					activeVideoIndex: null,
				}),
				speech: "requested",
			};
		}
		return invalidateSpeech(state, {
			mode: "completed",
			activeVideoIndex: null,
		});
	}
	return {
		...invalidateSpeech(state, {
			page: state.page + 1,
			mode: "presenting",
			activeVideoIndex: null,
			error: undefined,
		}),
		speech: "requested",
	};
}

function advanceAfterVideo(
	state: SlidePresenterState,
	index: number,
): SlidePresenterState {
	const cue = state.videoCues[index];
	const next = nextAvailableVideoIndex(state, cue.page, index);
	return next === null ? finishPage(state) : beginVideo(state, next);
}

export function reduceSlidePresenter(
	state: SlidePresenterState,
	action: SlidePresenterAction,
): SlidePresenterState {
	switch (action.type) {
		case "set-range": {
			if (
				!state.totalPages ||
				!Number.isFinite(action.start) ||
				!Number.isFinite(action.end)
			)
				return state;
			const range = boundedRange(action.start, action.end, state.totalPages);
			return invalidateSpeech(state, {
				...range,
				page: Math.min(range.rangeEnd, Math.max(range.rangeStart, state.page)),
				mode: ["presenting", "paused", "answering"].includes(state.mode)
					? "paused"
					: "ready",
				resumeAfterAnswer: false,
				activeVideoIndex: null,
				error: undefined,
			});
		}
		case "toggle-repeat":
			return { ...state, repeat: !state.repeat };
		case "set-video-cues":
			return invalidateSpeech(state, {
				videoCues: action.videoCues,
				activeVideoIndex: null,
				mode: ["presenting", "paused", "answering"].includes(state.mode)
					? "paused"
					: state.mode,
			});
		case "load":
			return {
				...EMPTY_SLIDE_PRESENTER_STATE,
				mode: "loading",
				generation: state.generation + 1,
			};
		case "loaded": {
			const totalPages = Math.max(0, Math.trunc(action.totalPages));
			if (totalPages === 0) {
				return invalidateSpeech(state, {
					mode: "error",
					totalPages: 0,
					page: 1,
					error: "empty_pdf",
				});
			}
			return invalidateSpeech(state, {
				mode: "ready",
				totalPages,
				...boundedRange(
					action.range?.start ?? 1,
					action.range?.end ?? totalPages,
					totalPages,
				),
				page: 1,
				videoCues: action.videoCues ?? [],
				activeVideoIndex: null,
				videoAttempt: 0,
				resumeAfterAnswer: false,
				error: undefined,
			});
		}
		case "fail":
			return invalidateSpeech(state, {
				mode: "error",
				activeVideoIndex: null,
				error: action.error,
			});
		case "start":
			if (state.totalPages === 0) return state;
			return {
				...invalidateSpeech(state, {
					mode: "presenting",
					page:
						state.mode === "completed" ||
						!isInPresentationRange(state, state.page)
							? state.rangeStart
							: state.page,
					activeVideoIndex: null,
					resumeAfterAnswer: false,
					error: undefined,
				}),
				speech: "requested",
			};
		case "pause":
			if (state.mode !== "presenting") return state;
			return invalidateSpeech(state, { mode: "paused" });
		case "resume":
			if (!["paused", "answering"].includes(state.mode)) return state;
			{
				const resumed = {
					...invalidateSpeech(state, {
						mode: "presenting",
						page: isInPresentationRange(state, state.page)
							? state.page
							: state.rangeStart,
						resumeAfterAnswer: false,
					}),
				};
				return state.activeVideoIndex === null
					? { ...resumed, speech: "requested" }
					: { ...resumed, speech: "idle" };
			}
		case "stop":
			if (state.totalPages === 0) return state;
			return invalidateSpeech(state, {
				mode: "ready",
				activeVideoIndex: null,
				resumeAfterAnswer: false,
			});
		case "next":
			if (state.activeVideoIndex !== null) {
				const next = nextAvailableVideoIndex(
					state,
					state.page,
					state.activeVideoIndex,
				);
				if (next !== null) return beginVideo(state, next, state.mode);
			}
			return navigate(state, state.page + 1);
		case "previous":
			return navigate(
				state,
				state.activeVideoIndex === null ? state.page - 1 : state.page,
			);
		case "goto":
			return navigate(state, action.page);
		case "question":
			if (state.totalPages === 0) return state;
			return invalidateSpeech(state, {
				mode: "answering",
				resumeAfterAnswer: state.mode === "presenting",
			});
		case "speech-requested":
			if (
				state.mode !== "presenting" ||
				state.speech !== "requested" ||
				action.generation !== state.generation
			) {
				return state;
			}
			return { ...state, speech: "speaking" };
		case "speech-finished": {
			if (
				state.mode !== "presenting" ||
				state.speech !== "speaking" ||
				action.generation !== state.generation
			) {
				return state;
			}
			const videoIndex = nextAvailableVideoIndex(state, state.page);
			return videoIndex === null
				? finishPage(state)
				: beginVideo(state, videoIndex);
		}
		case "speech-failed":
			if (action.generation !== state.generation) return state;
			return invalidateSpeech(state, {
				mode: "paused",
				error: action.error,
			});
		case "speech-cancelled":
			if (
				state.mode !== "presenting" ||
				state.speech !== "speaking" ||
				action.generation !== state.generation
			) {
				return state;
			}
			return invalidateSpeech(state, { mode: "paused", error: undefined });
		case "video-ended":
			if (
				state.mode !== "presenting" ||
				state.activeVideoIndex !== action.index ||
				action.generation !== state.generation
			)
				return state;
			return advanceAfterVideo(state, action.index);
		case "video-failed":
			if (
				state.mode !== "presenting" ||
				state.activeVideoIndex !== action.index ||
				action.generation !== state.generation
			)
				return state;
			return advanceAfterVideo(state, action.index);
	}
}

export function parseSlideSpeakerNotes(markdown: string): Map<number, string> {
	return parseSlideScript(markdown);
}

export function narrationForPage(
	page: number,
	notes: ReadonlyMap<number, string>,
	pageTexts: readonly string[],
): string {
	if (notes.has(page)) return notes.get(page)?.trim() ?? "";
	return pageTexts[page - 1]?.trim() || `Slide ${page}`;
}

export function boundedDeckContext(
	pageTexts: readonly string[],
	notes: ReadonlyMap<number, string>,
	maxCharacters = 12_000,
): string {
	const sections = pageTexts.map((text, index) => {
		const page = index + 1;
		const note = notes.get(page)?.trim();
		return [
			`[Slide ${page}]`,
			text.trim(),
			note ? `[Speaker note]\n${note}` : "",
		]
			.filter(Boolean)
			.join("\n");
	});
	return sections.join("\n\n").slice(0, Math.max(0, maxCharacters));
}
