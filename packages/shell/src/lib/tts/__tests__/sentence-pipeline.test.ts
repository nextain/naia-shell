// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalVoiceScheduler } from "../local-voice-scheduler";
import {
	type SentenceTtsPipelineDeps,
	createSentenceTtsPipeline,
} from "../sentence-pipeline";

vi.mock("../synthesize", () => ({ synthesizeTts: vi.fn() }));
import { synthesizeTts } from "../synthesize";
const synthesizeMock = vi.mocked(synthesizeTts);

function makeDeps(overrides: Partial<SentenceTtsPipelineDeps> = {}) {
	let nextId = 0;
	const queue = {
		nextSeq: 0,
		reserveSeq: vi.fn(() => queue.nextSeq++),
		enqueueOrdered: vi.fn(),
		skipOrdered: vi.fn(),
	};
	const reveal = vi.fn();
	const deps: SentenceTtsPipelineDeps = {
		generateRequestId: () => `req-${nextId++}`,
		reserveReveal: vi.fn(() => reveal),
		getRenderer: () => null,
		beginCascadeJob: vi.fn(() => vi.fn()),
		setOutputStage: vi.fn(),
		getQueue: () => queue,
		getVoiceConfig: () => ({ ttsProvider: "nextain", voice: "naia-default" }),
		getScheduler: () => null,
		getBrowserTurnGeneration: () => 0,
		setSpeaking: vi.fn(),
		getLocalRefAudioB64: () => null,
		addCostEntry: vi.fn(),
		notifyLocalVoiceUnavailable: vi.fn(async () => {}),
		...overrides,
	};
	return { deps, queue, reveal };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Minimal valid RIFF/WAVE payload of an exact duration, base64-encoded
 * (same construction as audio-queue.test.ts's wavDurationSeconds test).
 * gap-review-3 (2026-09-25): sampleRate is an optional third arg (default
 * 24_000, matching PcmStreamSource's own default) so tests can build a WAV
 * whose encoded rate actually differs from that default — otherwise a test
 * asserting `stream.sampleRate` would pass even if the pipeline never read
 * the WAV header at all. */
function makeWavBase64(durationSeconds: number, sampleRate = 24_000): string {
	const pcmBytes = Math.max(2, Math.round(durationSeconds * sampleRate) * 2);
	const bytes = new Uint8Array(44 + pcmBytes);
	const view = new DataView(bytes.buffer);
	const put = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++)
			bytes[offset + i] = text.charCodeAt(i);
	};
	put(0, "RIFF");
	put(8, "WAVE");
	put(12, "fmt ");
	put(36, "data");
	view.setUint32(4, bytes.length - 8, true);
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	view.setUint32(40, pcmBytes, true);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

describe("sentence TTS pipeline (FR-VOICE.16 Phase 2b)", () => {
	afterEach(() => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
	});

	it("plays an authored NVA clip instead of synthesizing, revealing on ready", async () => {
		const playAuthoredClip = vi.fn(
			async (_t: string, cb: { onPlaybackReady: () => void }) => {
				cb.onPlaybackReady();
			},
		);
		const { deps, reveal } = makeDeps({
			getRenderer: () => ({
				hasAuthoredClip: () => true,
				playAuthoredClip,
				setSpeakingVisual: vi.fn(),
			}),
		});
		const pipeline = createSentenceTtsPipeline(deps);
		pipeline.sendSentence("안녕하세요.");
		await flush();
		expect(playAuthoredClip).toHaveBeenCalledTimes(1);
		expect(synthesizeMock).not.toHaveBeenCalled();
		expect(reveal).toHaveBeenCalled();
		expect(deps.setOutputStage).toHaveBeenCalledWith("render");
	});

	it("routes a client-side provider through browser speechSynthesis", () => {
		const speak = vi.fn();
		vi.stubGlobal("speechSynthesis", { speak, cancel: vi.fn() });
		vi.stubGlobal(
			"SpeechSynthesisUtterance",
			class {
				text: string;
				lang = "";
				onstart: (() => void) | null = null;
				onend: (() => void) | null = null;
				onerror: (() => void) | null = null;
				constructor(text: string) {
					this.text = text;
				}
			},
		);
		const { deps } = makeDeps({
			getVoiceConfig: () => ({ ttsProvider: "browser" }),
		});
		createSentenceTtsPipeline(deps).sendSentence("Hello there.");
		expect(speak).toHaveBeenCalledTimes(1);
		expect(synthesizeMock).not.toHaveBeenCalled();
	});

	it("sends the same normalized text to browser and remote providers", async () => {
		const utterances: Array<{ text: string }> = [];
		vi.stubGlobal("speechSynthesis", {
			speak: vi.fn((utterance: { text: string }) => utterances.push(utterance)),
			cancel: vi.fn(),
		});
		vi.stubGlobal(
			"SpeechSynthesisUtterance",
			class {
				lang = "";
				onstart: (() => void) | null = null;
				onend: (() => void) | null = null;
				onerror: (() => void) | null = null;
				constructor(public text: string) {}
			},
		);
		const source = "**안내** https://example.com 😊";
		const { deps: browserDeps } = makeDeps({
			getVoiceConfig: () => ({ ttsProvider: "browser", voice: "ko-KR" }),
		});
		createSentenceTtsPipeline(browserDeps).sendSentence(source);

		synthesizeMock.mockResolvedValue({ audioBase64: "QUJD" });
		const { deps: remoteDeps } = makeDeps({
			getVoiceConfig: () => ({ ttsProvider: "nextain", voice: "ko-KR" }),
		});
		createSentenceTtsPipeline(remoteDeps).sendSentence(source);
		await flush();

		expect(utterances[0]?.text).toBe("안내");
		expect(synthesizeMock).toHaveBeenCalledWith(
			expect.objectContaining({ text: "안내" }),
		);
	});

	it("enqueues shell synthesis in reserved order and records the cost", async () => {
		synthesizeMock.mockResolvedValue({ audioBase64: "QUJD", costUsd: 0.01 });
		const { deps, queue } = makeDeps();
		const pipeline = createSentenceTtsPipeline(deps);
		pipeline.sendSentence("First sentence.");
		await flush();
		expect(queue.enqueueOrdered).toHaveBeenCalledWith(
			0,
			"QUJD",
			expect.objectContaining({ onPlaybackStart: expect.any(Function) }),
		);
		// Gateway costUsd is already API × 1.1. Do not multiply again.
		expect(deps.addCostEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				cost: 0.01,
				model: "tts:nextain (+10%)",
			}),
		);
	});

	it("emits an accepted WAV result for diagnostics without blocking playback", async () => {
		synthesizeMock.mockResolvedValue({ audioBase64: "QUJD" });
		const onSynthesisResult = vi.fn();
		const { deps, queue } = makeDeps({ onSynthesisResult });
		createSentenceTtsPipeline(deps).sendSentence("Recorded sentence.");
		await flush();
		expect(onSynthesisResult).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "Recorded sentence.",
				provider: "nextain",
				audioBase64: "QUJD",
				elapsedMs: expect.any(Number),
				audioDurationSeconds: null,
			}),
		);
		expect(queue.enqueueOrdered).toHaveBeenCalledWith(
			0,
			"QUJD",
			expect.any(Object),
		);
	});

	it("local engine failure: one notice, no browser fallback, slot released", async () => {
		synthesizeMock.mockRejectedValue(new Error("ECONNREFUSED"));
		const speak = vi.fn();
		vi.stubGlobal("speechSynthesis", { speak, cancel: vi.fn() });
		const scheduler = new LocalVoiceScheduler({
			pausePlayback: vi.fn(),
			resumePlayback: vi.fn(),
		});
		const { deps, queue, reveal } = makeDeps({
			getVoiceConfig: () => ({ ttsProvider: "naia-local-voice" }),
			getScheduler: () => scheduler,
		});
		const pipeline = createSentenceTtsPipeline(deps);
		pipeline.sendSentence("First.");
		pipeline.sendSentence("Second.");
		await flush();
		await flush();
		expect(speak).not.toHaveBeenCalled(); // FR-VOICE.2: no free-voice masquerade
		expect(deps.notifyLocalVoiceUnavailable).toHaveBeenCalledTimes(1); // once
		expect(queue.skipOrdered).toHaveBeenCalledWith(0);
		expect(queue.skipOrdered).toHaveBeenCalledWith(1);
		expect(reveal).toHaveBeenCalled();
		expect(pipeline.hasActiveRequests()).toBe(false);
	});

	it("cloud failure falls back to browser TTS so speech is never dropped", async () => {
		synthesizeMock.mockRejectedValue(new Error("quota"));
		const speak = vi.fn();
		vi.stubGlobal("speechSynthesis", { speak, cancel: vi.fn() });
		vi.stubGlobal(
			"SpeechSynthesisUtterance",
			class {
				lang = "";
				onstart: (() => void) | null = null;
				onend: (() => void) | null = null;
				onerror: (() => void) | null = null;
				constructor(public text: string) {}
			},
		);
		const { deps } = makeDeps();
		createSentenceTtsPipeline(deps).sendSentence("Cloudy sentence.");
		await flush();
		expect(speak).toHaveBeenCalledTimes(1);
		expect(deps.notifyLocalVoiceUnavailable).not.toHaveBeenCalled();
	});

	it("interrupt drops a late synthesis result: no enqueue, no billing", async () => {
		let resolveSynthesis!: (v: {
			audioBase64: string;
			costUsd?: number;
		}) => void;
		synthesizeMock.mockReturnValue(
			new Promise((resolve) => {
				resolveSynthesis = resolve;
			}) as ReturnType<typeof synthesizeTts>,
		);
		const { deps, queue } = makeDeps();
		const pipeline = createSentenceTtsPipeline(deps);
		pipeline.sendSentence("Will be superseded.");
		pipeline.interrupt();
		resolveSynthesis({ audioBase64: "QUJD", costUsd: 0.01 });
		await flush();
		expect(queue.enqueueOrdered).not.toHaveBeenCalled();
		expect(deps.addCostEntry).not.toHaveBeenCalled();
	});

	it("interrupt cancels a live browser utterance (Phase 3 lifecycle ownership)", () => {
		const cancel = vi.fn();
		vi.stubGlobal("speechSynthesis", { speak: vi.fn(), cancel });
		vi.stubGlobal(
			"SpeechSynthesisUtterance",
			class {
				lang = "";
				onstart: (() => void) | null = null;
				onend: (() => void) | null = null;
				onerror: (() => void) | null = null;
				constructor(public text: string) {}
			},
		);
		const { deps } = makeDeps({
			getVoiceConfig: () => ({ ttsProvider: "browser" }),
		});
		const pipeline = createSentenceTtsPipeline(deps);
		pipeline.sendSentence("Speaking now.");
		pipeline.interrupt();
		expect(cancel).toHaveBeenCalledTimes(1);
		// Session teardown is NOT a barge-in: dispose must never silence an
		// ongoing chat-mode browser reply (original ChatArea behavior).
		pipeline.dispose();
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("keeps the recent-utterance ring at 6 for the STT echo filter", () => {
		synthesizeMock.mockResolvedValue({ audioBase64: "QUJD" });
		const { deps } = makeDeps();
		const pipeline = createSentenceTtsPipeline(deps);
		for (let i = 1; i <= 8; i++) pipeline.sendSentence(`Sentence number ${i}.`);
		expect(pipeline.recentTexts()).toHaveLength(6);
		expect(pipeline.recentTexts()[0]).toContain("3");
		pipeline.dispose();
		expect(pipeline.recentTexts()).toHaveLength(0);
	});
});

