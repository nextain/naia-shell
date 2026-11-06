import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldUseMediaSource, webmMediaSourceType } from "../local-media-url";

const bytes = (...parts: string[]) =>
	new Uint8Array(
		parts.flatMap((p) => [0, ...Array.from(p, (c) => c.charCodeAt(0))]),
	);

describe("webmMediaSourceType", () => {
	it("reads the video and audio CodecIDs", () => {
		expect(webmMediaSourceType(bytes("V_VP9"))).toBe(
			'video/webm; codecs="vp9"',
		);
		expect(webmMediaSourceType(bytes("V_VP9", "A_OPUS"))).toBe(
			'video/webm; codecs="vp9,opus"',
		);
		expect(webmMediaSourceType(bytes("V_VP8", "A_VORBIS"))).toBe(
			'video/webm; codecs="vp8,vorbis"',
		);
	});

	it("returns null without a video track", () => {
		expect(webmMediaSourceType(bytes("A_OPUS"))).toBeNull();
	});
});

describe("shouldUseMediaSource", () => {
	afterEach(() => vi.unstubAllGlobals());
	const webm = new Blob([], { type: "video/webm" });

	it("routes webm through MediaSource only on Linux", () => {
		vi.stubGlobal("MediaSource", class {});
		vi.stubGlobal("navigator", {
			userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
		});
		expect(shouldUseMediaSource(webm)).toBe(true);
		expect(shouldUseMediaSource(new Blob([], { type: "audio/mpeg" }))).toBe(
			false,
		);
		vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0)" });
		expect(shouldUseMediaSource(webm)).toBe(false);
	});

	it("keeps the blob URL when MediaSource is missing", () => {
		vi.stubGlobal("MediaSource", undefined);
		vi.stubGlobal("navigator", { userAgent: "Linux" });
		expect(shouldUseMediaSource(webm)).toBe(false);
	});
});
