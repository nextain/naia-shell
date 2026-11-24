import { describe, expect, it, vi } from "vitest";
import type { SpeechPlan } from "../../avatar/nva-speech/speech-timing";
import {
	createAudioVrmLipSync,
	createBrowserVrmLipSync,
	createVrmMouthController,
	sampleVrmMouth,
} from "../lip-sync";

const speech: SpeechPlan = {
	version: "1",
	quality_mode: "aligned",
	audio: { duration_us: 800_000 },
	events: ["vowel-open", "vowel-spread", "vowel-round", "closed"].map(
		(unit, index) => ({
			unit,
			start_us: index * 200_000,
			end_us: (index + 1) * 200_000,
		}),
	),
};

describe("R43 VRM lip-sync", () => {
	it("writes timed aa, ih and ou into the VRM expression mixer and restores emotion after speech", () => {
		const values = { aa: 0.3, ih: 0, ou: 0, blink: 0.2 };
		const mouth = createVrmMouthController({
			expressionMap: values,
			getValue: (name: string) => values[name as keyof typeof values],
			setValue: (name: string, weight: number) => {
				values[name as keyof typeof values] = weight;
			},
		});
		for (const [position, expression] of [
			[0.1, "aa"],
			[0.3, "ih"],
			[0.5, "ou"],
		] as const) {
			mouth.restore();
			mouth.apply(sampleVrmMouth(speech, position, 0.08));
			expect(values[expression]).toBe(1);
			expect(values.blink).toBe(0.2);
		}
		mouth.restore();
		mouth.apply(sampleVrmMouth(speech, 0.7, 0.08));
		expect(values).toEqual({ aa: 0, ih: 0, ou: 0, blink: 0.2 });
		mouth.restore();
		expect(values).toEqual({ aa: 0.3, ih: 0, ou: 0, blink: 0.2 });
	});

	it("uses the legacy vowel name and does not open the mouth during silent audio", () => {
		let value = 0;
		const mouth = createVrmMouthController({
			expressionMap: { A: true },
			getValue: () => value,
			setValue: (name, weight) => {
				expect(name).toBe("A");
				value = weight;
			},
		});
		mouth.apply(sampleVrmMouth(speech, 0.3, 0.06));
		expect(value).toBeGreaterThan(0.6);
		mouth.restore();
		mouth.apply(sampleVrmMouth(speech, 0.3, 0.001));
		expect(value).toBe(0);
	});

	it("only opens while the audio clock advances through audible speech", () => {
		let time = 0;
		let level = 0.06;
		const frame = createAudioVrmLipSync("아 이 우", "ko", {
			clock: () => time,
			duration: () => 3,
			readSpeechLevel: () => level,
		});
		expect(frame()).toBeNull();
		time = 0.35;
		expect(frame()).toMatchObject({ viseme: "aa" });
		level = 0;
		expect(frame()).toBeNull();
		time = 3;
		level = 0.06;
		expect(frame()).toBeNull();
	});

	it("uses actual browser boundaries for scripts without local pronunciation units", () => {
		const time = vi.spyOn(performance, "now").mockReturnValue(1000);
		try {
			const speech = createBrowserVrmLipSync("こんにちは 世界", "ja");
			const frame = speech.start();
			expect(frame()).toMatchObject({ viseme: "aa" });
			time.mockReturnValue(1200);
			expect(frame()).toBeNull();
			speech.boundary(6, 0.2);
			expect(frame()).toMatchObject({ viseme: "aa" });
		} finally {
			time.mockRestore();
		}
	});
});
