// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NvaManifest } from "../../../nva";
import { PrebakedAvatarRenderer } from "../../prebaked-renderer";
import {
	CanonicalSpeechStage,
	type SpeechPlayerLike,
	canonicalSpeechAssetPaths,
	hasCanonicalSpeechMotion,
} from "../canonical-speech-stage";
import type { SpeechPlan } from "../speech-timing";

const here = dirname(fileURLToPath(import.meta.url));
const vendorDir = join(here, "..", "vendor");
const shellSrc = join(here, "..", "..", "..", "..");

function plan(mode: string): SpeechPlan {
	return {
		version: "1",
		quality_mode: mode as SpeechPlan["quality_mode"],
		audio: { duration_us: 400_000 },
		events: [{ unit: "sil", start_us: 0, end_us: 400_000 }],
	};
}

function manifest(withSpeech = true): NvaManifest {
	return {
		nva_version: "0.2",
		canvas: { width: 100, height: 100 },
		animations: {
			idle: { clip: "clips/idle.webm", loop: true, can_talk: false },
			talking: { clip: "clips/talking-ko.webm", loop: true, can_talk: true },
		},
		...(withSpeech
			? {
					speech_motion: {
						version: "1",
						representation: "whole-head-layer",
						region: [0, 0, 10, 10],
						neutral_head: "speech/neutral.png",
						atlas: "speech/atlas.bin",
						atlas_index: "speech/atlas.json",
						validation_report: "speech/validation.json",
						quality_report: "speech/quality.json",
						provenance: "speech/provenance.json",
					},
				}
			: {}),
	} as NvaManifest;
}

class FakePlayer implements SpeechPlayerLike {
	state = "empty";
	calls: string[] = [];
	clock: (() => number) | null = null;
	loadGate: Promise<void> = Promise.resolve();
	async loadAudioClock() {
		this.calls.push("loadAudioClock");
		await this.loadGate;
		this.state = "ready";
	}
	async loadExternal() {
		this.calls.push("loadExternal");
		await this.loadGate;
		this.state = "ready";
	}
	updateExternalPlan(next: SpeechPlan) {
		this.calls.push(`update:${next.quality_mode}`);
	}
	async playAudioClock(clock: () => number) {
		this.calls.push("playAudioClock");
		this.clock = clock;
		this.state = "speaking";
	}
	async playExternal(clock: () => number) {
		this.calls.push("playExternal");
		this.clock = clock;
		this.state = "speaking";
	}
	stop() {
		this.calls.push("stop");
		if (this.state === "speaking") this.state = "ready";
	}
	dispose() {
		this.calls.push("dispose");
		this.state = "disposed";
	}
}

function stageWith(player: FakePlayer, loadAsset = vi.fn()) {
	const host = document.createElement("video");
	const parent = document.createElement("div");
	parent.appendChild(host);
	loadAsset.mockImplementation(async (path: string) => new Blob([path]));
	const stage = new CanonicalSpeechStage({
		manifest: manifest(),
		host,
		loadAsset,
		createPlayer: () => player,
	});
	return { stage, parent, loadAsset };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("vendored canonical player (byte-identical, VENDOR.json)", () => {
	const vendor = JSON.parse(
		readFileSync(join(vendorDir, "VENDOR.json"), "utf8"),
	) as {
		repository: string;
		commit: string;
		files: Record<string, { sha256: string; size: number }>;
	};

	it("every vendored .js file matches its recorded sha256 and size", () => {
		for (const [name, expected] of Object.entries(vendor.files)) {
			const bytes = readFileSync(join(vendorDir, name));
			expect(bytes.length, name).toBe(expected.size);
			expect(createHash("sha256").update(bytes).digest("hex"), name).toBe(
				expected.sha256,
			);
		}
	});

	it("has no unrecorded .js file and records the canonical source", () => {
		const onDisk = readdirSync(vendorDir)
			.filter((name) => name.endsWith(".js"))
			.sort();
		expect(onDisk).toEqual(Object.keys(vendor.files).sort());
		expect(vendor.repository).toBe("nextain/naia-video-avatar");
		expect(vendor.commit).toMatch(/^[0-9a-f]{7,40}$/);
	});
});

describe("no sound-independent mouth loop in Shell product code (SoT 8)", () => {
	function productFiles(dir: string): string[] {
		const out: string[] = [];
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) {
				if (name === "__tests__" || name === "vendor") continue;
				out.push(...productFiles(path));
			} else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
				out.push(path);
			}
		}
		return out;
	}

	it("no product file plays visemes.aiueo, cycles vowels, or loops a talking clip on speech", () => {
		const offenders: string[] = [];
		const forbidden = [
			/visemes\??\.aiueo/,
			/SPEECH_SEQUENCE/,
			/createMouthController/,
			/\["A",\s*"I",\s*"U",\s*"E",\s*"O"\]/,
			/motions\??\.talking\??\.clip/,
		];
		for (const file of productFiles(shellSrc)) {
			const text = readFileSync(file, "utf8");
			for (const pattern of forbidden)
				if (pattern.test(text))
					offenders.push(`${relative(shellSrc, file)} ${pattern}`);
		}
		expect(offenders).toEqual([]);
	});

	it("the quarantined A-I-U-E-O controller is gone from lib/vrm", () => {
		expect(readdirSync(join(shellSrc, "lib", "vrm"))).not.toContain("mouth.ts");
	});
});

