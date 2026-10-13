import { type NvaManifest, defaultClipOf, findPrebakedSpeech } from "../nva";
import type {
	AvatarPlaybackOptions,
	AvatarSpeechRenderer,
} from "./avatar-renderer";
import { NvaChromakeyGL } from "./nva-chromakey-gl";
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
	SpeechPlan,
} from "./nva-speech/speech-timing";

interface Config {
	manifest: NvaManifest;
	locale: string;
	resolveAssetUrl: (path: string) => Promise<string>;
	/** Bundle asset bytes for the canonical speech player (defaults to fetch of resolveAssetUrl). */
	loadAssetBlob?: (path: string) => Promise<Blob>;
	/** Test seam for the canonical speech stage. */
	createSpeechStage?: (host: HTMLVideoElement) => CanonicalSpeechStage | null;
	onSpeaking?: (speaking: boolean) => void;
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
 *      그대로 — 말하기 반복 클립·아이우에오 순환 같은 근사는 없다(SoT 8).
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
	private keyer: NvaChromakeyGL | null = null;
	private keyerFailed = false;
	private currentKeyColor: string | undefined;
	private motionSpec: MotionSpec | null;
	private offscreenCanvas: HTMLCanvasElement | null = null;
	private offscreenCtx: CanvasRenderingContext2D | null = null;
	private disposed = false;
	private generation = 0;
	private tail = Promise.resolve();
	private raf = 0;
	private running = false;
	private speechStage: CanonicalSpeechStage | null = null;
	private speechKeyColor: string | undefined;

	constructor(private readonly config: Config) {
		this.motionSpec = parseMotionSpec(config.manifest);
		if (this.motionSpec) {
			this.motionSpec.chest_y = resolveChestY(config.manifest, this.motionSpec);
		}
	}

	start(video: HTMLVideoElement, canvas: HTMLCanvasElement): void {
		this.video = video;
		this.mountedVideo = video;
		this.canvas = canvas;
		this.ctx = canvas.getContext("2d", { alpha: true });
		this.speechStage = this.createSpeechStage(video);
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
		this.config.onSpeaking?.(true);
		try {
			await this.playClip(
				match.localized.clip,
				false,
				options?.muted ?? false,
				options,
			);
		} catch {
			options?.onPlaybackFailure?.();
		} finally {
			if (generation === this.generation && !this.disposed) {
				this.config.onSpeaking?.(false);
				await this.playIdle();
			}
		}
	}

	/**
	 * Speaking state only. The mouth moves solely through playSpeechTiming
	 * (canonical player); without a plan the idle clip keeps playing.
	 */
	setSpeakingVisual(active: boolean): void {
		if (!this.video || this.disposed) return;
		this.generation++;
		this.config.onSpeaking?.(active);
		if (!active) {
			this.speechStage?.stop();
			void this.playIdle();
		}
	}