describe("sentence TTS pipeline — local voice streaming slot", () => {
	afterEach(() => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
	});

	/**
	 * A queue that understands the streaming contract.
	 *
	 * FR-VOICE.22 (2026-09-25): forces `voicePlaybackMode: "streaming"` —
	 * these tests exercise the streaming SLOT MECHANICS (enqueueOrderedStream,
	 * chunk feeding, failure release), which must stay deterministic regardless
	 * of the "auto" mode's RTF-based decision (covered separately in
	 * voice-playback-mode.test.ts and the "auto" describe block below).
	 */
	function makeStreamingDeps(scheduler: LocalVoiceScheduler | null = null) {
		const { deps, queue, reveal } = makeDeps({
			getVoiceConfig: () => ({
				ttsProvider: "naia-local-voice",
				voicePlaybackMode: "streaming",
			}),
			getScheduler: () => scheduler,
		});
		const streaming = Object.assign(queue, {
			enqueueOrderedStream: vi.fn(),
		});
		return { deps, queue: streaming, reveal };
	}

	const chunkOf = (...samples: number[]) => Int16Array.from(samples);

	it("reserves the ordered slot as a stream before synthesis and feeds it chunks", async () => {
		synthesizeMock.mockImplementation(async (opts: any) => {
			opts.onPcmChunk?.(chunkOf(1, 2), 24_000);
			opts.onPcmChunk?.(chunkOf(3), 24_000);
			return { audioBase64: "QUJD" };
		});
		const { deps, queue } = makeStreamingDeps();
		createSentenceTtsPipeline(deps).sendSentence("첫 문장.");
		expect(queue.enqueueOrderedStream).toHaveBeenCalledTimes(1);
		// The slot is claimed before the request leaves — that is what removes
		// the whole-page wait before the first sound.
		expect(queue.enqueueOrderedStream.mock.invocationCallOrder[0]).toBeLessThan(
			synthesizeMock.mock.invocationCallOrder[0],
		);
		await flush();
		expect(synthesizeMock).toHaveBeenCalledWith(
			expect.objectContaining({ streamPcm: true }),
		);
		const [seq, stream] = queue.enqueueOrderedStream.mock.calls[0];
		expect(seq).toBe(0);
		expect(stream.chunks.map((c: Int16Array) => Array.from(c))).toEqual([
			[1, 2],
			[3],
		]);
		expect(stream.ended).toBe(true);
		expect(stream.failed).toBe(false);
		expect(queue.enqueueOrdered).not.toHaveBeenCalled();
	});

	it("keeps the whole-WAV path when the queue cannot take a stream", async () => {
		synthesizeMock.mockResolvedValue({ audioBase64: "QUJD" });
		const { deps, queue } = makeDeps({
			getVoiceConfig: () => ({ ttsProvider: "naia-local-voice" }),
		});
		createSentenceTtsPipeline(deps).sendSentence("첫 문장.");
		await flush();
		expect(synthesizeMock).toHaveBeenCalledWith(
			expect.objectContaining({ streamPcm: false }),
		);
		expect(queue.enqueueOrdered).toHaveBeenCalledWith(
			0,
			"QUJD",
			expect.any(Object),
		);
	});

	it("plays the assembled WAV when the host answered without streaming", async () => {
		synthesizeMock.mockResolvedValue({ audioBase64: makeWavBase64(1) });
		const { deps, queue } = makeStreamingDeps();
		createSentenceTtsPipeline(deps).sendSentence("첫 문장.");
		await flush();
		const stream = queue.enqueueOrderedStream.mock.calls[0][1];
		// gap-review-2 (2026-09-25): the host never streamed a chunk of its
		// own, but the reserved slot is fed the WAV decoded into PCM and ends —
		// it is NOT released via fail() + a second enqueueOrdered(seq, ...),
		// which the real AudioQueue's ordered flush cursor would silently drop
		// once this seq's turn has already come.
		expect(stream.failed).toBe(false);
		expect(stream.ended).toBe(true);
		expect(stream.chunks.length).toBeGreaterThan(0);
		expect(stream.sampleRate).toBe(24_000);
		expect(queue.enqueueOrdered).not.toHaveBeenCalled();
	});

	it("gap-review-4: the fallback's single chunk reports ended=true synchronously when the stream was subscribed before it landed", async () => {
		// This mirrors the REAL timing, not a simplified one: enqueueOrderedStream
		// is always called (and would be subscribed by a real AudioQueue) BEFORE
		// synthesizeTts's promise resolves — sendSentence() reserves and hands
		// off the slot synchronously, well before `await flush()` lets the
		// mocked WAV response land. Subscribing here BEFORE that flush
		// reproduces "already-subscribed, still-empty" exactly.
		synthesizeMock.mockResolvedValue({ audioBase64: makeWavBase64(0.5) });
		const { deps, queue } = makeStreamingDeps();
		createSentenceTtsPipeline(deps).sendSentence("첫 문장.");
		const stream = queue.enqueueOrderedStream.mock.calls[0][1];
		let onChunkCalls = 0;
		let onEndCalls = 0;
		let endedAtOnChunk: boolean | null = null;
		stream.subscribe(
			() => {
				onChunkCalls++;
				// gap-review-4 (2026-09-25): the exact assertion that catches the
				// push()+end() ordering bug — push() invokes this callback
				// synchronously, before a separate end() call could ever run, so
				// a push()+end() pair would still show `false` here. Only
				// pushFinal() (ended set BEFORE the callback) makes this `true`.
				endedAtOnChunk = stream.ended;
			},
			() => {
				onEndCalls++;
			},
		);
		expect(onChunkCalls).toBe(0); // nothing has arrived yet
		await flush(); // the whole-WAV fallback lands now, via pushFinal()
		expect(onChunkCalls).toBe(1);
		expect(endedAtOnChunk).toBe(true);
		expect(onEndCalls).toBe(1);
	});

	it.each([[16_000], [48_000]])(
		"gap-review-3: the whole-WAV fallback carries the WAV's own sample rate (%dHz), not the stream's 24kHz default",
		async (sampleRate) => {
			synthesizeMock.mockResolvedValue({
				audioBase64: makeWavBase64(1, sampleRate),
			});
			const { deps, queue } = makeStreamingDeps();
			createSentenceTtsPipeline(deps).sendSentence("첫 문장.");
			await flush();
			const stream = queue.enqueueOrderedStream.mock.calls[0][1];
			expect(stream.sampleRate).toBe(sampleRate);
			expect(stream.ended).toBe(true);
			expect(stream.failed).toBe(false);
		},
	);

	it("fails the reserved slot (does not silently vanish) when the whole-WAV fallback payload is undecodable", async () => {
		synthesizeMock.mockResolvedValue({ audioBase64: "QUJD" }); // too short to be a RIFF/WAVE payload
		const { deps, queue } = makeStreamingDeps();
		const pipeline = createSentenceTtsPipeline(deps);
		pipeline.sendSentence("첫 문장.");
		pipeline.sendSentence("둘째 문장.");
		await flush();
		await flush();
		const stream = queue.enqueueOrderedStream.mock.calls[0][1];
		expect(stream.chunks).toHaveLength(0);
		expect(stream.failed).toBe(true);
		expect(stream.ended).toBe(true);
		expect(queue.enqueueOrdered).not.toHaveBeenCalled();
		// The failure released the slot — seq 1 was not stalled behind it.
		expect(
			queue.enqueueOrderedStream.mock.calls.map((call: unknown[]) => call[0]),
		).toEqual([0, 1]);
		expect(pipeline.hasActiveRequests()).toBe(false);
	});

	it("releases a failed stream slot so the next sentence is not stalled", async () => {
		synthesizeMock.mockRejectedValue(new Error("ECONNREFUSED"));
		const { deps, queue } = makeStreamingDeps();
		const pipeline = createSentenceTtsPipeline(deps);
		pipeline.sendSentence("첫 문장.");
		pipeline.sendSentence("둘째 문장.");
		await flush();
		await flush();
		const seqs = queue.enqueueOrderedStream.mock.calls.map(
			(call: unknown[]) => call[0],
		);
		expect(seqs).toEqual([0, 1]);
		for (const call of queue.enqueueOrderedStream.mock.calls) {
			expect(call[1].failed).toBe(true);
			expect(call[1].ended).toBe(true);
		}
		// fail() replaces skipOrdered for streamed slots — never both.
		expect(queue.skipOrdered).not.toHaveBeenCalled();
		expect(pipeline.hasActiveRequests()).toBe(false);
	});

	it("gap-review-7 (2026-09-25) 구멍 6-2 (M19 변이 방지): 끼어들기(interrupt) 뒤 늦게 도착한 조각은 버려진 스트림에 쌓이지 않는다", async () => {
		// M19: onPcmChunk 의 activeRequests 가드(sentence-pipeline.ts:422 부근)
		// 를 지워도 기존 시험은 다 통과했다 — 끼어들기 뒤 도착하는 조각을
		// 직접 흉내 내는 시험이 없었기 때문이다. 지금은 큐가 구독을 끊어
		// 소리가 나진 않지만, 그 방어에만 기대면 나중에 구조가 바뀔 때
		// 조용히 깨진다 — 파이프라인 자신도 늦은 조각을 막아야 한다.
		// gap-review-7 검증 세션에서 tsc 가 `let x: T | null = null` +
		// 클로저 대입 + `x?.()` 조합을 `never` 로 좁혀 TS2349 를 냈다 — 이
		// 파일의 FR-VOICE.20(위)이 이미 쓰는 정의확정단언(`!`) 관용구로
		// 맞춘다.
		let capturedOnChunk!: (chunk: Int16Array, rate: number) => void;
		synthesizeMock.mockImplementation(
			(opts: any) =>
				new Promise(() => {
					// 절대 resolve/reject 하지 않는다 — 끼어들기로 버려지는
					// 진행 중 요청을 흉내 낸다.
					capturedOnChunk = opts.onPcmChunk;
				}),
		);
		const { deps, queue } = makeStreamingDeps();
		const pipeline = createSentenceTtsPipeline(deps);
		pipeline.sendSentence("첫 문장.");
		const stream = queue.enqueueOrderedStream.mock.calls[0][1];
		expect(capturedOnChunk).toBeTruthy();
		capturedOnChunk(chunkOf(1, 2), 24_000);
		expect(stream.chunks).toHaveLength(1); // 정상 조각은 쌓인다

		pipeline.interrupt(); // activeRequests 를 비운다 — 이 reqId 는 더 이상 활성이 아니다.

		// 끼어들기 뒤에 도착한 늦은 조각 — activeRequests 가드가 막아야 한다.
		capturedOnChunk(chunkOf(9, 9, 9), 24_000);
		expect(stream.chunks).toHaveLength(1); // 여전히 1개 — 늦은 조각이 안 쌓였다
	});

	it("FR-VOICE.20: the first chunk resumes playback before the sentence finishes", async () => {
		const pausePlayback = vi.fn();
		const resumePlayback = vi.fn();
		const scheduler = new LocalVoiceScheduler({
			pausePlayback,
			resumePlayback,
		});
		let sendChunk!: (chunk: Int16Array) => void;
		let finish!: (value: { audioBase64: string }) => void;
		synthesizeMock.mockImplementation((opts: any) => {
			sendChunk = (chunk) => opts.onPcmChunk?.(chunk, 24_000);
			return new Promise((resolve) => {
				finish = resolve;
			}) as ReturnType<typeof synthesizeTts>;
		});
		const { deps, queue } = makeStreamingDeps(scheduler);
		createSentenceTtsPipeline(deps).sendSentence("첫 문장.");
		await flush();
		expect(pausePlayback).toHaveBeenCalledTimes(1);
		expect(resumePlayback).not.toHaveBeenCalled();

		sendChunk(chunkOf(1, 2));
		expect(resumePlayback).toHaveBeenCalledTimes(1);
		// Synthesis has not returned yet — the release came from the chunk, not
		// from the finished WAV.
		expect(queue.enqueueOrdered).not.toHaveBeenCalled();

		sendChunk(chunkOf(3));
		expect(resumePlayback).toHaveBeenCalledTimes(1); // only the first chunk

		finish({ audioBase64: "QUJD" });
		await flush();
		// The sentence played through the streamed slot, so the assembled WAV is
		// never enqueued a second time.
		expect(queue.enqueueOrdered).not.toHaveBeenCalled();
		expect(queue.enqueueOrderedStream.mock.calls[0][1].ended).toBe(true);
	});

	it("FR-VOICE.20: a host that sends no chunks still releases playback through the reserved stream slot", async () => {
		const pausePlayback = vi.fn();
		const resumePlayback = vi.fn();
		const scheduler = new LocalVoiceScheduler({
			pausePlayback,
			resumePlayback,
		});
		synthesizeMock.mockResolvedValue({ audioBase64: makeWavBase64(1) });
		const { deps, queue } = makeStreamingDeps(scheduler);
		createSentenceTtsPipeline(deps).sendSentence("첫 문장.");
		await flush();
		const stream = queue.enqueueOrderedStream.mock.calls[0][1];
		expect(stream.ended).toBe(true);
		expect(stream.chunks.length).toBeGreaterThan(0);
		expect(queue.enqueueOrdered).not.toHaveBeenCalled();
		expect(resumePlayback).toHaveBeenCalledTimes(1);
	});
});

