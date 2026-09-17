import { describe, expect, it } from "vitest";
import { estimateSttCost, estimateTtsCost } from "../cost";

describe("estimateTtsCost (#603)", () => {
	it("edge / local providers are free", () => {
		expect(estimateTtsCost("edge", 1_000_000)).toBe(0);
		expect(estimateTtsCost("vllm", 1_000_000)).toBe(0);
		expect(estimateTtsCost("naia-local-voice", 1_000_000)).toBe(0);
		expect(estimateTtsCost("browser", 1_000_000)).toBe(0);
	});

	it("nextain fallback uses Neural HD estimate when gateway omits cost", () => {
		expect(
			estimateTtsCost("nextain", 1_000_000, "ko-KR-SunHi:DragonHDLatestNeural"),
		).toBeCloseTo(16, 5);
		expect(estimateTtsCost("nextain", 12)).toBeCloseTo(0.000192, 8);
	});

	it("removed third-party providers estimate as zero (absent)", () => {
		expect(estimateTtsCost("google", 1_000_000, "ko-KR-Neural2-A")).toBe(0);
		expect(estimateTtsCost("openai", 1_000_000)).toBe(0);
		expect(estimateTtsCost("elevenlabs", 1000)).toBe(0);
	});
});

describe("estimateSttCost (#603)", () => {
	it("local/browser STT is free", () => {
		expect(estimateSttCost("vosk", 60)).toBe(0);
		expect(estimateSttCost("whisper", 60)).toBe(0);
		expect(estimateSttCost("web-speech", 60)).toBe(0);
		expect(estimateSttCost("vllm", 60)).toBe(0);
	});

	it("removed cloud STT providers estimate as zero", () => {
		expect(estimateSttCost("google", 15)).toBe(0);
		expect(estimateSttCost("elevenlabs", 15)).toBe(0);
		expect(estimateSttCost("nextain", 15)).toBe(0);
	});
});
