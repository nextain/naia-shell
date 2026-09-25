import { describe, expect, it } from "vitest";
import { formatCredits, formatCreditsExact } from "../credits";

describe("formatCredits", () => {
	it("formats examples from specification correctly", () => {
		expect(formatCredits(1000)).toBe("1K");
		expect(formatCredits(2550)).toBe("2.55K");
		expect(formatCredits(12345)).toBe("12.34K");
		expect(formatCredits(1500000)).toBe("1,500K");
		expect(formatCredits(999.9)).toBe("999.9");
	});

	it("handles edge cases and additional test values", () => {
		expect(formatCredits(0)).toBe("0");
		expect(formatCredits(999)).toBe("999");
		expect(formatCredits(999.99)).toBe("999.99");
		expect(formatCredits(1000.009)).toBe("1K");
		expect(formatCredits(1009.99)).toBe("1K");
		expect(formatCredits(1010)).toBe("1.01K");
		expect(formatCredits(2500)).toBe("2.5K");
		expect(formatCredits(2550000)).toBe("2,550K");
	});

	it("handles negative numbers maintaining existing behavior", () => {
		expect(formatCredits(-500)).toBe("-500");
		expect(formatCredits(-1000)).toBe("-1,000");
		expect(formatCredits(-2550)).toBe("-2,550");
	});

	it("handles string inputs correctly", () => {
		expect(formatCredits("1000")).toBe("1K");
		expect(formatCredits("2550")).toBe("2.55K");
		expect(formatCredits("12345")).toBe("12.34K");
		expect(formatCredits("999.9")).toBe("999.9");
		expect(formatCredits("abc")).toBe("abc");
		expect(formatCredits("")).toBe("");
	});

	it("handles null and undefined", () => {
		expect(formatCredits(null)).toBe("");
		expect(formatCredits(undefined)).toBe("");
	});

	it("respects exactDecimals for values under 1000", () => {
		expect(formatCredits(12.5, 2)).toBe("12.50");
		expect(formatCredits(0, 2)).toBe("0.00");
		expect(formatCredits(2550, 2)).toBe("2.55K");
	});
});

describe("formatCreditsExact", () => {
	it("formats exact credits with thousands separator and max 4 fraction digits", () => {
		expect(formatCreditsExact(1000)).toBe("1,000");
		expect(formatCreditsExact(2550)).toBe("2,550");
		expect(formatCreditsExact(1500000)).toBe("1,500,000");
		expect(formatCreditsExact(999.9)).toBe("999.9");
		expect(formatCreditsExact(1000.009)).toBe("1,000.009");
		expect(formatCreditsExact(-2550)).toBe("-2,550");
		expect(formatCreditsExact("2550")).toBe("2,550");
		expect(formatCreditsExact(null)).toBe("");
		expect(formatCreditsExact(undefined)).toBe("");
		expect(formatCreditsExact("")).toBe("");
		expect(formatCreditsExact("abc")).toBe("abc");
	});

	it("supports exactDecimals parameter", () => {
		expect(formatCreditsExact(1000, 2)).toBe("1,000.00");
		expect(formatCreditsExact(2550, 2)).toBe("2,550.00");
		expect(formatCreditsExact(12.5, 2)).toBe("12.50");
	});
});
