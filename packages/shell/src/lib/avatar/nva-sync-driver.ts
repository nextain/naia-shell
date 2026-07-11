// nva-sync-driver — P3 A/V 실시간 동기화 드라이버. 오디오(TTS)를 **master clock**으로 삼아 head 비디오의
//   프레임 PTS 를 추종시킨다. 메커니즘 = **playbackRate 비례제어(P-controller)** — video.currentTime seek 는
//   janky 라 금지, 대신 재생 속도를 미세조정해 drift 를 0 으로 수렴. 데드밴드 안(수 ms)에서는 rate=1 로 고정
//   (제어가 떨림을 만들지 않게). 매 rVFC 프레임에서 drift 를 SyncMeter 로 기록 → stats() 로 품질 정량화.
//   (P0 nva-sync 의 측정 하니스/통계를 실사용. 여기서 '보정 액션'을 추가.)

import { SyncMeter } from "./nva-sync";

export interface SyncDriverOpts {
	/** 비례 게인. rate 편차 = -gain × (drift[s]). 클수록 빠른 수렴/과보정 위험. 기본 0.8. */
	gain?: number;
	/** playbackRate 하한/상한(과도한 피치 변화 방지). 기본 [0.85, 1.15]. */
	minRate?: number;
	maxRate?: number;
	/** 데드밴드(ms). |drift|≤이 값이면 rate=1(미세 떨림 억제). 기본 12. */
	deadbandMs?: number;
	/** 오디오 출력 지연 보정 lead(ms). 목표 = audioTime + lead. 기본 0(호출부가 outputLatency 주입). */
	leadMs?: number;
}

/**
 * 비례제어 재생속도 산출. drift = framePts − (audioTime + lead), ms.
 * drift>0 = 비디오가 앞섬 → 느리게(rate<1). drift<0 = 뒤처짐 → 빠르게(rate>1).
 * 데드밴드 안 = 1. 결과는 [minRate, maxRate] clamp. 순수 함수(테스트 용이).
 */
export function computePlaybackRate(
	driftMs: number,
	opts: SyncDriverOpts = {},
): number {
	if (!Number.isFinite(driftMs)) return 1;
	const dead = opts.deadbandMs ?? 12;
	if (Math.abs(driftMs) <= dead) return 1;
	const gain = opts.gain ?? 0.8;
	const min = opts.minRate ?? 0.85;
	const max = opts.maxRate ?? 1.15;
	const rate = 1 - gain * (driftMs / 1000);
	return Math.min(max, Math.max(min, rate));
}

type RvfcMeta = { mediaTime: number; presentedFrames?: number };
type RvfcFn = (cb: (now: number, meta: RvfcMeta) => void) => number;
type CancelRvfcFn = (handle: number) => void;

/**
 * head 비디오에 rVFC 를 걸어 매 프레임 drift 를 계산하고 playbackRate 로 보정한다.
 * audioClock() = 현재 오디오 시각(초) 또는 null(미시작 → 보정 보류, rate=1).
 * onFrame = 프레임 훅(head 오버레이 합성 지점, P4 배선). rVFC 미지원이면 no-op(호출부 capability 게이트).
 */
export class NvaSyncDriver {
	private readonly meter = new SyncMeter();
	private readonly video: HTMLVideoElement;
	private readonly audioClock: () => number | null;
	private readonly opts: SyncDriverOpts;
	private handle = 0;
	private running = false;

	constructor(
		video: HTMLVideoElement,
		audioClock: () => number | null,
		opts: SyncDriverOpts = {},
	) {
		this.video = video;
		this.audioClock = audioClock;
		this.opts = opts;
	}

	start(onFrame?: (meta: RvfcMeta) => void): void {
		const anyv = this.video as unknown as {
			requestVideoFrameCallback?: RvfcFn;
			cancelVideoFrameCallback?: CancelRvfcFn;
		};
		const rvfc = anyv.requestVideoFrameCallback;
		if (typeof rvfc !== "function" || this.running) return;
		this.running = true;
		const lead = (this.opts.leadMs ?? 0) / 1000;
		const cb = (_now: number, meta: RvfcMeta) => {
			if (!this.running) return;
			const at = this.audioClock();
			if (at != null) {
				const driftMs = (meta.mediaTime - (at + lead)) * 1000;
				this.meter.record(driftMs);
				this.video.playbackRate = computePlaybackRate(driftMs, this.opts);
			} else {
				this.video.playbackRate = 1; // 오디오 미시작 = 보정 보류
			}
			onFrame?.(meta);
			this.handle = rvfc.call(this.video, cb);
		};
		this.handle = rvfc.call(this.video, cb);
	}

	/** 정지 + 재생속도 원복(다음 재생이 1x 로 시작하도록). */
	stop(): void {
		this.running = false;
		const anyv = this.video as unknown as {
			cancelVideoFrameCallback?: CancelRvfcFn;
		};
		try {
			anyv.cancelVideoFrameCallback?.(this.handle);
		} catch {
			/* noop */
		}
		this.video.playbackRate = 1;
	}

	/** 지금까지 기록한 drift 통계(오프셋/jitter 백분위). */
	stats() {
		return this.meter.stats();
	}
}
