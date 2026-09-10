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
