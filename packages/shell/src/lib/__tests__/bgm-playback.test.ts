import { describe, expect, it } from "vitest";
import {
	createBgmPlaybackPort,
	toBgmObservedContext,
	toBgmPlayToolResult,
} from "../bgm-playback";

describe("BGM playback observation contract", () => {
	it("returns a request receipt, not a currently-playing claim", () => {
		let clock = 1_000;
		const playback = createBgmPlaybackPort(() => clock);
		const requested = playback.request({ videoId: "track-a", title: "Track A" });

		expect(toBgmPlayToolResult(requested)).toMatchObject({
			ok: true,
			action: "play",
			playback: { playbackId: "bgm-playback-1", sequence: 1, status: "requested" },
			selected: { videoId: "track-a", title: "Track A" },
			announceTrack: false,
		});
		expect(toBgmObservedContext(requested)).toMatchObject({
			currentTrack: null,
			announceTrack: false,
		});
	});

	it("exposes a title only after the same fresh playback reports playing", () => {
		let clock = 1_000;
		const playback = createBgmPlaybackPort(() => clock);
		const requested = playback.request({ videoId: "track-a", title: "Track A" });
		clock += 100;
		const playing = playback.observe({
			playbackId: requested.playbackId,
			sequence: 2,
			status: "playing",
		});

		expect(playing).not.toBeNull();
		expect(toBgmObservedContext(playing!, clock)).toMatchObject({
			currentTrack: { videoId: "track-a", title: "Track A" },
			announceTrack: true,
		});
	});

	it("does not let a late event from track A overwrite track B", () => {
		const playback = createBgmPlaybackPort(() => 1_000);
		const a = playback.request({ videoId: "track-a", title: "Track A" });
		const b = playback.request({ videoId: "track-b", title: "Track B" });

		expect(
			playback.observe({ playbackId: a.playbackId, sequence: 2, status: "error" }),
		).toBeNull();
		expect(playback.current()).toMatchObject({
			playbackId: b.playbackId,
			status: "requested",
			selected: { videoId: "track-b" },
		});
	});

	it("does not accept a lower sequence for the active playback", () => {
		const playback = createBgmPlaybackPort(() => 1_000);
		const requested = playback.request({ videoId: "track-a", title: "Track A" });
		expect(
			playback.observe({ playbackId: requested.playbackId, sequence: 1, status: "playing" }),
		).toBeNull();
		expect(playback.current()?.status).toBe("requested");
	});
});
