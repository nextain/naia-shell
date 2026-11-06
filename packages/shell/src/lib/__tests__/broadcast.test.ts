import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	connectSourceNodeToSharedContext,
	getBroadcastBridgeSnapshot,
	isBroadcastActive,
	setBroadcastAudioTapNode,
	setBroadcastBridgeSnapshot,
} from "../broadcast-audio-bridge";
import {
	BROADCAST_PLATFORM_PRESETS,
	canStartBroadcastWithConfig,
	checkYoutubeBgmAllowedDuringBroadcast,
	classifyBrainProvider,
	computeBroadcastSessionMetrics,
	formatBroadcastElapsed,
	int16ToBase64,
	maskStreamKeyForDisplay,
	PcmStereoFrameBundler,
	packStereoFloat32ToS16le,
	redactFfmpegArgs,
	redactStreamKey,
	resolveBroadcastBrainKind,
} from "../broadcast-client";
import { setLocale, t } from "../i18n";

describe("UC-BROADCAST-STREAM-026: broadcast presets and stream key redaction", () => {
	it("configures platform keyframe intervals (-g 60 vs -g 30) and default bitrates (6M vs 8M)", () => {
		expect(BROADCAST_PLATFORM_PRESETS.youtube.gopAt30Fps).toBe(60);
		expect(BROADCAST_PLATFORM_PRESETS.youtube.keyframeSeconds).toBe(2);
		expect(BROADCAST_PLATFORM_PRESETS.youtube.defaultVideoBitrate).toBe("6M");
		expect(BROADCAST_PLATFORM_PRESETS.youtube.audioBitrate).toBe("160k");
		expect(BROADCAST_PLATFORM_PRESETS.youtube.sampleRate).toBe(48000);

		expect(BROADCAST_PLATFORM_PRESETS.twitch.gopAt30Fps).toBe(60);
		expect(BROADCAST_PLATFORM_PRESETS.twitch.defaultVideoBitrate).toBe("6M");

		expect(BROADCAST_PLATFORM_PRESETS.chzzk.gopAt30Fps).toBe(30);
		expect(BROADCAST_PLATFORM_PRESETS.chzzk.keyframeSeconds).toBe(1);
		expect(BROADCAST_PLATFORM_PRESETS.chzzk.defaultVideoBitrate).toBe("8M");

		expect(BROADCAST_PLATFORM_PRESETS.soop.gopAt30Fps).toBe(60);
		expect(BROADCAST_PLATFORM_PRESETS.soop.defaultVideoBitrate).toBe("6M");
	});

	it("redacts the stream key with *** across strings and ffmpeg argument arrays", () => {
		const secret = "live_sk_987654321_secret";
		const args = [
			"-f",
			"flv",
			`rtmps://a.rtmp.youtube.com/live2/${secret}`,
		];
		const redacted = redactFfmpegArgs(args, secret);
		expect(redacted.join(" ")).not.toContain(secret);
		expect(redacted[2]).toBe("rtmps://a.rtmp.youtube.com/live2/***");
		expect(
			redactStreamKey(`failed to connect to rtmp://host/app/${secret}`, secret),
		).toBe("failed to connect to rtmp://host/app/***");
		expect(maskStreamKeyForDisplay(secret)).toBe("••••••••");
		expect(maskStreamKeyForDisplay("")).toBe("");
	});

	it("enables broadcast start only when a non-empty stream key is configured", () => {
		expect(canStartBroadcastWithConfig(null)).toBe(false);
		expect(canStartBroadcastWithConfig({ broadcastStreamKey: "" })).toBe(false);
		expect(canStartBroadcastWithConfig({ broadcastStreamKey: "   " })).toBe(
			false,
		);
		expect(
			canStartBroadcastWithConfig({ broadcastStreamKey: "sk-configured" }),
		).toBe(true);
	});
});

