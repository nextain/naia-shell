import { Logger } from "./logger";

/**
 * 앱 전체 글자 크기 (UC-UI-FONT-SCALE-20261105 / FR-UI-FONT-SCALE.1~2).
 *
 * 셸 스타일은 대부분 px 이라 루트 font-size 만 바꿔서는 글자가 커지지 않는다.
 * 그렇다고 `document.documentElement.style.zoom` 을 쓰면 WebKitGTK 에서
 * `getBoundingClientRect()` 가 확대된 값을 돌려주고 그 값을 다시 `left/top`
 * 으로 넣으면 한 번 더 확대된다 — BGM 앱 패널이 1920 폭 창에서 x≈2377 로
 * 화면 밖에 열린 사고(2026-11-04 실기)가 그것이다.
 *
 * 그래서 배율은 **글자 크기에만** 건다. 스타일시트의 px/rem `font-size` 는
 * `calc(<값> * var(--ui-font-scale, 1))` 로 쓰고, 이 모듈은 그 변수 하나만
 * 바꾼다. 배치(px)는 그대로이므로 위치 계산이 어긋나지 않는다.
 */
export type UiFontScaleId = "small" | "normal" | "large" | "xlarge";

export const UI_FONT_SCALES: Readonly<Record<UiFontScaleId, number>> = {
	small: 0.9,
	normal: 1,
	large: 1.25,
	xlarge: 1.5,
};

export const UI_FONT_SCALE_IDS: readonly UiFontScaleId[] = [
	"small",
	"normal",
	"large",
	"xlarge",
];

export const DEFAULT_UI_FONT_SCALE: UiFontScaleId = "normal";

/** CSS custom property every scaled `font-size` multiplies by. */
export const UI_FONT_SCALE_CSS_VAR = "--ui-font-scale";

/** Dispatched on window after the scale changes so px-positioned popovers can re-measure. */
export const UI_FONT_SCALE_EVENT = "naia-ui-font-scale-changed";

export function normalizeUiFontScale(value: unknown): UiFontScaleId {
	return typeof value === "string" &&
		Object.prototype.hasOwnProperty.call(UI_FONT_SCALES, value)
		? (value as UiFontScaleId)
		: DEFAULT_UI_FONT_SCALE;
}

export function uiFontScaleFactor(value: unknown): number {
	return UI_FONT_SCALES[normalizeUiFontScale(value)];
}

/**
 * 인라인 스타일용 글자 크기. 스타일시트와 같은 식이라 배율 변수 하나로 함께 움직인다.
 * 변수가 없는 창(슬라이드 단독 창 등)에서는 원래 px 그대로다.
 */
export function scaledFontSize(px: number): string {
	return `calc(${px}px * var(${UI_FONT_SCALE_CSS_VAR}, 1))`;
}

/** Sets the scale on the document root. Returns the normalized id that was applied. */
export function applyUiFontScale(
	value: unknown,
	root: HTMLElement | null = typeof document === "undefined"
		? null
		: document.documentElement,
): UiFontScaleId {
	const id = normalizeUiFontScale(value);
	if (!root) return id;
	const factor = UI_FONT_SCALES[id];
	const previous = root.dataset.uiFontScale;
	root.style.setProperty(UI_FONT_SCALE_CSS_VAR, String(factor));
	root.dataset.uiFontScale = id;
	if (previous !== id) {
		Logger.debug("UiFontScale", "applyUiFontScale", {
			requested: typeof value === "string" ? value : String(value),
			applied: id,
			factor,
		});
		if (typeof window !== "undefined") {
			window.dispatchEvent(
				new CustomEvent(UI_FONT_SCALE_EVENT, { detail: { id, factor } }),
			);
		}
	}
	return id;
}
