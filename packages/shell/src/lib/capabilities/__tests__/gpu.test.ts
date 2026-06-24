import { describe, expect, it } from "vitest";
import { parseVramResult } from "../gpu";

describe("parseVramResult", () => {
	it("accepts a positive finite number", () => {
		expect(parseVramResult(12)).toBe(12);
		expect(parseVramResult(24)).toBe(24);
	});

	it("rejects null / non-number / non-positive / non-finite → null", () => {
		expect(parseVramResult(null)).toBeNull();
		expect(parseVramResult(undefined)).toBeNull();
		expect(parseVramResult("12")).toBeNull();
		expect(parseVramResult(0)).toBeNull();
		expect(parseVramResult(-8)).toBeNull();
		expect(parseVramResult(Number.NaN)).toBeNull();
		expect(parseVramResult(Number.POSITIVE_INFINITY)).toBeNull();
	});
});