describe("UC-BROADCAST-STREAM-026: 48kHz stereo PCM frame bundling", () => {
	it("packs planar Float32 stereo channels into clamped s16le interleaved samples", () => {
		const left = new Float32Array([-1.5, -1.0, 0, 0.5, 1.0, 1.5]);
		const right = new Float32Array([1.0, 0.5, 0, -0.5, -1.0, -1.5]);
		const s16 = packStereoFloat32ToS16le(left, right);
		expect(Array.from(s16)).toEqual([
			-32768, 32767, -32768, 16384, 0, 0, 16384, -16384, 32767, -32768, 32767,
			-32768,
		]);
	});

	it("accumulates 128-frame Web Audio quanta into fixed-size stereo chunks and flushes remainder", () => {
		const bundler = new PcmStereoFrameBundler(256); // 256 stereo frames = 512 Int16 samples
		const quantumLeft = new Float32Array(128).fill(0.25);
		const quantumRight = new Float32Array(128).fill(-0.25);

		const first = bundler.push(quantumLeft, quantumRight);
		expect(first).toHaveLength(0);

		const second = bundler.push(quantumLeft, quantumRight);
		expect(second).toHaveLength(1);
		expect(second[0].length).toBe(512);
		expect(second[0][0]).toBe(8192);
		expect(second[0][1]).toBe(-8192);

		// Push a partial 64-frame tail and flush
		const tail = new Float32Array(64).fill(0.5);
		expect(bundler.push(tail, tail)).toHaveLength(0);
		const flushed = bundler.flush();
		expect(flushed).not.toBeNull();
		expect(flushed?.length).toBe(128);
		expect(int16ToBase64(flushed!).length).toBeGreaterThan(0);
	});

	it("routes shared AudioContext source nodes to both destination and active broadcast tap", () => {
		const connectedTargets: unknown[] = [];
		const fakeSource = {
			connect: vi.fn((target: unknown) => {
				connectedTargets.push(target);
			}),
		} as unknown as AudioNode;
		const fakeDestination = { kind: "destination" };
		const fakeTap = { kind: "worklet-tap" } as unknown as AudioNode;
		const fakeCtx = { destination: fakeDestination } as unknown as AudioContext;

		setBroadcastAudioTapNode(fakeTap);
		connectSourceNodeToSharedContext(fakeSource, fakeCtx);
		expect(connectedTargets).toEqual([fakeDestination, fakeTap]);

		connectedTargets.length = 0;
		setBroadcastAudioTapNode(null);
		connectSourceNodeToSharedContext(fakeSource, fakeCtx);
		expect(connectedTargets).toEqual([fakeDestination]);
	});
});

describe("UC-BROADCAST-STREAM-026: broadcast session log calculation and YouTube BGM guard", () => {
	beforeEach(() => {
		setBroadcastBridgeSnapshot({
			state: "idle",
			elapsedSeconds: 0,
			hasStreamKey: false,
			lastError: null,
		});
	});

	it("calculates answers, credits_used, and brain ('local' | 'gateway' | 'both') for log.jsonl", () => {
		expect(classifyBrainProvider("ollama")).toBe("local");
		expect(classifyBrainProvider("nextain")).toBe("gateway");
		expect(resolveBroadcastBrainKind(["ollama"])).toBe("local");
		expect(resolveBroadcastBrainKind(["nextain"])).toBe("gateway");
		expect(resolveBroadcastBrainKind(["ollama", "nextain"])).toBe("both");

		const fromCredits = computeBroadcastSessionMetrics({
			startAnswerCount: 3,
			endAnswerCount: 11,
			startCredits: 500.5,
			endCredits: 462.25,
			providersUsed: ["ollama", "nextain"],
		});
		expect(fromCredits).toEqual({
			answers: 8,
			creditsUsed: 38.25,
			brain: "both",
		});

		const fromUsd = computeBroadcastSessionMetrics({
			startAnswerCount: 1,
			endAnswerCount: 5,
			startCostUsdNaia: 0.01,
			endCostUsdNaia: 0.025,
			providersUsed: ["nextain"],
		});
		expect(fromUsd).toEqual({
			answers: 4,
			creditsUsed: 15,
			brain: "gateway",
		});
	});

	it("blocks YouTube BGM during active broadcast and surfaces '방송 중엔 내 곡만'", async () => {
		await setLocale("ko");
		setBroadcastBridgeSnapshot({ state: "live", elapsedSeconds: 65 });
		expect(isBroadcastActive(getBroadcastBridgeSnapshot().state)).toBe(true);
		expect(formatBroadcastElapsed(65)).toBe("01:05");

		const guardWhileLive = checkYoutubeBgmAllowedDuringBroadcast(true);
		expect(guardWhileLive.allowed).toBe(false);
		expect(guardWhileLive.forcedMode).toBe("local");
		expect(guardWhileLive.noticeKey).toBe("broadcast.bgmLocalOnlyNotice");
		expect(t(guardWhileLive.noticeKey!)).toBe("방송 중엔 내 곡만");

		const guardWhenIdle = checkYoutubeBgmAllowedDuringBroadcast(false);
		expect(guardWhenIdle.allowed).toBe(true);
		expect(guardWhenIdle.forcedMode).toBe("youtube");
		expect(guardWhenIdle.noticeKey).toBeNull();
	});
});
