import { describe, expect, it, vi } from "vitest";
import { validateSpeechPlan } from "../../avatar/nva-speech/vendor/speech-plan.js";
import {
	AZURE_SPEECH_PROVIDER_ID,
	AZURE_SPEECH_TTS_PROVIDER_META,
	AzureSpeechTtsAdapter,
	AzureVisemeTimelineDriver,
	type WebSocketLike,
	bytesToBase64,
	createAzureSpeechTtsProvider,
	decodeUspTextFrame,
	encodeUspBinaryFrame,
	encodeUspTextFrame,
	getTtsProviderMeta,
	isAbortError,
	listTtsProviderMetas,
	pcm16ChunksToWavBytes,
	registerAzureSpeechTtsProvider,
	resolveAzureSpeechConfig,
} from "../index";

function makeSinePcm16Bytes(
	sampleCount: number,
	amplitude = 14000,
): Uint8Array {
	const pcm = new Int16Array(sampleCount);
	for (let i = 0; i < sampleCount; i++) {
		pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * amplitude);
	}
	return new Uint8Array(pcm.buffer.slice(0));
}

function makeReadableByteStream(
	chunks: Uint8Array[],
	delayMs = 0,
): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (delayMs > 0) {
				await new Promise((r) => setTimeout(r, delayMs));
			}
			if (index >= chunks.length) {
				controller.close();
				return;
			}
			controller.enqueue(chunks[index++]);
		},
	});
}

class MockUspWebSocket implements WebSocketLike {
	binaryType = "arraybuffer";
	readyState = 0;
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
	readonly sentFrames: Array<string | ArrayBuffer | Uint8Array> = [];
	closed = false;

	constructor(
		readonly url: string,
		private readonly onClientFrame?: (
			ws: MockUspWebSocket,
			data: string | ArrayBuffer | Uint8Array,
		) => void,
		autoOpen = true,
	) {
		if (autoOpen) {
			queueMicrotask(() => {
				if (this.closed) return;
				this.readyState = 1;
				this.onopen?.({});
			});
		}
	}

	send(data: string | ArrayBuffer | Uint8Array): void {
		this.sentFrames.push(data);
		this.onClientFrame?.(this, data);
	}

	close(code = 1000, reason = ""): void {
		if (this.closed) return;
		this.closed = true;
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}

	emitServerMessage(data: unknown): void {
		if (this.closed) return;
		this.onmessage?.({ data });
	}

	emitServerError(): void {
		if (this.closed) return;
		this.onerror?.(new Error("mock ws failure"));
	}
}

