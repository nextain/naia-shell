import { describe, expect, it } from "vitest";
import { randomSaccadeInterval } from "../eye-motions";

describe("randomSaccadeInterval", () => {
	it("returns a positive number", () => {
		const interval = randomSaccadeInterval();
		expect(interval).toBeGreaterThan(0);
	});

	it("returns values in expected range (800-4800ms)", () => {
		// Max = last bucket (4000) + random * step (400) = 4800
		for (let i = 0; i < 100; i++) {
			const interval = randomSaccadeInterval();
			expect(interval).toBeGreaterThanOrEqual(800);
			expect(interval).toBeLessThanOrEqual(4800);
		}
	});

	it("produces varying results (not constant)", () => {
		const results = new Set<number>();
		for (let i = 0; i < 20; i++) {
			results.add(Math.round(randomSaccadeInterval()));
		}
		expect(results.size).toBeGreaterThan(1);
	});
});
