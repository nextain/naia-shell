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
		const requested = playback.request({
			videoId: "track-a",
			title: "Track A",
		});

		expect(toBgmPlayToolResult(requested)).toMatchObject({
			ok: true,
			action: "play",
			playback: {
				playbackId: "bgm-playback-1",
				sequence: 1,
				status: "requested",
			},
			announceTrack: false,
		});
		expect(toBgmPlayToolResult(requested)).not.toHaveProperty("selected");
		expect(toBgmPlayToolResult(requested)).not.toHaveProperty("currentTrack");
		expect(toBgmObservedContext(requested)).toMatchObject({
			currentTrack: null,
			announceTrack: false,
		});
	});

	it("exposes a title only after the same fresh playback reports playing", () => {
		let clock = 1_000;
		const playback = createBgmPlaybackPort(() => clock);
		const requested = playback.request({
			videoId: "track-a",
			title: "Track A",
		});
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
		expect(toBgmPlayToolResult(playing!).instruction).toContain(
			"Playback is confirmed",
		);
		expect(toBgmPlayToolResult(playing!).instruction).not.toContain(
			"not confirmed",
		);
	});

	it("still names a playing track after the freshness window", () => {
		let clock = 1_000;
		const playback = createBgmPlaybackPort(() => clock);
		const requested = playback.request({
			videoId: "track-a",
			title: "Track A",
		});
		clock += 100;
		playback.observe({
			playbackId: requested.playbackId,
			sequence: 2,
			status: "playing",
		});
		clock += 30_000;
		expect(
			toBgmObservedContext(playback.current(), clock),
		).toMatchObject({
			currentTrack: { videoId: "track-a", title: "Track A" },
			announceTrack: true,
		});
	});

	it("refreshes a long playback with observed position and duration", () => {
		let clock = 1_000;
		const playback = createBgmPlaybackPort(() => clock);
		const requested = playback.request({
			videoId: "long-track",
			title: "Long Track",
		});
		clock += 6_000;
		const playing = playback.observe({
			playbackId: requested.playbackId,
			sequence: 2,
			status: "playing",
			currentTime: 6,
			duration: 3_600,
		});

		expect(toBgmObservedContext(playing, clock)).toMatchObject({
			playback: {
				currentTime: 6,
				duration: 3_600,
			},
			currentTrack: { videoId: "long-track", title: "Long Track" },
			announceTrack: true,
		});
	});

	it("does not let a late event from track A overwrite track B", () => {
		const playback = createBgmPlaybackPort(() => 1_000);
		const a = playback.request({ videoId: "track-a", title: "Track A" });
		const b = playback.request({ videoId: "track-b", title: "Track B" });

		expect(
			playback.observe({
				playbackId: a.playbackId,
				sequence: 2,
				status: "error",
			}),
		).toBeNull();
		expect(playback.current()).toMatchObject({
			playbackId: b.playbackId,
			status: "requested",
			selected: { videoId: "track-b" },
		});
	});

	it("does not accept a lower sequence for the active playback", () => {
		const playback = createBgmPlaybackPort(() => 1_000);
		const requested = playback.request({
			videoId: "track-a",
			title: "Track A",
		});
		expect(
			playback.observe({
				playbackId: requested.playbackId,
				sequence: 1,
				status: "playing",
			}),
		).toBeNull();
		expect(playback.current()?.status).toBe("requested");
	});

	it("queues a second tool request and promotes it only after the active track ends", () => {
		const playback = createBgmPlaybackPort(() => 1_000);
		const first = playback.enqueue({ videoId: "track-a", title: "Track A" });
		const second = playback.enqueue({ videoId: "track-b", title: "Track B" });

		expect(first).toMatchObject({
			disposition: "play",
			playback: { selected: { videoId: "track-a" } },
		});
		expect(second).toMatchObject({
			disposition: "queued",
			queued: { position: 1, selected: { videoId: "track-b" } },
		});
		expect(playback.current()?.selected.videoId).toBe("track-a");
		expect(playback.queue()).toHaveLength(1);

		const active = playback.current()!;
		playback.observe({
			playbackId: active.playbackId,
			sequence: 2,
			status: "ended",
		});
		const promoted = playback.advance();
		expect(promoted).toMatchObject({
			selected: { videoId: "track-b" },
			status: "requested",
		});
		expect(playback.queue()).toHaveLength(0);
	});
});