describe("azure-speech-tts adapter, fallbacks, abort, and factory", () => {
	it("streams real-time Viseme 0..21 + odd-boundary PCM16 over WebSocket USP and builds a valid NVA SpeechPlan", async () => {
		const rawPcm = makeSinePcm16Bytes(2400); // 100ms = 4800 bytes
		// Split across an odd byte index (1777) to verify PCM16 carry framing!
		const part1 = rawPcm.subarray(0, 1777);
		const part2 = rawPcm.subarray(1777);

		let capturedUrl = "";
		const streamedSamples: number[] = [];
		const receivedVisemes: number[] = [];
		const driver = new AzureVisemeTimelineDriver();

		const adapter = new AzureSpeechTtsAdapter({
			mode: "websocket",
			region: "koreacentral",
			authToken: "sts-short-token-xyz",
			createWebSocket: (url) => {
				capturedUrl = url;
				return new MockUspWebSocket(url, (ws, raw) => {
					if (typeof raw !== "string") return;
					const decoded = decodeUspTextFrame(raw);
					if (decoded.path === "ssml") {
						const reqId = decoded.requestId;
						queueMicrotask(() => {
							ws.emitServerMessage(
								encodeUspTextFrame({
									path: "audio.metadata",
									requestId: reqId,
									contentType: "application/json; charset=utf-8",
									body: JSON.stringify({
										Metadata: [
											{
												Type: "Viseme",
												Data: { Offset: 0, VisemeId: 2 },
											},
											{
												Type: "Viseme",
												Data: { Offset: 450_000, VisemeId: 21 },
											},
											{
												Type: "Viseme",
												Data: { Offset: 900_000, VisemeId: 0 },
											},
										],
									}),
								}),
							);
							ws.emitServerMessage(
								encodeUspBinaryFrame({
									path: "audio",
									requestId: reqId,
									contentType: "audio/pcm",
									payload: part1,
								}),
							);
							ws.emitServerMessage(
								encodeUspBinaryFrame({
									path: "audio",
									requestId: reqId,
									contentType: "audio/pcm",
									payload: part2,
								}),
							);
							ws.emitServerMessage(
								encodeUspTextFrame({
									path: "turn.end",
									requestId: reqId,
									contentType: "application/json; charset=utf-8",
									body: "{}",
								}),
							);
						});
					}
				});
			},
		});

		const result = await adapter.synthesize({
			text: "안녕하세요, 나이아 웹 음성입니다.",
			voice: "ko-KR-SunHiNeural",
			visemeDriver: driver,
			onPcmChunk: (chunk) => streamedSamples.push(chunk.length),
			onViseme: (cue) => receivedVisemes.push(cue.visemeId),
		});

		expect(capturedUrl).toContain(
			"wss://koreacentral.tts.speech.microsoft.com/cognitiveservices/websocket/v1",
		);
		expect(capturedUrl).toContain("Authorization=Bearer+sts-short-token-xyz");
		expect(result.transportUsed).toBe("websocket");
		expect(result.lipSyncMode).toBe("viseme");
		expect(receivedVisemes).toEqual([2, 21, 0]);
		expect(streamedSamples.reduce((a, b) => a + b, 0)).toBe(2400);
		expect(result.durationMs).toBeCloseTo(100, 3);
		expect(result.audioMimeType).toBe("audio/wav");

		// SpeechPlan passes canonical validator with exact WAV SHA-256
		expect(result.speechPlan).not.toBeNull();
		expect(validateSpeechPlan(result.speechPlan)).toEqual({
			ok: true,
			errors: [],
		});

		// Driver synchronized to Viseme 2 at 10ms and Viseme 21 at 50ms
		expect(driver.sampleAt(10).visemeId).toBe(2);
		expect(driver.sampleAt(50).visemeId).toBe(21);
		expect(driver.sampleAt(50).mouthOpen).toBe(0);
	});

	it("automatically activates PCM16 amplitude lip-sync fallback when DragonHD omits viseme metadata", async () => {
		const rawPcm = makeSinePcm16Bytes(3600, 16000); // 150ms loud speech
		const driver = new AzureVisemeTimelineDriver();

		const adapter = new AzureSpeechTtsAdapter({
			mode: "websocket",
			region: "koreacentral",
			authToken: "sts-hd-token",
			createWebSocket: (url) =>
				new MockUspWebSocket(url, (ws, raw) => {
					if (typeof raw !== "string") return;
					const decoded = decodeUspTextFrame(raw);
					if (decoded.path === "ssml") {
						queueMicrotask(() => {
							ws.emitServerMessage(
								encodeUspBinaryFrame({
									path: "audio",
									requestId: decoded.requestId,
									payload: rawPcm,
								}),
							);
							ws.emitServerMessage(
								encodeUspTextFrame({
									path: "turn.end",
									requestId: decoded.requestId,
									contentType: "application/json",
									body: "{}",
								}),
							);
						});
					}
				}),
		});

		const result = await adapter.synthesize({
			text: "드래곤 HD 음성 테스트",
			voice: "ko-KR-SunHi:DragonHDLatestNeural",
			visemeDriver: driver,
		});

		expect(result.resolvedVoice.isDragonHd).toBe(true);
		expect(result.visemes).toHaveLength(0);
		expect(result.lipSyncMode).toBe("amplitude");
		expect(result.amplitudeCues.length).toBeGreaterThan(3);

		const sampled = driver.sampleAt(60);
		expect(sampled.source).toBe("amplitude");
		expect(sampled.talking).toBe(true);
		expect(sampled.mouthOpen).toBeGreaterThan(0.25);
	});

	it("supports REST mode with STS short-lived token caching and automatic 401 token refresh", async () => {
		const rawPcm = makeSinePcm16Bytes(1200);
		let stsCalls = 0;
		let restCalls = 0;

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/sts/v1.0/issueToken")) {
					stsCalls++;
					return new Response(`issued-token-${stsCalls}`, { status: 200 });
				}
				restCalls++;
				const authHeader =
					(init?.headers as Record<string, string>)?.Authorization ?? "";
				// Simulate expired token on the 2nd synthesis's first attempt
				if (restCalls === 2 && authHeader === "Bearer issued-token-1") {
					return new Response("Token expired", { status: 401 });
				}
				return new Response(
					makeReadableByteStream([
						rawPcm.subarray(0, 701),
						rawPcm.subarray(701),
					]),
					{
						status: 200,
						headers: { "Content-Type": "audio/pcm;rate=24000" },
					},
				);
			},
		);

		const adapter = new AzureSpeechTtsAdapter({
			mode: "rest",
			region: "koreacentral",
			subscriptionKey: "mock-sub-key-only-in-test",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});

		// First call exchanges STS token #1 and streams PCM16
		const r1 = await adapter.synthesize({ text: "첫 번째 문장입니다." });
		expect(stsCalls).toBe(1);
		expect(r1.transportUsed).toBe("rest");
		expect(r1.lipSyncMode).toBe("amplitude");

		// Second call reuses cached token #1 -> gets 401 -> refreshes token #2 -> succeeds!
		const r2 = await adapter.synthesize({ text: "두 번째 문장입니다." });
		expect(stsCalls).toBe(2);
		expect(restCalls).toBe(3);
		expect(r2.durationMs).toBeCloseTo(50, 3);
	});

	it("supports Gateway /v1/audio/speech in PCM16 stream, Nextain JSON, and NDJSON viseme+audio modes", async () => {
		const rawPcm = makeSinePcm16Bytes(1200);
		const wavBytes = pcm16ChunksToWavBytes(
			[new Int16Array(rawPcm.buffer)],
			1200,
			24000,
		);
		const wavBase64 = bytesToBase64(wavBytes);

		let modeSelector: "pcm" | "json" | "ndjson" = "pcm";
		const capturedHeaders: Array<Record<string, string>> = [];

		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				capturedHeaders.push((init?.headers as Record<string, string>) ?? {});
				if (modeSelector === "pcm") {
					return new Response(
						makeReadableByteStream([
							rawPcm.subarray(0, 503),
							rawPcm.subarray(503),
						]),
						{
							status: 200,
							headers: {
								"Content-Type": "audio/pcm;rate=24000",
								"X-Azure-Visemes": JSON.stringify([
									{ offsetMs: 0, visemeId: 1 },
									{ offsetMs: 40, visemeId: 0 },
								]),
								"X-Cost-Usd": "0.00032",
							},
						},
					);
				}
				if (modeSelector === "json") {
					return new Response(
						JSON.stringify({
							audio_content: wavBase64,
							cost_usd: 0.00048,
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				const ndjsonLines = `${[
					JSON.stringify({ type: "viseme", offset_ms: 0, viseme_id: 2 }),
					JSON.stringify({
						type: "audio",
						audio_base64: bytesToBase64(rawPcm),
					}),
					JSON.stringify({ type: "viseme", offset_ms: 45, viseme_id: 0 }),
					JSON.stringify({ type: "done", cost_usd: 0.00025 }),
				].join("\n")}\n`;
				return new Response(
					makeReadableByteStream([new TextEncoder().encode(ndjsonLines)]),
					{
						status: 200,
						headers: { "Content-Type": "application/x-ndjson" },
					},
				);
			},
		);

		const adapter = new AzureSpeechTtsAdapter({
			mode: "gateway",
			gatewayUrl: "https://gateway.naia.nextain.io/",
			naiaKey: "naia-live-key-123",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});

		const pcmRes = await adapter.synthesize({ text: "게이트웨이 스트리밍" });
		expect(capturedHeaders[0]["X-AnyLLM-Key"]).toBe("Bearer naia-live-key-123");
		expect(pcmRes.transportUsed).toBe("gateway");
		expect(pcmRes.lipSyncMode).toBe("viseme");
		expect(pcmRes.costUsd).toBeCloseTo(0.00032, 6);

		modeSelector = "json";
		const jsonRes = await adapter.synthesize({ text: "게이트웨이 JSON 폴백" });
		expect(jsonRes.audioMimeType).toBe("audio/wav");
		expect(jsonRes.lipSyncMode).toBe("amplitude");
		expect(jsonRes.amplitudeCues.length).toBeGreaterThan(1);
		expect(jsonRes.costUsd).toBeCloseTo(0.00048, 6);

		modeSelector = "ndjson";
		const ndjsonRes = await adapter.synthesize({ text: "게이트웨이 NDJSON" });
		expect(ndjsonRes.lipSyncMode).toBe("viseme");
		expect(ndjsonRes.visemes.map((v) => v.visemeId)).toEqual([2, 0]);
		expect(ndjsonRes.costUsd).toBeCloseTo(0.00025, 6);
	});

	it("falls back cleanly across websocket -> rest -> gateway when upstream transports fail", async () => {
		const rawPcm = makeSinePcm16Bytes(1200);
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("tts.speech.microsoft.com/cognitiveservices/v1")) {
				return new Response("Regional throttling", { status: 503 });
			}
			return new Response(makeReadableByteStream([rawPcm]), {
				status: 200,
				headers: { "Content-Type": "audio/pcm;rate=24000" },
			});
		});

		const adapter = new AzureSpeechTtsAdapter({
			mode: "auto",
			region: "koreacentral",
			authToken: "sts-token",
			gatewayUrl: "https://gateway.naia.nextain.io",
			naiaKey: "naia-key",
			fetchImpl: fetchMock as unknown as typeof fetch,
			createWebSocket: (url) => {
				const ws = new MockUspWebSocket(url, undefined, false);
				queueMicrotask(() => ws.emitServerError());
				return ws;
			},
		});

		const result = await adapter.synthesize({ text: "자동 폴백 테스트" });
		expect(result.attemptedTransports).toEqual([
			"websocket",
			"rest",
			"gateway",
		]);
		expect(result.transportUsed).toBe("gateway");
	});

	it("cancels WebSocket, REST stream, and parallel provider utterances immediately on AbortController.abort()", async () => {
		const speakingStates: boolean[] = [];
		const activeSockets: MockUspWebSocket[] = [];

		const session = createAzureSpeechTtsProvider({
			mode: "auto",
			region: "koreacentral",
			authToken: "sts-token",
			gatewayUrl: "https://gateway.naia.nextain.io",
			naiaKey: "naia-key",
			onSpeakingChange: (talking) => speakingStates.push(talking),
			fetchImpl: vi.fn(async () => {
				throw new Error("Should NEVER fall back to REST/Gateway after abort!");
			}) as unknown as typeof fetch,
			createWebSocket: (url) => {
				const ws = new MockUspWebSocket(url, (sock, raw) => {
					if (typeof raw !== "string") return;
					const frame = decodeUspTextFrame(raw);
					if (frame.path === "ssml") {
						// Emit one viseme frame and keep stream open until aborted
						sock.emitServerMessage(
							encodeUspTextFrame({
								path: "audio.metadata",
								requestId: frame.requestId,
								contentType: "application/json",
								body: JSON.stringify({
									Metadata: [
										{ Type: "Viseme", Data: { Offset: 0, VisemeId: 2 } },
									],
								}),
							}),
						);
					}
				});
				activeSockets.push(ws);
				return ws;
			},
		});

		// Launch 3 concurrent utterances and start playback clock on utterance 1
		const u1 = session.speakStream({ text: "문장 1" });
		const u2 = session.speakStream({ text: "문장 2" });
		const u3 = session.speakStream({ text: "문장 3" });

		await new Promise((r) => setTimeout(r, 10));
		u1.queueCallbacks.onPlaybackStart?.({ clock: () => 0.02 });
		expect(u1.visemeDriver.getCurrentFrame().talking).toBe(true);
		expect(speakingStates).toContain(true);

		// Interrupt all 3 simultaneously!
		session.interruptAll();

		const outcomes = await Promise.allSettled([
			u1.result,
			u2.result,
			u3.result,
		]);
		for (const outcome of outcomes) {
			expect(outcome.status).toBe("rejected");
			if (outcome.status === "rejected") {
				expect(isAbortError(outcome.reason)).toBe(true);
			}
		}
		expect(activeSockets.every((ws) => ws.closed)).toBe(true);
		expect(u1.pcmStream.failed).toBe(true);
		expect(u1.visemeDriver.getCurrentFrame().mouthOpen).toBe(0);
		expect(u1.visemeDriver.getCurrentFrame().talking).toBe(false);
		expect(speakingStates[speakingStates.length - 1]).toBe(false);

		// Also verify mid-stream abort on REST ReadableStream
		const abortCtrl = new AbortController();
		const restAdapter = new AzureSpeechTtsAdapter({
			mode: "rest",
			region: "koreacentral",
			authToken: "sts-token",
			fetchImpl: (async () =>
				new Response(
					makeReadableByteStream(
						[
							makeSinePcm16Bytes(400),
							makeSinePcm16Bytes(400),
							makeSinePcm16Bytes(400),
						],
						25,
					),
					{ status: 200, headers: { "Content-Type": "audio/pcm;rate=24000" } },
				)) as unknown as typeof fetch,
		});

		const restPromise = restAdapter.synthesize({
			text: "REST 스트림 중단 테스트",
			signal: abortCtrl.signal,
			onPcmChunk: () => {
				abortCtrl.abort();
			},
		});
		await expect(restPromise).rejects.toSatisfy((err) => isAbortError(err));
	});

	it("resolves env configuration and preserves default TTS registry until opt-in registration", async () => {
		// Default registry order must remain untouched before opt-in call
		expect(
			listTtsProviderMetas()
				.slice(0, 3)
				.map((m) => m.id),
		).toEqual(["edge", "naia-local-voice", "nextain"]);
		expect(getTtsProviderMeta(AZURE_SPEECH_PROVIDER_ID)).toBeUndefined();

		const registered = registerAzureSpeechTtsProvider();
		expect(registered.id).toBe(AZURE_SPEECH_TTS_PROVIDER_META.id);
		expect(getTtsProviderMeta(AZURE_SPEECH_PROVIDER_ID)?.name).toContain(
			"Azure AI Speech",
		);

		const cfg = resolveAzureSpeechConfig(
			{
				fetchImpl: (async () =>
					new Response(JSON.stringify({ token: "from-gateway-sts" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					})) as unknown as typeof fetch,
			},
			{
				VITE_AZURE_SPEECH_REGION: "eastus",
				VITE_AZURE_SPEECH_TOKEN_URL:
					"https://gateway.naia.nextain.io/v1/audio/speech/token",
				VITE_NAIA_GATEWAY_URL: "https://gateway.naia.nextain.io/",
				VITE_NAIA_KEY: "nk-test",
			},
		);

		expect(cfg.region).toBe("eastus");
		expect(cfg.gatewayUrl).toBe("https://gateway.naia.nextain.io");
		expect(await cfg.getAuthToken?.()).toBe("from-gateway-sts");
	});
});