	/** Play one aligned or browser-timed plan through the canonical player. */
	async playSpeechTiming(timing: AvatarSpeechTiming): Promise<boolean> {
		const stage = this.speechStage;
		if (!stage || this.disposed) return false;
		this.speechKeyColor = this.keyColorFor(
			this.config.manifest.animations.talking?.clip ?? "",
		);
		return stage.start(timing);
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
				loadAsset:
					this.config.loadAssetBlob ??
					(async (path) => {
						const response = await fetch(
							await this.config.resolveAssetUrl(path),
						);
						if (!response.ok) throw new Error(`NVA asset ${path} unavailable`);
						return response.blob();
					}),
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
	): Promise<void> {
		if (!this.video || !this.mountedVideo)
			throw new Error("NVA video is not mounted");
		this.currentKeyColor = this.keyColorFor(path);
		const url = await this.config.resolveAssetUrl(path);
		if (this.disposed || !this.mountedVideo)
			throw new Error("NVA renderer stopped");
		const video = this.videoForClip(url);
		if (this.video !== video) {
			this.video.pause();
			this.video = video;
		}
		video.loop = loop;
		video.muted = muted;
		video.currentTime = 0;
		if (loop) {
			await video.play();
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const ready = () => options?.onPlaybackReady?.();
			const ended = () => resolve();
			const failed = () => reject(new Error("NVA clip playback failed"));
			video.addEventListener("playing", ready, { once: true });
			video.addEventListener("ended", ended, { once: true });
			video.addEventListener("error", failed, { once: true });
			video.play().catch(failed);
		});
	}

	/**
	 * 클립마다 <video> 를 하나씩 두고 재사용한다. WebKitGTK 에서 `src=` 재대입은 이전
	 * GStreamer 파이프라인을 메인 스레드에서 동기 해체하는데, 그 파이프라인의 demuxer
	 * 스레드가 bus 동기 핸들러에서 메인 스레드를 기다리는 순간과 겹치면 서로 기다리며
	 * 웹뷰 전체가 멈춘다(gdb: HTMLMediaElement::prepareForLoad → MediaPlayerPrivateGStreamer
	 * ::tearDown ↔ matroskademux → callOnMainThreadAndWait; 슬라이드 낭독 idle/talking
	 * 전환에서 3/3 재현, 2026-09-11). 첫 클립은 마운트된 요소를 쓰고, 다른 클립은 같은
	 * 부모 아래 같은 스타일의 숨은 형제 요소를 만든다. 그래서 idle↔talking 왕복에 해체가 없다.
	 */
	private videoForClip(url: string): HTMLVideoElement {
		const mounted = this.mountedVideo;
		if (!mounted) throw new Error("NVA video is not mounted");
		const pooled = this.clipVideos.get(url);
		if (pooled) return pooled;
		let video: HTMLVideoElement;
		if (this.clipVideos.size === 0) {
			video = mounted;
		} else {
			video = document.createElement("video");
			video.playsInline = true;
			video.crossOrigin = mounted.crossOrigin;
			video.style.cssText = mounted.style.cssText;
			mounted.parentNode?.insertBefore(video, mounted.nextSibling);
		}
		video.src = url;
		video.dataset.naiaClipUrl = url;
		this.clipVideos.set(url, video);
		return video;
	}

	private async playIdle(): Promise<void> {
		if (!this.video || this.disposed) return;
		await this.playClip(
			defaultClipOf(this.config.manifest).video,
			true,
			true,
		).catch(() => {});
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
			const sourceWidth = stage ? stage.canvas.width : (video?.videoWidth ?? 0);
			const sourceHeight = stage
				? stage.canvas.height
				: (video?.videoHeight ?? 0);
			const canvas = this.canvas;
			const ctx = this.ctx;
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
				ctx.clearRect(0, 0, canvas.width, canvas.height);
				if (rect.dw > 0 && rect.dh > 0) {
					const keyColor = stage ? this.speechKeyColor : this.currentKeyColor;
					const motionSpec = this.motionSpec;
					const offscreen = motionSpec
						? this.ensureOffscreen(canvas.width, canvas.height)
						: null;
					const drawTarget = offscreen ? offscreen.ctx : ctx;

					if (offscreen) {
						offscreen.ctx.clearRect(0, 0, canvas.width, canvas.height);
					}

					let drew = false;
					if (keyColor && !this.keyerFailed) {
						try {
							if (!this.keyer) this.keyer = new NvaChromakeyGL({ keyColor });
							else this.keyer.setParams({ keyColor });
							const keyed = this.keyer.process(
								source,
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
						drawTarget.drawImage(source, rect.dx, rect.dy, rect.dw, rect.dh);

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
		this.speechStage?.stop();
		this.config.onSpeaking?.(false);
		void this.playIdle();
	}

	stop(): void {
		this.disposed = true;
		this.running = false;
		if (this.raf) cancelAnimationFrame(this.raf);
		this.raf = 0;
		this.keyer?.dispose();
		this.keyer = null;
		this.offscreenCanvas = null;
		this.offscreenCtx = null;
		this.interrupt();
		this.speechStage?.dispose();
		this.speechStage = null;
		for (const v of this.clipVideos.values()) {
			v.pause();
			if (v !== this.mountedVideo) v.remove();
		}
		this.clipVideos.clear();
		this.video?.pause();
		this.video = null;
		this.mountedVideo = null;
		this.canvas = null;
		this.ctx = null;
	}
}