describe("CanonicalSpeechStage", () => {
	it("lists every animation clip plus the speech bundle files", () => {
		const paths = canonicalSpeechAssetPaths(manifest());
		expect(paths).toContain("clips/idle.webm");
		expect(paths).toContain("clips/talking-ko.webm");
		expect(paths).toContain("speech/atlas.bin");
		expect(paths).toContain("speech/neutral.png");
		expect(hasCanonicalSpeechMotion(manifest())).toBe(true);
		expect(hasCanonicalSpeechMotion(manifest(false))).toBe(false);
	});

	it("plays an aligned plan on the given audio clock (loadAudioClock + playAudioClock)", async () => {
		const player = new FakePlayer();
		const { stage } = stageWith(player);
		const clock = () => 0.25;
		expect(await stage.start({ plan: plan("aligned"), clock })).toBe(true);
		expect(player.calls).toEqual(["stop", "loadAudioClock", "playAudioClock"]);
		expect(player.clock).toBe(clock);
		expect(stage.speaking).toBe(true);
		// aligned plans are never revised by boundaries.
		expect(stage.update(plan("browser-timed"))).toBe(false);
	});

	it("plays a browser-timed plan on the utterance clock and accepts revisions", async () => {
		const player = new FakePlayer();
		const { stage } = stageWith(player);
		expect(
			await stage.start({ plan: plan("browser-timed"), clock: () => 0 }),
		).toBe(true);
		expect(player.calls).toEqual(["stop", "loadExternal", "playExternal"]);
		expect(stage.update(plan("browser-timed"))).toBe(true);
		expect(stage.update(plan("aligned"))).toBe(false);
		expect(player.calls.at(-1)).toBe("update:browser-timed");
	});

	it("refuses any other plan kind (no approximation modes)", async () => {
		const player = new FakePlayer();
		const { stage, loadAsset } = stageWith(player);
		for (const mode of ["approximate", "viseme-approx", "aiueo", ""]) {
			expect(await stage.start({ plan: plan(mode), clock: () => 0 })).toBe(
				false,
			);
		}
		expect(player.calls).toEqual([]);
		expect(loadAsset).not.toHaveBeenCalled();
	});

	it("a newer start or stop supersedes a pending load", async () => {
		const player = new FakePlayer();
		let release = () => {};
		player.loadGate = new Promise((resolve) => {
			release = resolve;
		});
		const { stage } = stageWith(player);
		const first = stage.start({ plan: plan("aligned"), clock: () => 0 });
		await Promise.resolve();
		stage.stop();
		release();
		expect(await first).toBe(false);
		expect(player.calls).not.toContain("playAudioClock");
	});

	it("reads bundle assets once and removes its media on dispose", async () => {
		const player = new FakePlayer();
		const { stage, parent, loadAsset } = stageWith(player);
		expect(parent.querySelectorAll("video")).toHaveLength(4);
		expect(parent.querySelectorAll("audio")).toHaveLength(1);
		await stage.start({ plan: plan("aligned"), clock: () => 0 });
		await stage.start({ plan: plan("aligned"), clock: () => 0 });
		expect(loadAsset).toHaveBeenCalledTimes(
			canonicalSpeechAssetPaths(manifest()).length,
		);
		stage.dispose();
		expect(player.calls.at(-1)).toBe("dispose");
		expect(parent.querySelectorAll("video")).toHaveLength(1);
		expect(parent.querySelectorAll("audio")).toHaveLength(0);
	});
});

