// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger", () => ({
	Logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { createWebSpeechSttSession } from "../web-speech-stt";

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
	start = vi.fn();
	stop = vi.fn();
	abort = vi.fn();

	constructor() {
		FakeSpeechRecognition.instances.push(this);
	}

	emitError(error: string, message = "") {
		this.onerror?.({ error, message });
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
