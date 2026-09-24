// @vitest-environment jsdom
/**
 * FR-SLIDES-PREFETCH.1 — page-turn silence (IR recording 2026-09-24: 8.5 s,
 * 7.2 s, 6.6 s gaps). A fake local voice host takes SYNTH_MS per sentence and
 * answers one request at a time, like the 8917 host. The page-turn gap is the
 * time from "next page starts" (interrupt + sendSentence) to the next page's
 * first audio entering the playback queue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlideNarrationPrefetcher } from "../../slide-narration-prefetch";
import { LocalVoiceScheduler } from "../local-voice-scheduler";
import {
	type SentenceTtsPipelineDeps,
	createSentenceTtsPipeline,
} from "../sentence-pipeline";

vi.mock("../synthesize", () => ({ synthesizeTts: vi.fn() }));
import { synthesizeTts } from "../synthesize";
const synthesizeMock = vi.mocked(synthesizeTts);

const SYNTH_MS = 3_000;

interface FakeHost {
	calls: string[];
	inFlight: number;
	maxInFlight: number;
	aborted: string[];
}

function installFakeHost(): FakeHost {
	const host: FakeHost = {
		calls: [],
		inFlight: 0,
		maxInFlight: 0,
		aborted: [],
	};
	synthesizeMock.mockImplementation(
		(opts: { text: string; signal?: AbortSignal }) =>
			new Promise((resolve, reject) => {
				host.calls.push(opts.text);
				host.inFlight++;
				host.maxInFlight = Math.max(host.maxInFlight, host.inFlight);
				const timer = setTimeout(() => {
					host.inFlight--;
					resolve({ audioBase64: `WAV:${opts.text}` });
				}, SYNTH_MS);
				opts.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					host.inFlight--;
					host.aborted.push(opts.text);
					reject(new DOMException("aborted", "AbortError"));
				});
			}) as ReturnType<typeof synthesizeTts>,
	);
	return host;
}

function makeLocalVoiceDeps() {
	let nextId = 0;
	const queue = {
		nextSeq: 0,
		reserveSeq: vi.fn(() => queue.nextSeq++),
		enqueueOrdered: vi.fn(),
		skipOrdered: vi.fn(),
	};
	const scheduler = new LocalVoiceScheduler({
		pausePlayback: vi.fn(),
		resumePlayback: vi.fn(),
	});
	const deps: SentenceTtsPipelineDeps = {
		generateRequestId: () => `req-${nextId++}`,
		reserveReveal: vi.fn(() => vi.fn()),
		getRenderer: () => null,
		beginCascadeJob: vi.fn(() => vi.fn()),
		setOutputStage: vi.fn(),
		getQueue: () => queue,
		getVoiceConfig: () => ({
			ttsProvider: "naia-local-voice",
			vllmTtsHost: "http://127.0.0.1:65000",
		}),
		getScheduler: () => scheduler,
		getBrowserTurnGeneration: () => 0,
		setSpeaking: vi.fn(),
		getLocalRefAudioB64: () => null,
		addCostEntry: vi.fn(),
		notifyLocalVoiceUnavailable: vi.fn(async () => {}),
	};
	return { deps, queue, scheduler };
}

/** Enqueued audio payloads, in call order. */
const enqueued = (queue: { enqueueOrdered: ReturnType<typeof vi.fn> }) =>
	queue.enqueueOrdered.mock.calls.map((call) => call[1] as string);

/** Advance fake time in small steps until `done()` or `limitMs`. */
async function msUntil(done: () => boolean, limitMs = 20_000): Promise<number> {
	let waited = 0;
	await vi.advanceTimersByTimeAsync(0);
	while (!done() && waited < limitMs) {
		await vi.advanceTimersByTimeAsync(50);
		waited += 50;
	}
	return waited;
}

/**
 * Same order of calls as ChatArea: the Slides app asks for the next page's
 * prefetch, then the current page narration enters the pipeline, then the
 * page turn interrupts and sends the next page.
 */