describe("PrebakedAvatarRenderer + canonical stage", () => {
	function rendererWith(stage: Partial<CanonicalSpeechStage> | null) {
		const renderer = new PrebakedAvatarRenderer({
			manifest: manifest(),
			locale: "ko-KR",
			resolveAssetUrl: async (path) => `blob:${path}`,
			createSpeechStage: () => stage as CanonicalSpeechStage | null,
		});
		const video = document.createElement("video");
		vi.spyOn(video, "play").mockResolvedValue();
		vi.spyOn(video, "pause").mockImplementation(() => {});
		renderer.start(video, document.createElement("canvas"));
		return renderer;
	}

	it("routes playSpeechTiming/updateSpeechPlan to the stage and stops it when speech ends", async () => {
		const stage = {
			start: vi.fn(async () => true),
			update: vi.fn(() => true),
			stop: vi.fn(),
			dispose: vi.fn(),
			speaking: false,
		};
		const renderer = rendererWith(stage);
		const timing = { plan: plan("aligned"), clock: () => 0 };
		expect(await renderer.playSpeechTiming(timing)).toBe(true);
		expect(stage.start).toHaveBeenCalledWith(timing);
		expect(renderer.updateSpeechPlan(plan("browser-timed"))).toBe(true);
		renderer.setSpeakingVisual(true);
		expect(stage.stop).not.toHaveBeenCalled();
		renderer.setSpeakingVisual(false);
		expect(stage.stop).toHaveBeenCalledTimes(1);
		renderer.interrupt();
		expect(stage.stop).toHaveBeenCalledTimes(2);
		renderer.stop();
		expect(stage.dispose).toHaveBeenCalled();
	});

	it("without the canonical speech set it stays idle (no stage, returns false)", async () => {
		const renderer = new PrebakedAvatarRenderer({
			manifest: manifest(false),
			locale: "ko-KR",
			resolveAssetUrl: async (path) => `blob:${path}`,
		});
		const video = document.createElement("video");
		vi.spyOn(video, "play").mockResolvedValue();
		renderer.start(video, document.createElement("canvas"));
		expect(
			await renderer.playSpeechTiming({
				plan: plan("aligned"),
				clock: () => 0,
			}),
		).toBe(false);
		renderer.stop();
	});

	it("draws the stage canvas instead of the idle video while the stage speaks", () => {
		const frames: FrameRequestCallback[] = [];
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
			frames.push(cb);
			return frames.length;
		});
		const stageCanvas = document.createElement("canvas");
		stageCanvas.width = 100;
		stageCanvas.height = 100;
		const stage = {
			start: vi.fn(async () => true),
			update: vi.fn(),
			stop: vi.fn(),
			dispose: vi.fn(),
			speaking: true,
			canvas: stageCanvas,
		};
		const renderer = new PrebakedAvatarRenderer({
			manifest: { ...manifest(), motion: false } as NvaManifest,
			locale: "ko-KR",
			resolveAssetUrl: async (path) => `blob:${path}`,
			createSpeechStage: () => stage as unknown as CanonicalSpeechStage,
		});
		const video = document.createElement("video");
		vi.spyOn(video, "play").mockResolvedValue();
		const ctx = { clearRect: vi.fn(), drawImage: vi.fn() };
		const canvas = document.createElement("canvas");
		canvas.width = 100;
		canvas.height = 100;
		vi.spyOn(canvas, "getContext").mockReturnValue(ctx as never);
		renderer.start(video, canvas);
		frames[0]?.(0);
		expect(ctx.drawImage).toHaveBeenCalledWith(stageCanvas, 0, 0, 100, 100);
		expect(ctx.drawImage).not.toHaveBeenCalledWith(
			video,
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
		renderer.stop();
	});
});
