// @vitest-environment jsdom
/**
 * FR-SLIDES-PAGE-GAP.1 — after a page turn the first sound waits at least the
 * minimum gap (Luke 2026-09-24: 500 ms) even when the audio was prefetched,
 * and never longer than max(gap, synthesis). Real AudioQueue + real local
 * voice scheduler + real pipeline; only the voice host and <audio> are fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	SLIDE_PAGE_MIN_GAP_MS,
	SlideNarrationPrefetcher,
	slidePageMinGapMs,
} from "../../slide-narration-prefetch";
import { AudioQueue } from "../../voice/audio-queue";
import { LocalVoiceScheduler } from "../local-voice-scheduler";
import {
	type SentenceTtsPipelineDeps,
	createSentenceTtsPipeline,
} from "../sentence-pipeline";

vi.mock("../synthesize", () => ({ synthesizeTts: vi.fn() }));
import { synthesizeTts } from "../synthesize";
const synthesizeMock = vi.mocked(synthesizeTts);

const GAP = SLIDE_PAGE_MIN_GAP_MS;

/** performance.now() of every <audio>.play(), with the text it plays. */
let plays: Array<{ at: number; text: string }> = [];

class FakeAudio {
	src: string;
	onplay: (() => void) | null = null;
	onended: (() => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	pause = vi.fn();
	constructor(src: string) {
		this.src = src;
	}
	play = vi.fn(async () => {
		const b64 = this.src.split(",")[1] ?? "";
		plays.push({
			at: performance.now(),
			text: decodeURIComponent(escape(atob(b64))),
		});
		this.onplay?.();
	});
}

class FakeAudioContext {
	state = "running";
	destination = {};
	currentTime = 0;
	resume = vi.fn(async () => {});
	createBuffer = vi.fn();
	createBufferSource = vi.fn();
}

/** Fake single-flight voice host: each sentence takes `synthMs`. */
function installHost(synthMs: number) {
	synthesizeMock.mockImplementation(
		(opts: { text: string; signal?: AbortSignal }) =>
			new Promise((resolve, reject) => {
				const timer = setTimeout(
					() =>
						resolve({
							audioBase64: btoa(unescape(encodeURIComponent(opts.text))),
						}),
					synthMs,
				);
				opts.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(new DOMException("aborted", "AbortError"));
				});
			}) as ReturnType<typeof synthesizeTts>,
	);
}

function setup() {
	const queue = new AudioQueue();
	const scheduler = new LocalVoiceScheduler({
		pausePlayback: () => queue.pauseBeforePlayback(),
		resumePlayback: () => queue.resumePlayback(),
	});
	let nextId = 0;
	const deps: SentenceTtsPipelineDeps = {
		generateRequestId: () => `req-${nextId++}`,
		reserveReveal: vi.fn(() => vi.fn()),
		getRenderer: () => null,
		beginCascadeJob: vi.fn(() => vi.fn()),
		setOutputStage: vi.fn(),
		getQueue: () => queue,
		getVoiceConfig: () => ({ ttsProvider: "naia-local-voice" }),
		getScheduler: () => scheduler,
		getBrowserTurnGeneration: () => 0,
		setSpeaking: vi.fn(),
		getLocalRefAudioB64: () => null,
		addCostEntry: vi.fn(),
		notifyLocalVoiceUnavailable: vi.fn(async () => {}),
	};
	const pipeline = createSentenceTtsPipeline(deps);
	const prefetcher = new SlideNarrationPrefetcher({
		prefetchSentence: (s) => pipeline.prefetchSentence(s),
		discardPrefetch: () => pipeline.discardPrefetch(),
	});
	/** The same steps ChatArea's slide speak handler takes for one page. */
	const speakPage = (generation: number, sentences: string[]) => {
		const earliestPlaybackAt = performance.now() + slidePageMinGapMs();
		// interruptTts
		queue.clear();
		scheduler.interrupt();
		pipeline.interrupt();
		prefetcher.beforeNarration();
		queue.holdPlaybackUntil(earliestPlaybackAt);
		for (const s of sentences) pipeline.sendSentence(s);
		scheduler.finishStream();
		prefetcher.narrationQueued(generation);
	};
	return { queue, pipeline, prefetcher, speakPage };
}

