import { Logger } from "../logger";
import { type NvaManifest, defaultClipOf, findPrebakedSpeech } from "../nva";
import type {
	AvatarPlaybackOptions,
	AvatarSpeechRenderer,
} from "./avatar-renderer";
import type { NvaGestureAction } from "./camera-actions";
import { NvaChromakeyGL } from "./nva-chromakey-gl";
import { animKind } from "./nva-core";
import {
	type MotionSpec,
	drawWithMotion,
	parseMotionSpec,
	resolveChestY,
} from "./nva-procedural-motion";
import {
	CanonicalSpeechStage,
	hasCanonicalSpeechMotion,
} from "./nva-speech/canonical-speech-stage";
import type {
	AvatarSpeechTiming,
	PreparedSpeech,
	SpeechPlan,
} from "./nva-speech/speech-timing";
import { isStackedAlphaClipUrl } from "./nva-stacked-alpha";
import { NvaStackedAlphaGL } from "./nva-stacked-alpha-gl";

export interface StackedAlphaCompositorLike {
	readonly canvas: HTMLCanvasElement;
	draw(video: HTMLVideoElement): boolean;
	dispose(): void;
}

interface Config {
	modelId?: string;
	manifest: NvaManifest;
	locale: string;
	resolveAssetUrl: (path: string) => Promise<string>;
	/** Bundle asset bytes for the canonical speech player (defaults to fetch of resolveAssetUrl). */
	loadAssetBlob?: (path: string) => Promise<Blob>;
	/** Test seam for the canonical speech stage. */
	createSpeechStage?: (host: HTMLVideoElement) => CanonicalSpeechStage | null;
	onSpeaking?: (speaking: boolean) => void;
	createStackedAlpha?: () => StackedAlphaCompositorLike;
	onPlaybackFailure?: (reason: string) => void;
	/** Optional interval (ms) to periodically play non-greeting gesture clips while idle. */
	idleGestureIntervalMs?: number;
}

/** contain-fit draw rect (source aspect preserved, letterboxed within target). */
export function containRect(cw: number, ch: number, vw: number, vh: number) {
	if (vw <= 0 || vh <= 0 || cw <= 0 || ch <= 0)
		return { dx: 0, dy: 0, dw: 0, dh: 0 };
	const scale = Math.min(cw / vw, ch / vh);
	const dw = vw * scale;
	const dh = vh * scale;
	return { dx: (cw - dw) / 2, dy: (ch - dh) / 2, dw, dh };
}

/** WebM alone can carry a real (VP9 yuva420p) alpha channel; other containers cannot. */
export function canCarryAlpha(clipPath: string): boolean {
	return /\.webm$/i.test(clipPath);
}

/**
 * GPU 없는 pre-baked NVA 비디오 재생기. Shell TTS가 오디오 합성·재생의 단일
 * 소유자이며, 이 렌더러는 절대 텍스트를 스스로 합성하지 않는다(브라우저
 * speechSynthesis 자동 폴백 없음). 두 가지만 담당한다:
 *   1) 정확히 일치하는 문구의 저작 클립(자체 녹음 음성 포함) 재생
 *   2) 발화 입 모양 = 정본 SpeechPlayer(vendor) 하나뿐. Shell 음성은 aligned
 *      계획 + 그 소리의 오디오 시계, 브라우저/시스템 음성은 browser-timed 계획
 *      (playSpeechTiming/updateSpeechPlan). 계획이 없거나 실패하면 대기 클립
 *      그대로 — 말하기 반복 클립·모음 순환 같은 근사는 없다(SoT 8).
 *
 * 표시는 숨은 `<video>`(디코드 버퍼)를 매 프레임 `<canvas>`(alpha:true)에 합성한다.
 * WebM 알파 클립은 그대로 drawImage, 알파를 가질 수 없는 컨테이너(mp4 등)는
 * `manifest.chroma_key`(또는 배경색 `background.color`)로 GPU 크로마키 처리해
 * 검은/불투명 배경이 노출되지 않게 한다.
 */
