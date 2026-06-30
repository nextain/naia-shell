import { afterEach, describe, expect, it, vi } from "vitest";
import {
	arrayBufferToBase64,
	deriveLanguageCode,
	synthesizeTts,
} from "../synthesize";

/** Build a minimal fetch Response-like object for a JSON body. */
function jsonResponse(body: unknown, ok = true, status = 200) {
	return {
		ok,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
		arrayBuffer: async () => new ArrayBuffer(0),
	} as unknown as Response;
}

/** Build a fetch Response-like object that returns raw audio bytes. */
function bytesResponse(bytes: Uint8Array, ok = true, status = 200) {
	return {
		ok,
		status,
		json: async () => ({}),
		text: async () => "",
		arrayBuffer: async () =>
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
	} as unknown as Response;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("arrayBufferToBase64", () => {
	it("round-trips bytes through base64", () => {
		const bytes = new Uint8Array([1, 2, 3, 250, 255]);
		const b64 = arrayBufferToBase64(bytes.buffer);
		expect(atob(b64)).toBe(String.fromCharCode(1, 2, 3, 250, 255));
	});

	it("handles buffers larger than the chunk size without stack overflow", () => {
		const big = new Uint8Array(0x8000 * 2 + 7).fill(65);
		const b64 = arrayBufferToBase64(big.buffer);
		expect(atob(b64).length).toBe(big.length);
	});
});

describe("deriveLanguageCode", () => {
	it("extracts the BCP-47 prefix from a voice name", () => {
		expect(deriveLanguageCode("ko-KR-Neural2-A")).toBe("ko-KR");
		expect(deriveLanguageCode("en-US-Wavenet-B")).toBe("en-US");
	});
	it("defaults to ko-KR for undefined / malformed input", () => {
		expect(deriveLanguageCode(undefined)).toBe("ko-KR");
		expect(deriveLanguageCode("alloy")).toBe("ko-KR");
	});
});

describe("synthesizeTts — nextain (gateway)", () => {
	it("POSTs to the gateway with the Bearer key and returns audio + cost", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				jsonResponse({ audio_content: "QUJD", cost_usd: 0.002 }),
			);
		vi.stubGlobal("fetch", fetchMock);

		const res = await synthesizeTts({
			text: "안녕",
			voice: "ko-KR-Chirp3-HD-Kore",
			provider: "nextain",
			naiaKey: "gw-secret",
			gatewayUrl: "https://api.nextain.io",
		});

		expect(res).toEqual({ audioBase64: "QUJD", costUsd: 0.002 });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.nextain.io/v1/audio/speech");
		expect((init.headers as Record<string, string>)["X-AnyLLM-Key"]).toBe(
			"Bearer gw-secret",
		);
		const body = JSON.parse(init.body as string);
		expect(body).toMatchObject({
			input: "안녕",
			voice: "ko-KR-Chirp3-HD-Kore",
			audio_encoding: "MP3",
		});
	});

	it("strips a trailing slash from the gateway URL", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ audio_content: "QQ==" }));
		vi.stubGlobal("fetch", fetchMock);
		await synthesizeTts({
			text: "x",
			provider: "nextain",
			naiaKey: "k",
			gatewayUrl: "https://api.nextain.io/",
		});
		expect(fetchMock.mock.calls[0][0]).toBe(
			"https://api.nextain.io/v1/audio/speech",
		);
	});

	it("throws without a naiaKey (the #363 silent-cause)", async () => {
		await expect(
			synthesizeTts({
				text: "x",
				provider: "nextain",
				gatewayUrl: "https://api.nextain.io",
			}),
		).rejects.toThrow(/naiaKey/);
	});

	it("throws without a gateway URL", async () => {
		await expect(
			synthesizeTts({ text: "x", provider: "nextain", naiaKey: "k" }),
		).rejects.toThrow(/게이트웨이/);
	});

	it("surfaces a gateway error with its status", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(jsonResponse({ detail: "nope" }, false, 402)),
		);
		await expect(
			synthesizeTts({
				text: "x",
				provider: "nextain",
				naiaKey: "k",
				gatewayUrl: "https://api.nextain.io",
			}),
		).rejects.toThrow(/402/);
	});
});

