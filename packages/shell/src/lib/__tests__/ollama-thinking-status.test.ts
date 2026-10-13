import { describe, expect, it, vi } from "vitest";
import {
	getOllamaThinkingUnsupportedStatus,
	matchesOllamaThinkingUnsupportedStatus,
	parseOllamaThinkingUnsupportedMessage,
	recordOllamaThinkingUnsupportedStatus,
	subscribeOllamaThinkingUnsupportedStatus,
} from "../ollama-thinking-status";

describe("Ollama thinking unsupported status", () => {
	it("parses only a nonempty host and model from the event message", () => {
		expect(
			parseOllamaThinkingUnsupportedMessage(
				JSON.stringify({ host: "http://localhost:11434", model: "qwen3:8b" }),
			),
		).toEqual({ host: "http://localhost:11434", model: "qwen3:8b" });
		expect(parseOllamaThinkingUnsupportedMessage("not json")).toBeNull();
		expect(parseOllamaThinkingUnsupportedMessage(JSON.stringify({ model: "qwen3:8b" }))).toBeNull();
		expect(
			parseOllamaThinkingUnsupportedMessage(
				JSON.stringify({ host: "http://localhost:11434", model: "" }),
			),
		).toBeNull();
	});

	it("retains the latest status for deferred settings and matches exact host and model", () => {
		const status = { host: "http://localhost:11434", model: "qwen3:8b" };
		const listener = vi.fn();
		const unsubscribe = subscribeOllamaThinkingUnsupportedStatus(listener);
		try {
			recordOllamaThinkingUnsupportedStatus(status);
			expect(getOllamaThinkingUnsupportedStatus()).toEqual(status);
			expect(listener).toHaveBeenCalledTimes(1);
			expect(matchesOllamaThinkingUnsupportedStatus(status, status.host, status.model)).toBe(true);
			expect(matchesOllamaThinkingUnsupportedStatus(status, "http://other-host:11434", status.model)).toBe(false);
			expect(matchesOllamaThinkingUnsupportedStatus(status, status.host, "llama3:8b")).toBe(false);

			recordOllamaThinkingUnsupportedStatus(status);
			expect(listener).toHaveBeenCalledTimes(1);
		} finally {
			unsubscribe();
		}
	});
});