export class PrebakedAvatarRenderer implements AvatarSpeechRenderer {
	private video: HTMLVideoElement | null = null;
	/** 마운트된 숨은 디코드 요소(첫 클립이 차지). 다른 클립은 형제 요소를 만든다. */
	private mountedVideo: HTMLVideoElement | null = null;
	/** 클립 URL → 그 클립을 계속 들고 있는 <video>. 한 번 로드한 클립은 src 를 다시 대입하지 않는다. */
	private clipVideos = new Map<string, HTMLVideoElement>();
	private canvas: HTMLCanvasElement | null = null;
	private ctx: CanvasRenderingContext2D | null = null;
	private stackedAlpha: StackedAlphaCompositorLike | null = null;
	private stackedAlphaFailed = false;
	private currentClipUrl = "";
	private keyer: NvaChromakeyGL | null = null;
	private keyerFailed = false;
	private currentKeyColor: string | undefined;
	private motionSpec: MotionSpec | null;
	private offscreenCanvas: HTMLCanvasElement | null = null;
	private offscreenCtx: CanvasRenderingContext2D | null = null;
	private disposed = false;
	private generation = 0;
	private speakingVisual = false;
	private activeGesture = false;
	private greetingGestureActive = false;
	private cancelOneShot: (() => void) | null = null;
	private idleOverride: string | null = null;
	private tail = Promise.resolve();
	private raf = 0;
	private running = false;
	private playbackTimers = new Map<ReturnType<typeof setTimeout>, () => void>();
	private mediaFailed = false;
	private speechStage: CanonicalSpeechStage | null = null;
	private prefetchedSpeechStage: CanonicalSpeechStage | null = null;
	private speechKeyColor: string | undefined;
	private assetBlobCache = new Map<string, Promise<Blob>>();
	private idleGestureTimer: ReturnType<typeof setInterval> | null = null;
	private idleGestureCursor = 0;
	private zoom = 1;

	setZoom(zoom: number): void {
		if (typeof zoom === "number" && Number.isFinite(zoom)) {
			this.zoom = Math.min(3, Math.max(0.5, zoom));
		}
	}

	private failMedia(reason: string): void {
		if (this.disposed || this.mediaFailed) return;
		this.mediaFailed = true;
		Logger.warn("PrebakedAvatarRenderer", "media fallback", {
			reason,
			...this.mediaDiagnostics(this.video),
		});
		if (this.canvas && this.ctx) {
			this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		}
		this.stop(true);
		this.config.onPlaybackFailure?.(reason);
	}

	private mediaDiagnostics(video: HTMLVideoElement | null) {
		return {
			errorCode: video?.error?.code ?? null,
			errorMessage: video?.error?.message?.slice(0, 512) ?? null,
			readyState: video?.readyState,
			networkState: video?.networkState,
			currentTime: video?.currentTime,
			duration: video?.duration,
			width: video?.videoWidth,
			height: video?.videoHeight,
			bufferedRanges: video?.buffered.length,
			// Do not log local paths or object URLs.
			sourceKind: video?.src.split(":", 1)[0],
		};
	}

	constructor(private readonly config: Config) {
		this.motionSpec = parseMotionSpec(config.manifest);
		if (this.motionSpec) {
			this.motionSpec.chest_y = resolveChestY(config.manifest, this.motionSpec);
		}
	}

	get modelId(): string | undefined {
		return this.config.modelId;
	}

	start(video: HTMLVideoElement, canvas: HTMLCanvasElement): void {
		this.video = video;
		this.mountedVideo = video;
		this.canvas = canvas;
		this.ctx = canvas.getContext("2d", { alpha: true });
		if (this.ctx) {
			this.ctx.imageSmoothingEnabled = true;
			this.ctx.imageSmoothingQuality = "high";
		}
		this.speechStage = this.createSpeechStage(video);
		void this.playIdle();
		this.startDrawLoop();
		if (
			typeof this.config.idleGestureIntervalMs === "number" &&
			this.config.idleGestureIntervalMs > 0
		) {
			this.startIdleGestureLoop(this.config.idleGestureIntervalMs);
		}
	}

	async setVoice(): Promise<boolean> {
		return false;
	}

	hasAuthoredClip(text: string): boolean {
		return !!findPrebakedSpeech(this.config.manifest, text, this.config.locale)
			?.localized.clip;
	}

