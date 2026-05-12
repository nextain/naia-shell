/**
 * MemoryTagScrubber — stateful scrubber for streaming text that may contain
 * <recalled_memories> blocks injected into the system prompt leaking back
 * into the assistant's output stream across chunk boundaries.
 *
 * Ported pattern: hermes-agent/agent/memory_manager.py StreamingContextScrubber.
 * naia-agent reference impl: @nextain/agent-runtime/memory-scrubber.ts
 *
 * G-NA-01 wire-in for naia-os (naia-os#240 follow-up).
 * Uses <recalled_memories> tag (naia-os system prompt convention).
 */

const OPEN_TAG = "<recalled_memories>";
const CLOSE_TAG = "</recalled_memories>";

export class MemoryTagScrubber {
	private inSpan = false;
	private buf = "";

	reset(): void {
		this.inSpan = false;
		this.buf = "";
	}

	feed(text: string): string {
		if (!text) return "";
		let buf = this.buf + text;
		this.buf = "";
		const out: string[] = [];

		while (buf) {
			if (this.inSpan) {
				const idx = buf.toLowerCase().indexOf(CLOSE_TAG);
				if (idx === -1) {
					const held = maxPartialSuffix(buf, CLOSE_TAG);
					this.buf = held ? buf.slice(-held) : "";
					return out.join("");
				}
				buf = buf.slice(idx + CLOSE_TAG.length);
				this.inSpan = false;
			} else {
				const idx = buf.toLowerCase().indexOf(OPEN_TAG);
				if (idx === -1) {
					const held = maxPartialSuffix(buf, OPEN_TAG);
					if (held) {
						out.push(buf.slice(0, -held));
						this.buf = buf.slice(-held);
					} else {
						out.push(buf);
					}
					return out.join("");
				}
				if (idx > 0) out.push(buf.slice(0, idx));
				buf = buf.slice(idx + OPEN_TAG.length);
				this.inSpan = true;
			}
		}

		return out.join("");
	}

	flush(): string {
		if (this.inSpan) {
			this.buf = "";
			this.inSpan = false;
			return "";
		}
		const tail = this.buf;
		this.buf = "";
		return tail;
	}
}

function maxPartialSuffix(buf: string, tag: string): number {
	const tagLower = tag.toLowerCase();
	const bufLower = buf.toLowerCase();
	const maxCheck = Math.min(bufLower.length, tagLower.length - 1);
	for (let i = maxCheck; i > 0; i--) {
		if (tagLower.startsWith(bufLower.slice(-i))) return i;
	}
	return 0;
}
