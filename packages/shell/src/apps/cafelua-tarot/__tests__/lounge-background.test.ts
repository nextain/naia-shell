import { describe, expect, it } from "vitest";
import { loungeBackground } from "../lounge-background";

describe("lounge background selection", () => {
	it.each([
		[2, "winter"],
		[3, "spring"],
		[5, "spring"],
		[6, "summer"],
		[8, "summer"],
		[9, "autumn"],
		[11, "autumn"],
		[12, "winter"],
	])("selects the season for month %i", (month, season) => {
		expect(loungeBackground(new Date(2026, month - 1, 1, 12))).toBe(
			`lounge-background-img/lounge_bg_${season}_day_sunny.webp`,
		);
	});
	it.each([
		[5, "night_closed"],
		[6, "day_sunny"],
		[16, "day_sunny"],
		[17, "sunset_clear"],
		[18, "sunset_clear"],
		[19, "night_closed"],
	])("selects the time of day at %i:00", (hour, time) => {
		expect(loungeBackground(new Date(2026, 9, 1, hour))).toBe(
			`lounge-background-img/lounge_bg_autumn_${time}.webp`,
		);
	});
});