	async playAuthoredClip(
		text: string,
		options?: AvatarPlaybackOptions,
	): Promise<void> {
		const operation = this.tail.then(() =>
			this.playAuthoredClipNow(text, options),
		);
		this.tail = operation.catch(() => {});
		return operation;
	}

	private async playAuthoredClipNow(
		text: string,
		options?: AvatarPlaybackOptions,
	): Promise<void> {
		if (!this.video || this.disposed) return;
		const match = findPrebakedSpeech(
			this.config.manifest,
			text,
			this.config.locale,
		);
		if (!match?.localized.clip) return;
		const generation = ++this.generation;
		this.speakingVisual = true;
		this.config.onSpeaking?.(true);
		try {
			await this.playClip(
				match.localized.clip,
				false,
				options?.muted ?? false,
				options,
				generation,
				false,
			);
		} catch {
			options?.onPlaybackFailure?.();
		} finally {
			if (generation === this.generation && !this.disposed) {
				this.speakingVisual = false;
				this.config.onSpeaking?.(false);
				await this.playIdle();
			}
		}
	}

	/** Manifest gestures are the only clips exposed as manual or AI actions. */
	getGestureActions(): NvaGestureAction[] {
		return Object.entries(this.config.manifest.animations)
			.filter(([, animation]) => animKind(animation) === "gesture")
			.map(([key, animation]) => ({ key, label: animation.label || key }));
	}

	/**
	 * Return gesture actions suitable for periodic idle variation
	 * (prefers non-`greeting` clips like `idea`, `happy`; falls back to all gestures).
	 */
	getIdleGestureActions(): NvaGestureAction[] {
		const all = this.getGestureActions();
		const nonGreeting = all.filter((action) => action.key !== "greeting");
		return nonGreeting.length > 0 ? nonGreeting : all;
	}

	/**
	 * Play the greeting gesture clip (`greeting` if present in `manifest.animations`,
	 * otherwise the first available gesture clip). Preserved across initial greeting TTS.
	 */
	async playGreetingAction(): Promise<string | null> {
		const actions = this.getGestureActions();
		if (actions.length === 0) return null;
		const greeting =
			actions.find((action) => action.key === "greeting") ?? actions[0]!;
		const ok = await this.playActionInternal(greeting.key, true);
		return ok ? greeting.key : null;
	}

	/**
	 * Trigger the next idle variation gesture clip in round-robin order
	 * when the avatar is currently idle and not speaking.
	 */
	async triggerNextIdleGesture(): Promise<string | null> {
		if (
			!this.video ||
			this.disposed ||
			this.speakingVisual ||
			this.speechStage?.speaking ||
			this.activeGesture
		) {
			return null;
		}
		const actions = this.getIdleGestureActions();
		if (actions.length === 0) return null;
		const action = actions[this.idleGestureCursor % actions.length]!;
		this.idleGestureCursor = (this.idleGestureCursor + 1) % actions.length;
		const ok = await this.playAction(action.key);
		return ok ? action.key : null;
	}

	/**
	 * Start a periodic timer that plays idle variation gestures (`idea`, `happy`, etc.)
	 * while the avatar is idle and not speaking.
	 */
	startIdleGestureLoop(intervalMs = 18_000): void {
		this.stopIdleGestureLoop();
		if (this.disposed || intervalMs <= 0) return;
		this.idleGestureTimer = setInterval(() => {
			if (
				!this.disposed &&
				!this.speakingVisual &&
				!this.speechStage?.speaking &&
				!this.activeGesture
			) {
				void this.triggerNextIdleGesture();
			}
		}, intervalMs);
	}

	stopIdleGestureLoop(): void {
		if (this.idleGestureTimer !== null) {
			clearInterval(this.idleGestureTimer);
			this.idleGestureTimer = null;
		}
	}

	/** Play a manifest gesture once, silently. Speech visuals take priority. */
	async playAction(key: string): Promise<boolean> {
		return this.playActionInternal(key, false);
	}

