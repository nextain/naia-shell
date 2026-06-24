import { describe, expect, it } from "vitest";
import {
	buildConfigMessage,
	buildEdgeWsUrl,
	buildSsml,
	buildSsmlMessage,
	computeSecMsGec,
	escapeXml,
	parseBinaryFrame,
	resolveEdgeVoice,
	secMsGecTicks,
} from "../edge-tts";

describe("secMsGecTicks", () => {
	it("rounds the Windows file-time down to the nearest 5 minutes", () => {
		// epoch 0 → (0 + 11644473600) is divisible by 300 → ×1e7.
		expect(secMsGecTicks(0)).toBe(116444736000000000n);
	});
	it("rounds a mid-bucket timestamp down", () => {
		// 1_700_000_000s + 11644473600 = 13344473600; %300 = 200 → 13344473400 ×1e7.
		expect(secMsGecTicks(1_700_000_000_000)).toBe(133444734000000000n);
	});
});

describe("computeSecMsGec", () => {
	it("returns a 64-char uppercase hex digest", async () => {
		const tok = await computeSecMsGec(1_700_000_000_000);
		expect(tok).toMatch(/^[0-9A-F]{64}$/);
	});
	it("is deterministic within a 5-minute bucket and changes across buckets", async () => {
		const a = await computeSecMsGec(1_700_000_000_000);
		const b = await computeSecMsGec(1_700_000_000_000 + 1000); // same bucket
		const c = await computeSecMsGec(1_700_000_000_000 + 600_000); // +10 min
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});
});

describe("buildEdgeWsUrl", () => {
	it("includes the endpoint, trusted token, GEC token and version", async () => {
		const url = await buildEdgeWsUrl(1_700_000_000_000);
		expect(url.startsWith("wss://speech.platform.bing.com/")).toBe(true);
		expect(url).toContain("TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4");
		expect(url).toContain("Sec-MS-GEC=");
		expect(url).toContain("Sec-MS-GEC-Version=");
	});
});

describe("resolveEdgeVoice", () => {
	it("passes through real edge neural voices", () => {
		expect(resolveEdgeVoice("ko-KR-SunHiNeural", "ko-KR")).toBe(
			"ko-KR-SunHiNeural",
		);
		expect(
			resolveEdgeVoice("en-US-AvaMultilingualNeural", "ko-KR"),
		).toBe("en-US-AvaMultilingualNeural");
	});
	it("rejects google-style voices (Neural2-A) and falls back to the language default", () => {
		expect(resolveEdgeVoice("ko-KR-Neural2-A", "ko-KR")).toBe(
			"ko-KR-SunHiNeural",
		);
	});
	it("uses the language default when no voice is given", () => {
		expect(resolveEdgeVoice(undefined, "en-US")).toBe("en-US-AriaNeural");
		expect(resolveEdgeVoice(undefined, "ja-JP")).toBe("ja-JP-NanamiNeural");
	});
	it("falls back to Korean for unknown languages", () => {
		expect(resolveEdgeVoice(undefined, "xx-YY")).toBe("ko-KR-SunHiNeural");
		expect(resolveEdgeVoice(undefined, "")).toBe("ko-KR-SunHiNeural");
	});
});

describe("escapeXml", () => {
	it("escapes the five XML entities", () => {
		expect(escapeXml(`a&b<c>d"e'f`)).toBe(
			"a&amp;b&lt;c&gt;d&quot;e&apos;f",
		);
	});
});

describe("buildSsml", () => {
	it("embeds the voice, lang and escaped text inside a prosody block", () => {
		const ssml = buildSsml("hi & bye", "ko-KR-SunHiNeural", "ko-KR");
		expect(ssml).toContain("xml:lang='ko-KR'");
		expect(ssml).toContain("name='ko-KR-SunHiNeural'");
		expect(ssml).toContain("hi &amp; bye");
		expect(ssml).toContain("<prosody");
	});
});

describe("buildConfigMessage / buildSsmlMessage", () => {
	it("config message selects the mp3 output format", () => {
		const msg = buildConfigMessage("2026-01-01T00:00:00.000Z");
		expect(msg).toContain("Path:speech.config");
		expect(msg).toContain("audio-24khz-48kbitrate-mono-mp3");
	});
	it("ssml message carries the request id and ssml path", () => {
		const msg = buildSsmlMessage("abc123", "<speak/>", "2026-01-01T00:00:00.000Z");
		expect(msg).toContain("X-RequestId:abc123");
		expect(msg).toContain("Path:ssml");
		expect(msg).toContain("<speak/>");
	});
});

describe("parseBinaryFrame", () => {
	function frame(header: string, payload: number[]): ArrayBuffer {
		const headerBytes = new TextEncoder().encode(header);
		const buf = new ArrayBuffer(2 + headerBytes.length + payload.length);
		const view = new DataView(buf);
		view.setUint16(0, headerBytes.length, false); // big-endian
		new Uint8Array(buf, 2, headerBytes.length).set(headerBytes);
		new Uint8Array(buf, 2 + headerBytes.length).set(payload);
		return buf;
	}

	it("extracts the audio path and trailing payload", () => {
		const buf = frame(
			"X-RequestId:1\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n\r\n",
			[0xff, 0xfb, 0x90],
		);
		const { path, payload } = parseBinaryFrame(buf);
		expect(path).toBe("audio");
		expect(Array.from(payload)).toEqual([0xff, 0xfb, 0x90]);
	});

	it("reports non-audio frame paths", () => {
		const buf = frame("Path:turn.start\r\n\r\n", []);
		expect(parseBinaryFrame(buf).path).toBe("turn.start");
	});
});
