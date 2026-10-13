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
 */
import type { NvaManifest } from "../../nva";
import type { AvatarSpeechTiming, SpeechPlan } from "./speech-timing";
import {
	type SpeechMotionManifest,
	speechBundlePaths,
} from "./vendor/speech-bundle.js";
import { SpeechPlayer } from "./vendor/speech-player.js";

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
		if (this.disposed) return false;
		const mode = timing.plan?.quality_mode;
		if (mode !== "aligned" && mode !== "browser-timed") return false;
		if (typeof timing.clock !== "function") return false;
		const generation = ++this.generation;
		this.player.stop("cancel");
		this.mode = null;
		try {
			const assets = await this.loadAssets();
			if (generation !== this.generation || this.disposed) return false;
			const input = {
				manifest: this.config.manifest,
				assets,
				plan: timing.plan,
			};
			if (mode === "aligned") await this.player.loadAudioClock(input);
			else await this.player.loadExternal(input);
			if (generation !== this.generation || this.disposed) {
				this.player.stop("cancel");
				return false;
			}
			if (mode === "aligned") await this.player.playAudioClock(timing.clock);
			else await this.player.playExternal(timing.clock);
			if (generation !== this.generation || this.disposed) {
				this.player.stop("cancel");
				return false;
			}
			this.mode = mode;
			return true;
		} catch {
			if (generation === this.generation) this.player.stop("error");
			return false;
		}
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