	private async playActionInternal(
		key: string,
		preserveDuringSpeech: boolean,
	): Promise<boolean> {
		if (
			!this.video ||
			this.disposed ||
			this.speechStage?.speaking ||
			(this.speakingVisual && !preserveDuringSpeech)
		) {
			return false;
		}
		const resolvedKey = this.config.manifest.animations[key]
			? key
			: key === "guidance"
				? this.config.manifest.animations.greeting
					? "greeting"
					: "idea"
				: key;
		const animation = this.config.manifest.animations[resolvedKey];
		if (!animation || animKind(animation) !== "gesture") return false;
		const generation = ++this.generation;
		this.activeGesture = true;
		this.greetingGestureActive = preserveDuringSpeech;
		let resolveStarted!: (started: boolean) => void;
		let startSettled = false;
		const started = new Promise<boolean>((resolve) => {
			resolveStarted = (didStart) => {
				if (startSettled) return;
				startSettled = true;
				resolve(didStart);
			};
		});
		void this.playClip(
			animation.clip,
			false,
			true,
			{ onPlaybackReady: () => resolveStarted(true) },
			generation,
			false,
		).then(
			async () => {
				if (generation === this.generation) {
					this.activeGesture = false;
					this.greetingGestureActive = false;
				}
				resolveStarted(false);
				if (
					generation === this.generation &&
					!this.disposed &&
					(!this.speakingVisual || preserveDuringSpeech)
				) {
					await this.playIdle();
				}
			},
			async () => {
				if (generation === this.generation) {
					this.activeGesture = false;
					this.greetingGestureActive = false;
				}
				resolveStarted(false);
				if (generation === this.generation && !this.disposed)
					await this.playIdle();
			},
		);
		return started;
	}

	/** Use `key` (a manifest animation) as the idle loop; null = bundle default. */
	setIdleOverride(key: string | null): void {
		const next = key && this.config.manifest.animations[key]?.clip ? key : null;
		if (next === this.idleOverride) return;
		this.idleOverride = next;
		// Speech or a gesture returns to idle on its own and picks the new loop then.
		if (
			!this.video ||
			this.disposed ||
			this.speakingVisual ||
			this.cancelOneShot
		)
			return;
		++this.generation;
		void this.playIdle();
	}

	/**
	 * Speaking state only. The mouth moves solely through playSpeechTiming
	 * (canonical player); without a plan the idle clip keeps playing.
	 */
	setSpeakingVisual(active: boolean): void {
		if (!this.video || this.disposed) return;
		this.speakingVisual = active;
		this.config.onSpeaking?.(active);
		if (this.greetingGestureActive && this.activeGesture) {
			if (!active) {
				this.speechStage?.stop();
			}
			return;
		}
		this.generation++;
		if (active) {
			const needsFallbackClip =
				Boolean(this.speechStage) &&
				this.speechStage?.assetsLoaded === false &&
				!this.speechStage.speaking &&
				Boolean(this.config.manifest.animations.talking?.clip);
			if (this.activeGesture || needsFallbackClip) {
				this.activeGesture = false;
				this.cancelOneShot?.();
				void this.playIdle();
			}
		} else {
			this.speechStage?.stop();
			void this.playIdle();
		}
	}

	/** Play one aligned or browser-timed plan through the canonical player. */
	async playSpeechTiming(timing: AvatarSpeechTiming): Promise<boolean> {
		const stage = this.speechStage;
		if (!stage || this.disposed) return false;
		if (this.activeGesture) {
			this.generation++;
			this.activeGesture = false;
			this.greetingGestureActive = false;
			this.cancelOneShot?.();
			void this.playIdle();
		}
		this.speechKeyColor = this.keyColorFor(
			this.config.manifest.animations.talking?.clip ?? "",
		);
		return stage.start(timing);
	}

	/** True when this avatar carries the canonical speech set. */
	canPlaySpeechPlans(): boolean {
		return Boolean(this.speechStage) && !this.disposed;
	}

	/** Pre-fetch canonical speech assets (`speech/atlas.bin`, etc.) in the background after greeting. */
	async warmSpeechAssets(): Promise<void> {
		if (!this.speechStage || this.disposed) return;
		await this.speechStage.warmAssets();
	}

	/** Load a plan ahead of its sound; play(clock) once the sound starts. */
	async prepareSpeechTiming(plan: SpeechPlan): Promise<PreparedSpeech | null> {
		const stage = this.speechStage;
		if (!stage || this.disposed) return null;
		this.speechKeyColor = this.keyColorFor(
			this.config.manifest.animations.talking?.clip ?? "",
		);
		return stage.prepare(plan);
	}

