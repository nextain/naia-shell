// local-media-url — object URL for a local media Blob.
//   WebKitGTK (Linux) cannot decode a blob: URL webm past about 2 MB (error 3 / stall /
//   "operation not supported"; 3090 2026-11-06: 1.7 MB plays, 2.8 MB+ fails, same clip
//   decodes fine from file). asset:// does not play video at all there. Feeding the same
//   bytes through MediaSource plays to the end and keeps the VP9 alpha.
//   So on Linux a video/webm Blob above MEDIA_SOURCE_MIN_BYTES gets a MediaSource URL;
//   everything else (and Windows/macOS) keeps the plain blob: URL. Small clips stay on
//   blob: because every MediaSource attach leaves WebKit MSE pipeline threads behind
//   (3090 2026-11-10: speech atlas slices, one MediaSource each, grew WebKitWebProcess
//   to ~18k vqueue:src/webkitmediasrc threads in under an hour). Both kinds are released with URL.revokeObjectURL.
//   A MediaSource URL serves one media element at a time and cannot be fetch()ed
//   (isMediaSourceUrl lets a caller that mounts one URL twice skip the second).

import { Logger } from "./logger";

function isLinuxWebView(): boolean {
	return (
		typeof navigator !== "undefined" && navigator.userAgent.includes("Linux")
	);
}

/** blob: URLs decode up to about 2 MB on WebKitGTK (1.7 MB measured); keep a margin. */
export const MEDIA_SOURCE_MIN_BYTES = 1_500_000;

/** True when `blob` should go through MediaSource instead of a blob: URL. */
export function shouldUseMediaSource(blob: Blob): boolean {
	return (
		blob.type === "video/webm" &&
		blob.size > MEDIA_SOURCE_MIN_BYTES &&
		isLinuxWebView() &&
		typeof MediaSource !== "undefined"
	);
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const CODEC_IDS: Array<[number[], string, "video" | "audio"]> = [
	[ascii("V_VP9"), "vp9", "video"],
	[ascii("V_VP8"), "vp8", "video"],
	[ascii("A_OPUS"), "opus", "audio"],
	[ascii("A_VORBIS"), "vorbis", "audio"],
];

function hasBytes(haystack: Uint8Array, needle: number[]): boolean {
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++)
			if (haystack[i + j] !== needle[j]) continue outer;
		return true;
	}
	return false;
}

/** MediaSource type for a webm from its track CodecIDs (header only), or null.
 * An audio-only webm (BGM) gets an audio/webm type. */
export function webmMediaSourceType(bytes: Uint8Array): string | null {
	const head = bytes.subarray(0, 64 * 1024);
	let video: string | null = null;
	let audio: string | null = null;
	for (const [id, codec, kind] of CODEC_IDS) {
		if (!hasBytes(head, id)) continue;
		if (kind === "video") video ??= codec;
		else audio ??= codec;
	}
	if (!video) return audio ? `audio/webm; codecs="${audio}"` : null;
	return `video/webm; codecs="${audio ? `${video},${audio}` : video}"`;
}

const mediaSourceUrls = new Set<string>();

/** True for a URL made by createLocalMediaUrl on the MediaSource path. */
export function isMediaSourceUrl(url: string): boolean {
	return mediaSourceUrls.has(url);
}

function mediaSourceUrl(blob: Blob): string {
	const source = new MediaSource();
	const url = URL.createObjectURL(source);
	mediaSourceUrls.add(url);
	let bytes: Promise<Uint8Array<ArrayBuffer>> | null = null;
	// Not once: a detached MediaSource returns to "closed" and re-opens (with no
	// SourceBuffers) when an element attaches the same URL again, e.g. after a remount.
	source.addEventListener("sourceopen", async () => {
		try {
			bytes ??= blob.arrayBuffer().then((b) => new Uint8Array(b));
			const data = await bytes;
			if (source.readyState !== "open" || source.sourceBuffers.length > 0)
				return;
			const type = webmMediaSourceType(data);
			if (!type || !MediaSource.isTypeSupported(type))
				throw new Error(`unsupported webm for MediaSource: ${type}`);
			const buffer = source.addSourceBuffer(type);
			buffer.addEventListener(
				"updateend",
				() => {
					if (source.readyState === "open") source.endOfStream();
				},
				{ once: true },
			);
			buffer.appendBuffer(data);
		} catch (err) {
			Logger.warn("local-media-url", "MediaSource load failed", {
				error: String(err),
				bytes: blob.size,
			});
			if (source.readyState === "open") source.endOfStream("decode");
		}
	});
	return url;
}

/** URL.createObjectURL, but MediaSource-backed for webm video on Linux. */
export function createLocalMediaUrl(blob: Blob): string {
	return shouldUseMediaSource(blob)
		? mediaSourceUrl(blob)
		: URL.createObjectURL(blob);
}

/** `urlApi` for the canonical speech player (same routing as createLocalMediaUrl). */
export const localMediaUrlApi = {
	createObjectURL: createLocalMediaUrl,
	revokeObjectURL: (url: string) => {
		mediaSourceUrls.delete(url);
		URL.revokeObjectURL(url);
	},
};
