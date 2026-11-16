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
	isStackedAlphaClipUrl,
	isStackedAlphaVideoElement,
	isWebKitWithoutVp9Alpha,
	markVideoStackedAlpha,
	resolveNvaClipKeyColor,
	shouldUseStackedAlpha,
} from "./nva-stacked-alpha";
import { NvaStackedAlphaGL } from "./nva-stacked-alpha-gl";

export interface StackedAlphaCompositorLike {
	readonly canvas: HTMLCanvasElement;
	draw(video: HTMLVideoElement): boolean;
	dispose(): void;
}

export interface ResolvedNvaClipSource {
	url: string;
	stackedAlpha?: boolean;
	resolvedPath?: string;
}

interface Config {
	manifest: NvaManifest;
	locale: string;
	resolveAssetUrl: (path: string) => Promise<string>;
	/**
	 * Bundle asset bytes for the canonical NVA speech player (`CanonicalSpeechStage`).
	 * On desktop, uses `createDesktopNvaAssetBlobLoader` so macOS `WKWebView`
	 * transparently resolves `.stacked.mp4` / `.mp4` fallbacks without `fetch(blob:)`.
	 */
	loadAssetBlob?: (path: string) => Promise<Blob>;
	/** Optional ordered fallback resolver (e.g. `.stacked.mp4` -> `.mp4` -> `.webm` on WKWebView). */
	resolveClipCandidates?: (path: string) => Promise<ResolvedNvaClipSource[]>;
	onSpeaking?: (speaking: boolean) => void;
	createStackedAlpha?: () => StackedAlphaCompositorLike;
	onPlaybackFailure?: (reason: string) => void;
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
 *   2) Shell의 실제 재생 시작/종료에 맞춘 idle/talking 비주얼 전환
 *
 * 표시는 숨은 `<video>`(디코드 버퍼)를 매 프레임 `<canvas>`(alpha:true)에 합성한다.
 * - 상하 분리(`stacked_alpha`, `.stacked.mp4` 또는 `dataset.naiaStackedAlpha="true"`):
 *   `NvaStackedAlphaGL`(WebGL1)로 상단 RGB + 하단 그레이스케일 알파를 합성한다.
 * - WebM 알파 클립: 그대로 drawImage.
 * - 알파를 가질 수 없는 일반 컨테이너(mp4 등): `manifest.chroma_key`(또는 배경색 `background.color`)로
 *   GPU 크로마키 처리해 검은/불투명 배경이 노출되지 않게 한다.
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
	private keyer: NvaChromakeyGL | null = null;
	private keyerFailed = false;
	private currentKeyColor: string | undefined;
	private motionSpec: MotionSpec | null;
	private offscreenCanvas: HTMLCanvasElement | null = null;
	private offscreenCtx: CanvasRenderingContext2D | null = null;
	private disposed = false;
	private mediaFailed = false;
	private generation = 0;
	private speakingVisual = false;
	private cancelOneShot: (() => void) | null = null;
	private cancelLoopErrorWatcher: (() => void) | null = null;
	private assetBlobCache = new Map<string, Promise<Blob>>();
	private tail = Promise.resolve();
	private raf = 0;
	private running = false;

	constructor(private readonly config: Config) {
		this.motionSpec = parseMotionSpec(config.manifest);
		if (this.motionSpec) {
			this.motionSpec.chest_y = resolveChestY(config.manifest, this.motionSpec);
		}
	}

	/**
	 * Cached bundle-relative `Blob` reader shared with `0.2.6` `CanonicalSpeechStage`
	 * (`loadAsset`). Delegates to `config.loadAssetBlob` when wired (desktop IPC +
	 * macOS `.stacked.mp4` / `.mp4` fallback) or `fetch(resolveAssetUrl(path))` in web mode.
	 */
	loadAssetBlob(path: string): Promise<Blob> {
		const cached = this.assetBlobCache.get(path);
		if (cached) return cached;
		const loader = this.config.loadAssetBlob
			? this.config.loadAssetBlob(path)
			: (async () => {
					const response = await fetch(await this.config.resolveAssetUrl(path));
					if (!response.ok) {
						throw new Error(`NVA asset ${path} unavailable`);
					}
					return response.blob();
				})();
		const tracked = loader.catch((err) => {
			this.assetBlobCache.delete(path);
			throw err;
		});
		this.assetBlobCache.set(path, tracked);
		return tracked;
	}

	start(video: HTMLVideoElement, canvas: HTMLCanvasElement): void {
		this.video = video;
		this.mountedVideo = video;
		this.canvas = canvas;
		this.ctx = canvas.getContext("2d", { alpha: true });
		void this.playIdle();
		this.startDrawLoop();
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

	/** Play a manifest gesture once, silently. Speech visuals take priority. */
	async playAction(key: string): Promise<boolean> {
		if (!this.video || this.disposed || this.speakingVisual) return false;
		const animation = this.config.manifest.animations[key];
		if (!animation || animKind(animation) !== "gesture") return false;
		const generation = ++this.generation;
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
				resolveStarted(false);
				if (
					generation === this.generation &&
					!this.disposed &&
					!this.speakingVisual
				)
					await this.playIdle();
			},
			async () => {
				resolveStarted(false);
				if (generation === this.generation && !this.disposed)
					await this.playIdle();
			},
		);
		return started;
	}

	/** Switch idle/talking visual only. Shell owns the actual audio playback. */
	setSpeakingVisual(active: boolean): void {
		if (!this.video || this.disposed) return;
		const generation = ++this.generation;
		this.speakingVisual = active;
		this.config.onSpeaking?.(active);
		if (active) {
			const clip =
				this.config.manifest.vrm_slots?.visemes?.aiueo?.clip ??
				this.config.manifest.vrm_slots?.motions?.talking?.clip ??
				this.config.manifest.animations.talking?.clip ??
				this.config.manifest.animations.speak?.clip ??
				defaultClipOf(this.config.manifest).video;
			void this.playClip(clip, true, true, undefined, generation, false).catch(
				(err) => {
					Logger.warn(
						"PrebakedAvatarRenderer",
						"talking clip playback failed",
						{
							clip,
							error: String(err),
						},
					);
				},
			);
		} else {
			void this.playIdle();
		}
	}

	private reportPlaybackFailure(reason: unknown): void {
		if (this.disposed || this.mediaFailed) return;
		this.mediaFailed = true;
		const message =
			reason instanceof Error
				? reason.message
				: String(reason || "NVA clip playback failed");
		Logger.warn("PrebakedAvatarRenderer", "NVA playback failed", {
			reason: message,
		});
		this.config.onPlaybackFailure?.(message);
	}

	private async resolveSourcesForClip(
		path: string,
	): Promise<ResolvedNvaClipSource[]> {
		if (this.config.resolveClipCandidates) {
			const resolved = await this.config.resolveClipCandidates(path);
			if (resolved.length > 0) return resolved;
		}
		const normalizedRel = path.replace(/\\/g, "/").replace(/^\/+/, "");
		const mappedStacked = shouldUseStackedAlpha()
			? (this.config.manifest.stacked_alpha?.clips?.[normalizedRel] ??
				this.config.manifest.stacked_alpha?.clips?.[path])
			: undefined;

		if (mappedStacked && mappedStacked !== path) {
			const sources: ResolvedNvaClipSource[] = [];
			try {
				const stackedUrl = await this.config.resolveAssetUrl(mappedStacked);
				sources.push({
					url: stackedUrl,
					stackedAlpha: true,
					resolvedPath: mappedStacked,
				});
			} catch {
				// Fall through to primary clip path when stacked asset cannot be resolved.
			}
			try {
				const fallbackUrl = await this.config.resolveAssetUrl(path);
				sources.push({
					url: fallbackUrl,
					stackedAlpha: isStackedAlphaClipUrl(path),
					resolvedPath: path,
				});
			} catch (err) {
				if (sources.length === 0) throw err;
			}
			return sources;
		}

		const url = await this.config.resolveAssetUrl(path);
		return [
			{
				url,
				stackedAlpha: isStackedAlphaClipUrl(path) || isStackedAlphaClipUrl(url),
				resolvedPath: path,
			},
		];
	}

	private evictFailedPooledVideo(url: string, video: HTMLVideoElement): void {
		if (this.clipVideos.get(url) === video) {
			this.clipVideos.delete(url);
		}
		video.pause();
		if (video !== this.mountedVideo) {
			video.remove();
		} else {
			video.removeAttribute("src");
			delete video.dataset.naiaClipUrl;
			delete video.dataset.naiaStackedAlpha;
			delete video.dataset.naiaResolvedPath;
		}
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
		const normalizedRel = path.replace(/\\/g, "/").replace(/^\/+/, "");
		const mappedStacked = shouldUseStackedAlpha()
			? (this.config.manifest.stacked_alpha?.clips?.[normalizedRel] ??
				this.config.manifest.stacked_alpha?.clips?.[path])
			: undefined;
		let sources: ResolvedNvaClipSource[];
		try {
			if (
				!this.config.resolveClipCandidates &&
				(!mappedStacked || mappedStacked === path)
			) {
				const url = await this.config.resolveAssetUrl(path);
				sources = [
					{
						url,
						stackedAlpha:
							isStackedAlphaClipUrl(path) || isStackedAlphaClipUrl(url),
						resolvedPath: path,
					},
				];
			} else {
				sources = await this.resolveSourcesForClip(path);
			}
		} catch (err) {
			if (loop) this.reportPlaybackFailure(err);
			throw err;
		}
		if (this.disposed || !this.mountedVideo)
			throw new Error("NVA renderer stopped");
		if (
			expectedGeneration !== undefined &&
			expectedGeneration !== this.generation
		)
			return;

		let lastError: unknown = new Error("NVA clip playback failed");
		for (let i = 0; i < sources.length; i++) {
			const source = sources[i];
			const effectivePath = source.resolvedPath ?? path;
			const isStacked =
				source.stackedAlpha ??
				(isStackedAlphaClipUrl(effectivePath) ||
					isStackedAlphaClipUrl(source.url));
			this.currentKeyColor = resolveNvaClipKeyColor(
				this.config.manifest,
				effectivePath,
				isStacked,
			);

			const video = this.videoForClip(source.url, isStacked, effectivePath);
			this.cancelOneShot?.();
			this.cancelLoopErrorWatcher?.();
			if (this.video && this.video !== video) {
				this.video.pause();
			}
			this.video = video;
			video.loop = loop;
			video.muted = muted;
			if (!resumePosition) video.currentTime = 0;

			try {
				if (loop) {
					if (isWebKitWithoutVp9Alpha()) {
						const onAsyncMediaError = () => {
							if (this.video !== video || this.disposed) return;
							const reason =
								video.error?.message || `Media decode error (${effectivePath})`;
							this.evictFailedPooledVideo(source.url, video);
							if (i + 1 < sources.length) {
								Logger.warn(
									"PrebakedAvatarRenderer",
									"async loop decode failed; trying next fallback",
									{
										failedPath: effectivePath,
										nextPath: sources[i + 1]?.resolvedPath ?? path,
										error: reason,
									},
								);
								void this.playLoopFallbackFrom(
									path,
									sources,
									i + 1,
									muted,
									expectedGeneration,
									resumePosition,
								);
								return;
							}
							this.reportPlaybackFailure(reason);
						};
						video.addEventListener("error", onAsyncMediaError, { once: true });
						this.cancelLoopErrorWatcher = () => {
							video.removeEventListener("error", onAsyncMediaError);
							this.cancelLoopErrorWatcher = null;
						};
					}
					await video.play();
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
					const failed = (cause?: unknown) => {
						cleanup();
						reject(
							cause instanceof Error
								? cause
								: new Error(
										video.error?.message ||
											`NVA clip playback failed (${effectivePath})`,
									),
						);
					};
					video.addEventListener("playing", ready, { once: true });
					video.addEventListener("ended", ended, { once: true });
					video.addEventListener("error", () => failed(), { once: true });
					this.cancelOneShot = cancel;
					video.play().then(ready).catch(failed);
				});
				return;
			} catch (err) {
				lastError = err;
				this.cancelLoopErrorWatcher?.();
				this.evictFailedPooledVideo(source.url, video);
				if (this.disposed) throw err;
				if (
					expectedGeneration !== undefined &&
					expectedGeneration !== this.generation
				) {
					return;
				}
				if (i + 1 < sources.length) {
					Logger.warn(
						"PrebakedAvatarRenderer",
						"clip candidate failed; trying next fallback",
						{
							failedPath: effectivePath,
							nextPath: sources[i + 1]?.resolvedPath ?? path,
							error: String(err),
						},
					);
				}
			}
		}

		if (loop) {
			this.reportPlaybackFailure(lastError);
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	private async playLoopFallbackFrom(
		path: string,
		sources: ResolvedNvaClipSource[],
		startIndex: number,
		muted: boolean,
		expectedGeneration?: number,
		resumePosition = false,
	): Promise<void> {
		let lastError: unknown = new Error("NVA clip playback failed");
		for (let i = startIndex; i < sources.length; i++) {
			if (
				this.disposed ||
				(expectedGeneration !== undefined &&
					expectedGeneration !== this.generation)
			) {
				return;
			}
			const source = sources[i];
			const effectivePath = source.resolvedPath ?? path;
			const isStacked =
				source.stackedAlpha ??
				(isStackedAlphaClipUrl(effectivePath) ||
					isStackedAlphaClipUrl(source.url));
			this.currentKeyColor = resolveNvaClipKeyColor(
				this.config.manifest,
				effectivePath,
				isStacked,
			);
			const video = this.videoForClip(source.url, isStacked, effectivePath);
			this.cancelLoopErrorWatcher?.();
			if (this.video && this.video !== video) {
				this.video.pause();
			}
			this.video = video;
			video.loop = true;
			video.muted = muted;
			if (!resumePosition) video.currentTime = 0;

			try {
				const onAsyncMediaError = () => {
					if (this.video !== video || this.disposed) return;
					const reason =
						video.error?.message || `Media decode error (${effectivePath})`;
					this.evictFailedPooledVideo(source.url, video);
					if (i + 1 < sources.length) {
						void this.playLoopFallbackFrom(
							path,
							sources,
							i + 1,
							muted,
							expectedGeneration,
							resumePosition,
						);
						return;
					}
					this.reportPlaybackFailure(reason);
				};
				video.addEventListener("error", onAsyncMediaError, { once: true });
				this.cancelLoopErrorWatcher = () => {
					video.removeEventListener("error", onAsyncMediaError);
					this.cancelLoopErrorWatcher = null;
				};
				await video.play();
				return;
			} catch (err) {
				lastError = err;
				this.cancelLoopErrorWatcher?.();
				this.evictFailedPooledVideo(source.url, video);
			}
		}
		this.reportPlaybackFailure(lastError);
	}

	/**
	 * 클립마다 <video> 를 하나씩 두고 재사용한다. WebKitGTK 에서 `src=` 재대입은 이전
	 * GStreamer 파이프라인을 메인 스레드에서 동기 해체하는데, 그 파이프라인의 demuxer
	 * 스레드가 bus 동기 핸들러에서 메인 스레드를 기다리는 순간과 겹치면 서로 기다리며
	 * 웹뷰 전체가 멈춘다. 첫 클립은 마운트된 요소를 쓰고, 다른 클립은 같은
	 * 부모 아래 같은 스타일의 숨은 형제 요소를 만든다.
	 * 또한 데스크톱 `blob:` URL에서도 `stacked_alpha` 여부가 유실되지 않도록
	 * `dataset.naiaStackedAlpha`와 `dataset.naiaResolvedPath`를 기록한다.
	 */
	private videoForClip(
		url: string,
		isStackedAlpha = false,
		resolvedPath?: string,
	): HTMLVideoElement {
		const mounted = this.mountedVideo;
		if (!mounted) throw new Error("NVA video is not mounted");
		const pooled = this.clipVideos.get(url);
		if (pooled) {
			markVideoStackedAlpha(pooled, isStackedAlpha, resolvedPath);
			return pooled;
		}
		let video: HTMLVideoElement;
		if (this.clipVideos.size === 0 && !mounted.dataset.naiaClipUrl) {
			video = mounted;
		} else {
			video = document.createElement("video");
			video.playsInline = true;
			video.muted = true;
			video.crossOrigin = mounted.crossOrigin;
			video.style.cssText = mounted.style.cssText;
			mounted.parentNode?.insertBefore(video, mounted.nextSibling);
		}
		video.src = url;
		video.dataset.naiaClipUrl = url;
		markVideoStackedAlpha(video, isStackedAlpha, resolvedPath);
		this.clipVideos.set(url, video);
		return video;
	}

	private async playIdle(): Promise<void> {
		if (!this.video || this.disposed) return;
		const generation = this.generation;
		await this.playClip(
			defaultClipOf(this.config.manifest).video,
			true,
			true,
			undefined,
			generation,
			true,
		).catch((err) => {
			this.reportPlaybackFailure(err);
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
		return { canvas: this.offscreenCanvas, ctx: this.offscreenCtx };
	}

	/** 숨은 decode `<video>`를 매 프레임 표시 `<canvas>`에 합성(stacked_alpha / 크로마키 / 절차적 모션). */
	private startDrawLoop(): void {
		if (this.running) return;
		this.running = true;
		const draw = () => {
			if (!this.running) return;
			const video = this.video;
			const canvas = this.canvas;
			const ctx = this.ctx;
			if (
				video &&
				canvas &&
				ctx &&
				video.readyState >= 2 &&
				video.videoWidth > 0 &&
				video.videoHeight > 0
			) {
				const isStacked = isStackedAlphaVideoElement(video);
				const sourceWidth = video.videoWidth;
				const sourceHeight = isStacked
					? Math.max(1, Math.floor(video.videoHeight / 2))
					: video.videoHeight;
				const rect = containRect(
					canvas.width,
					canvas.height,
					sourceWidth,
					sourceHeight,
				);
				ctx.clearRect(0, 0, canvas.width, canvas.height);
				if (rect.dw > 0 && rect.dh > 0) {
					const keyColor = this.currentKeyColor;
					const motionSpec = this.motionSpec;
					const offscreen = motionSpec
						? this.ensureOffscreen(canvas.width, canvas.height)
						: null;
					const drawTarget = offscreen ? offscreen.ctx : ctx;

					if (offscreen) {
						offscreen.ctx.clearRect(0, 0, canvas.width, canvas.height);
					}

					let drew = false;
					if (isStacked) {
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
							if (!this.keyer) this.keyer = new NvaChromakeyGL({ keyColor });
							else this.keyer.setParams({ keyColor });
							const keyed = this.keyer.process(
								video,
								sourceWidth,
								sourceHeight,
							);
							drawTarget.drawImage(keyed, rect.dx, rect.dy, rect.dw, rect.dh);
							drew = true;
						} catch {
							// WebGL2 unavailable or context lost — fall back to a plain
							// (possibly opaque-backdrop) draw rather than a blank canvas.
							this.keyerFailed = true;
						}
					}
					if (!drew)
						drawTarget.drawImage(video, rect.dx, rect.dy, rect.dw, rect.dh);

					if (offscreen) {
						drawWithMotion(
							ctx,
							offscreen.canvas,
							rect,
							motionSpec,
							performance.now(),
						);
					}
				}
			}
			this.raf = requestAnimationFrame(draw);
		};
		this.raf = requestAnimationFrame(draw);
	}

	interrupt(): void {
		this.generation++;
		this.cancelOneShot?.();
		this.cancelLoopErrorWatcher?.();
		this.speakingVisual = false;
		this.config.onSpeaking?.(false);
		void this.playIdle();
	}

	stop(): void {
		this.disposed = true;
		this.running = false;
		if (this.raf) cancelAnimationFrame(this.raf);
		this.raf = 0;
		this.cancelLoopErrorWatcher?.();
		this.stackedAlpha?.dispose();
		this.stackedAlpha = null;
		this.keyer?.dispose();
		this.keyer = null;
		this.offscreenCanvas = null;
		this.offscreenCtx = null;
		this.interrupt();
		for (const v of this.clipVideos.values()) {
			v.pause();
			if (v !== this.mountedVideo) v.remove();
		}
		this.clipVideos.clear();
		this.assetBlobCache.clear();
		this.video?.pause();
		this.video = null;
		this.mountedVideo = null;
		this.canvas = null;
		this.ctx = null;
	}
}