async function pageTurnGap(options: { prefetch: boolean }): Promise<{
	gapMs: number;
	host: FakeHost;
	queue: ReturnType<typeof makeLocalVoiceDeps>["queue"];
}> {
	const host = installFakeHost();
	const { deps, queue } = makeLocalVoiceDeps();
	const pipeline = createSentenceTtsPipeline(deps);
	const prefetcher = new SlideNarrationPrefetcher({
		prefetchSentence: (s) => pipeline.prefetchSentence(s),
		discardPrefetch: () => pipeline.discardPrefetch(),
	});

	// Page 1 is read.
	prefetcher.beforeNarration();
	if (options.prefetch) {
		prefetcher.request({
			generation: 1,
			page: 2,
			text: "둘째 쪽 첫 문장. 둘째 쪽 두 번째 문장. 셋째 문장.",
		});
	}
	pipeline.sendSentence("첫 쪽 문장.");
	prefetcher.narrationQueued(1);
	// Page 1 audio is ready after SYNTH_MS and plays for 4 s.
	await msUntil(() => enqueued(queue).includes("WAV:첫 쪽 문장."));
	await vi.advanceTimersByTimeAsync(4_000);

	// Page turn: speech-finished → next page speak → interruptTts + sentences.
	pipeline.interrupt();
	prefetcher.beforeNarration();
	pipeline.sendSentence("둘째 쪽 첫 문장.");
	pipeline.sendSentence("둘째 쪽 두 번째 문장.");
	pipeline.sendSentence("셋째 문장.");
	prefetcher.narrationQueued(2);
	const gapMs = await msUntil(() =>
		enqueued(queue).includes("WAV:둘째 쪽 첫 문장."),
	);
	return { gapMs, host, queue };
}

describe("FR-SLIDES-PREFETCH.1 page-turn prefetch", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("plays the next page's first sentence without waiting for synthesis", async () => {
		const { gapMs, host, queue } = await pageTurnGap({ prefetch: true });
		expect(gapMs).toBeLessThan(SYNTH_MS / 3);
		// The prefetched sentences were not synthesized a second time.
		expect(host.calls.filter((t) => t === "둘째 쪽 첫 문장.")).toHaveLength(1);
		expect(
			host.calls.filter((t) => t === "둘째 쪽 두 번째 문장."),
		).toHaveLength(1);
		// Only the first two sentences are prefetched; the third waits its turn.
		expect(host.calls.slice(0, 3)).toEqual([
			"첫 쪽 문장.",
			"둘째 쪽 첫 문장.",
			"둘째 쪽 두 번째 문장.",
		]);
		// The voice host never had more than one request at a time.
		expect(host.maxInFlight).toBe(1);
		await msUntil(() => enqueued(queue).includes("WAV:셋째 문장."));
		expect(enqueued(queue)).toEqual([
			"WAV:첫 쪽 문장.",
			"WAV:둘째 쪽 첫 문장.",
			"WAV:둘째 쪽 두 번째 문장.",
			"WAV:셋째 문장.",
		]);
	});

	it("without prefetch the page turn waits the whole synthesis time (baseline)", async () => {
		const { gapMs } = await pageTurnGap({ prefetch: false });
		expect(gapMs).toBeGreaterThanOrEqual(SYNTH_MS - 50);
	});

	it("queues the prefetch behind the current page, never ahead of it", async () => {
		const host = installFakeHost();
		const { deps, queue } = makeLocalVoiceDeps();
		const pipeline = createSentenceTtsPipeline(deps);
		const prefetcher = new SlideNarrationPrefetcher({
			prefetchSentence: (s) => pipeline.prefetchSentence(s),
			discardPrefetch: () => pipeline.discardPrefetch(),
		});
		prefetcher.beforeNarration();
		// The Slides app asks before the page's own sentences are queued.
		prefetcher.request({ generation: 4, page: 5, text: "다음 쪽." });
		expect(pipeline.prefetchedCount()).toBe(0);
		pipeline.sendSentence("이번 쪽 하나.");
		pipeline.sendSentence("이번 쪽 둘.");
		prefetcher.narrationQueued(4);
		expect(pipeline.prefetchedCount()).toBe(1);
		await msUntil(() => host.calls.length === 3 && host.inFlight === 0);
		expect(host.calls).toEqual(["이번 쪽 하나.", "이번 쪽 둘.", "다음 쪽."]);
		expect(host.maxInFlight).toBe(1);
		// A prefetch alone is never played.
		expect(enqueued(queue)).toEqual(["WAV:이번 쪽 하나.", "WAV:이번 쪽 둘."]);
	});

	it("discard aborts the prefetch and the next page synthesizes again", async () => {
		const host = installFakeHost();
		const { deps, queue } = makeLocalVoiceDeps();
		const pipeline = createSentenceTtsPipeline(deps);
		expect(pipeline.prefetchSentence("다음 쪽.")).toBe(true);
		await vi.advanceTimersByTimeAsync(100);
		pipeline.discardPrefetch();
		await vi.advanceTimersByTimeAsync(0);
		expect(host.aborted).toEqual(["다음 쪽."]);
		expect(pipeline.prefetchedCount()).toBe(0);
		pipeline.sendSentence("다음 쪽.");
		await msUntil(() => enqueued(queue).length === 1);
		expect(host.calls).toEqual(["다음 쪽.", "다음 쪽."]);
		expect(enqueued(queue)).toEqual(["WAV:다음 쪽."]);
	});

	it("page-turn interrupt keeps the prefetch; a leftover one is dropped once the page is queued", async () => {
		const host = installFakeHost();
		const { deps } = makeLocalVoiceDeps();
		const pipeline = createSentenceTtsPipeline(deps);
		const prefetcher = new SlideNarrationPrefetcher({
			prefetchSentence: (s) => pipeline.prefetchSentence(s),
			discardPrefetch: () => pipeline.discardPrefetch(),
		});
		prefetcher.narrationQueued(1);
		prefetcher.request({ generation: 1, page: 2, text: "원래 문장." });
		expect(pipeline.prefetchedCount()).toBe(1);
		pipeline.interrupt();
		expect(pipeline.prefetchedCount()).toBe(1);
		// The script of page 2 changed before it was read: the old audio is
		// not what will be read and must not stay queued on the voice host.
		prefetcher.beforeNarration();
		pipeline.sendSentence("고친 문장.");
		prefetcher.narrationQueued(2);
		expect(pipeline.prefetchedCount()).toBe(0);
		await msUntil(() => host.calls.length >= 1 && host.inFlight === 0);
		// The stale prefetch was still waiting in the scheduler, so the voice
		// host is never asked for it.
		expect(host.calls).toEqual(["고친 문장."]);
	});

	it("a failed prefetched sentence takes the normal failure path", async () => {
		synthesizeMock.mockRejectedValue(new Error("host down"));
		const { deps, queue } = makeLocalVoiceDeps();
		const pipeline = createSentenceTtsPipeline(deps);
		pipeline.prefetchSentence("다음 쪽.");
		await vi.advanceTimersByTimeAsync(0);
		pipeline.sendSentence("다음 쪽.");
		await vi.advanceTimersByTimeAsync(0);
		expect(queue.enqueueOrdered).not.toHaveBeenCalled();
		expect(queue.skipOrdered).toHaveBeenCalledWith(0);
		expect(deps.notifyLocalVoiceUnavailable).toHaveBeenCalledTimes(1);
	});
});

