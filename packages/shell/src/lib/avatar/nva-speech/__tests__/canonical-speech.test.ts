// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../../../logger";
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
		expect(vendor.commit).toBe("3bb5ee066598256e2799e231cc7a153d8419b5dd");
	});

	// The canonical repo is not a Shell dependency, so this pin runs when
	// NVA_CANONICAL_MANIFEST points at naia-video-avatar's vendor-manifest.json
	// (checked out at VENDOR.json's commit).
	it.skipIf(!process.env.NVA_CANONICAL_MANIFEST)(
		"records exactly the canonical vendor-manifest.json files",
		() => {
			const canonical = JSON.parse(
				readFileSync(process.env.NVA_CANONICAL_MANIFEST as string, "utf8"),
			) as { source_directory: string; files: typeof vendor.files };
			expect(canonical.source_directory).toBe("src/main");
			const pinnedFiles = Object.fromEntries(
				Object.keys(vendor.files).map((name) => [name, canonical.files[name]]),
			);
			expect(vendor.files).toEqual(pinnedFiles);
		},
	);
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

	// SoT 3 drift traces, same patterns as the canonical guard
	// (naia-video-avatar src/test/drift-patterns.mjs, 097eb15/57a7614).
	const DRIFT: [string, RegExp][] = [
		["aiueo loop", /aiueo|a-i-u-e-o|아이우에오/i],
		[
			"volume threshold mouth",
			/createAnalyser|AnalyserNode|get(Byte|Float)(Frequency|TimeDomain)Data|\brms\b|volume[_-]?threshold|amplitude|loudness/i,
		],
		[
			"drawn mouth",
			/draw[_-]?mouth|mouth[_-]?(open|shape|path|draw)|openness|\.ellipse\(|quadraticCurveTo|bezierCurveTo/i,
		],
		["approximate plan", /approximate/i],
		[
			"talking loop",
			/playTalking|SPEECH_SEQUENCE|#show\(\s*this\.talkKey|motions\??\.talking\??\.clip|state\s*=\s*["']talking["']|talking[ _-]?loop/i,
		],
	];
	// Microphone-input files measure the user's voice level (STT silence gate,
	// echo gate, mic meter) or use "approximate" in an unrelated sense; none of
	// them drives the avatar mouth. Only those two labels are waived there —
	// aiueo, drawn mouth and talking loop are still forbidden in every file.
	const INPUT_SIDE = new Set([
		"components/ChatArea.tsx",
		"components/SettingsTab.tsx",
		"lib/stt/api-stt.ts",
		"lib/stt/types.ts",
		"lib/voice/echo-gate.ts",
		"lib/voice/ref-audio.ts",
		"lib/voice/ref-recorder.ts",
		"lib/voice/types.ts",
		"lib/voice/vllm-omni.ts",
	]);
	const INPUT_SIDE_WAIVED = new Set([
		"volume threshold mouth",
		"approximate plan",
	]);

	it("no product line carries an SoT 3 drift trace (volume threshold, drawn mouth, approximate, aiueo, talking loop)", () => {
		const offenders: string[] = [];
		for (const file of productFiles(shellSrc)) {
			const name = relative(shellSrc, file).split("\\").join("/");
			readFileSync(file, "utf8")
				.split("\n")
				.forEach((line, index) => {
					for (const [label, pattern] of DRIFT) {
						if (INPUT_SIDE.has(name) && INPUT_SIDE_WAIVED.has(label)) continue;
						if (pattern.test(line))
							offenders.push(`${name}:${index + 1} ${label}: ${line.trim()}`);
					}
				});
		}
		expect(offenders).toEqual([]);
	});

	it("the drift scan catches each forbidden trace", () => {
		const samples = [
			"const AIUEO = ['a','i','u','e','o'];",
			"const analyser = ctx.createAnalyser();",
			"if (rms > volumeThreshold) open();",
			"drawMouth(ctx, openness);",
			"ctx.ellipse(x, y, w, h, 0, 0, 7);",
			"quality_mode: 'approximate'",
			"await player.playTalking();",
			'this.state = "talking";',
		];
		for (const sample of samples)
			expect(
				DRIFT.some(([, pattern]) => pattern.test(sample)),
				sample,
			).toBe(true);
	});

	it("the scans catch the aiueo/talking fallback that origin/main setSpeakingVisual used", () => {
		// Verbatim shape of the pre-#760 loop (naia-shell main 12c1f61f).
		const oldMain = [
			"this.config.manifest.vrm_slots?.visemes?.aiueo?.clip ??",
			"this.config.manifest.vrm_slots?.motions?.talking?.clip ??",
		];
		for (const line of oldMain)
			expect(
				DRIFT.some(([, pattern]) => pattern.test(line)),
				line,
			).toBe(true);
		expect(/visemes\??\.aiueo/.test(oldMain[0])).toBe(true);
		expect(/motions\??\.talking\??\.clip/.test(oldMain[1])).toBe(true);
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

	it("prepare loads without playing; play starts on the sound clock once", async () => {
		const player = new FakePlayer();
		const { stage } = stageWith(player);
		const prepared = await stage.prepare(plan("aligned"));
		expect(prepared).not.toBeNull();
		expect(player.calls).toEqual(["stop", "loadAudioClock"]);
		expect(stage.speaking).toBe(false);
		const clock = () => 0;
		expect(await prepared?.play(clock)).toBe(true);
		expect(player.calls.at(-1)).toBe("playAudioClock");
		expect(player.clock).toBe(clock);
		// A used preparation never starts a second time.
		expect(await prepared?.play(clock)).toBe(false);
		expect(player.calls.filter((c) => c === "playAudioClock")).toHaveLength(1);
	});

	it("a newer prepare or stop makes an earlier preparation unplayable", async () => {
		const player = new FakePlayer();
		const { stage } = stageWith(player);
		const first = await stage.prepare(plan("aligned"));
		stage.stop();
		expect(await first?.play(() => 0)).toBe(false);
		const second = await stage.prepare(plan("aligned"));
		const third = await stage.prepare(plan("browser-timed"));
		expect(await second?.play(() => 0)).toBe(false);
		expect(await third?.play(() => 0)).toBe(true);
		expect(player.calls).not.toContain("playAudioClock");
		expect(await stage.prepare(plan("approximate"))).toBeNull();
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

	it("warm() loads the bundle once before any plan, without playing", async () => {
		const player = new FakePlayer();
		const { stage, loadAsset } = stageWith(player);
		const [a, b] = [stage.warm(), stage.warm()];
		expect(await a).toBe(true);
		expect(await b).toBe(true);
		expect(await stage.warm()).toBe(true);
		expect(player.calls).toEqual(["loadExternal"]);
		expect(stage.speaking).toBe(false);
		const info = vi.spyOn(Logger, "info");
		const prepared = await stage.prepare(plan("aligned"));
		expect(await prepared?.play(() => 0)).toBe(true);
		expect(info).toHaveBeenCalledWith(
			"CanonicalSpeechStage",
			"speech plan loaded",
			expect.objectContaining({ firstLoad: false }),
		);
		expect(loadAsset).toHaveBeenCalledTimes(
			canonicalSpeechAssetPaths(manifest()).length,
		);
	});

	it("warm() never runs once a real plan was asked for", async () => {
		const player = new FakePlayer();
		const { stage } = stageWith(player);
		const info = vi.spyOn(Logger, "info");
		const prepared = stage.prepare(plan("aligned"));
		const warmed = stage.warm();
		// Skipped (not queued behind the real load it would replace).
		expect(await warmed).toBe(false);
		await prepared;
		expect(player.calls).toEqual(["stop", "loadAudioClock"]);
		expect(info).toHaveBeenCalledWith(
			"CanonicalSpeechStage",
			"speech plan loaded",
			expect.objectContaining({ firstLoad: true }),
		);
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
