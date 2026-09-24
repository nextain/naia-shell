import type { SlidePresenterPrefetchRequest } from "./slide-presenter-events";

/**
 * FR-SLIDES-PREFETCH.1 — page-turn silence.
 *
 * A page's narration used to enter TTS only after the previous page's audio
 * had finished, so every page turn waited for the first sentence of the next
 * page to be synthesized (IR recording 2026-09-24: 6.6–8.5 s of silence with
 * a local voice host that answers one WAV per sentence). The Slides app now
 * asks for the next page's opening while the current page is being read; this
 * coordinator decides WHEN that prefetch may start and when it is dropped.
 *
 * Ordering rule: a prefetch waits until the current page's own sentences have
 * entered the pipeline. The local voice scheduler is single-flight and runs
 * jobs in submission order, so the prefetch then queues strictly behind the
 * sentences being read and never delays them, and the voice host still sees
 * one request at a time.
 */

/** Slide narration split (VITE_NAIA_SLIDES_TTS_CHUNK: word | phrase | sentence). */
export function splitSlideNarration(
	text: string,
	mode: string = (import.meta.env?.VITE_NAIA_SLIDES_TTS_CHUNK as
		| string
		| undefined) ?? "sentence",
): string[] {
	const clean = text.replace(/\s+/g, " ").trim();
	if (!clean) return [];
	let parts: string[];
	if (mode === "word") parts = clean.split(" ");
	else if (mode === "phrase") parts = clean.split(/(?<=[,.!?…])\s+/);
	else parts = clean.split(/(?<=[.!?…])\s+/);
	return parts.map((p) => p.trim()).filter(Boolean);
}

/** How many opening pieces of the next page are synthesized ahead. */
export const SLIDE_PREFETCH_PIECES = 2;

export interface SlideNarrationPrefetchDeps {
	prefetchSentence(sentence: string): boolean;
	discardPrefetch(): void;
	split?(text: string): string[];
	maxPieces?: number;
}

export class SlideNarrationPrefetcher {
	private pending: SlidePresenterPrefetchRequest | null = null;
	private started: { generation: number; text: string } | null = null;
	private queuedGeneration: number | null = null;

	constructor(private readonly deps: SlideNarrationPrefetchDeps) {}

	/** A prefetch request (or a discard, `text: null`) from the Slides app. */
	request(detail: SlidePresenterPrefetchRequest | null | undefined): void {
		const text = detail?.text?.trim();
		if (!detail || !text || !Number.isSafeInteger(detail.generation)) {
			this.discard();
			return;
		}
		if (this.started?.generation === detail.generation) {
			if (this.started.text === text) return;
			// Same page, new text (script edited while reading): replace it.
			this.deps.discardPrefetch();
			this.started = null;
		}
		// A prefetch started for an older page is left alone: it is either about
		// to be consumed by that page's narration or dropped once it is queued.
		this.pending = { ...detail, text };
		this.tryStart();
	}

	/** A new page narration is about to enter the pipeline. */
	beforeNarration(): void {
		this.queuedGeneration = null;
	}

	/**
	 * The page narration for `generation` has entered the pipeline. Whatever
	 * prefetched audio it did not consume is stale; the next page may start.
	 */
	narrationQueued(generation: number): void {
		this.deps.discardPrefetch();
		this.started = null;
		this.queuedGeneration = generation;
		if (this.pending && this.pending.generation < generation) {
			this.pending = null;
		}
		this.tryStart();
	}

	/** Pause, stop, previous page, failure or leaving the presentation. */
	discard(): void {
		this.deps.discardPrefetch();
		this.pending = null;
		this.started = null;
	}

	private tryStart(): void {
		const pending = this.pending;
		if (!pending?.text || this.queuedGeneration !== pending.generation) return;
		this.pending = null;
		const split =
			this.deps.split ?? ((text: string) => splitSlideNarration(text));
		const pieces = split(pending.text).slice(
			0,
			this.deps.maxPieces ?? SLIDE_PREFETCH_PIECES,
		);
		for (const piece of pieces) {
			if (!this.deps.prefetchSentence(piece)) break;
		}
		this.started = { generation: pending.generation, text: pending.text };
	}
}
