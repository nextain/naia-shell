import { Logger } from "../../logger";
/**
 * Shell host for the canonical NVA SpeechPlayer (naia-shell#760).
 *
 * The player bytes live in ./vendor and are identical to naia-video-avatar
 * (VENDOR.json + vendor hash test). This stage only supplies what the player
 * needs from the Shell: bundle assets as Blobs, an offscreen canvas, a body
 * <video>, two speech <video>s, and a silent audio element (the Shell never
 * hands its sound to the player; aligned plans run on the Shell's audio clock).
 *
 *  - aligned plan      → loadAudioClock + playAudioClock(clock of the sound)
 *  - browser-timed plan → loadExternal + playExternal(time since onstart),
 *                         revised by updateExternalPlan on boundary events
 *
 * Anything else is refused and the caller keeps the idle clip (SoT 8).
 *
 * Cost per avatar vs per sentence: the canonical player verifies the bundle
 * (receipt + sha256 of every asset and atlas slice) and decodes the body clip
 * only when it sees a new manifest/asset map (vendor 3bb5ee0 `sameBundle`).
 * This stage keeps one manifest object and one asset Map for its lifetime, so
 * that work happens once per avatar; each sentence only swaps the plan and
 * primes its first speech clips. `warm()` runs the once-per-avatar part
 * before the first sentence so the first plan does not pay for it while its
 * sound is waiting.
 */
import type { NvaManifest } from "../../nva";
import type {
	AvatarSpeechTiming,
	PreparedSpeech,
	SpeechPlan,
} from "./speech-timing";
import {
	type SpeechMotionManifest,
	speechBundlePaths,
} from "./vendor/speech-bundle.js";
import { SpeechPlayer } from "./vendor/speech-player.js";

const TAG = "CanonicalSpeechStage";

export interface CanonicalSpeechStageConfig {
	manifest: NvaManifest;
	/** Reads one bundle-relative asset as bytes. */
	loadAsset: (path: string) => Promise<Blob>;
	/** Mounted decode element; the stage's own media become hidden siblings. */
	host: HTMLVideoElement;
	/** Test seam; defaults to the canonical player. */
	createPlayer?: (
		options: ConstructorParameters<typeof SpeechPlayer>[0],
	) => SpeechPlayerLike;
}

/** The subset of SpeechPlayer the stage drives (lets tests inject a fake). */
export interface SpeechPlayerLike {
	readonly state: string;
	loadAudioClock(input: {
		manifest: unknown;
		assets: Map<string, Blob>;
		plan: SpeechPlan;
	}): Promise<unknown>;
	loadExternal(input: {
		manifest: unknown;
		assets: Map<string, Blob>;
		plan: SpeechPlan;
	}): Promise<unknown>;
	updateExternalPlan(plan: SpeechPlan): unknown;
	playAudioClock(clock: () => number): Promise<void>;
	playExternal(clock: () => number): Promise<void>;
	stop(outcome?: "complete" | "cancel" | "error"): void;
	dispose(): void;
}

type ManifestWithSpeech = NvaManifest & {
	speech_motion?: SpeechMotionManifest;
};

/** True only when the NVA bundle carries the canonical speech set. */
export function hasCanonicalSpeechMotion(manifest: NvaManifest): boolean {
	return Boolean((manifest as ManifestWithSpeech).speech_motion);
}

