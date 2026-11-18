// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger", () => ({
	Logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
	createWebSpeechSttSession,
	webSpeechSttOptions,
} from "../web-speech-stt";

/**
 * Minimal fake of the browser SpeechRecognition object, letting tests
 * fire synthetic onresult events the way WebView2/Chromium would.
 */
class FakeSpeechRecognition {
	static instances: FakeSpeechRecognition[] = [];
	lang = "";
	continuous = false;
	interimResults = false;
	maxAlternatives = 1;
	onresult: ((event: unknown) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onend: (() => void) | null = null;
	start = vi.fn();
	stop = vi.fn();
	abort = vi.fn();

	constructor() {
		FakeSpeechRecognition.instances.push(this);
	}

	emitError(error: string, message = "") {
		this.onerror?.({ error, message });
	}

	emitEnd() {
		this.onend?.();
	}

	emitResult(
		results: { transcript: string; confidence: number; isFinal: boolean }[],
	) {
		const resultList = results.map((r) => {
			const alt = { transcript: r.transcript, confidence: r.confidence };
			const item = Object.assign([alt], {
				isFinal: r.isFinal,
				length: 1,
				item: (index: number) => (index === 0 ? alt : undefined),
			});
			return item;
		});
		this.onresult?.({
			resultIndex: 0,
			results: Object.assign(resultList, { length: resultList.length }),
		});
	}
}

declare global {
	// eslint-disable-next-line no-var
	var SpeechRecognition: unknown;
}

describe("createWebSpeechSttSession — empty transcript detection (#615)", () => {
	beforeEach(() => {
		FakeSpeechRecognition.instances = [];
		(window as unknown as { SpeechRecognition: unknown }).SpeechRecognition =
			FakeSpeechRecognition;
	});

	it("forwards genuine non-empty results normally", async () => {
		const session = createWebSpeechSttSession("ko-KR");
		const results: { transcript: string; isFinal: boolean }[] = [];
		const errors: { code: string }[] = [];
		session.onResult((r) => results.push(r));
		session.onError?.((e) => errors.push(e));

		await session.start();
		const recognition = FakeSpeechRecognition.instances[0];
		recognition.emitResult([
			{ transcript: "안녕하세요", confidence: 0.9, isFinal: true },
		]);

		expect(results).toEqual([
			{ transcript: "안녕하세요", isFinal: true, confidence: 0.9 },
		]);
		expect(errors).toEqual([]);
	});

	it("does not treat repeated empty final transcripts as success (WebView2 broken backend)", async () => {
		const session = createWebSpeechSttSession("ko-KR");
		const results: { transcript: string; isFinal: boolean }[] = [];
		const errors: { code: string; message: string }[] = [];
		session.onResult((r) => results.push(r));
		session.onError?.((e) => errors.push(e));

		await session.start();
		const recognition = FakeSpeechRecognition.instances[0];

		// Matches the exact repro from #615: repeated final results with an
		// empty transcript and confidence 1.
		recognition.emitResult([
			{ transcript: "", confidence: 1, isFinal: true },
		]);
		recognition.emitResult([
			{ transcript: "", confidence: 1, isFinal: true },
		]);

		// Empty finals must never be forwarded as if they were real results.
		expect(results).toEqual([]);
		// After enough consecutive empty finals, the session must report an
		// error instead of silently doing nothing.
		expect(errors).toHaveLength(1);
		expect(errors[0].code).toBe("empty-transcript");
	});

	it("does not error on a single empty final followed by real speech", async () => {
		const session = createWebSpeechSttSession("ko-KR");
		const results: { transcript: string; isFinal: boolean }[] = [];
		const errors: { code: string }[] = [];
		session.onResult((r) => results.push(r));
		session.onError?.((e) => errors.push(e));

		await session.start();
		const recognition = FakeSpeechRecognition.instances[0];

		recognition.emitResult([
			{ transcript: "", confidence: 1, isFinal: true },
		]);
		recognition.emitResult([
			{ transcript: "날씨 어때요", confidence: 0.8, isFinal: true },
		]);

		expect(errors).toEqual([]);
		expect(results).toEqual([
			{ transcript: "날씨 어때요", isFinal: true, confidence: 0.8 },
		]);
	});

	it("web build (detectEmptyBackend: false) drops empty finals without erroring", async () => {
		const session = createWebSpeechSttSession("ko-KR", {
			detectEmptyBackend: false,
		});
		const results: { transcript: string; isFinal: boolean }[] = [];
		const errors: { code: string }[] = [];
		session.onResult((r) => results.push(r));
		session.onError?.((e) => errors.push(e));

		await session.start();
		const recognition = FakeSpeechRecognition.instances[0];

		// Music or a stop() flush in a real browser: several empty finals.
		for (let i = 0; i < 5; i++) {
			recognition.emitResult([
				{ transcript: "", confidence: 0, isFinal: true },
			]);
		}
		recognition.emitResult([
			{ transcript: "노래 틀어줘", confidence: 0.9, isFinal: true },
		]);

		expect(errors).toEqual([]);
		expect(results).toEqual([
			{ transcript: "노래 틀어줘", isFinal: true, confidence: 0.9 },
		]);
	});
});

describe("createWebSpeechSttSession — network error retry loop (#623)", () => {
	beforeEach(() => {
		FakeSpeechRecognition.instances = [];
		(window as unknown as { SpeechRecognition: unknown }).SpeechRecognition =
			FakeSpeechRecognition;
	});

	it("aborts the native recognizer on a fatal error instead of leaving it running", async () => {
		const session = createWebSpeechSttSession("ko-KR");
		const errors: { code: string }[] = [];
		session.onError?.((e) => errors.push(e));

		await session.start();
		const recognition = FakeSpeechRecognition.instances[0];
		recognition.emitError("network");

		expect(errors).toEqual([{ code: "network", message: "" }]);
		expect(recognition.abort).toHaveBeenCalledTimes(1);
	});

	it("ignores further onerror events fired on the same instance after a fatal error", async () => {
		// Repro for #623: some WebView2/Chromium builds without a working
		// speech backend keep restarting capture internally on "network"
		// errors, re-firing onerror on the same recognizer many times in a
		// row even after we tell it to stop. Each one must not re-log or
		// re-surface an error — otherwise the app spams an infinite retry.
		const session = createWebSpeechSttSession("ko-KR");
		const errors: { code: string }[] = [];
		session.onError?.((e) => errors.push(e));

		await session.start();
		const recognition = FakeSpeechRecognition.instances[0];
		recognition.emitError("network");
		recognition.emitError("network");
		recognition.emitError("network");

		expect(errors).toHaveLength(1);
		expect(recognition.abort).toHaveBeenCalledTimes(1);
	});

	it("detaches the recognizer's handlers so a stale instance cannot forward events", async () => {
		const session = createWebSpeechSttSession("ko-KR");
		session.onError?.(() => {});

		await session.start();
		const recognition = FakeSpeechRecognition.instances[0];
		recognition.emitError("network");

		expect(recognition.onresult).toBeNull();
		expect(recognition.onerror).toBeNull();
	});

	it("starts a fresh session normally after a prior fatal error was cleaned up", async () => {
		const session = createWebSpeechSttSession("ko-KR");
		const results: { transcript: string; isFinal: boolean }[] = [];
		const errors: { code: string }[] = [];
		session.onResult((r) => results.push(r));
		session.onError?.((e) => errors.push(e));

		await session.start();
		FakeSpeechRecognition.instances[0].emitError("network");
		expect(errors).toHaveLength(1);

		await session.start();
		const second = FakeSpeechRecognition.instances[1];
		second.emitResult([
			{ transcript: "다시 시작", confidence: 0.9, isFinal: true },
		]);

		expect(results).toEqual([
			{ transcript: "다시 시작", isFinal: true, confidence: 0.9 },
		]);
		expect(errors).toHaveLength(1);
	});
});

describe("createWebSpeechSttSession — build options (19판)", () => {
	beforeEach(() => {
		FakeSpeechRecognition.instances = [];
		(window as unknown as { SpeechRecognition: unknown }).SpeechRecognition =
			FakeSpeechRecognition;
	});

	it("desktop build keeps the #615 check: two empty finals report empty-transcript", async () => {
		const session = createWebSpeechSttSession(
			"ko-KR",
			webSpeechSttOptions(false),
		);
		const errors: { code: string }[] = [];
		session.onError?.((e) => errors.push(e));

		await session.start();
		const recognition = FakeSpeechRecognition.instances[0];
		recognition.emitResult([{ transcript: "", confidence: 1, isFinal: true }]);
		recognition.emitResult([{ transcript: "", confidence: 1, isFinal: true }]);

		expect(errors.map((e) => e.code)).toEqual(["empty-transcript"]);
	});

	it("web build drops empty finals without erroring", async () => {
		const session = createWebSpeechSttSession(
			"ko-KR",
			webSpeechSttOptions(true),
		);
		const errors: { code: string }[] = [];
		session.onError?.((e) => errors.push(e));

		await session.start();
		const recognition = FakeSpeechRecognition.instances[0];
		for (let i = 0; i < 5; i++) {
			recognition.emitResult([
				{ transcript: "", confidence: 0, isFinal: true },
			]);
		}

		expect(errors).toEqual([]);
	});
});

describe("createWebSpeechSttSession — late results after stop (19판)", () => {
	beforeEach(() => {
		FakeSpeechRecognition.instances = [];
		(window as unknown as { SpeechRecognition: unknown }).SpeechRecognition =
			FakeSpeechRecognition;
	});

	it("drops results a stopped recognizer flushes after stop()", async () => {
		const session = createWebSpeechSttSession("ko-KR");
		const results: { transcript: string }[] = [];
		session.onResult((r) => results.push(r));

		await session.start();
		const recognition = FakeSpeechRecognition.instances[0];
		await session.stop();
		// Real browsers still deliver the pending final after stop().
		recognition.emitResult([
			{ transcript: "멈춘 뒤 결과", confidence: 0.9, isFinal: true },
		]);

		expect(recognition.stop).toHaveBeenCalledTimes(1);
		expect(results).toEqual([]);
	});

	it("after a pause/resume only the new recognizer forwards results", async () => {
		const session = createWebSpeechSttSession("ko-KR");
		const results: { transcript: string }[] = [];
		session.onResult((r) => results.push(r));

		await session.start();
		const first = FakeSpeechRecognition.instances[0];
		// TTS self-echo pause: stop then start again.
		await session.stop();
		await session.start();
		const second = FakeSpeechRecognition.instances[1];

		first.emitResult([
			{ transcript: "나이아 목소리 메아리", confidence: 0.9, isFinal: true },
		]);
		second.emitResult([
			{ transcript: "사용자 말", confidence: 0.9, isFinal: true },
		]);

		expect(results.map((r) => r.transcript)).toEqual(["사용자 말"]);
	});

	it("detaches onerror on stop() so a late aborted error from a TTS-paused recognizer never kills the resumed recognizer", async () => {
		const session = createWebSpeechSttSession("ko-KR", webSpeechSttOptions(true));
		const results: { transcript: string }[] = [];
		const errors: { code: string }[] = [];
		session.onResult((r) => results.push(r));
		session.onError?.((e) => errors.push(e));

		await session.start();
		const first = FakeSpeechRecognition.instances[0];
		// Capture old handler reference in case a broken browser retained an internal closure
		const staleOnError = first.onerror;
		await session.stop();
		expect(first.onerror).toBeNull();
		expect(first.onresult).toBeNull();
		expect(first.onend).toBeNull();

		// Resume after TTS ends
		await session.start();
		const second = FakeSpeechRecognition.instances[1];

		// Even if stale closure is invoked directly after new start(), instance guard blocks it
		staleOnError?.({ error: "aborted", message: "late abort" });
		expect(errors).toEqual([]);
		expect(second.abort).not.toHaveBeenCalled();

		second.emitResult([
			{ transcript: "정상 이어 말하기", confidence: 0.95, isFinal: true },
		]);
		expect(results.map((r) => r.transcript)).toEqual(["정상 이어 말하기"]);
	});
});

describe("createWebSpeechSttSession — continuous voice recovery (Stage 1)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		FakeSpeechRecognition.instances = [];
		(window as unknown as { SpeechRecognition: unknown }).SpeechRecognition =
			FakeSpeechRecognition;
	});

	it("silently recovers and auto-restarts on no-speech, aborted, transient audio-capture, and natural onend in web mode", async () => {
		const session = createWebSpeechSttSession("ko-KR", {
			...webSpeechSttOptions(true),
			recoveryDelayMs: 50,
			maxAudioCaptureRetries: 2,
		});
		const results: { transcript: string }[] = [];
		const errors: { code: string }[] = [];
		session.onResult((r) => results.push(r));
		session.onError?.((e) => errors.push(e));

		await session.start();
		expect(FakeSpeechRecognition.instances).toHaveLength(1);

		// 1) no-speech -> silent restart
		FakeSpeechRecognition.instances[0].emitError("no-speech");
		await vi.advanceTimersByTimeAsync(60);
		expect(errors).toEqual([]);
		expect(FakeSpeechRecognition.instances).toHaveLength(2);

		// 2) aborted -> silent restart
		FakeSpeechRecognition.instances[1].emitError("aborted");
		await vi.advanceTimersByTimeAsync(60);
		expect(errors).toEqual([]);
		expect(FakeSpeechRecognition.instances).toHaveLength(3);

		// 3) browser natural onend -> silent restart
		FakeSpeechRecognition.instances[2].emitEnd();
		await vi.advanceTimersByTimeAsync(60);
		expect(errors).toEqual([]);
		expect(FakeSpeechRecognition.instances).toHaveLength(4);

		// 4) transient audio-capture (2x within maxAudioCaptureRetries=2) -> silent restart
		FakeSpeechRecognition.instances[3].emitError("audio-capture");
		await vi.advanceTimersByTimeAsync(150);
		expect(errors).toEqual([]);
		expect(FakeSpeechRecognition.instances).toHaveLength(5);

		FakeSpeechRecognition.instances[4].emitResult([
			{ transcript: "마이크 복구 완료", confidence: 0.9, isFinal: true },
		]);
		expect(results.map((r) => r.transcript)).toEqual(["마이크 복구 완료"]);

		// 5) persistent audio-capture exceeding maxAudioCaptureRetries surfaces cleanly
		FakeSpeechRecognition.instances[4].emitError("audio-capture");
		await vi.advanceTimersByTimeAsync(150);
		FakeSpeechRecognition.instances[5].emitError("audio-capture");
		await vi.advanceTimersByTimeAsync(300);
		FakeSpeechRecognition.instances[6].emitError("audio-capture");
		expect(errors.map((e) => e.code)).toEqual(["audio-capture"]);

		await session.stop();
		vi.useRealTimers();
	});

	it("aborts any prior active recognizer if start() is called twice without leaking duplicate listeners", async () => {
		vi.useRealTimers();
		const session = createWebSpeechSttSession("ko-KR", webSpeechSttOptions(true));
		await session.start();
		const first = FakeSpeechRecognition.instances[0];
		await session.start();
		const second = FakeSpeechRecognition.instances[1];

		expect(first.abort).toHaveBeenCalledTimes(1);
		expect(first.onresult).toBeNull();
		expect(second.start).toHaveBeenCalledTimes(1);
		await session.stop();
	});
});
