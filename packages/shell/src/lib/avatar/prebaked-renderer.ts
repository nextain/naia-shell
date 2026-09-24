import { type NvaManifest, defaultClipOf, findPrebakedSpeech } from "../nva";
import { readActiveVoiceLevel } from "../voice/voice-level";
import type {
	AvatarPlaybackOptions,
	AvatarSpeechRenderer,
} from "./avatar-renderer";
import { NvaAudioGate } from "./nva-audio-gate";
import { NvaChromakeyGL } from "./nva-chromakey-gl";
import { TwinLoop } from "./twin-loop";

interface Config {
	manifest: NvaManifest;
	locale: string;
	resolveAssetUrl: (path: string) => Promise<string>;
	onSpeaking?: (speaking: boolean) => void;
	/**
	 * RMS of the TTS audio playing now, or null when it cannot be measured.
	 * Defaults to the shell AudioQueue that is playing.
	 */
	voiceLevel?: () => number | null;
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

/** Resolves when the element reaches its end (or fails). */
function endOf(video: HTMLVideoElement): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			video.removeEventListener("ended", done);
			video.removeEventListener("error", done);
			resolve();
		};
		video.addEventListener("ended", done);
		video.addEventListener("error", done);
	});
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
	/** Clip element → its looping pair. Loops never use the `loop` attribute (see TwinLoop). */
	private loops = new Map<HTMLVideoElement, TwinLoop>();
	/** The loop being shown, or null while a one-shot clip plays. */
	private activeLoop: TwinLoop | null = null;
	private canvas: HTMLCanvasElement | null = null;
	private ctx: CanvasRenderingContext2D | null = null;
	private keyer: NvaChromakeyGL | null = null;
	private keyerFailed = false;
	private currentKeyColor: string | undefined;
	private disposed = false;
	private generation = 0;
	private tail = Promise.resolve();
	private raf = 0;
	private running = false;
	/** Idle clip element, kept playing under the talking loop for voice gating. */
	private idleVideo: HTMLVideoElement | null = null;
	private speakingVisual = false;
	private readonly gate = new NvaAudioGate();
	private lastDrawAt: number | null = null;
	/** Chroma key per clip element (a clip without alpha needs its own key). */
	private keyColors = new WeakMap<HTMLVideoElement, string | undefined>();

	constructor(private readonly config: Config) {}

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
	 * Switch idle/talking visual only. Shell owns the actual audio playback.
	 * While speaking, the talking loop is shown only while the audio level is
	 * above the gate threshold (see drawSource), like the Studio clip engine;
	 * the idle loop keeps playing under it (playClip).
	 */
	setSpeakingVisual(active: boolean): void {
		if (!this.video || this.disposed) return;
		this.generation++;
		this.config.onSpeaking?.(active);
		this.speakingVisual = active;
		this.gate.reset("idle");
		if (active) {
			const clip =
				this.config.manifest.vrm_slots?.visemes?.aiueo?.clip ??
				this.config.manifest.vrm_slots?.motions?.talking?.clip ??
				this.config.manifest.animations.talking?.clip ??
				this.config.manifest.animations.speak?.clip ??
				defaultClipOf(this.config.manifest).video;
			void this.playClip(clip, true, true).catch(() => {});
		} else {
			void this.playIdle();
		}
	}

	private async playClip(
		path: string,
		loop: boolean,
		muted: boolean,
		options?: AvatarPlaybackOptions,
	): Promise<void> {
		if (!this.video || !this.mountedVideo)
			throw new Error("NVA video is not mounted");
		const keyColor =
			this.config.manifest.chroma_key ??
			(canCarryAlpha(path)
				? undefined
				: this.config.manifest.background?.color);
		this.currentKeyColor = keyColor;
		const url = await this.config.resolveAssetUrl(path);
		if (this.disposed || !this.mountedVideo)
			throw new Error("NVA renderer stopped");
		const video = this.videoForClip(url);
		this.keyColors.set(video, keyColor);
		// Under the talking loop the idle loop keeps running, so the voice gate
		// can cut back to a closed mouth in every pause (drawSource). It is
		// only played, never paused or sought (WebKitGTK freeze, TwinLoop).
		const idleLoop =
			loop && this.speakingVisual && this.idleVideo && this.idleVideo !== video
				? this.loops.get(this.idleVideo)
				: undefined;
		if (idleLoop) void idleLoop.play().catch(() => {});
		if (this.video !== video) {
			if (!idleLoop || this.video !== this.idleVideo)
				this.leaveClip(this.video);
			this.video = video;
		}
		if (loop) {
			// Resume where the loop stopped. Rewinding here would seek an
			// element that may still be streaming (WebKitGTK freeze, TwinLoop).
			const pair = this.loopFor(video, url);
			this.activeLoop = pair;
			pair.setMuted(muted);
			await pair.play();
			return;
		}
		this.activeLoop = null;
		this.loops.get(video)?.stop();
		video.loop = false;
		// A one-shot clip left before its end is still running, hidden and
		// muted. Let it finish: rewinding a playing element can freeze WebKitGTK.
		if (!video.paused) await endOf(video);
		video.muted = muted;
		if (video.currentTime !== 0) video.currentTime = 0;
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
		const video =
			this.clipVideos.size === 0 ? mounted : this.siblingVideo(mounted);
		video.src = url;
		video.dataset.naiaClipUrl = url;
		this.clipVideos.set(url, video);
		return video;
	}

	/** A hidden decode element next to the mounted one, styled like it. */
	private siblingVideo(mounted: HTMLVideoElement): HTMLVideoElement {
		const video = document.createElement("video");
		video.playsInline = true;
		video.crossOrigin = mounted.crossOrigin;
		video.style.cssText = mounted.style.cssText;
		mounted.parentNode?.insertBefore(video, mounted.nextSibling);
		return video;
	}

	/**
	 * The looping pair for a clip element. The twin loads the same URL once,
	 * when the clip first loops, and then only takes turns with the element.
	 */
	private loopFor(video: HTMLVideoElement, url: string): TwinLoop {
		const existing = this.loops.get(video);
		if (existing) return existing;
		const mounted = this.mountedVideo;
		if (!mounted) throw new Error("NVA video is not mounted");
		const twinOf = () => {
			const twin = this.siblingVideo(mounted);
			twin.preload = "auto";
			twin.src = url;
			twin.dataset.naiaClipUrl = url;
			twin.dataset.naiaLoopTwin = "true";
			return twin;
		};
		const pair = new TwinLoop(video, twinOf(), {
			replace: twinOf,
			remove: (element) => {
				if (element !== mounted) element.remove();
			},
		});
		this.loops.set(video, pair);
		return pair;
	}

	/**
	 * Leave a clip without touching its pipeline: a loop stops at the end of
	 * its pass, a one-shot clip is muted and runs out hidden. Pausing a playing
	 * element can freeze WebKitGTK (see TwinLoop).
	 */
	private leaveClip(video: HTMLVideoElement): void {
		const pair = this.loops.get(video);
		if (pair) pair.stop();
		else video.muted = true;
	}

	private async playIdle(): Promise<void> {
		if (!this.video || this.disposed) return;
		await this.playClip(defaultClipOf(this.config.manifest).video, true, true)
			.then(() => {
				this.idleVideo = this.video;
			})
			.catch(() => {});
	}

	/**
	 * Element to draw this frame. While the talking loop is on and the audio
	 * level is known, the gate picks talking (voice) or idle (pause).
	 * Unknown level (MP3, browser speech) keeps the talking loop, as before.
	 */
	drawSource(nowMs: number): HTMLVideoElement | null {
		const video = this.video ? (this.activeLoop?.current ?? this.video) : null;
		const last = this.lastDrawAt;
		this.lastDrawAt = nowMs;
		if (!this.speakingVisual || !video) return video;
		const level = (this.config.voiceLevel ?? readActiveVoiceLevel)();
		if (level == null) return video;
		const state = this.gate.process(level, last == null ? 0 : nowMs - last);
		const idle = this.idleVideo
			? (this.loops.get(this.idleVideo)?.current ?? this.idleVideo)
			: null;
		if (
			state === "idle" &&
			idle &&
			idle !== video &&
			idle.readyState >= 2 &&
			idle.videoWidth > 0
		)
			return idle;
		return video;
	}

	/** 숨은 decode `<video>`를 매 프레임 표시 `<canvas>`에 합성(필요 시 크로마키). */
	private startDrawLoop(): void {
		if (this.running) return;
		this.running = true;
		const draw = (now?: number) => {
			if (!this.running) return;
			const video = this.drawSource(now ?? performance.now());
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
				const rect = containRect(
					canvas.width,
					canvas.height,
					video.videoWidth,
					video.videoHeight,
				);
				ctx.clearRect(0, 0, canvas.width, canvas.height);
				if (rect.dw > 0 && rect.dh > 0) {
					const keyColor = this.keyColors.has(video)
						? this.keyColors.get(video)
						: this.currentKeyColor;
					let drew = false;
					if (keyColor && !this.keyerFailed) {
						try {
							if (!this.keyer) this.keyer = new NvaChromakeyGL({ keyColor });
							else this.keyer.setParams({ keyColor });
							const keyed = this.keyer.process(
								video,
								video.videoWidth,
								video.videoHeight,
							);
							ctx.drawImage(keyed, rect.dx, rect.dy, rect.dw, rect.dh);
							drew = true;
						} catch {
							// WebGL2 unavailable or context lost — fall back to a plain
							// (possibly opaque-backdrop) draw rather than a blank canvas.
							this.keyerFailed = true;
						}
					}
					if (!drew) ctx.drawImage(video, rect.dx, rect.dy, rect.dw, rect.dh);
				}
			}
			this.raf = requestAnimationFrame(draw);
		};
		this.raf = requestAnimationFrame(draw);
	}

	interrupt(): void {
		this.generation++;
		this.speakingVisual = false;
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
		this.interrupt();
		for (const pair of this.loops.values()) {
			pair.dispose();
			for (const v of pair.all) if (v !== this.mountedVideo) v.remove();
		}
		this.loops.clear();
		this.activeLoop = null;
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
