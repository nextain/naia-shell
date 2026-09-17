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