describe("synthesizeTts — google", () => {
	it("POSTs to the Google REST endpoint with the api key in the query", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ audioContent: "R09PRA==" }));
		vi.stubGlobal("fetch", fetchMock);
		const res = await synthesizeTts({
			text: "hi",
			voice: "ko-KR-Neural2-A",
			provider: "google",
			apiKey: "g-key",
		});
		expect(res.audioBase64).toBe("R09PRA==");
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toContain("texttospeech.googleapis.com");
		expect(url).toContain("key=g-key");
		const body = JSON.parse(init.body as string);
		expect(body.voice).toEqual({
			languageCode: "ko-KR",
			name: "ko-KR-Neural2-A",
		});
	});

	it("throws without an api key", async () => {
		await expect(
			synthesizeTts({ text: "x", provider: "google" }),
		).rejects.toThrow(/Google API/);
	});
});

describe("synthesizeTts — openai", () => {
	it("returns base64 of the raw audio bytes and picks tts-1 for standard voices", async () => {
		const bytes = new Uint8Array([10, 20, 30]);
		const fetchMock = vi.fn().mockResolvedValue(bytesResponse(bytes));
		vi.stubGlobal("fetch", fetchMock);
		const res = await synthesizeTts({
			text: "hi",
			voice: "alloy",
			provider: "openai",
			apiKey: "sk-x",
		});
		expect(atob(res.audioBase64)).toBe(String.fromCharCode(10, 20, 30));
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.openai.com/v1/audio/speech");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer sk-x",
		);
		expect(JSON.parse(init.body as string).model).toBe("tts-1");
	});

	it("uses gpt-4o-mini-tts for the 4o-only voices", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(bytesResponse(new Uint8Array([1])));
		vi.stubGlobal("fetch", fetchMock);
		await synthesizeTts({
			text: "hi",
			voice: "marin",
			provider: "openai",
			apiKey: "sk-x",
		});
		expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).model).toBe(
			"gpt-4o-mini-tts",
		);
	});
});

describe("synthesizeTts — elevenlabs", () => {
	it("POSTs to the voice endpoint with the xi-api-key header", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(bytesResponse(new Uint8Array([7, 8])));
		vi.stubGlobal("fetch", fetchMock);
		const res = await synthesizeTts({
			text: "hi",
			voice: "voiceXYZ",
			provider: "elevenlabs",
			apiKey: "el-key",
		});
		expect(atob(res.audioBase64)).toBe(String.fromCharCode(7, 8));
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toContain("api.elevenlabs.io/v1/text-to-speech/voiceXYZ");
		expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(
			"el-key",
		);
	});
});

describe("synthesizeTts — vllm", () => {
	it("POSTs to the local OpenAI-compatible endpoint", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(bytesResponse(new Uint8Array([9])));
		vi.stubGlobal("fetch", fetchMock);
		await synthesizeTts({
			text: "hi",
			provider: "vllm",
			vllmHost: "http://localhost:8001/",
		});
		expect(fetchMock.mock.calls[0][0]).toBe(
			"http://localhost:8001/v1/audio/speech",
		);
	});

	it("throws without a host", async () => {
		await expect(
			synthesizeTts({ text: "x", provider: "vllm" }),
		).rejects.toThrow(/vLLM/);
	});
});