	/**
	 * Load one future aligned plan on a second canonical stage. Loading a plan
	 * into the active stage stops its current plan, so the standby stage remains
	 * invisible until the matching audio starts and its PreparedSpeech is used.
	 */
	async prefetchSpeechTiming(plan: SpeechPlan): Promise<PreparedSpeech | null> {
		const host = this.mountedVideo;
		if (!this.speechStage || !host || this.disposed) return null;
		this.cancelPrefetchedSpeechTiming();
		const stage = this.createSpeechStage(host);
		if (!stage) return null;
		this.prefetchedSpeechStage = stage;
		this.speechKeyColor = this.keyColorFor(
			this.config.manifest.animations.talking?.clip ?? "",
		);
		const ready = await stage.prepare(plan);
		if (!ready || this.prefetchedSpeechStage !== stage || this.disposed) {
			if (this.prefetchedSpeechStage === stage)
				this.cancelPrefetchedSpeechTiming();
			else stage.dispose();
			return null;
		}
		let used = false;
		return {
			play: async (clock) => {
				if (used || typeof clock !== "function") return false;
				used = true;
				if (this.prefetchedSpeechStage !== stage || this.disposed) return false;
				const previous = this.speechStage;
				this.speechStage = stage;
				this.prefetchedSpeechStage = null;
				previous?.dispose();
				return ready.play(clock);
			},
		};
	}

	cancelPrefetchedSpeechTiming(): void {
		const stage = this.prefetchedSpeechStage;
		this.prefetchedSpeechStage = null;
		stage?.dispose();
	}

	/** Revise the running browser-timed plan after a boundary event. */
	updateSpeechPlan(plan: SpeechPlan): boolean {
		return this.speechStage?.update(plan) ?? false;
	}

	private createSpeechStage(
		host: HTMLVideoElement,
	): CanonicalSpeechStage | null {
		if (this.config.createSpeechStage)
			return this.config.createSpeechStage(host);
		if (!hasCanonicalSpeechMotion(this.config.manifest)) return null;
		try {
			return new CanonicalSpeechStage({
				manifest: this.config.manifest,
				host,
				loadAsset: (path) => {
					const cached = this.assetBlobCache.get(path);
					if (cached) return cached;
					const loader = this.config.loadAssetBlob
						? this.config.loadAssetBlob(path)
						: (async () => {
								const response = await fetch(
									await this.config.resolveAssetUrl(path),
								);
								if (!response.ok)
									throw new Error(`NVA asset ${path} unavailable`);
								return response.blob();
							})();
					const tracked = loader.catch((err) => {
						this.assetBlobCache.delete(path);
						throw err;
					});
					this.assetBlobCache.set(path, tracked);
					return tracked;
				},
			});
		} catch {
			return null;
		}
	}

	private keyColorFor(path: string): string | undefined {
		return (
			this.config.manifest.chroma_key ??
			(canCarryAlpha(path) ? undefined : this.config.manifest.background?.color)
		);
	}

