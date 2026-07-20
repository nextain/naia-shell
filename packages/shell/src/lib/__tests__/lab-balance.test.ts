import { describe, expect, it } from "vitest";
import { parseLabCredits } from "../lab-balance";

describe("parseLabCredits", () => {
	it("normalizes direct and nested gateway micro-dollar balances", () => {
		expect(parseLabCredits({ balance: 1_250_000 })).toBe(12.5);
		expect(parseLabCredits({ data: { balance: 250_000 } })).toBe(2.5);
	});

	it("accepts the already-normalized Naia account credits response", () => {
		expect(parseLabCredits({ credits: 10 })).toBe(10);
		expect(parseLabCredits({ data: { credits: 4.25 } })).toBe(4.25);
	});

	it("rejects malformed balances", () => {
		expect(parseLabCredits({ balance: "100" })).toBeNull();
		expect(parseLabCredits(null)).toBeNull();
	});
});