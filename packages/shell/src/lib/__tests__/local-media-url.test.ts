import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createLocalMediaUrl,
	isMediaSourceUrl,
	localMediaUrlApi,
	shouldUseMediaSource,
	webmMediaSourceType,
} from "../local-media-url";

const LINUX_WEBKIT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 Version/60.5 Safari/605.1.15";
const LINUX_CHROMIUM =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36";

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

	it("gives an audio type for an audio-only webm", () => {
		expect(webmMediaSourceType(bytes("A_OPUS"))).toBe(
			'audio/webm; codecs="opus"',
		);
	});

	it("returns null without any known track", () => {
		expect(webmMediaSourceType(bytes("V_AV1"))).toBeNull();
	});
});

describe("shouldUseMediaSource", () => {
	afterEach(() => vi.unstubAllGlobals());
	const webm = new Blob([], { type: "video/webm" });

	it("routes webm through MediaSource only on Linux WebKit", () => {
		vi.stubGlobal("MediaSource", class {});
		vi.stubGlobal("navigator", {
			userAgent: LINUX_WEBKIT,
		});
		expect(shouldUseMediaSource(webm)).toBe(true);
		expect(shouldUseMediaSource(new Blob([], { type: "audio/mpeg" }))).toBe(
			false,
		);
		vi.stubGlobal("navigator", { userAgent: LINUX_CHROMIUM });
		expect(shouldUseMediaSource(webm)).toBe(false);
		vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0)" });
		expect(shouldUseMediaSource(webm)).toBe(false);
	});

	it("keeps the blob URL when MediaSource is missing", () => {
		vi.stubGlobal("MediaSource", undefined);
		vi.stubGlobal("navigator", { userAgent: LINUX_WEBKIT });
		expect(shouldUseMediaSource(webm)).toBe(false);
	});
});

describe("isMediaSourceUrl", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("marks MediaSource URLs until they are revoked", () => {
		vi.stubGlobal(
			"MediaSource",
			class {
				addEventListener() {}
			},
		);
		vi.stubGlobal("navigator", { userAgent: LINUX_WEBKIT });
		let next = 0;
		vi.spyOn(URL, "createObjectURL").mockImplementation(
			() => `blob:test/${++next}`,
		);
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		const sourceUrl = createLocalMediaUrl(new Blob([], { type: "video/webm" }));
		const plainUrl = createLocalMediaUrl(new Blob([], { type: "image/webp" }));
		expect(isMediaSourceUrl(sourceUrl)).toBe(true);
		expect(isMediaSourceUrl(plainUrl)).toBe(false);
		localMediaUrlApi.revokeObjectURL(sourceUrl);
		expect(isMediaSourceUrl(sourceUrl)).toBe(false);
	});
});
