import { describe, expect, it } from "vitest";
import { selectBackground, selectOnboardingBackground } from "../background-selection";

describe("selectBackground", () => {
	const other = "/background/naia-autumn-office-live.mp4";
	const sunrise = "/background/naia-sunrise-river.webp";
	const dawn = "/background/naia-dawn-city-uhd.webp";

	it.each([undefined, "", "  "])("treats %s as unset and prefers sunrise then dawn", (saved) => {
		expect(selectBackground([other, dawn, sunrise], saved)).toBe(sunrise);
		expect(selectBackground([other, dawn], saved)).toBe(dawn);
		expect(selectBackground([other], saved)).toBeUndefined();
	});

	it("preserves a saved selection", () => {
		expect(selectBackground([sunrise, dawn, other], "naia-autumn-office-live.mp4")).toBe(other);
	});

	it("does not replace a missing saved selection with a default", () => {
		expect(selectBackground([sunrise, dawn], "missing.webp")).toBeUndefined();
	});

	it("chooses dawn for onboarding when sunrise is absent even if another background comes first", () => {
		expect(selectOnboardingBackground([other, dawn])).toBe(dawn);
	});

	it("keeps the first available onboarding background when neither default exists", () => {
		expect(selectOnboardingBackground([other, "/background/another.webp"])).toBe(other);
		expect(selectOnboardingBackground([])).toBeUndefined();
	});
});
