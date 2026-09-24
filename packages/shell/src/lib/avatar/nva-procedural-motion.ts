// nva-procedural-motion.ts — Live2D식 절차적 몸 움직임(숨쉬기·흔들림) 및 머리 위치표 (naia-shell#714)
//
// 1. 순수 계산부:
//    - parseMotionSpec: 매니페스트 최상위 motion 필드 파싱 (허용 범위 검사, 개별 필드 기본값 폴백, false=null)
//    - motionAt: 주어진 시각(tMs, performance.now())에 대한 breath(0..breath), angleDeg 계산 (벽시계 연속성 보장)
//    - sliceGeometry: 가슴선(chest_y) 기준 상하 2조각 분할 기하 계산 (1px 오버랩 지원)
// 2. 그리기부:
//    - drawWithMotion: 오프스크린 캔버스에 합성된 캐릭터를 회전/숨쉬기 변환하여 타깃 2D 컨텍스트에 렌더링
//    - 움직임 줄이기(prefers-reduced-motion) 활성화 시 모션 미적용
// 3. 머리 위치표(head_track):
//    - parseHeadTrack: 발화 애니메이션의 head_track 필드 파싱
//    - headTrackFrameAt: currentTime 기준 현재 프레임 선택
//    - applyHeadTrackToRect: faceBboxToRect 결과에 위치 이동/중심 기준 회전/스케일 적용

export interface MotionSpec {
	/** 숨쉬기 세로 늘임 최대 비율 (0~0.05, 기본 0.010) */
	breath: number;
	/** 숨쉬기 주기(초) (1~20, 기본 3.6) */
	breath_period_s: number;
	/** 흔들림 최대 각도(도) (0~5, 기본 1.0) */
	sway_deg: number;
	/** 흔들림 주기(초) (1~30, 기본 7.0) */
	sway_period_s: number;
	/** 숨쉬기 기준선, 그림 높이 비율 (0.3~0.95, 기본 0.72) */
	chest_y: number;
	/** 흔들림 축 높이, 그림 높이 비율 (0.5~1.5, 기본 1.0) */
	pivot_y: number;
}

export const DEFAULT_MOTION_SPEC: Readonly<MotionSpec> = Object.freeze({
	breath: 0.01,
	breath_period_s: 3.6,
	sway_deg: 1.0,
	sway_period_s: 7.0,
	chest_y: 0.72,
	pivot_y: 1.0,
});

export interface DrawRect {
	dx: number;
	dy: number;
	dw: number;
	dh: number;
}

export interface SliceRect {
	sx: number;
	sy: number;
	sw: number;
	sh: number;
	dx: number;
	dy: number;
	dw: number;
	dh: number;
}

export interface MotionSlices {
	top: SliceRect;
	bottom: SliceRect;
	cy: number;
	lift: number;
}

export type HeadTrackFrame = [
	dx: number,
	dy: number,
	rotDeg: number,
	scale: number,
];

export interface HeadTrackSpec {
	fps: number;
	frames: HeadTrackFrame[];
}

export interface HeadRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

function parseNumber(
	val: unknown,
	min: number,
	max: number,
	fallback: number,
): number {
	if (
		typeof val === "number" &&
		Number.isFinite(val) &&
		val >= min &&
		val <= max
	) {
		return val;
	}
	return fallback;
}

/**
 * 매니페스트 최상위 motion 필드를 읽는다.
 * - motion: false -> null (움직임 끔)
 * - 필드 부재/객체가 아니면 기본값 사용 (움직임 켬)
 * - 각 필드별 유효 범위를 벗어나면 개별 필드만 기본값으로 폴백
 */
export function parseMotionSpec(manifest: unknown): MotionSpec | null {
	if (!manifest || typeof manifest !== "object") {
		return { ...DEFAULT_MOTION_SPEC };
	}
	const raw = (manifest as { motion?: unknown }).motion;
	if (raw === false) {
		return null;
	}
	if (!raw || typeof raw !== "object") {
		return { ...DEFAULT_MOTION_SPEC };
	}

	const m = raw as Record<string, unknown>;
	return {
		breath: parseNumber(m.breath, 0, 0.05, DEFAULT_MOTION_SPEC.breath),
		breath_period_s: parseNumber(
			m.breath_period_s,
			1,
			20,
			DEFAULT_MOTION_SPEC.breath_period_s,
		),
		sway_deg: parseNumber(m.sway_deg, 0, 5, DEFAULT_MOTION_SPEC.sway_deg),
		sway_period_s: parseNumber(
			m.sway_period_s,
			1,
			30,
			DEFAULT_MOTION_SPEC.sway_period_s,
		),
		chest_y: parseNumber(m.chest_y, 0.3, 0.95, DEFAULT_MOTION_SPEC.chest_y),
		pivot_y: parseNumber(m.pivot_y, 0.5, 1.5, DEFAULT_MOTION_SPEC.pivot_y),
	};
}

