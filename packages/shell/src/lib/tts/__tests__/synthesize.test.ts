import { afterEach, describe, expect, it, vi } from "vitest";
import {
	arrayBufferToBase64,
	deriveLanguageCode,
	streamsAvatarPcm,
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

describe("synthesizeTts — naia-local-voice (cascade /tts facade contract)", () => {
	// The public facade returns audio/wav (RIFF) bytes directly.
	const WAV_BYTES = new Uint8Array([
		0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
	]); // "RIFF....WAVE" 헤더 선두
	const wavResponse = () => ({
		ok: true,
		status: 200,
		arrayBuffer: async () => WAV_BYTES.buffer.slice(0),
		json: async () => ({}),
		text: async () => "",
	});

	it("uses the standard facade endpoint and required OpenAI-compatible fields", async () => {
		const fetchMock = vi.fn().mockResolvedValue(wavResponse());
		vi.stubGlobal("fetch", fetchMock);
		await synthesizeTts({
			text: "hello",
			voice: "cc0-ko-female-01.wav",
			provider: "naia-local-voice",
			vllmTtsHost: "http://localhost:8910",
		});
		expect(fetchMock.mock.calls[0][0]).toBe(
			"http://localhost:8910/v1/audio/speech",
		);
		expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
			model: "voxcpm2",
			input: "hello",
			voice: "cc0-ko-female-01.wav",
			response_format: "wav",
		});
	});

	it("POSTs to {host}/tts with the facade payload and passes the WAV through", async () => {
		const fetchMock = vi.fn().mockResolvedValue(wavResponse());
		vi.stubGlobal("fetch", fetchMock);
		const res = await synthesizeTts({
			text: "안녕",
			provider: "naia-local-voice",
			vllmTtsHost: "http://localhost:8910/",
		});
		expect(fetchMock.mock.calls[0][0]).toBe(
			"http://localhost:8910/v1/audio/speech",
		);
		const init = fetchMock.mock.calls[0][1];
		const body = JSON.parse(init.body as string);
		expect(init.headers).toEqual({ "Content-Type": "application/json" });
		expect(body).toMatchObject({
			text: "안녕",
			voice: "cc0-ko-female-01.wav",
		});
		// WAV bytes 무변환 패스스루 (AudioQueue/ttsAudioToWav 가 RIFF 네이티브 감지)
		const out = Uint8Array.from(atob(res.audioBase64), (c) => c.charCodeAt(0));
		expect(String.fromCharCode(...out.subarray(0, 4))).toBe("RIFF");
		expect(String.fromCharCode(...out.subarray(8, 12))).toBe("WAVE");
		expect(out.length).toBe(WAV_BYTES.length);
	});

	it("voice 미지정 시 naia-default (무지문 랜덤 음색 금지 — 서버가 ref 로 해석)", async () => {
		const fetchMock = vi.fn().mockResolvedValue(wavResponse());
		vi.stubGlobal("fetch", fetchMock);
		await synthesizeTts({
			text: "x",
			provider: "naia-local-voice",
			vllmTtsHost: "http://localhost:8910",
		});
		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
		expect(body).toMatchObject({
			text: "x",
			voice: "cc0-ko-female-01.wav",
		});
	});

	it("UI placeholder voice='default' 도 naia-default 로 정규화 (2026-07-15 실측: 서버는 모르는 id 를 400 없이 받아 문장마다 랜덤 음색 생성)", async () => {
		const fetchMock = vi.fn().mockResolvedValue(wavResponse());
		vi.stubGlobal("fetch", fetchMock);
		await synthesizeTts({
			text: "x",
			provider: "naia-local-voice",
			voice: "default", // SettingsTab 이 naia-local-voice 에 넣는 placeholder
			vllmTtsHost: "http://localhost:8910",
		});
		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
		expect(body).toMatchObject({
			text: "x",
			voice: "cc0-ko-female-01.wav",
		});
	});

	it("실제 음색 id 는 그대로 전달 (정규화는 placeholder/빈값만)", async () => {
		const fetchMock = vi.fn().mockResolvedValue(wavResponse());
		vi.stubGlobal("fetch", fetchMock);
		await synthesizeTts({
			text: "x",
			provider: "naia-local-voice",
			voice: "my-cloned-voice",
			vllmTtsHost: "http://localhost:8910",
		});
		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
		expect(body).toMatchObject({
			text: "x",
			voice: "my-cloned-voice",
		});
	});

	it("uses vllmTtsHost, never the LLM vllmHost", async () => {
		const fetchMock = vi.fn().mockResolvedValue(wavResponse());
		vi.stubGlobal("fetch", fetchMock);
		await synthesizeTts({
			text: "x",
			provider: "naia-local-voice",
			vllmHost: "http://localhost:8000", // LLM — 무시
			vllmTtsHost: "http://localhost:8910",
		});
		expect(fetchMock.mock.calls[0][0]).toBe(
			"http://localhost:8910/v1/audio/speech",
		);
	});

	it("defaults to :8910 facade when no voice host (never the LLM vllmHost)", async () => {
		const fetchMock = vi.fn().mockResolvedValue(wavResponse());
		vi.stubGlobal("fetch", fetchMock);
		await synthesizeTts({
			text: "x",
			provider: "naia-local-voice",
			vllmHost: "http://localhost:9000", // LLM — 폴백 안 함
		});
		expect(fetchMock.mock.calls[0][0]).toBe(
			"http://localhost:8910/v1/audio/speech",
		);
	});

	it("throws on service error (5xx)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(jsonResponse({ error: "OOM" }, false, 500)),
		);
		await expect(
			synthesizeTts({ text: "x", provider: "naia-local-voice" }),
		).rejects.toThrow(/로컬 음성 합성 실패/);
	});
});

describe("streamsAvatarPcm — 아바타 립싱크 PCM 직결 게이트 (FR-VOICE.5)", () => {
	it("nextain(게이트웨이 LINEAR16=WAV) → true", () => {
		expect(streamsAvatarPcm("nextain")).toBe(true);
	});
	it("naia-local-voice(/tts WAV, 음색=서버 해석) → true", () => {
		// 8g avatar-only 파사드는 자체 TTS 가 없어 /stream_text 는 무음 —
		// 셸 합성 WAV 를 /stream 으로 흘리는 것이 유일한 립싱크 경로.
		expect(streamsAvatarPcm("naia-local-voice")).toBe(true);
	});
	it("합성 결과가 오디오 버퍼가 아닌 provider(edge/브라우저) → false (facade 폴백)", () => {
		expect(streamsAvatarPcm("edge")).toBe(false);
		expect(streamsAvatarPcm("browser")).toBe(false);
		expect(streamsAvatarPcm("google")).toBe(false);
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
