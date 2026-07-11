// nva-layered-player — P4 상태머신 + 합성. P1 base + P2 head + P3 sync 를 하나의 플레이어로 조립한다.
//   Layer 0 = 더블버퍼 base(idle/speak/gesture, 알파 클립 → canvas contain-fit, 전환 깜빡임 0).
//   Layer 1 = 발화 중 head 오버레이(WebGL chromakey)를 speak.face_bbox 에 합성 + sync 드라이버가 오디오 추종.
//   상태 = idle | speaking | gesturing. barge-in(발화 중단)·gesture preempt(끼어들기 후 복귀)·전환 race 처리.
//   nva-core derive 로 idle/talk/gesture 키를 뽑는다(정본 규칙 = mirror 가드). 클립 URL 은 resolveClip 주입.

import { type NvaManifest, derive } from "./nva-core";
import { NvaHeadOverlay } from "./nva-head-overlay";
import { NvaSyncDriver } from "./nva-sync-driver";

export type PlayerState = "idle" | "speaking" | "gesturing";

export interface HeadSource {
	/** Ditto head 프레임(h264, green bg) 비디오. */
	video: HTMLVideoElement;
	/** 오디오 master clock(초) 또는 null. */
	audioClock: () => number | null;
	/** 오디오 출력지연 보정(ms). */
	leadMs?: number;
}

export interface LayeredPlayerOpts {
	/** 애니 clip 파일명 → 재생 URL. (테스트=blob, 프로덕션=번들 dir URL.) */
	resolveClip: (clipName: string) => string;
	/** head chroma 키색(#rrggbb). 기본 manifest.animations[speak].head_chroma 또는 #00ff00. */
	chromaKey?: string;
	/** head 정합 튜닝. */
	headScale?: number;
	headOffsetX?: number;
	headOffsetY?: number;
	headSmoothing?: number;
}

/** contain-fit draw rect. */
function containRect(cw: number, ch: number, vw: number, vh: number) {
	if (vw <= 0 || vh <= 0 || cw <= 0 || ch <= 0)
		return { dx: 0, dy: 0, dw: 0, dh: 0 };
	const scale = Math.min(cw / vw, ch / vh);
	const dw = vw * scale;
	const dh = vh * scale;
	return { dx: (cw - dw) / 2, dy: (ch - dh) / 2, dw, dh };
}

export class NvaLayeredPlayer {
	private readonly canvas: HTMLCanvasElement;
	private readonly ctx: CanvasRenderingContext2D;
	private readonly manifest: NvaManifest;
	private readonly opts: LayeredPlayerOpts;
	private readonly idleKey: string | null;
	private readonly talkKey: string | null;

	// 더블버퍼 base 비디오(front=현재 그리는 것, back=프리로드).
	private front: HTMLVideoElement;
	private back: HTMLVideoElement;

	private overlay: NvaHeadOverlay | null = null;
	private driver: NvaSyncDriver | null = null;
	private head: HeadSource | null = null;

	private _state: PlayerState = "idle";
	private raf = 0;
	private running = false;
	private epoch = 0; // 전환 race 가드(비동기 로드가 뒤늦게 반영되는 것 차단)
	private framesDrawn = 0;
	private returnKey: string | null = null; // gesture 종료 후 복귀할 base 키
	private abortLoad: (() => void) | null = null; // 진행 중 back 로드 취소(동시 전환 충돌 방지)
	private gestureCleanup: (() => void) | null = null; // gesture ended 리스너 해제(front 캡처)

	constructor(
		canvas: HTMLCanvasElement,
		manifest: NvaManifest,
		opts: LayeredPlayerOpts,
	) {
		this.canvas = canvas;
		const ctx = canvas.getContext("2d", { alpha: true });
		if (!ctx) throw new Error("canvas 2d(alpha) 컨텍스트 불가");
		this.ctx = ctx;
		this.manifest = manifest;
		this.opts = opts;
		const d = derive(manifest);
		this.idleKey = d.idleKey;
		this.talkKey = d.talkKey;
		this.front = this.makeVideo();
		this.back = this.makeVideo();
	}

	private makeVideo(): HTMLVideoElement {
		const v = document.createElement("video");
		v.muted = true;
		v.playsInline = true;
		v.crossOrigin = "anonymous";
		return v;
	}