function safeError(error: unknown): string {
	const message =
		error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return message
		.replace(/https?:\/\/[^\s"'<>]+/giu, "[url]")
		.replace(
			/\b(authorization|api[-_ ]?key|token|secret|password)\b\s*[:=]\s*[^,\s]+/giu,
			"$1=[redacted]",
		)
		.slice(0, 240);
}

/**
 * Load-only plan for warm(): one silent unit, no transitions, so the player
 * runs its once-per-avatar bundle work and decodes no speech clip. It is
 * never played — the stage never calls playExternal for it and the renderer
 * only shows the stage while the player state is "speaking".
 */
export const WARM_PLAN: SpeechPlan = Object.freeze({
	version: "1",
	text: "",
	quality_mode: "browser-timed",
	audio: Object.freeze({ duration_us: 1_000_000 }),
	events: Object.freeze([
		Object.freeze({ unit: "sil", start_us: 0, end_us: 1_000_000 }),
	]),
}) as unknown as SpeechPlan;

/** Every file the canonical player validates or reads. */
export function canonicalSpeechAssetPaths(manifest: NvaManifest): string[] {
	const speech = (manifest as ManifestWithSpeech).speech_motion;
	const paths = new Set<string>();
	for (const animation of Object.values(manifest.animations ?? {}))
		if (animation?.clip) paths.add(animation.clip);
	for (const path of speechBundlePaths(speech)) paths.add(path);
	return [...paths];
}

export class CanonicalSpeechStage {
	readonly canvas: HTMLCanvasElement;
	private readonly player: SpeechPlayerLike;
	private readonly media: HTMLMediaElement[] = [];
	private assets: Promise<Map<string, Blob>> | null = null;
	private mode: "aligned" | "browser-timed" | null = null;
	private generation = 0;
	/** Player loads are serialized; the vendored media are never reloaded concurrently. */
	private prepareQueue: Promise<void> = Promise.resolve();
	/** Set once the first real plan is asked for; warm() never runs after it. */
	private prepareIssued = false;
	private warming: Promise<boolean> | null = null;
	/** True once the player holds this avatar's verified bundle and body clip. */
	private bundleLoaded = false;
	private disposed = false;

	constructor(private readonly config: CanonicalSpeechStageConfig) {
		const host = config.host;
		const doc = host.ownerDocument;
		this.canvas = doc.createElement("canvas");
		const hidden = (element: HTMLMediaElement) => {
			element.muted = true;
			element.setAttribute("aria-hidden", "true");
			element.style.cssText =
				"position:absolute;width:1px;height:1px;opacity:0;pointer-events:none";
			host.parentNode?.insertBefore(element, host.nextSibling);
			this.media.push(element);
			return element;
		};
		const video = () => {
			const element = doc.createElement("video");
			element.playsInline = true;
			return hidden(element) as HTMLVideoElement;
		};
		// The Shell owns the sound; this element is never given a source.
		const audio = hidden(doc.createElement("audio")) as HTMLAudioElement;
		const options = {
			audio,
			canvas: this.canvas,
			bodyVideo: video(),
			speechVideos: [video(), video()] as [HTMLVideoElement, HTMLVideoElement],
		};
		this.player = config.createPlayer
			? config.createPlayer(options)
			: new SpeechPlayer(options);
	}

	/** True while the player is drawing a plan onto `canvas`. */
	get speaking(): boolean {
		return !this.disposed && this.player.state === "speaking";
	}

	/**
	 * Load and start one plan. Resolves false when the plan kind is not
	 * allowed, the load fails, or a newer start/stop superseded this one.
	 */
	async start(timing: AvatarSpeechTiming): Promise<boolean> {
		if (typeof timing.clock !== "function") return false;
		const prepared = await this.prepare(timing.plan);
		return prepared ? prepared.play(timing.clock) : false;
	}

	/**
	 * Load one plan into the player without starting it, so the first mouth
	 * frame can appear together with the first sound (no load wait after the
	 * sound starts). `play(clock)` must be called with the clock of the very
	 * sound the plan was made for; a newer prepare/start/stop supersedes it.
	 */
	async prepare(plan: SpeechPlan): Promise<PreparedSpeech | null> {
		if (this.disposed) return null;
		const mode = plan?.quality_mode;
		if (mode !== "aligned" && mode !== "browser-timed") return null;
		this.prepareIssued = true;
		const generation = ++this.generation;
		const operation = this.prepareQueue.then(
			async (): Promise<PreparedSpeech | null> => {
				if (generation !== this.generation || this.disposed) return null;
				this.player.stop("cancel");
				this.mode = null;
				const startedAt = Date.now();
				const firstLoad = !this.bundleLoaded;
				try {
					const assets = await this.loadAssets();
					if (generation !== this.generation || this.disposed) return null;
					const input = { manifest: this.config.manifest, assets, plan };
					if (mode === "aligned") await this.player.loadAudioClock(input);
					else await this.player.loadExternal(input);
					this.bundleLoaded = true;
					if (generation !== this.generation || this.disposed) {
						this.player.stop("cancel");
						return null;
					}
				} catch (error) {
					Logger.warn(TAG, "speech plan load failed", {
						generation,
						error: safeError(error),
					});
					if (generation === this.generation) this.player.stop("error");
					return null;
				}
				Logger.info(TAG, "speech plan loaded", {
					generation,
					mode,
					firstLoad,
					loadMs: Date.now() - startedAt,
				});
				return this.preparedFor(generation, mode);
			},
		);
		this.prepareQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	/**
	 * Run the once-per-avatar load (bundle verification, neutral head, body
	 * clip) before the first sentence. Idempotent; skipped once a real plan
	 * was asked for, because loading the warm plan then would replace it.
	 * Resolves true when the bundle is loaded.
	 */
	warm(): Promise<boolean> {
		if (this.disposed) return Promise.resolve(false);
		if (this.bundleLoaded) return Promise.resolve(true);
		if (this.warming) return this.warming;
		if (this.prepareIssued) return Promise.resolve(false);
		const startedAt = Date.now();
		const run = this.prepareQueue.then(async (): Promise<boolean> => {
			try {
				const assets = await this.loadAssets();
				// A real plan arrived while the assets were loading: let it do the
				// first load itself instead of queueing a load it would cancel.
				if (this.disposed || this.prepareIssued) return this.bundleLoaded;
				await this.player.loadExternal({
					manifest: this.config.manifest,
					assets,
					plan: WARM_PLAN,
				});
				this.bundleLoaded = true;
				Logger.info(TAG, "speech bundle warmed", {
					loadMs: Date.now() - startedAt,
				});
				return true;
			} catch (error) {
				Logger.warn(TAG, "speech bundle warm failed", {
					error: safeError(error),
				});
				return false;
			}
		});
		this.warming = run;
		this.prepareQueue = run.then(
			() => undefined,
			() => undefined,
		);
		void run.then((ok) => {
			if (!ok && this.warming === run) this.warming = null;
		});
		return run;
	}

	private preparedFor(
		generation: number,
		mode: "aligned" | "browser-timed",
	): PreparedSpeech {
		let used = false;
		return {
			play: async (clock) => {
				if (used || typeof clock !== "function") return false;
				used = true;
				if (generation !== this.generation || this.disposed) return false;
				try {
					if (mode === "aligned") await this.player.playAudioClock(clock);
					else await this.player.playExternal(clock);
					if (generation !== this.generation || this.disposed) {
						this.player.stop("cancel");
						return false;
					}
					this.mode = mode;
					return true;
				} catch (error) {
					Logger.warn(TAG, "speech plan playback failed", {
						generation,
						error: safeError(error),
					});
					if (generation === this.generation) this.player.stop("error");
					return false;
				}
			},
		};
	}

	/** Revise the running browser-timed plan (boundary events). */
	update(plan: SpeechPlan): boolean {
		if (this.disposed || this.mode !== "browser-timed") return false;
		if (plan?.quality_mode !== "browser-timed") return false;
		try {
			this.player.updateExternalPlan(plan);
			return true;
		} catch {
			return false;
		}
	}

	stop(): void {
		this.generation++;
		this.mode = null;
		if (!this.disposed) this.player.stop("cancel");
	}

	dispose(): void {
		if (this.disposed) return;
		this.stop();
		this.disposed = true;
		this.player.dispose();
		for (const element of this.media.splice(0)) {
			element.pause?.();
			element.remove();
		}
		this.assets = null;
	}

	private loadAssets(): Promise<Map<string, Blob>> {
		if (!this.assets) {
			const paths = canonicalSpeechAssetPaths(this.config.manifest);
			this.assets = Promise.all(
				paths.map(
					async (path) => [path, await this.config.loadAsset(path)] as const,
				),
			).then((entries) => new Map(entries));
			this.assets.catch(() => {
				this.assets = null;
			});
		}
		return this.assets;
	}
}
