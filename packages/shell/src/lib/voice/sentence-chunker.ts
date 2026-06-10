/**
 * Sentence-level text chunker for streaming TTS.
 *
 * Accumulates LLM text chunks and emits complete sentences.
 * Designed for Korean + English mixed text.
 *
 * Reference: AIRI TTS chunker (min 4 / max 12 words, hard punctuation).
 * Simplified for Naia pipeline voice Phase 1.
 */

/** Hard sentence-ending punctuation (triggers flush). */
const HARD_PUNCT = /[.!?。！？~]\s*/;

/** Minimum character count before flushing on punctuation. */
const MIN_CHARS = 10;

/** Maximum character count — force flush even without punctuation. */
const MAX_CHARS = 120;

export class SentenceChunker {
	private buffer = "";

	/** Feed a text chunk. Returns any complete sentences ready for TTS. */
	feed(text: string): string[] {
		this.buffer += text;
		const sentences: string[] = [];
		let searchFrom = 0;

		// biome-ignore lint/correctness/noConstantCondition: intentional loop
		while (true) {
			// Search for punctuation starting from searchFrom position
			const sub = this.buffer.slice(searchFrom);
			// Skip ellipsis (don't split on "...")
			const cleaned = sub.replace(/\.{2,}/g, "\u2026");
			// Skip decimal numbers (don't split on "2.5")
			const safe = cleaned.replace(/(\d)\.(\d)/g, "$1\u2024$2");

			const match = HARD_PUNCT.exec(safe);

			if (match) {
				const end = searchFrom + match.index + match[0].length;
				if (end <= this.buffer.length) {
					const sentence = this.buffer.slice(0, end).trim();

					if (sentence.length >= MIN_CHARS) {
						// Restore ellipsis and decimal dots
						sentences.push(
							sentence.replace(/\u2026/g, "...").replace(/\u2024/g, "."),
						);
						this.buffer = this.buffer.slice(end);
						searchFrom = 0;
						continue;
					}
					// Sentence too short — skip past this punctuation and keep looking
					searchFrom = end;
					continue;
				}
			}

			// Force flush if buffer exceeds max chars (find last space/comma)
			if (this.buffer.length >= MAX_CHARS) {
				const breakIdx = findBreakPoint(this.buffer, MAX_CHARS);
				const sentence = this.buffer.slice(0, breakIdx).trim();
				if (sentence) {
					sentences.push(sentence);
				}
				this.buffer = this.buffer.slice(breakIdx);
				searchFrom = 0;
				continue;
			}

			break;
		}

		return sentences;
	}

	/** Flush remaining buffer (call on stream end). */
	flush(): string | null {
		const text = this.buffer.trim();
		this.buffer = "";
		return text || null;
	}

	/** Reset without emitting. */
	clear(): void {
		this.buffer = "";
	}
}

function findBreakPoint(text: string, maxLen: number): number {
	// Look for last comma or space within maxLen
	for (let i = maxLen - 1; i >= maxLen / 2; i--) {
		if (text[i] === "," || text[i] === " " || text[i] === "，") {
			return i + 1;
		}
	}
	// No good break point — force at maxLen
	return maxLen;
}
