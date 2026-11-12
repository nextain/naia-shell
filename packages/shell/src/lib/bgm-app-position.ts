/**
 * BGM 앱 패널(`.bgm-yt-app`, position: fixed) 위치 계산 (FR-UI-FONT-SCALE.3).
 *
 * 패널은 음악 막대의 오른쪽 끝에 맞춰 바로 아래 열린다. 예전 계산은 가로만
 * 가두고 세로는 가두지 않았으며, 측정값과 배치값의 좌표계가 다르면(CSS zoom)
 * 화면 밖으로 나갔다. 여기서 가로·세로를 모두 창 안으로 가둔다.
 * 순수 함수라 DOM 없이 시험한다.
 */

/** CSS `.bgm-yt-app` width(380px)와 반드시 같은 값 — 어긋나면 우측 정렬 계산이 밀린다. */
export const BGM_APP_WIDTH = 380;
/** 창 가장자리와 패널 사이 최소 여백(px). */
export const BGM_APP_MARGIN = 8;
/** 앵커와 패널 사이 간격(px). */
export const BGM_APP_GAP = 4;
/** 세로로 가둘 때 최소한 보여야 하는 패널 높이(px) — 머리줄·닫기 단추가 보이도록. */
export const BGM_APP_MIN_VISIBLE_HEIGHT = 160;

export interface AnchorRect {
	right: number;
	bottom: number;
}

export interface Viewport {
	width: number;
	height: number;
}

export interface BgmAppPosition {
	top: number;
	left: number;
	width: number;
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(value, Math.max(min, max)));
}

export function computeBgmAppPosition(
	anchor: AnchorRect,
	viewport: Viewport,
): BgmAppPosition {
	const width = Math.max(
		0,
		Math.min(BGM_APP_WIDTH, viewport.width - BGM_APP_MARGIN * 2),
	);
	const left = clamp(
		anchor.right - width,
		BGM_APP_MARGIN,
		viewport.width - width - BGM_APP_MARGIN,
	);
	const top = clamp(
		anchor.bottom + BGM_APP_GAP,
		BGM_APP_MARGIN,
		viewport.height - BGM_APP_MIN_VISIBLE_HEIGHT - BGM_APP_MARGIN,
	);
	return { top, left, width };
}
