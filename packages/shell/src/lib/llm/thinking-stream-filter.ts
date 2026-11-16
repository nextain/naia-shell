export interface ThinkingStreamOutput {
	visible: string;
	thinking: string;
}

const OPEN_TAG = "<think>";
const BRACKET_OPEN_TAG = "[think]";
const CLOSE_TAG = "</think>";

function partialTagSuffixLength(text: string, tag: string): number {
	const lower = text.toLowerCase();
	const max = Math.min(lower.length, tag.length - 1);
	for (let length = max; length > 0; length -= 1) {
		if (tag.startsWith(lower.slice(-length))) return length;
	}
	return 0;
}

/**
 * Separates textual `<think>...</think>` blocks before visible rendering and
 * sentence-level TTS. A possible partial tag is retained until the next chunk,
 * so no tag boundary can leak reasoning into either downstream consumer.
 */
export class ThinkingStreamFilter {
	private buffer = "";
	private insideThinking = false;
	private bracketCandidate = false;

	push(chunk: string): ThinkingStreamOutput {
		this.buffer += chunk;
		let visible = "";
		let thinking = "";

		while (this.buffer) {
			if (!this.insideThinking) {
				const leadingWhitespace = this.buffer.match(/^\s*/)?.[0] ?? "";
				const candidate = this.buffer.slice(leadingWhitespace.length);
				const candidateLower = candidate.toLowerCase();
				if (
					this.bracketCandidate ||
					(candidate.length > 0 &&
						BRACKET_OPEN_TAG.startsWith(candidateLower)) ||
					candidateLower.startsWith(BRACKET_OPEN_TAG)
				) {
					this.bracketCandidate = true;
					const closeIndex = candidateLower.indexOf(
						CLOSE_TAG,
						BRACKET_OPEN_TAG.length,
					);
					if (closeIndex < 0) break;
					thinking += candidate.slice(BRACKET_OPEN_TAG.length, closeIndex);
					this.buffer = candidate.slice(closeIndex + CLOSE_TAG.length);
					this.bracketCandidate = false;
					continue;
				}
			}

			const tag = this.insideThinking ? CLOSE_TAG : OPEN_TAG;
			const lower = this.buffer.toLowerCase();
			const tagIndex = lower.indexOf(tag);

			if (tagIndex >= 0) {
				const content = this.buffer.slice(0, tagIndex);
				if (this.insideThinking) thinking += content;
				else visible += content;
				this.buffer = this.buffer.slice(tagIndex + tag.length);
				this.insideThinking = !this.insideThinking;
				continue;
			}

			const retainedLength = partialTagSuffixLength(this.buffer, tag);
			const safeLength = this.buffer.length - retainedLength;
			const content = this.buffer.slice(0, safeLength);
			if (this.insideThinking) thinking += content;
			else visible += content;
			this.buffer = this.buffer.slice(safeLength);
			break;
		}

		return { visible, thinking };
	}

	flush(): ThinkingStreamOutput {
		if (this.bracketCandidate) {
			const visible = this.buffer;
			this.reset();
			return { visible, thinking: "" };
		}
		const output = this.insideThinking
			? { visible: "", thinking: this.buffer }
			: { visible: this.buffer, thinking: "" };
		this.reset();
		return output;
	}

	reset(): void {
		this.buffer = "";
		this.insideThinking = false;
		this.bracketCandidate = false;
	}
}