	private async playClip(
		path: string,
		loop: boolean,
		muted: boolean,
		options?: AvatarPlaybackOptions,
		expectedGeneration?: number,
		resumePosition = false,
	): Promise<void> {
		if (!this.video || !this.mountedVideo)
			throw new Error("NVA video is not mounted");
		// Cancel the previous startup wait before resolving the next asset URL.
		this.clearPlaybackTimers();
		const url = await this.config.resolveAssetUrl(path);
		if (this.disposed || !this.mountedVideo)
			throw new Error("NVA renderer stopped");
		if (
			expectedGeneration !== undefined &&
			expectedGeneration !== this.generation
		)
			return;
		this.currentClipUrl = url;
		this.currentKeyColor = isStackedAlphaClipUrl(url)
			? undefined
			: this.keyColorFor(path);
		const video = this.videoForClip(url);
		this.cancelOneShot?.();
		if (this.video !== video) {
			this.video.pause();
			this.video = video;
		}
		video.loop = loop;
		video.muted = muted;
		if (!resumePosition) video.currentTime = 0;
		if (loop) {
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const cleanup = () => {
					clearTimeout(timer);
					this.playbackTimers.delete(timer);
					if (this.cancelOneShot === cancel) this.cancelOneShot = null;
				};
				const cancel = () => {
					if (settled) return;
					settled = true;
					cleanup();
					resolve();
				};
				const finish = (reason?: string) => {
					if (settled) return;
					settled = true;
					cleanup();
					if (reason) {
						this.failMedia(reason);
						reject(new Error(reason));
					} else resolve();
				};
				const timer = setTimeout(
					() =>
						this.video !== video ||
						(expectedGeneration !== undefined &&
							expectedGeneration !== this.generation)
							? cancel()
							: finish("NVA playback start timeout"),
					8000,
				);
				// Loop waits are cancelled through clearPlaybackTimers; cancelOneShot
				// stays reserved for one-shot clips so setIdleOverride is not blocked.
				this.playbackTimers.set(timer, cancel);
				video.play().then(
					() => finish(),
					(err: unknown) => {
						const isAbort = (err as DOMException)?.name === "AbortError";
						const superseded =
							this.disposed ||
							this.video !== video ||
							(expectedGeneration !== undefined &&
								expectedGeneration !== this.generation);
						if (isAbort || superseded) cancel();
						else finish("NVA playback rejected");
					},
				);
			});
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				video.removeEventListener("playing", ready);
				video.removeEventListener("ended", ended);
				video.removeEventListener("error", failed);
				if (this.cancelOneShot === cancel) this.cancelOneShot = null;
			};
			const cancel = () => {
				cleanup();
				resolve();
			};
			let playbackStarted = false;
			const ready = () => {
				if (playbackStarted) return;
				playbackStarted = true;
				options?.onPlaybackReady?.();
			};
			const ended = () => {
				cleanup();
				resolve();
			};
			const failed = () => {
				cleanup();
				reject(new Error("NVA clip playback failed"));
			};
			video.addEventListener("playing", ready, { once: true });
			video.addEventListener("ended", ended, { once: true });
			video.addEventListener("error", failed, { once: true });
			this.cancelOneShot = cancel;
			video.play().then(ready).catch(failed);
		});
	}

	/**
	 * Return the persistent `<video>` for `url`, creating and loading it once.
	 * The first clip re-uses the React-mounted element; each additional clip
	 * gets a hidden sibling so switching clips is pause/play, never `src =`.
	 */
	private videoForClip(url: string): HTMLVideoElement {
		const existing = this.clipVideos.get(url);
		if (existing) return existing;
		const mounted = this.mountedVideo!;
		const element =
			this.clipVideos.size === 0
				? mounted
				: (mounted.cloneNode(false) as HTMLVideoElement);
		if (element !== mounted) {
			element.playsInline = true;
			mounted.parentElement?.insertBefore(element, mounted.nextSibling);
		}
		element.addEventListener(
			"error",
			() => {
				Logger.warn(
					"PrebakedAvatarRenderer",
					"decoder error",
					this.mediaDiagnostics(element),
				);
				if (element.loop) this.failMedia("NVA decoder error");
			},
			{ once: true },
		);
		element.src = url;
		element.dataset.naiaClipUrl = url;
		this.clipVideos.set(url, element);
		return element;
	}

	private async playIdle(): Promise<void> {
		if (!this.video || this.disposed) return;
		const generation = this.generation;
		const fallbackClip =
			this.speakingVisual &&
			this.speechStage?.assetsLoaded === false &&
			!this.speechStage.speaking
				? this.config.manifest.animations.talking?.clip
				: undefined;
		const override = this.idleOverride
			? this.config.manifest.animations[this.idleOverride]?.clip
			: undefined;
		await this.playClip(
			fallbackClip ?? override ?? defaultClipOf(this.config.manifest).video,
			true,
			true,
			undefined,
			generation,
			!fallbackClip,
		).catch(() => {
			if (generation === this.generation && !this.disposed)
				this.failMedia("NVA idle playback failed");
		});
	}

	private ensureOffscreen(
		width: number,
		height: number,
	): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
		if (!this.offscreenCanvas) {
			this.offscreenCanvas = document.createElement("canvas");
			this.offscreenCanvas.width = width;
			this.offscreenCanvas.height = height;
			this.offscreenCtx = this.offscreenCanvas.getContext("2d", {
				alpha: true,
			});
		} else {
			if (this.offscreenCanvas.width !== width)
				this.offscreenCanvas.width = width;
			if (this.offscreenCanvas.height !== height)
				this.offscreenCanvas.height = height;
		}
		if (!this.offscreenCtx) return null;
		this.offscreenCtx.imageSmoothingEnabled = true;
		this.offscreenCtx.imageSmoothingQuality = "high";
		return { canvas: this.offscreenCanvas, ctx: this.offscreenCtx };
	}

	/** 숨은 decode `<video>`를 매 프레임 표시 `<canvas>`에 합성(필요 시 크로마키 및 라이브2D식 절차적 모션). */
	private startDrawLoop(): void {
		if (this.running) return;
		this.running = true;
		const draw = () => {
			if (!this.running) return;
			const stage = this.speechStage?.speaking ? this.speechStage : null;
			const video = this.video;
			const source: HTMLVideoElement | HTMLCanvasElement | null = stage
				? stage.canvas
				: video;
			const canvas = this.canvas;
			const ctx = this.ctx;
			const clipUrl = stage
				? ""
				: video?.dataset.naiaClipUrl ||
					this.currentClipUrl ||
					video?.getAttribute("src") ||
					video?.src ||
					"";
			const isStacked = !stage && Boolean(video) && isStackedAlphaClipUrl(clipUrl);
			const sourceWidth = stage ? stage.canvas.width : (video?.videoWidth ?? 0);
			const rawHeight = stage ? stage.canvas.height : (video?.videoHeight ?? 0);
			const sourceHeight = isStacked
				? Math.max(1, Math.floor(rawHeight / 2))
				: rawHeight;
			if (
				source &&
				canvas &&
				ctx &&
				(stage || (video?.readyState ?? 0) >= 2) &&
				sourceWidth > 0 &&
				sourceHeight > 0
			) {
				const rect = containRect(
					canvas.width,
					canvas.height,
					sourceWidth,
					sourceHeight,
				);
				ctx.imageSmoothingEnabled = true;
				ctx.imageSmoothingQuality = "high";
				ctx.clearRect(0, 0, canvas.width, canvas.height);
				if (rect.dw > 0 && rect.dh > 0) {
					const keyColor = stage ? this.speechKeyColor : this.currentKeyColor;
					const baseMotion = this.motionSpec;
					const motionSpec: MotionSpec | null =
						baseMotion && this.activeGesture
							? {
									...baseMotion,
									breath: baseMotion.breath,
									breath_period_s: Math.max(
										1.5,
										Math.min(baseMotion.breath_period_s, 2.2),
									),
									sway_deg: Math.min(
										2.4,
										Math.max(baseMotion.sway_deg * 1.8, 1.6),
									),
									sway_period_s: Math.max(
										2.0,
										Math.min(baseMotion.sway_period_s, 2.6),
									),
								}
							: baseMotion;
					const offscreen = motionSpec
						? this.ensureOffscreen(canvas.width, canvas.height)
						: null;
					const drawTarget = offscreen ? offscreen.ctx : ctx;
					drawTarget.imageSmoothingEnabled = true;
					drawTarget.imageSmoothingQuality = "high";

					if (offscreen) {
						offscreen.ctx.clearRect(0, 0, canvas.width, canvas.height);
					}

					const applyDirectZoom = !offscreen && Math.abs(this.zoom - 1) > 1e-4;
					if (applyDirectZoom) {
						ctx.save?.();
						ctx.translate?.(canvas.width / 2, canvas.height / 2);
						ctx.scale?.(this.zoom, this.zoom);
						ctx.translate?.(-canvas.width / 2, -canvas.height / 2);
					}

					let drew = false;
					if (isStacked && video) {
						if (!this.stackedAlphaFailed) {
							try {
								if (!this.stackedAlpha) {
									this.stackedAlpha = this.config.createStackedAlpha
										? this.config.createStackedAlpha()
										: new NvaStackedAlphaGL();
								}
								if (!this.stackedAlpha.draw(video)) {
									throw new Error("stacked-alpha context lost");
								}
								drawTarget.drawImage(
									this.stackedAlpha.canvas,
									rect.dx,
									rect.dy,
									rect.dw,
									rect.dh,
								);
								drew = true;
							} catch (error) {
								this.stackedAlphaFailed = true;
								this.stackedAlpha?.dispose();
								this.stackedAlpha = null;
								Logger.warn(
									"PrebakedAvatarRenderer",
									"stacked-alpha WebGL failed; drawing top half only",
									{ error: String(error) },
								);
							}
						}
						if (!drew) {
							drawTarget.drawImage(
								video,
								0,
								0,
								sourceWidth,
								sourceHeight,
								rect.dx,
								rect.dy,
								rect.dw,
								rect.dh,
							);
							drew = true;
						}
					} else if (keyColor && !this.keyerFailed) {
						try {
							if (!this.keyer)
								this.keyer = new NvaChromakeyGL({
									mode: "chromakey",
									keyColor,
								});
							else this.keyer.setParams({ mode: "chromakey", keyColor });
							const keyed = this.keyer.process(source, sourceWidth, sourceHeight);
							drawTarget.drawImage(keyed, rect.dx, rect.dy, rect.dw, rect.dh);
							drew = true;
						} catch {
							// WebGL2 unavailable or context lost — fall back to a plain
							// (possibly opaque-backdrop) draw rather than a blank canvas.
							this.keyerFailed = true;
						}
					} else if (
						this.config.manifest.background?.type === "transparent" &&
						!this.keyerFailed
					) {
						try {
							if (!this.keyer)
								this.keyer = new NvaChromakeyGL({ mode: "alpha-repair" });
							else this.keyer.setParams({ mode: "alpha-repair" });
							const repaired = this.keyer.process(
								source,
								sourceWidth,
								sourceHeight,
							);
							drawTarget.drawImage(
								repaired,
								rect.dx,
								rect.dy,
								rect.dw,
								rect.dh,
							);
							drew = true;
						} catch {
							this.keyerFailed = true;
						}
					}
					if (!drew)
						drawTarget.drawImage(source, rect.dx, rect.dy, rect.dw, rect.dh);

					if (applyDirectZoom) {
						ctx.restore?.();
					}

					if (offscreen) {
						const applyMotionZoom = Math.abs(this.zoom - 1) > 1e-4;
						if (applyMotionZoom) {
							ctx.save?.();
							ctx.translate?.(canvas.width / 2, canvas.height / 2);
							ctx.scale?.(this.zoom, this.zoom);
							ctx.translate?.(-canvas.width / 2, -canvas.height / 2);
						}
						drawWithMotion(
							ctx,
							offscreen.canvas,
							rect,
							motionSpec,
							performance.now(),
						);
						if (applyMotionZoom) {
							ctx.restore?.();
						}
					}
				}
			}
			this.raf = requestAnimationFrame(draw);
		};
		this.raf = requestAnimationFrame(draw);
	}

	private clearPlaybackTimers(): void {
		for (const cancel of this.playbackTimers.values()) cancel();
		this.playbackTimers.clear();
	}

	interrupt(): void {
		this.clearPlaybackTimers();
		this.generation++;
		this.cancelOneShot?.();
		this.activeGesture = false;
		this.greetingGestureActive = false;
		this.speakingVisual = false;
		this.speechStage?.stop();
		this.config.onSpeaking?.(false);
		void this.playIdle();
	}

	stop(preserveMedia = false): void {
		this.disposed = true;
		this.clearPlaybackTimers();
		this.running = false;
		this.stopIdleGestureLoop();
		if (this.raf) cancelAnimationFrame(this.raf);
		this.raf = 0;
		this.stackedAlpha?.dispose();
		this.stackedAlpha = null;
		this.keyer?.dispose();
		this.keyer = null;
		this.offscreenCanvas = null;
		this.offscreenCtx = null;
		this.interrupt();
		this.cancelPrefetchedSpeechTiming();
		this.speechStage?.dispose();
		this.speechStage = null;
		for (const v of this.clipVideos.values()) {
			v.pause();
			if (!preserveMedia && v !== this.mountedVideo) v.remove();
		}
		if (!preserveMedia) {
			this.clipVideos.clear();
			this.assetBlobCache.clear();
		}
		this.video?.pause();
		this.video = null;
		if (!preserveMedia) this.mountedVideo = null;
		this.canvas = null;
		this.ctx = null;
	}
}