describe("SlideNarrationPrefetcher", () => {
	function make() {
		const prefetchSentence = vi.fn((_sentence: string) => true);
		const discardPrefetch = vi.fn();
		const prefetcher = new SlideNarrationPrefetcher({
			prefetchSentence,
			discardPrefetch,
		});
		return { prefetcher, prefetchSentence, discardPrefetch };
	}

	it("starts only after the same generation's narration is queued", () => {
		const { prefetcher, prefetchSentence } = make();
		prefetcher.beforeNarration();
		prefetcher.request({ generation: 3, page: 4, text: "하나. 둘. 셋." });
		expect(prefetchSentence).not.toHaveBeenCalled();
		prefetcher.narrationQueued(2);
		expect(prefetchSentence).not.toHaveBeenCalled();
		prefetcher.narrationQueued(3);
		expect(prefetchSentence.mock.calls.map((c) => c[0])).toEqual([
			"하나.",
			"둘.",
		]);
	});

	it("ignores a repeated request and replaces an edited one", () => {
		const { prefetcher, prefetchSentence, discardPrefetch } = make();
		prefetcher.narrationQueued(1);
		prefetcher.request({ generation: 1, page: 2, text: "처음." });
		prefetcher.request({ generation: 1, page: 2, text: "처음." });
		expect(prefetchSentence).toHaveBeenCalledTimes(1);
		discardPrefetch.mockClear();
		prefetcher.request({ generation: 1, page: 2, text: "고침." });
		expect(discardPrefetch).toHaveBeenCalledTimes(1);
		expect(prefetchSentence).toHaveBeenLastCalledWith("고침.");
	});

	it("a discard request drops pending and started prefetch", () => {
		const { prefetcher, prefetchSentence, discardPrefetch } = make();
		prefetcher.beforeNarration();
		prefetcher.request({ generation: 2, page: 3, text: "다음." });
		prefetcher.request({ generation: 2, page: null, text: null });
		expect(discardPrefetch).toHaveBeenCalled();
		prefetcher.narrationQueued(2);
		expect(prefetchSentence).not.toHaveBeenCalled();
	});
});
