// nva-sync — A/V 실시간 동기 코어 + 측정 하니스 (codex R1/R2: 가장 위험한 가정 = 브라우저 실시간
//   clock 싱크가 수용가능한가 → P0 에서 먼저 측정). master clock = AudioContext.currentTime(오디오),
//   head 비디오 프레임 PTS = requestVideoFrameCallback.mediaTime. drift = framePts - audioTime.
//   드리프트 통계(p50/p95/p99/max)로 싱크 품질을 정량화한다.

export interface DriftStats {
	/** 샘플 수. */
	n: number;
	/** |drift| ms 백분위(raw, 오프셋 포함). */
	p50: number;
	p95: number;
	p99: number;
	max: number;
	/** 평균 |drift| ms. */
	meanAbs: number;
	/** 부호 있는 평균 drift = **일정 오프셋(calibration 상수)**. 양수=비디오가 오디오보다 앞섬.
	 *  이 오프셋은 lead 상수로 보정 가능 → 실제 싱크 품질은 아래 jitter(오프셋 제거 후 변동). */
	meanSigned: number;
	/** ★|drift - meanSigned| 백분위 = **오프셋 보정 후 jitter**(실제 싱크 품질 지표). */
	jitterP95: number;
	jitterP99: number;
}

/** drift 샘플(부호 있음)을 모아 백분위 + **오프셋 보정 jitter** 통계 산출. 순수(부작용 없음). */
export class SyncMeter {
	private samples: number[] = []; // 부호 있는 drift ms

	record(driftMs: number): void {
		this.samples.push(driftMs);
	}

	get count(): number {
		return this.samples.length;
	}

	stats(): DriftStats {
		const n = this.samples.length;
		if (n === 0)
			return {
				n: 0,
				p50: 0,
				p95: 0,
				p99: 0,
				max: 0,
				meanAbs: 0,
				meanSigned: 0,
				jitterP95: 0,
				jitterP99: 0,
			};
		const mean = this.samples.reduce((s, v) => s + v, 0) / n;
		const abs = this.samples.map((v) => Math.abs(v)).sort((a, b) => a - b);
		const jit = this.samples
			.map((v) => Math.abs(v - mean))
			.sort((a, b) => a - b);
		const pct = (arr: number[], p: number) =>
			arr[Math.min(n - 1, Math.floor((p / 100) * n))];
		return {
			n,
			p50: pct(abs, 50),
			p95: pct(abs, 95),
			p99: pct(abs, 99),
			max: abs[n - 1],
			meanAbs: abs.reduce((s, v) => s + v, 0) / n,
			meanSigned: mean,
			jitterP95: pct(jit, 95),
			jitterP99: pct(jit, 99),
		};
	}
}

type RvfcMeta = { mediaTime: number; presentedFrames?: number };
type RvfcFn = (cb: (now: number, meta: RvfcMeta) => void) => number;
type CancelRvfcFn = (handle: number) => void;

/**
 * head 비디오에 requestVideoFrameCallback 을 걸어 매 프레임 drift(framePts - audioTime)를 meter 에
 * 기록한다. audioClock() = 현재 오디오 시각(초) 또는 null(미시작). onFrame = 렌더 훅(캔버스 draw 등).
 * 반환 = 정지 함수. rVFC 미지원이면 no-op 반환(호출부가 capability 로 사전 게이트).
 * (DOM lib 의 requestVideoFrameCallback 타입 재정의 충돌 회피 위해 캐스트로 접근.)
 */
export function measureSync(
	video: HTMLVideoElement,
	audioClock: () => number | null,
	meter: SyncMeter,
	onFrame?: (meta: RvfcMeta) => void,
): () => void {
	const anyv = video as unknown as {
		requestVideoFrameCallback?: RvfcFn;
		cancelVideoFrameCallback?: CancelRvfcFn;
	};
	const rvfc = anyv.requestVideoFrameCallback;
	if (typeof rvfc !== "function") return () => undefined;
	let handle = 0;
	let stopped = false;
	const cb = (_now: number, meta: RvfcMeta) => {
		if (stopped) return;
		const at = audioClock();
		if (at != null) meter.record((meta.mediaTime - at) * 1000);
		onFrame?.(meta);
		handle = rvfc.call(video, cb);
	};
	handle = rvfc.call(video, cb);
	return () => {
		stopped = true;
		try {
			anyv.cancelVideoFrameCallback?.call(video, handle);
		} catch {
			/* noop */
		}
	};
}

/**
 * 소프트싱크 결정(P3 에서 사용) — 현재 프레임 PTS 와 오디오 시각의 drift 로 draw/skip/wait 판정.
 * drift > +skipAheadMs (비디오가 너무 앞섬) = wait(이번 프레임 건너뛰지 말고 유지),
 * drift < -catchUpMs (비디오가 너무 뒤처짐) = skip(다음 프레임으로 빨리 감기 유도).
 * 그 사이 = draw. (currentTime seek 는 janky 라 안 씀 — 판정만 반환, 실제 pacing 은 호출부.)
 */
export function syncDecision(
	framePtsMs: number,
	audioTimeMs: number,
	opts: { skipAheadMs?: number; catchUpMs?: number } = {},
): "draw" | "skip" | "wait" {
	const drift = framePtsMs - audioTimeMs; // +면 비디오가 앞섬
	const ahead = opts.skipAheadMs ?? 80;
	const behind = opts.catchUpMs ?? 80;
	if (drift > ahead) return "wait";
	if (drift < -behind) return "skip";
	return "draw";
}
