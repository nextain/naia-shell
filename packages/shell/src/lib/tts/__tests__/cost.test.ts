import { describe, expect, it } from "vitest";
import { estimateSttCost, estimateTtsCost } from "../cost";

describe("estimateTtsCost", () => {
	it("edge is free", () => {
		expect(estimateTtsCost("edge", 1000)).toBe(0);
	});

	it("openai flat rate $15/1M", () => {
		expect(estimateTtsCost("openai", 1_000_000)).toBeCloseTo(15, 5);
		expect(estimateTtsCost("openai", 100)).toBeCloseTo(0.0015, 7);
	});

	it("elevenlabs flat rate $0.30/1K", () => {
		expect(estimateTtsCost("elevenlabs", 1000)).toBeCloseTo(0.3, 5);
	});

	// Voice tier-based providers
	it("google Neural2 voice = $16/1M", () => {
		expect(estimateTtsCost("google", 1_000_000, "ko-KR-Neural2-A")).toBeCloseTo(
			16,
			5,
		);
	});

	it("google Wavenet voice = $16/1M", () => {
		expect(estimateTtsCost("google", 1_000_000, "ko-KR-Wavenet-B")).toBeCloseTo(
			16,
			5,
		);
	});

	it("google Standard voice = $4/1M", () => {
		expect(
			estimateTtsCost("google", 1_000_000, "ko-KR-Standard-A"),
		).toBeCloseTo(4, 5);
	});

	it("google Chirp3-HD voice = $16/1M", () => {
		expect(
			estimateTtsCost("google", 1_000_000, "ko-KR-Chirp3-HD-Kore"),
		).toBeCloseTo(16, 5);
	});

	it("nextain (fallback) Neural2 = $16/1M", () => {
		expect(
			estimateTtsCost("nextain", 1_000_000, "ko-KR-Neural2-C"),
		).toBeCloseTo(16, 5);
	});

	it("nextain without voice defaults to conservative neural2", () => {
		expect(estimateTtsCost("nextain", 1_000_000)).toBeCloseTo(16, 5);
	});

	it("unknown provider without voice defaults to neural2", () => {
		expect(estimateTtsCost("unknown", 1_000_000)).toBeCloseTo(16, 5);
	});

	// Matches gateway _voice_tier exactly
	it("matches gateway tier: 12 chars of Neural2 text", () => {
		// Gateway: (12 / 1_000_000) * 16 = 0.000192
		expect(estimateTtsCost("google", 12, "ko-KR-Neural2-A")).toBeCloseTo(
			0.000192,
			8,
		);
	});

	it("matches gateway tier: 12 chars of Standard text", () => {
		// Gateway: (12 / 1_000_000) * 4 = 0.000048
		expect(estimateTtsCost("google", 12, "ko-KR-Standard-A")).toBeCloseTo(
			0.000048,
			8,
		);
	});
});

describe("estimateSttCost", () => {
	it("vosk is free", () => {
		expect(estimateSttCost("vosk", 60)).toBe(0);
	});

	it("whisper is free", () => {
		expect(estimateSttCost("whisper", 30)).toBe(0);
	});

	it("edge is free", () => {
		expect(estimateSttCost("edge", 10)).toBe(0);
	});

	it("google 15s = 1 increment = $0.006", () => {
		expect(estimateSttCost("google", 15)).toBeCloseTo(0.006, 5);
	});

	it("google 16s = 2 increments = $0.012", () => {
		expect(estimateSttCost("google", 16)).toBeCloseTo(0.012, 5);
	});

	it("google 3s = 1 increment (min)", () => {
		expect(estimateSttCost("google", 3)).toBeCloseTo(0.006, 5);
	});
});