describe("synthesizeTts — naia-local-voice (VoxCPM2 /tts 어댑터)", () => {
	// f32 PCM 샘플 → base64 (서비스가 audio_b64 로 반환하는 형식).
	const f32 = new Float32Array([0.5, -0.5]);
	const PCM_B64 = btoa(String.fromCharCode(...new Uint8Array(f32.buffer)));
	const ttsResponse = () =>
		jsonResponse({ audio_b64: PCM_B64, sample_rate: 48000 });

	it("POSTs to {host}/tts (NOT /v1/audio/speech) and returns a WAV", async () => {
		const fetchMock = vi.fn().mockResolvedValue(ttsResponse());
		vi.stubGlobal("fetch", fetchMock);
		const res = await synthesizeTts({
			text: "안녕",
			provider: "naia-local-voice",
			vllmTtsHost: "http://localhost:22600/",
		});
		expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:22600/tts");
		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
		expect(body.text).toBe("안녕");
		// f32 PCM → 16-bit WAV 변환을 헤더 필드 + 샘플 왕복값까지 검증.
		const wav = Uint8Array.from(atob(res.audioBase64), (c) => c.charCodeAt(0));
		const view = new DataView(wav.buffer);
		expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
		expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
		expect(view.getUint16(22, true)).toBe(1); // mono
		expect(view.getUint32(24, true)).toBe(48000); // sample rate
		expect(view.getUint32(28, true)).toBe(96000); // byte rate = sr*2
		expect(view.getUint16(34, true)).toBe(16); // bits/sample
		expect(view.getUint32(40, true)).toBe(4); // data size = 2 samples * 2 bytes
		// 0.5 → 16383, -0.5 → -16384 (비대칭 풀스케일 매핑)
		expect(view.getInt16(44, true)).toBe(16383);
		expect(view.getInt16(46, true)).toBe(-16384);
	});

	it("defaults sample_rate to 48000 when the service omits it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(jsonResponse({ audio_b64: PCM_B64 })),
		);
		const res = await synthesizeTts({
			text: "x",
			provider: "naia-local-voice",
			vllmTtsHost: "http://localhost:22600",
		});
		const wav = Uint8Array.from(atob(res.audioBase64), (c) => c.charCodeAt(0));
		expect(new DataView(wav.buffer).getUint32(24, true)).toBe(48000);
	});

	it("uses vllmTtsHost, never the LLM vllmHost", async () => {
		const fetchMock = vi.fn().mockResolvedValue(ttsResponse());
		vi.stubGlobal("fetch", fetchMock);
		await synthesizeTts({
			text: "x",
			provider: "naia-local-voice",
			vllmHost: "http://localhost:8000", // LLM — 무시
			vllmTtsHost: "http://localhost:22600",
		});
		expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:22600/tts");
	});

	it("defaults to :22600 when no voice host (and never the LLM vllmHost)", async () => {
		const fetchMock = vi.fn().mockResolvedValue(ttsResponse());
		vi.stubGlobal("fetch", fetchMock);
		await synthesizeTts({
			text: "x",
			provider: "naia-local-voice",
			vllmHost: "http://localhost:9000", // LLM — 폴백 안 함
		});
		expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:22600/tts");
	});

	it("throws on service error (5xx / no audio_b64)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(jsonResponse({ error: "OOM" }, false, 500)),
		);
		await expect(
			synthesizeTts({ text: "x", provider: "naia-local-voice" }),
		).rejects.toThrow(/로컬 음성 합성 실패/);
	});
});

describe("synthesizeTts — edge (bgm sidecar)", () => {
	it("fetches the sidecar /edge-tts with a resolved edge voice", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(bytesResponse(new Uint8Array([1, 2, 3])));
		vi.stubGlobal("fetch", fetchMock);
		const res = await synthesizeTts({
			text: "안녕",
			voice: "ko-KR-Neural2-A", // a Google voice → resolved to an edge voice
			provider: "edge",
		});
		expect(atob(res.audioBase64)).toBe(String.fromCharCode(1, 2, 3));
		const url = String(fetchMock.mock.calls[0][0]);
		expect(url).toContain("http://localhost:18791/edge-tts");
		expect(url).toContain("voice=ko-KR-SunHiNeural"); // Neural2-A → edge default
	});

	it("surfaces a sidecar error (e.g. not running)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 503,
				text: async () => "",
			} as unknown as Response),
		);
		await expect(
			synthesizeTts({ text: "x", provider: "edge" }),
		).rejects.toThrow(/사이드카/);
	});
});

describe("synthesizeTts — unsupported", () => {
	it("rejects an unknown provider", async () => {
		await expect(
			// @ts-expect-error — intentional invalid provider
			synthesizeTts({ text: "x", provider: "bogus" }),
		).rejects.toThrow(/지원하지 않는/);
	});
});
