import { describe, expect, it } from "vitest";
import { resolveEdgeVoice } from "../edge-tts";

describe("resolveEdgeVoice", () => {
	it("passes through real edge neural voices", () => {
		expect(resolveEdgeVoice("ko-KR-SunHiNeural", "ko-KR")).toBe(
			"ko-KR-SunHiNeural",
		);
		expect(resolveEdgeVoice("en-US-AvaMultilingualNeural", "ko-KR")).toBe(
			"en-US-AvaMultilingualNeural",
		);
	});

	it("rejects google-style voices (Neural2-A) → language default", () => {
		expect(resolveEdgeVoice("ko-KR-Neural2-A", "ko-KR")).toBe(
			"ko-KR-SunHiNeural",
		);
	});

	it("uses the language default when no voice is given", () => {
		expect(resolveEdgeVoice(undefined, "en-US")).toBe("en-US-AriaNeural");
		expect(resolveEdgeVoice(undefined, "ja-JP")).toBe("ja-JP-NanamiNeural");
	});

	it("falls back to Korean for unknown / empty language", () => {
		expect(resolveEdgeVoice(undefined, "xx-YY")).toBe("ko-KR-SunHiNeural");
		expect(resolveEdgeVoice(undefined, "")).toBe("ko-KR-SunHiNeural");
	});
});
