// nva-base-renderer — 레이어드 플레이어 **Layer 0(base)**. 현재 애니 클립(알파 VP9 webm)을 canvas 에
//   contain-fit drawImage 로 렌더(알파 보존 → 앱 배경 위 투명 합성). idle/talk=loop, gesture=once.
//   head 오버레이(P2)·A/V 싱크(P3)는 이 base 위에 얹는다 — video 요소·draw rect·프레임 훅을 노출한다.
//   (정본 editor.html compose() 의 base drawImage 에 대응. 단 stretch 대신 contain-fit + drawRect 노출로
//    face_bbox 매핑의 letterbox/pillarbox 오프셋을 정확히 잡는다 = 설계 face_bbox 정합 요건.)

/** base 클립이 실제로 그려진 canvas 내 사각형(px). face_bbox → 픽셀 매핑 기준. */
export interface DrawRect {
	dx: number;
	dy: number;
	dw: number;
	dh: number;
}

export interface BaseRendererState {
	/** 현재 재생 중 clip src(없으면 null). */
	src: string | null;
	/** 렌더 루프 가동 여부. */
	running: boolean;
	/** 지금까지 canvas 에 그린 프레임 수(테스트/진단). */
	framesDrawn: number;
}

/**
 * Layer 0 base 렌더러. 순수 클라이언트(DOM). 하나의 <video> + 2D canvas.
 * play() 로 클립 전환(P1 은 즉시 교체 — 무결점 더블버퍼 전환은 P4 상태머신 몫).
 */
export class NvaBaseRenderer {
	private readonly ctx: CanvasRenderingContext2D;
	private readonly video: HTMLVideoElement;
	private raf = 0;
	private running = false;
	private framesDrawn = 0;
	private playToken = 0; // play() 재진입 가드(경쟁하는 로드 중 stale resolve 무시)
	private _drawRect: DrawRect = { dx: 0, dy: 0, dw: 0, dh: 0 };
	private onFrameHook?: (rect: DrawRect, video: HTMLVideoElement) => void;
	private onEndedHook?: () => void;

	constructor(private readonly canvas: HTMLCanvasElement) {
		const ctx = canvas.getContext("2d", { alpha: true });
		if (!ctx) throw new Error("canvas 2d(alpha) 컨텍스트 불가");
		this.ctx = ctx;
		const v = document.createElement("video");
		v.muted = true;
		v.playsInline = true;
		v.crossOrigin = "anonymous";
		this.video = v;
	}

	// once(loop:false) 클립 종료 통지. 마지막 프레임은 render 루프가 계속 hold(정지 프레임 유지) → P4
	// 상태머신이 onEnded 를 받아 idle 로 전환할 때까지 화면 공백 0. (loop=true 면 ended 자체가 안 남.)
	private readonly onVideoEnded = () => {
		this.onEndedHook?.();
	};

	/**
	 * base 클립 재생 시작(첫 프레임 디코드까지 대기 후 resolve). loop=idle/talk, once=gesture.
	 * 이미 루프가 돌고 있으면 src 만 교체(렌더 루프는 유지). 경쟁 호출은 playToken 으로 stale 무시.
	 */
	async play(src: string, opts: { loop?: boolean } = {}): Promise<void> {
		const token = ++this.playToken;
		this.video.loop = opts.loop ?? true;
		this.video.removeEventListener("ended", this.onVideoEnded); // 이전 클립 종료 리스너 해제
		this.video.src = src;
		await new Promise<void>((resolve, reject) => {
			const done = () => {
				cleanup();
				resolve();
			};
			const fail = () => {
				cleanup();
				// 더 최신 play()/stop() 이 토큰을 올렸으면 이 로드는 superseded — 에러 아님(resolve).
				if (token !== this.playToken) resolve();
				else reject(new Error(`base 클립 로드 실패: ${src}`));
			};
			const cleanup = () => {
				this.video.removeEventListener("loadeddata", done);
				this.video.removeEventListener("error", fail);
			};
			this.video.addEventListener("loadeddata", done, { once: true });
			this.video.addEventListener("error", fail, { once: true });
		});
		if (token !== this.playToken) return; // loadeddata 대기 후 재확인(stale play/stop 무시)
		if (!this.video.loop)
			this.video.addEventListener("ended", this.onVideoEnded);
		await this.video.play().catch(() => undefined);
		// ★ play() 도 async 중단점 — 그 사이 stop()/신규 play() 있었으면 start() 금지(race 완전 차단).
		if (token !== this.playToken) return;
		this.start();
	}

	/** 매 프레임 base draw 직후 호출되는 훅(P2 head 오버레이 합성 지점). */
	setOnFrame(cb: (rect: DrawRect, video: HTMLVideoElement) => void): void {
		this.onFrameHook = cb;
	}

	/** once(loop:false) 클립이 끝까지 재생됐을 때 1회 호출(P4 상태머신 idle 복귀 훅). */
	setOnEnded(cb: () => void): void {
		this.onEndedHook = cb;
	}

	get drawRect(): DrawRect {
		return this._drawRect;
	}
	get videoEl(): HTMLVideoElement {
		return this.video;
	}
	get currentTime(): number {
		return this.video.currentTime;
	}
	state(): BaseRendererState {
		return {
			src: this.video.src || null,
			running: this.running,
			framesDrawn: this.framesDrawn,
		};
	}

	/** contain-fit: 종횡비 유지하며 canvas 안에 맞춤(letterbox/pillarbox). 0 크기/미로드 = 빈 rect. */
	private computeRect(): DrawRect {
		const cw = this.canvas.width;
		const ch = this.canvas.height;
		const vw = this.video.videoWidth;
		const vh = this.video.videoHeight;
		if (vw <= 0 || vh <= 0 || cw <= 0 || ch <= 0)
			return { dx: 0, dy: 0, dw: 0, dh: 0 };
		const scale = Math.min(cw / vw, ch / vh);
		const dw = vw * scale;
		const dh = vh * scale;
		return { dx: (cw - dw) / 2, dy: (ch - dh) / 2, dw, dh };
	}

	private start(): void {
		if (this.running) return;
		this.running = true;
		const draw = () => {
			if (!this.running) return;
			if (this.video.readyState >= 2) {
				const r = this.computeRect();
				if (r.dw > 0 && r.dh > 0) {
					this._drawRect = r;
					this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); // 투명 유지
					this.ctx.drawImage(this.video, r.dx, r.dy, r.dw, r.dh); // 알파 보존
					this.framesDrawn += 1;
					try {
						this.onFrameHook?.(r, this.video);
					} catch {
						/* 훅 예외가 렌더 루프를 죽이지 않게 격리 */
					}
				}
			}
			this.raf = requestAnimationFrame(draw);
		};
		this.raf = requestAnimationFrame(draw);
	}

	/** 렌더 정지 + 비디오 일시정지 + 종료 리스너 해제(리소스 정리). 진행 중 play() 도 무효화. */
	stop(): void {
		this.playToken += 1; // 로드 대기 중인 play() 가 뒤늦게 start() 하지 않게 무효화
		this.running = false;
		if (this.raf) cancelAnimationFrame(this.raf);
		this.raf = 0;
		this.video.removeEventListener("ended", this.onVideoEnded);
		this.video.pause();
	}
}
