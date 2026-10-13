import { describe, expect, it, vi } from "vitest";
import { type FlipAudioContext, TarotAudioController } from "../audio";

function createFakeAudio() {
	const events: string[] = [];
	const oscillator = {
		type: "sine",
		frequency: {
			setValueAtTime: vi.fn(),
			exponentialRampToValueAtTime: vi.fn(),
		},
		connect: vi.fn(),
		start: vi.fn(() => events.push("flip:start")),
		stop: vi.fn(() => events.push("flip:stop")),
		onended: null as (() => void) | null,
	} as unknown as OscillatorNode;
	const gain = {
		gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
		connect: vi.fn(),
	} as unknown as GainNode;
	const context = {
		currentTime: 2,
		destination: {} as AudioNode,
		createOscillator: () => oscillator,
		createGain: () => gain,
		resume: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
	} as FlipAudioContext;
	const bgm = {
		volume: 1,
		loop: false,
		paused: true,
		play: vi.fn(async () => {
			events.push("bgm:play");
		}),
		pause: vi.fn(() => {
			events.push("bgm:pause");
		}),
	};
	return { events, oscillator, context, bgm };
}

describe("Cafe Lua Tarot shared sound control", () => {
	it("layers the synthesized card cue over looping BGM and mutes both together", async () => {
		const fixture = createFakeAudio();
		const controller = new TarotAudioController(
			fixture.bgm,
			() => fixture.context,
		);
		expect(fixture.bgm.loop).toBe(true);
		expect(fixture.bgm.volume).toBe(0.42);
		await expect(controller.startBgm()).resolves.toBe(true);
		await expect(controller.playFlip()).resolves.toBe(true);
		expect(fixture.events).toEqual(["bgm:play", "flip:start", "flip:stop"]);
		expect(fixture.context.resume).toHaveBeenCalledOnce();
		controller.setMuted(true);
		expect(fixture.bgm.pause).toHaveBeenCalledOnce();
		expect(fixture.events).toEqual([
			"bgm:play",
			"flip:start",
			"flip:stop",
			"bgm:pause",
			"flip:stop",
		]);
		expect(controller.isMuted).toBe(true);
	});

	it("reports autoplay rejection and retries playback after unmute", async () => {
		const fixture = createFakeAudio();
		fixture.bgm.play.mockRejectedValueOnce(new Error("NotAllowedError"));
		const playback: boolean[] = [];
		const controller = new TarotAudioController(
			fixture.bgm,
			() => fixture.context,
			(playing) => playback.push(playing),
		);
		expect(await controller.startBgm()).toBe(false);
		controller.setMuted(true);
		fixture.bgm.play.mockResolvedValue(undefined);
		controller.setMuted(false);
		await Promise.resolve();
		expect(fixture.bgm.play).toHaveBeenCalledTimes(2);
		expect(playback).toContain(false);
		expect(playback).toContain(true);
	});
});