	get state(): PlayerState {
		return this._state;
	}
	stats() {
		return {
			state: this._state,
			framesDrawn: this.framesDrawn,
			sync: this.driver?.stats() ?? null,
		};
	}

	/** idle 재생 시작(첫 프레임 디코드까지 대기 후 렌더 루프 가동). */
	async start(): Promise<void> {
		if (!this.idleKey) throw new Error("manifest 에 idle 애니가 없음");
		await this.swapTo(this.idleKey, { loop: true });
		this._state = "idle";
		this.startLoop();
	}

	/**
	 * 발화 전환: base 를 speak 클립으로 더블버퍼 교체 + head 오버레이/sync 부착. barge-in 은 endSpeak.
	 */
	async speak(head: HeadSource): Promise<void> {
		if (!this.talkKey)
			throw new Error("manifest 에 talk(can_talk) 애니가 없음");
		const myEpoch = ++this.epoch; // 이전 전환 무효화
		this.clearGestureListener();
		this.teardownHead();
		this.head = head;
		await this.swapTo(this.talkKey, { loop: true }, myEpoch);
		if (myEpoch !== this.epoch) return; // 그 사이 다른 전환이 시작됨
		this._state = "speaking";
		this.setupHead(head);
	}

	/** 발화 종료 / barge-in → idle 복귀. */
	endSpeak(): void {
		this.epoch++;
		this.clearGestureListener();
		this.teardownHead();
		if (this.idleKey)
			void this.swapTo(this.idleKey, { loop: true }, this.epoch);
		this._state = "idle";
	}

	/**
	 * gesture 끼어들기: gesture 클립 1회 재생(preempt), 종료 시 이전 base(idle/talk)로 복귀.
	 * 발화 중이면 head 는 유지(gesture 는 몸짓, 얼굴은 계속 말함) — 단 base 클립은 gesture 로 교체.
	 */
	async gesture(key: string): Promise<void> {
		const anim = this.manifest.animations?.[key];
		if (!anim) throw new Error(`gesture 애니 없음: ${key}`);
		const myEpoch = ++this.epoch;
		this.clearGestureListener(); // 이전 gesture 리스너 해제
		this.returnKey = this._state === "speaking" ? this.talkKey : this.idleKey;
		await this.swapTo(key, { loop: false }, myEpoch);
		if (myEpoch !== this.epoch) return;
		this._state = "gesturing";
		// gesture 종료 → 복귀. ended 리스너는 **현재 front 를 캡처**(이후 front 가 바뀌어도 올바른 요소서 해제).
		const gestureVideo = this.front;
		const onEnded = () => {
			gestureVideo.removeEventListener("ended", onEnded);
			this.gestureCleanup = null;
			if (myEpoch !== this.epoch) return; // 그새 다른 전환 — 복귀 안 함
			const back = this.returnKey ?? this.idleKey;
			if (back) void this.swapTo(back, { loop: true }, ++this.epoch);
			this._state = this.head ? "speaking" : "idle";
		};
		gestureVideo.addEventListener("ended", onEnded);
		this.gestureCleanup = () =>
			gestureVideo.removeEventListener("ended", onEnded);
	}

	/** 대기 중 gesture ended 리스너 해제(캡처한 요소서). 전환/정지 시 호출. */
	private clearGestureListener(): void {
		this.gestureCleanup?.();
		this.gestureCleanup = null;
	}

	/** 전체 정지 + 리소스 해제. */
	stop(): void {
		this.running = false;
		if (this.raf) cancelAnimationFrame(this.raf);
		this.raf = 0;
		this.epoch++;
		this.abortLoad?.(); // 진행 중 back 로드 취소
		this.clearGestureListener();
		this.teardownHead();
		this.front.pause();
		this.back.pause();
	}

	dispose(): void {
		this.stop();
		this.overlay?.dispose();
		this.overlay = null;
	}

	// ── 내부 ────────────────────────────────────────────────────────────────