describe("sentence TTS pipeline — FR-VOICE.22 음성 재생 방식 integration", () => {
	afterEach(() => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
	});

	function makeAutoDeps(mode: "auto" | "streaming" | "sentence" = "auto") {
		const { deps, queue, reveal } = makeDeps({
			getVoiceConfig: () => ({
				ttsProvider: "naia-local-voice",
				voicePlaybackMode: mode,
			}),
			getScheduler: () => null,
		});
		const streaming = Object.assign(queue, { enqueueOrderedStream: vi.fn() });
		return { deps, queue: streaming, reveal };
	}

	it('mode="auto" 의 첫 문장은 RTF 를 모르므로 스트리밍 슬롯을 열지 않는다(문장 방식)', async () => {
		synthesizeMock.mockResolvedValue({ audioBase64: makeWavBase64(1) });
		const { deps, queue } = makeAutoDeps("auto");
		createSentenceTtsPipeline(deps).sendSentence("첫 문장.");
		expect(queue.enqueueOrderedStream).not.toHaveBeenCalled();
		await flush();
		expect(synthesizeMock).toHaveBeenCalledWith(
			expect.objectContaining({ streamPcm: false }),
		);
		expect(queue.enqueueOrdered).toHaveBeenCalledWith(
			0,
			expect.any(String),
			expect.any(Object),
		);
	});

	it('mode="sentence" 는 RTF 가 좋아져도 절대 스트리밍 슬롯을 열지 않는다', async () => {
		synthesizeMock.mockResolvedValue({ audioBase64: makeWavBase64(1) });
		const { deps, queue } = makeAutoDeps("sentence");
		const pipeline = createSentenceTtsPipeline(deps);
		pipeline.sendSentence("첫 문장.");
		await flush();
		pipeline.sendSentence("둘째 문장.");
		await flush();
		expect(queue.enqueueOrderedStream).not.toHaveBeenCalled();
		expect(synthesizeMock).toHaveBeenCalledWith(
			expect.objectContaining({ streamPcm: false }),
		);
	});

	it('mode="streaming" 은 RTF 를 몰라도(첫 문장) 항상 스트리밍 슬롯을 연다', async () => {
		synthesizeMock.mockResolvedValue({ audioBase64: makeWavBase64(1) });
		const { deps, queue } = makeAutoDeps("streaming");
		createSentenceTtsPipeline(deps).sendSentence("첫 문장.");
		expect(queue.enqueueOrderedStream).toHaveBeenCalledTimes(1);
	});

	it('mode="auto" 는 앞 문장의 실측 RTF 가 좋으면 다음 문장부터 스트리밍한다', async () => {
		// First sentence resolves ~instantly against a positive-duration WAV —
		// elapsed≈0s over a real duration measures RTF≈0 (well within realtime).
		synthesizeMock.mockResolvedValue({ audioBase64: makeWavBase64(2) });
		const { deps, queue } = makeAutoDeps("auto");
		const pipeline = createSentenceTtsPipeline(deps);
		pipeline.sendSentence("첫 문장.");
		expect(queue.enqueueOrderedStream).not.toHaveBeenCalled();
		await flush();

		pipeline.sendSentence("둘째 문장.");
		expect(queue.enqueueOrderedStream).toHaveBeenCalledTimes(1);
	});

	it("gap-review-2: 실 스케줄러 아래 flush 없이 연달아 보내도(burst) 같은 턴 안에서 둘째 문장부터 재판정한다", async () => {
		// The old bug: the decision read voicePlaybackRtfTracker.get() at
		// sendSentence() call time — synchronously, before any sentence's
		// synthesis had even started. A real AI reply dispatches every
		// sentence of a turn in a burst (as text streams in), well before the
		// first one's synthesis resolves, so every sentence saw "unknown RTF"
		// and fell back to "sentence" for the WHOLE turn, not just the first
		// sentence. The fix moves the decision inside synthesize(), which the
		// LocalVoiceScheduler only invokes once the previous sentence's job
		// has settled (and its RTF recorded) — this test never calls
		// `await flush()` between the three sendSentence() calls, matching
		// exactly how ChatArea actually dispatches a streamed reply.
		const pausePlayback = vi.fn();
		const resumePlayback = vi.fn();
		const scheduler = new LocalVoiceScheduler({
			pausePlayback,
			resumePlayback,
		});
		// Every resolved WAV is 2s; the mock resolves near-instantly, so the
		// measured RTF (elapsed/duration) lands well within realtime (<=1.0).
		synthesizeMock.mockResolvedValue({ audioBase64: makeWavBase64(2) });
		const { deps, queue } = makeAutoDeps("auto");
		deps.getScheduler = () => scheduler;
		const pipeline = createSentenceTtsPipeline(deps);

		// Burst dispatch — no await between sends.
		pipeline.sendSentence("첫 문장.");
		pipeline.sendSentence("둘째 문장.");
		pipeline.sendSentence("셋째 문장.");

		// Nothing has streamed yet: even the first sentence's synthesize()
		// (and therefore its decision) only runs once the scheduler admits it.
		expect(queue.enqueueOrderedStream).not.toHaveBeenCalled();

		await flush();
		await flush();

		// Sentence 1: no RTF measured yet anywhere in the session → "sentence"
		// (no stream slot). Sentences 2 and 3: by the time the scheduler
		// admits THEIR synthesize(), sentence 1's synthesis has already
		// settled and recorded a good RTF — despite no flush having ever
		// separated the three sendSentence() calls.
		const streamedSeqs = queue.enqueueOrderedStream.mock.calls.map(
			(call: unknown[]) => call[0],
		);
		expect(streamedSeqs).toEqual([1, 2]);
		expect(queue.enqueueOrderedStream).toHaveBeenCalledTimes(2);
	});

	it("gap-review-6: switching vllmTtsHost mid-session drops the stale RTF (new host's first sentence is sentence-method, not streaming)", async () => {
		// Sentence 1 against hostA measures a fast RTF (near-instant mock
		// resolve over a real-duration WAV → RTF well within realtime), which
		// would normally make sentence 2 stream. But sentence 2 is dispatched
		// AFTER the config switches to hostB — a host that has never been
		// measured. The old bug: voicePlaybackRtfTracker.get() has no notion
		// of "target", so it would hand back hostA's fast RTF as if it still
		// described hostB, streaming with zero pre-roll against an unmeasured
		// (possibly much slower) host.
		let host = "hostA";
		const { deps, queue } = makeDeps({
			getVoiceConfig: () => ({
				ttsProvider: "naia-local-voice",
				voicePlaybackMode: "auto",
				vllmTtsHost: host,
			}),
			getScheduler: () => null,
		});
		const streaming = Object.assign(queue, { enqueueOrderedStream: vi.fn() });
		synthesizeMock.mockResolvedValue({ audioBase64: makeWavBase64(2) });
		const pipeline = createSentenceTtsPipeline(deps);

		pipeline.sendSentence("첫 문장, hostA.");
		await flush();
		// Confirm the fast RTF really was recorded and WOULD stream on the
		// same host (sanity check on the test's own premise).
		host = "hostA";
		pipeline.sendSentence("같은 호스트 둘째 문장.");
		expect(streaming.enqueueOrderedStream).toHaveBeenCalledTimes(1);
		await flush();

		// Now switch hosts before the next sentence is admitted.
		host = "hostB";
		pipeline.sendSentence("호스트 전환 뒤 첫 문장, hostB.");
		// No NEW stream slot opened for hostB's unmeasured first sentence —
		// still exactly the one call recorded above from same-host sentence 2.
		expect(streaming.enqueueOrderedStream).toHaveBeenCalledTimes(1);
		expect(synthesizeMock).toHaveBeenLastCalledWith(
			expect.objectContaining({ streamPcm: false }),
		);
	});

	it("gap-review-6: dispose() resets the RTF tracker so a later session doesn't inherit a stale reading", async () => {
		const { deps, queue } = makeAutoDeps("auto");
		const streaming = Object.assign(queue, { enqueueOrderedStream: vi.fn() });
		synthesizeMock.mockResolvedValue({ audioBase64: makeWavBase64(2) });
		const pipeline = createSentenceTtsPipeline(deps);

		pipeline.sendSentence("세션1 첫 문장.");
		await flush();
		pipeline.sendSentence("세션1 둘째 문장(스트리밍 확인용).");
		expect(streaming.enqueueOrderedStream).toHaveBeenCalledTimes(1);
		await flush();

		pipeline.dispose();

		// A fresh sentence after dispose must see "unknown RTF" again, not the
		// pre-dispose measurement — same pipeline instance, simulating a new
		// session/turn reusing it without a measured RTF surviving teardown.
		pipeline.sendSentence("dispose 이후 새 세션 첫 문장.");
		expect(streaming.enqueueOrderedStream).toHaveBeenCalledTimes(1);
		expect(synthesizeMock).toHaveBeenLastCalledWith(
			expect.objectContaining({ streamPcm: false }),
		);
	});

	it("gap-review-3: a borderline-RTF decision's preRollSeconds/estimated duration actually land on the stream object", async () => {
		// Force the first sentence's measured RTF into the borderline band
		// (1.0 < RTF <= 1.3) by controlling performance.now() directly, so the
		// SECOND sentence's "auto" decision is streaming+pre-roll (not the
		// zero-preroll realtime case, which would pass this assertion even if
		// the two assignments in synthesize() were deleted, since both
		// stream.startDelaySeconds and stream.expectedDurationSeconds default
		// to 0/null already matching a 0-preRoll outcome).
		const now = vi
			.spyOn(performance, "now")
			.mockReturnValueOnce(0) // sentence 1: synthesisStartedAt
			.mockReturnValueOnce(1_100) // sentence 1: elapsedMs (diagnostics)
			.mockReturnValueOnce(1_100) // sentence 1: elapsed used for RTF record
			.mockReturnValue(0); // sentence 2 onward: value irrelevant here
		try {
			synthesizeMock.mockResolvedValue({ audioBase64: makeWavBase64(1) }); // 1s WAV
			const { deps, queue } = makeAutoDeps("auto");
			const pipeline = createSentenceTtsPipeline(deps);
			pipeline.sendSentence(
				"첫 문장입니다, 충분히 길게 써서 예상 길이를 만듭니다.",
			);
			await flush();
			// elapsed(1.1s)/duration(1s) = RTF 1.1 → borderline band.
			pipeline.sendSentence(
				"둘째 문장도 충분히 길게 써서 예상 길이가 0보다 크게 만듭니다.",
			);
			expect(queue.enqueueOrderedStream).toHaveBeenCalledTimes(1);
			const stream = queue.enqueueOrderedStream.mock.calls[0][1];
			expect(stream.startDelaySeconds).toBeGreaterThan(0);
			expect(stream.expectedDurationSeconds).toBeGreaterThan(0);
		} finally {
			now.mockRestore();
		}
	});

	it("gap-review-8 구멍 4-1: pipeline passes rtfInformedPreRoll=true to onFirstChunk for RTF-informed pre-roll sentence", async () => {
		const now = vi
			.spyOn(performance, "now")
			.mockReturnValueOnce(0) // sentence 1: synthesisStartedAt
			.mockReturnValueOnce(1_100) // sentence 1: elapsedMs
			.mockReturnValueOnce(1_100) // sentence 1: elapsed for RTF
			.mockReturnValue(0);
		try {
			synthesizeMock.mockResolvedValue({ audioBase64: makeWavBase64(1) });
			const scheduler = {
				noteSentence: vi.fn(),
				schedule: vi.fn((fn: () => any) => fn()),
				onFirstChunk: vi.fn(),
				onSentenceResult: vi.fn(),
				onEnqueued: vi.fn(),
				finishStream: vi.fn(),
				interrupt: vi.fn(),
				noteTarget: vi.fn(),
			};
			const { deps, queue } = makeDeps({
				getVoiceConfig: () => ({
					ttsProvider: "naia-local-voice",
					voicePlaybackMode: "auto",
				}),
				getScheduler: () => scheduler as any,
			});
			Object.assign(queue, { enqueueOrderedStream: vi.fn() });
			const pipeline = createSentenceTtsPipeline(deps);

			pipeline.sendSentence("첫 문장으로 RTF 1.1을 만듭니다.");
			await flush();

			// Sentence 2: RTF 1.1 is known -> method is streaming with preRoll > 0.
			synthesizeMock.mockImplementationOnce(async (opts) => {
				opts.onPcmChunk?.(new Int16Array(240), 24_000);
				return { audioBase64: makeWavBase64(1) };
			});

			pipeline.sendSentence("둘째 문장은 RTF를 아는 pre-roll 스트리밍입니다.");
			await flush();

			expect(scheduler.onFirstChunk).toHaveBeenCalledWith(
				expect.any(Number),
				expect.any(Number),
				true,
			);
		} finally {
			now.mockRestore();
		}
	});

	it("gap-review-8: switching localVoiceGpuIndex mid-session drops the stale RTF (mutant MG guard)", async () => {
		let gpuIndex: number | undefined = 0;
		const { deps, queue } = makeDeps({
			getVoiceConfig: () => ({
				ttsProvider: "naia-local-voice",
				voicePlaybackMode: "auto",
				vllmTtsHost: "http://localhost:8910",
				localVoiceGpuIndex: gpuIndex,
			}),
			getScheduler: () => null,
		});
		const streaming = Object.assign(queue, { enqueueOrderedStream: vi.fn() });
		synthesizeMock.mockResolvedValue({ audioBase64: makeWavBase64(2) });
		const pipeline = createSentenceTtsPipeline(deps);

		pipeline.sendSentence("첫 문장, GPU 0.");
		await flush();
		// Confirm the fast RTF was recorded and would stream on the same GPU.
		pipeline.sendSentence("같은 GPU 둘째 문장.");
		expect(streaming.enqueueOrderedStream).toHaveBeenCalledTimes(1);
		await flush();

		// Now switch GPU index before the next sentence is admitted.
		gpuIndex = 1;
		pipeline.sendSentence("GPU 전환 뒤 첫 문장, GPU 1.");
		// No new stream slot opened for GPU 1's unmeasured first sentence.
		expect(streaming.enqueueOrderedStream).toHaveBeenCalledTimes(1);
		expect(synthesizeMock).toHaveBeenLastCalledWith(
			expect.objectContaining({ streamPcm: false }),
		);
	});

	it("gap-review-8: sentenceRateCalibrator.record updates expectedDurationSeconds for subsequent sentences (mutant MF guard)", async () => {
		const now = vi
			.spyOn(performance, "now")
			.mockReturnValueOnce(0) // sentence 1: synthesisStartedAt
			.mockReturnValueOnce(1_100) // sentence 1: elapsedMs
			.mockReturnValueOnce(1_100) // sentence 1: elapsed for RTF
			.mockReturnValue(0);
		try {
			// Sentence 1: text length exactly 20 chars. WAV duration = 1.0s.
			// Calibrated rate = 20 chars / 1.0s = 20 chars/sec.
			synthesizeMock.mockResolvedValue({ audioBase64: makeWavBase64(1) });
			const { deps, queue } = makeAutoDeps("auto");
			const pipeline = createSentenceTtsPipeline(deps);

			pipeline.sendSentence("01234567890123456789");
			await flush();

			// Sentence 2: length exactly 40 chars.
			// With calibrated rate (20 chars/sec): expected duration = 40 / 20 = 2.0s.
			// Without calibration / mutant MF (default 7 chars/sec): expected duration = 40 / 7 ≈ 5.71s.
			pipeline.sendSentence("0123456789012345678901234567890123456789");
			expect(queue.enqueueOrderedStream).toHaveBeenCalledTimes(1);
			const stream = queue.enqueueOrderedStream.mock.calls[0][1];
			expect(stream.expectedDurationSeconds).toBeCloseTo(2.0, 1);
		} finally {
			now.mockRestore();
		}
	});

	it("gap-review-8: changing voice resets sentenceRateCalibrator so next sentence uses default rate", async () => {
		let currentVoice = "voice1";
		const now = vi
			.spyOn(performance, "now")
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(1_100)
			.mockReturnValueOnce(1_100)
			.mockReturnValue(0);
		try {
			synthesizeMock.mockResolvedValue({ audioBase64: makeWavBase64(1) });
			const { deps, queue } = makeDeps({
				getVoiceConfig: () => ({
					ttsProvider: "naia-local-voice",
					voicePlaybackMode: "auto",
					voice: currentVoice,
				}),
				getScheduler: () => null,
			});
			const streaming = Object.assign(queue, { enqueueOrderedStream: vi.fn() });
			const pipeline = createSentenceTtsPipeline(deps);

			// Exactly 21 chars in 1s -> 21 chars/sec
			pipeline.sendSentence("012345678901234567890");
			await flush();

			// Switch voice before sentence 2
			currentVoice = "voice2";
			// Exactly 21 chars.
			// If reset to default 7 chars/sec: 21 / 7 = 3.0s.
			// If stale calibration (21 chars/sec) remained: 21 / 21 = 1.0s.
			pipeline.sendSentence("012345678901234567890");
			expect(streaming.enqueueOrderedStream).toHaveBeenCalledTimes(1);
			const stream = streaming.enqueueOrderedStream.mock.calls[0][1];
			expect(stream.expectedDurationSeconds).toBeCloseTo(3.0, 1);
		} finally {
			now.mockRestore();
		}
	});
});