/**
 * tMs(performance.now()) 기준 숨쉬기 늘임 비율 및 회전 각도를 계산하는 순수 함수.
 * - breath = spec.breath * (0.5 - 0.5 * cos(2π t / breath_period)) -> 0..breath
 * - angleDeg = spec.sway_deg * sin(2π t / sway_period)
 */
export function motionAt(
	tMs: number,
	spec: MotionSpec,
): { breath: number; angleDeg: number } {
	const tSec = tMs / 1000;
	const breathPhase = (2 * Math.PI * tSec) / spec.breath_period_s;
	const swayPhase = (2 * Math.PI * tSec) / spec.sway_period_s;

	const breath = spec.breath * (0.5 - 0.5 * Math.cos(breathPhase));
	const angleDeg = spec.sway_deg * Math.sin(swayPhase);

	return { breath, angleDeg };
}

/**
 * 가슴선(chest_y)을 기준으로 캐릭터의 상/하 2조각 기하 좌표를 계산한다.
 * - 위 조각: 크기 그대로 lift만큼 위로 이동
 * - 아래 조각: 아랫변 고정, 세로로 (1 + breath)배 늘임
 * - overlapPx: 두 조각 사이 틈 방지를 위해 아래 조각을 위쪽으로 겹쳐 그리는 픽셀 수 (기본 1)
 */
export function sliceGeometry(
	rect: DrawRect,
	chestY: number,
	breath: number,
	overlapPx = 1,
): MotionSlices {
	if (rect.dw <= 0 || rect.dh <= 0) {
		const empty: SliceRect = {
			sx: 0,
			sy: 0,
			sw: 0,
			sh: 0,
			dx: 0,
			dy: 0,
			dw: 0,
			dh: 0,
		};
		return { top: empty, bottom: empty, cy: 0, lift: 0 };
	}

	const cy = rect.dy + chestY * rect.dh;
	const aboveH = cy - rect.dy;
	const belowH = rect.dy + rect.dh - cy;
	const lift = belowH * breath;

	const top: SliceRect = {
		sx: rect.dx,
		sy: rect.dy,
		sw: rect.dw,
		sh: aboveH,
		dx: rect.dx,
		dy: rect.dy - lift,
		dw: rect.dw,
		dh: aboveH,
	};

	const bottom: SliceRect = {
		sx: rect.dx,
		sy: cy,
		sw: rect.dw,
		sh: belowH,
		dx: rect.dx,
		dy: cy - lift - overlapPx,
		dw: rect.dw,
		dh: belowH + lift + overlapPx,
	};

	return { top, bottom, cy, lift };
}

/**
 * OS/브라우저의 움직임 줄이기(prefers-reduced-motion) 설정 활성화 여부 확인.
 */
