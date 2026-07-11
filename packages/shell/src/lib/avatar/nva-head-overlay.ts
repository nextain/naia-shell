// nva-head-overlay — Layer 1 head 오버레이. chromakey GL 로 head 프레임(green bg)을 키잉 → base draw
//   rect + face_bbox 기준 픽셀 위치에 합성(정본 editor.html: head 를 face_bbox rect 에 drawImage).
//   head_scale/offset 튜닝 + jitter lerp 스무딩. base 렌더러의 onFrame 훅에서 매 프레임 호출(P4 배선).

import type { DrawRect } from "./nva-base-renderer";
import { type ChromakeyOpts, NvaChromakeyGL } from "./nva-chromakey-gl";

export interface HeadTuning {
	/** head 크기 배율(정합 미세조정). 기본 1. */
	scale?: number;
	/** head 위치 오프셋(base draw rect 폭/높이 대비 정규화). */
	offsetX?: number;
	offsetY?: number;
	/** jitter 스무딩 계수(0=없음, 0.x=이전 위치와 lerp). */
	smoothing?: number;
}

export interface HeadRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * face_bbox(정규화, speak 클립 기준) → base draw rect 내 픽셀 rect.
 * bbox=[x,y,l] 정사각(s=l*min(dw,dh)) | [x,y,w,h] 직사각. scale/offset 튜닝 반영.
 */
export function faceBboxToRect(
	bbox: number[],
	drawRect: DrawRect,
	tuning: HeadTuning = {},
): HeadRect {
	const x = bbox[0] ?? 0;
	const y = bbox[1] ?? 0;
	const scale = tuning.scale ?? 1;
	const ox = tuning.offsetX ?? 0;
	const oy = tuning.offsetY ?? 0;
	let w: number;
	let h: number;
	if (bbox.length >= 4) {
		w = (bbox[2] ?? 0) * drawRect.dw;
		h = (bbox[3] ?? 0) * drawRect.dh;
	} else {
		const s = (bbox[2] ?? 0) * Math.min(drawRect.dw, drawRect.dh);
		w = s;
		h = s;
	}
	// scale 은 중심 기준(정합 흔들림 방지).
	const baseX = drawRect.dx + x * drawRect.dw + ox * drawRect.dw;
	const baseY = drawRect.dy + y * drawRect.dh + oy * drawRect.dh;
	const sw = w * scale;
	const sh = h * scale;
	return {
		x: baseX - (sw - w) / 2,
		y: baseY - (sh - h) / 2,
		w: sw,
		h: sh,
	};
}

/** head 오버레이 합성기. chromakey GL 을 소유. WebGL2 미지원 시 생성자 throw. */
export class NvaHeadOverlay {
	private readonly key: NvaChromakeyGL;
	private smoothed: HeadRect | null = null;

	constructor(opts?: ChromakeyOpts) {
		this.key = new NvaChromakeyGL(opts);
	}

	/**
	 * head 프레임을 키잉해 target 2D ctx 의 base draw rect + face_bbox 위치에 합성.
	 * head 소스 크기가 0(미로드)면 no-op(null). 반환 = 그린 rect(진단/테스트).
	 */
	draw(
		ctx: CanvasRenderingContext2D,
		head: HTMLVideoElement | HTMLCanvasElement,
		bbox: number[],
		drawRect: DrawRect,
		tuning: HeadTuning = {},
	): HeadRect | null {
		const hw =
			(head as HTMLVideoElement).videoWidth ||
			(head as HTMLCanvasElement).width;
		const hh =
			(head as HTMLVideoElement).videoHeight ||
			(head as HTMLCanvasElement).height;
		if (!hw || !hh) return null;

		const keyed = this.key.process(head, hw, hh);
		let rect = faceBboxToRect(bbox, drawRect, tuning);

		const s = tuning.smoothing ?? 0;
		if (s > 0 && this.smoothed) {
			const t = 1 - s;
			rect = {
				x: lerp(this.smoothed.x, rect.x, t),
				y: lerp(this.smoothed.y, rect.y, t),
				w: lerp(this.smoothed.w, rect.w, t),
				h: lerp(this.smoothed.h, rect.h, t),
			};
		}
		this.smoothed = rect;
		ctx.drawImage(keyed, rect.x, rect.y, rect.w, rect.h);
		return rect;
	}

	setParams(p: ChromakeyOpts): void {
		this.key.setParams(p);
	}

	/** 새 발화 시작 등 위치 점프 시 스무딩 이력 초기화(잔상 방지). */
	resetSmoothing(): void {
		this.smoothed = null;
	}

	dispose(): void {
		this.key.dispose();
	}
}