async function msUntil(done: () => boolean, limitMs = 20_000): Promise<number> {
	const start = performance.now();
	await vi.advanceTimersByTimeAsync(0);
	while (!done() && performance.now() - start < limitMs) {
		await vi.advanceTimersByTimeAsync(10);
	}
	return performance.now() - start;
}

describe("FR-SLIDES-PAGE-GAP.1 minimum gap after a page turn", () => {
	beforeEach(() => {
		plays = [];
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"setInterval",
				"clearInterval",
				"Date",
				"performance",
			],
		});
		vi.stubGlobal("Audio", FakeAudio);
		vi.stubGlobal("AudioContext", FakeAudioContext);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("prefetched audio still waits the gap, and only the gap", async () => {
		installHost(1_000);
		const { prefetcher, speakPage } = setup();
		prefetcher.request({ generation: 1, page: 2, text: "둘째 쪽." });
		speakPage(1, ["첫 쪽."]);
		// Page 1 plays; the prefetch for page 2 finishes behind it.
		await msUntil(() => plays.length === 1);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(plays.map((p) => p.text)).toEqual(["첫 쪽."]);

		const turnedAt = performance.now();
		speakPage(2, ["둘째 쪽."]);
		await msUntil(() => plays.length === 2);
		const gap = plays[1].at - turnedAt;
		expect(plays[1].text).toBe("둘째 쪽.");
		expect(gap).toBeGreaterThanOrEqual(GAP);
		expect(gap).toBeLessThan(GAP + 50);
	});

	it("synthesis slower than the gap plays as soon as it is ready (3 s → 3 s)", async () => {
		installHost(3_000);
		const { speakPage } = setup();
		const turnedAt = performance.now();
		speakPage(1, ["첫 문장."]);
		await msUntil(() => plays.length === 1);
		const gap = plays[0].at - turnedAt;
		expect(gap).toBeGreaterThanOrEqual(3_000);
		expect(gap).toBeLessThan(3_050);
	});

	it("later sentences of the page are not held again", async () => {
		installHost(100);
		const { queue, speakPage } = setup();
		speakPage(1, ["하나.", "둘."]);
		await msUntil(() => plays.length === 1);
		const firstAt = plays[0].at;
		// Both sentences are ready; ending the first plays the second at once.
		await vi.advanceTimersByTimeAsync(1_000);
		const endedAt = performance.now();
		(queue as unknown as { current: FakeAudio | null }).current?.onended?.();
		await msUntil(() => plays.length === 2);
		expect(firstAt).toBeGreaterThan(0);
		expect(plays[1].at - endedAt).toBeLessThan(10);
	});

	it("pause, page move or stop (queue clear) cancels the pending wait", async () => {
		const queue = new AudioQueue();
		queue.holdPlaybackUntil(performance.now() + GAP);
		queue.enqueue(btoa("x"));
		await vi.advanceTimersByTimeAsync(GAP / 2);
		expect(plays).toHaveLength(0);
		queue.clear();
		await vi.advanceTimersByTimeAsync(GAP * 4);
		expect(plays).toHaveLength(0);
		// A later ordinary enqueue is not held by the cancelled wait.
		queue.enqueue(btoa("y"));
		await vi.advanceTimersByTimeAsync(0);
		expect(plays).toHaveLength(1);
	});

	it("the gap is one constant with an env override following the chunk-mode convention", () => {
		expect(SLIDE_PAGE_MIN_GAP_MS).toBe(500);
		expect(slidePageMinGapMs(undefined)).toBe(500);
		expect(slidePageMinGapMs("800")).toBe(800);
		expect(slidePageMinGapMs("0")).toBe(0);
		expect(slidePageMinGapMs("abc")).toBe(500);
		expect(slidePageMinGapMs("-1")).toBe(500);
	});
});