export function isReducedMotion(): boolean {
	if (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function"
	) {
		return false;
	}
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 합성된 오프스크린 캔버스 소스를 숨쉬기 및 흔들림 변환과 함께 타깃 2D 컨텍스트에 렌더링한다.
 * - spec이 null이거나 움직임 줄이기가 켜져 있으면 원본 그대로 단일 drawImage
 * - 흔들림: (rect.dx + rect.dw/2, rect.dy + pivot_y * rect.dh) 축 기준 회전
 * - 숨쉬기: 가슴선 기준 2조각 분할 후 하단 조각(1px 겹침) -> 상단 조각 순서로 렌더링
 */
export function drawWithMotion(
	target: CanvasRenderingContext2D,
	source: CanvasImageSource,
	rect: DrawRect,
	spec: MotionSpec | null,
	tMs: number,
): void {
	if (rect.dw <= 0 || rect.dh <= 0) return;

	if (!spec || isReducedMotion()) {
		target.drawImage(
			source,
			rect.dx,
			rect.dy,
			rect.dw,
			rect.dh,
			rect.dx,
			rect.dy,
			rect.dw,
			rect.dh,
		);
		return;
	}

	const { breath, angleDeg } = motionAt(tMs, spec);

	if (Math.abs(breath) < 1e-6 && Math.abs(angleDeg) < 1e-6) {
		target.drawImage(
			source,
			rect.dx,
			rect.dy,
			rect.dw,
			rect.dh,
			rect.dx,
			rect.dy,
			rect.dw,
			rect.dh,
		);
		return;
	}

	const pivotX = rect.dx + rect.dw / 2;
	const pivotY = rect.dy + spec.pivot_y * rect.dh;
	const angleRad = (angleDeg * Math.PI) / 180;

	target.save();
	target.translate(pivotX, pivotY);
	target.rotate(angleRad);
	target.translate(-pivotX, -pivotY);

	const { top, bottom } = sliceGeometry(rect, spec.chest_y, breath, 1);

	// 아래 조각 먼저 그리고 위에 위 조각을 그려 1px 겹침 부위의 경계를 깨끗하게 유지
	target.drawImage(
		source,
		bottom.sx,
		bottom.sy,
		bottom.sw,
		bottom.sh,
		bottom.dx,
		bottom.dy,
		bottom.dw,
		bottom.dh,
	);
	target.drawImage(
		source,
		top.sx,
		top.sy,
		top.sw,
		top.sh,
		top.dx,
		top.dy,
		top.dw,
		top.dh,
	);

	target.restore();
}

/**
 * 발화 애니메이션에 정의된 head_track 스펙을 파싱한다.
 * 잘못된 스펙이나 10만 프레임 초과 배열은 null 반환.
 */
export function parseHeadTrack(anim: unknown): HeadTrackSpec | null {
	if (!anim || typeof anim !== "object") return null;
	const raw = (anim as { head_track?: unknown }).head_track;
	if (!raw || typeof raw !== "object") return null;

	const track = raw as Record<string, unknown>;
	const fps = track.fps;
	if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0) {
		return null;
	}

	const frames = track.frames;
	if (!Array.isArray(frames) || frames.length === 0 || frames.length > 100000) {
		return null;
	}

	for (let i = 0; i < frames.length; i++) {
		const f = frames[i];
		if (!Array.isArray(f) || f.length !== 4) return null;
		if (
			typeof f[0] !== "number" ||
			!Number.isFinite(f[0]) ||
			typeof f[1] !== "number" ||
			!Number.isFinite(f[1]) ||
			typeof f[2] !== "number" ||
			!Number.isFinite(f[2]) ||
			typeof f[3] !== "number" ||
			!Number.isFinite(f[3])
		) {
			return null;
		}
	}

	return {
		fps,
		frames: frames as HeadTrackFrame[],
	};
}

/**
 * video.currentTime(초) 기준 현재 프레임을 순환(modulo) 선택한다.
 */
export function headTrackFrameAt(
	track: HeadTrackSpec,
	currentTimeSec: number,
): HeadTrackFrame {
	const count = track.frames.length;
	const idx =
		((Math.floor(currentTimeSec * track.fps) % count) + count) % count;
	return track.frames[idx] ?? { dx: 0, dy: 0, scale: 1, rot_deg: 0 };
}

/**
 * faceBboxToRect 결과에 head_track 프레임의 위치 이동, 중심 기준 회전 및 확대를 적용한다.
 */
export function applyHeadTrackToRect(
	headRect: HeadRect,
	drawRect: DrawRect,
	frame?: HeadTrackFrame | null,
): { rect: HeadRect; cx: number; cy: number; rotDeg: number } {
	if (!frame) {
		const cx = headRect.x + headRect.w / 2;
		const cy = headRect.y + headRect.h / 2;
		return { rect: { ...headRect }, cx, cy, rotDeg: 0 };
	}

	const [tdx, tdy, rotDeg, scale] = frame;
	const shiftedX = headRect.x + tdx * drawRect.dw;
	const shiftedY = headRect.y + tdy * drawRect.dh;
	const cx = shiftedX + headRect.w / 2;
	const cy = shiftedY + headRect.h / 2;

	const newW = headRect.w * scale;
	const newH = headRect.h * scale;

	return {
		rect: {
			x: cx - newW / 2,
			y: cy - newH / 2,
			w: newW,
			h: newH,
		},
		cx,
		cy,
		rotDeg,
	};
}
