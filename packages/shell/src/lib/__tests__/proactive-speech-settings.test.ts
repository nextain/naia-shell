import { describe, expect, it } from "vitest";
import {
	normalizeProactiveSpeechSettings,
	toSpeechProfileCommandInput,
} from "../proactive-speech-settings";

describe("PA-DJ-04 proactive speech settings", () => {
	it("normalizes proactive settings fail-closed", () => {
		expect(
			normalizeProactiveSpeechSettings({
				profile: "personal_radio_dj",
				timezone: "Asia/Seoul",
				idleMs: 5000,
				intervalMs: 30000,
				bgmAutoPlay: true,
				weatherConsented: true,
				weatherLatitude: 37.5665,
				weatherLongitude: 126.978,
				knowledgeScope: "expo-2026",
			}),
		).toEqual({
			profile: "personal_radio_dj",
			timezone: "Asia/Seoul",
			idleMs: 5000,
			intervalMs: 30000,
			bgmAutoPlay: true,
			weatherConsented: true,
			weatherLatitude: 37.5665,
			weatherLongitude: 126.978,
			knowledgeScope: "expo-2026",
		});
	});

	it.each([
		{ timezone: "bad/timezone" },
		{ weatherLatitude: 91, weatherLongitude: 0 },
		{ weatherLatitude: 0, weatherLongitude: 181 },
		{ weatherLatitude: Number.NaN, weatherLongitude: 0 },
		{ weatherLatitude: 0, weatherLongitude: Number.POSITIVE_INFINITY },
		{ weatherLatitude: 37, weatherLongitude: undefined },
		{ weatherLatitude: undefined, weatherLongitude: 127 },
		{ weatherLatitude: undefined, weatherLongitude: undefined },
	])(
		"rejects each invalid timezone or coordinate shape independently: %o",
		(invalid) => {
			const result = normalizeProactiveSpeechSettings({
				profile: "personal_radio_dj",
				timezone: "UTC",
				weatherConsented: true,
				weatherLatitude: 37,
				weatherLongitude: 127,
				...invalid,
			});
			expect(result.profile).toBe("disabled");
			expect(result.weatherLatitude).toBeUndefined();
			expect(result.weatherLongitude).toBeUndefined();
		},
	);

	it("accepts exact coordinate boundaries", () => {
		expect(
			normalizeProactiveSpeechSettings({
				profile: "personal_radio_dj",
				timezone: "UTC",
				weatherConsented: true,
				weatherLatitude: -90,
				weatherLongitude: 180,
			}).profile,
		).toBe("personal_radio_dj");
	});

	it("removes coordinates when weather consent is withdrawn", () => {
		const result = normalizeProactiveSpeechSettings({
			profile: "personal_radio_dj",
			timezone: "UTC",
			weatherConsented: false,
			weatherLatitude: 37,
			weatherLongitude: 127,
		});
		expect(result.weatherLatitude).toBeUndefined();
		expect(result.weatherLongitude).toBeUndefined();
	});

	it("omits coordinates from the agent command when consent is withdrawn", () => {
		expect(
			toSpeechProfileCommandInput({
				profile: "personal_radio_dj",
				timezone: "Asia/Seoul",
				weatherConsented: false,
				weatherLatitude: 37.5665,
				weatherLongitude: 126.978,
			}),
		).toEqual({
			profile: "personal_radio_dj",
			idleMs: undefined,
			djIntervalMs: undefined,
			introIntervalMs: undefined,
			timezone: "Asia/Seoul",
			bgmAutoPlayOptIn: undefined,
			weatherConsented: false,
			knowledgeScope: undefined,
		});
	});

	it("requires a non-empty knowledge scope for exhibition", () => {
		expect(
			normalizeProactiveSpeechSettings({
				profile: "exhibition_intro",
				timezone: "UTC",
				knowledgeScope: " ",
			}).profile,
		).toBe("disabled");
		expect(
			normalizeProactiveSpeechSettings({
				profile: "exhibition_intro",
				timezone: "UTC",
				knowledgeScope: "  expo-2026  ",
			}).knowledgeScope,
		).toBe("expo-2026");
	});
});
