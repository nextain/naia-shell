import { describe, expect, it } from "vitest";
import {
	filterUserVisibleAssistantText,
	isToolResultDump,
} from "../visible-chat-text";

describe("visible chat text", () => {
	it("hides empty knowledge dumps", () => {
		expect(isToolResultDump("{}")).toBe(true);
		expect(filterUserVisibleAssistantText("  {}  ")).toBe("");
	});

	it("hides BGM play receipts", () => {
		expect(
			isToolResultDump(
				JSON.stringify({
					ok: true,
					action: "play",
					playback: { status: "requested" },
					announceTrack: false,
					instruction: "playback is not confirmed",
				}),
			),
		).toBe(true);
	});

	it("keeps ordinary answers", () => {
		expect(isToolResultDump("음악을 찾고 있습니다.")).toBe(false);
		expect(filterUserVisibleAssistantText("안녕")).toBe("안녕");
	});
});
