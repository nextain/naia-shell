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
		expect(queue.enqueueOrdered).toHaveBeenCalledWith(0, "QUJD", expect.any(Object));
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

	/** A queue that understands the streaming contract. */
	function makeStreamingDeps(scheduler: LocalVoiceScheduler | null = null) {
		const { deps, queue, reveal } = makeDeps({
			getVoiceConfig: () => ({ ttsProvider: "naia-local-voice" }),
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
		expect(
			queue.enqueueOrderedStream.mock.invocationCallOrder[0],
		).toBeLessThan(synthesizeMock.mock.invocationCallOrder[0]);
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
		synthesizeMock.mockResolvedValue({ audioBase64: "QUJD" });
		const { deps, queue } = makeStreamingDeps();
		createSentenceTtsPipeline(deps).sendSentence("첫 문장.");
		await flush();
		const stream = queue.enqueueOrderedStream.mock.calls[0][1];
		expect(stream.chunks).toHaveLength(0);
		// The reserved stream slot is released, and the sentence still plays.
		expect(stream.failed).toBe(true);
		expect(queue.enqueueOrdered).toHaveBeenCalledWith(
			0,
			"QUJD",
			expect.any(Object),
		);
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

	it("FR-VOICE.20: the first chunk resumes playback before the sentence finishes", async () => {
		const pausePlayback = vi.fn();
		const resumePlayback = vi.fn();
		const scheduler = new LocalVoiceScheduler({ pausePlayback, resumePlayback });
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

	it("FR-VOICE.20: a host that sends no chunks still releases through the enqueue path", async () => {
		const pausePlayback = vi.fn();
		const resumePlayback = vi.fn();
		const scheduler = new LocalVoiceScheduler({ pausePlayback, resumePlayback });
		synthesizeMock.mockResolvedValue({ audioBase64: "QUJD" });
		const { deps, queue } = makeStreamingDeps(scheduler);
		createSentenceTtsPipeline(deps).sendSentence("첫 문장.");
		await flush();
		expect(queue.enqueueOrdered).toHaveBeenCalledWith(
			0,
			"QUJD",
			expect.any(Object),
		);
		expect(resumePlayback).toHaveBeenCalledTimes(1);
	});

});