	/**
	 * 더블버퍼 교체: back 에 새 클립 로드 → 첫 프레임 준비되면 front/back swap(교체 순간까지 old front 유지=공백0).
	 * 공유 back 을 두 전환이 동시에 건드리는 것을 막기 위해, 새 swapTo 는 진행 중이던 로드를 먼저 **취소**
	 * (abortLoad — 리스너 해제 + 대기 promise 를 superseded 로 resolve)한 뒤 시작한다. 그래서 항상 단일 로드만 유효.
	 */
	private async swapTo(
		key: string,
		opts: { loop: boolean },
		myEpoch = this.epoch,
	): Promise<void> {
		const anim = this.manifest.animations?.[key];
		if (!anim?.clip) throw new Error(`clip 없는 애니: ${key}`);
		const url = this.opts.resolveClip(anim.clip);
		// 이전 진행 중 로드가 있으면 취소(그 promise 는 superseded 로 unblock).
		this.abortLoad?.();
		const back = this.back;
		back.loop = opts.loop;

		const loaded = await new Promise<"ok" | "aborted" | "error">((resolve) => {
			const done = () => {
				cleanup();
				resolve("ok");
			};
			const fail = () => {
				cleanup();
				resolve("error");
			};
			const cleanup = () => {
				back.removeEventListener("loadeddata", done);
				back.removeEventListener("error", fail);
				if (this.abortLoad === abort) this.abortLoad = null;
			};
			const abort = () => {
				cleanup();
				resolve("aborted");
			};
			this.abortLoad = abort;
			back.src = url;
			back.addEventListener("loadeddata", done, { once: true });
			back.addEventListener("error", fail, { once: true });
		});

		if (loaded === "aborted" || myEpoch !== this.epoch) {
			// superseded — back 로드 중단(고아 디코딩 방지), old front 유지. swap 안 함.
			try {
				back.pause();
			} catch {
				/* noop */
			}
			return;
		}
		if (loaded === "error") throw new Error(`base 클립 로드 실패: ${key}`);

		await back.play().catch(() => undefined);
		if (myEpoch !== this.epoch) {
			try {
				back.pause();
			} catch {
				/* noop */
			}
			return;
		}
		// swap: back 이 새 front. old front 는 back 이 되어 다음 프리로드에 재사용(정지).
		const oldFront = this.front;
		this.front = back;
		this.back = oldFront;
		oldFront.pause();
	}

	private setupHead(head: HeadSource): void {
		const speakAnim = this.talkKey
			? this.manifest.animations?.[this.talkKey]
			: undefined;
		const chroma = this.opts.chromaKey ?? speakAnim?.head_chroma ?? "#00ff00";
		this.overlay = new NvaHeadOverlay({ keyColor: chroma });
		this.driver = new NvaSyncDriver(head.video, head.audioClock, {
			leadMs: head.leadMs ?? 0,
		});
		this.driver.start();
	}

	private teardownHead(): void {
		this.driver?.stop();
		this.driver = null;
		this.overlay?.dispose();
		this.overlay = null;
		this.head = null;
	}

	private startLoop(): void {
		if (this.running) return;
		this.running = true;
		const draw = () => {
			if (!this.running) return;
			const v = this.front;
			if (v.readyState >= 2) {
				const rect = containRect(
					this.canvas.width,
					this.canvas.height,
					v.videoWidth,
					v.videoHeight,
				);
				if (rect.dw > 0 && rect.dh > 0) {
					this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
					this.ctx.drawImage(v, rect.dx, rect.dy, rect.dw, rect.dh);
					this.framesDrawn += 1;
					// 발화 중 head 오버레이 합성(speak.face_bbox 기준).
					const speakAnim = this.talkKey
						? this.manifest.animations?.[this.talkKey]
						: undefined;
					const bbox = speakAnim?.face_bbox;
					if (
						this.overlay &&
						this.head &&
						this._state === "speaking" &&
						bbox &&
						this.head.video.readyState >= 2
					) {
						try {
							this.overlay.draw(this.ctx, this.head.video, bbox, rect, {
								scale: this.opts.headScale,
								offsetX: this.opts.headOffsetX,
								offsetY: this.opts.headOffsetY,
								smoothing: this.opts.headSmoothing,
							});
						} catch {
							/* 오버레이 예외 격리(렌더 루프 유지) */
						}
					}
				}
			}
			this.raf = requestAnimationFrame(draw);
		};
		this.raf = requestAnimationFrame(draw);
	}
}
