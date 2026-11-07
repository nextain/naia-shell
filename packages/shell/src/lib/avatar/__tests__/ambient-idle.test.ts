import { describe, expect, it } from "vitest";
import { selectAmbientIdle } from "../ambient-idle";

const withKeyboard = {
	animations: {
		idle: { clip: "clips/idle.webm", loop: true },
		"keyboard-idle": { clip: "clips/keyboard-idle.webm", loop: true },
		"singing-keyboard": { clip: "clips/singing-keyboard.webm" },
	},
};
const plain = { animations: { idle: { clip: "clips/idle.webm", loop: true } } };

describe("selectAmbientIdle", () => {
	it("keeps the bundle idle when nothing is on", () => {
		expect(
			selectAmbientIdle(
				{ broadcastActive: false, bgmPlaying: "" },
				withKeyboard,
			),
		).toBeNull();
	});

	it("types on the keyboard while broadcasting or playing local BGM", () => {
		expect(
			selectAmbientIdle(
				{ broadcastActive: true, bgmPlaying: "" },
				withKeyboard,
			),
		).toBe("keyboard-idle");
		expect(
			selectAmbientIdle(
				{ broadcastActive: false, bgmPlaying: "local" },
				withKeyboard,
			),
		).toBe("keyboard-idle");
	});

	it("sings while a YouTube song plays, broadcast or not", () => {
		for (const broadcastActive of [false, true])
			expect(
				selectAmbientIdle(
					{ broadcastActive, bgmPlaying: "youtube" },
					withKeyboard,
				),
			).toBe("singing-keyboard");
	});

	it("leaves bundles without those animations alone", () => {
		expect(
			selectAmbientIdle(
				{ broadcastActive: true, bgmPlaying: "youtube" },
				plain,
			),
		).toBeNull();
	});
});
