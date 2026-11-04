/**
 * FR-UI-FONT-SCALE.3 — BGM 앱 패널(.bgm-yt-app)은 어느 배율·창 크기에서도 화면 안에 열린다.
 *
 * 2026-11-04 실기: html 에 CSS zoom 1.6~2.0 을 걸자 패널이 1920 폭 창에서
 * x≈2377 에 열렸다(측정 좌표와 배치 좌표가 달라 한 번 더 확대됨).
 *
 * Run:
 *   pnpm exec vitest run src/lib/__tests__/bgm-app-position.test.ts
 */
import { describe, expect, it } from "vitest";
import {
	BGM_APP_GAP,
	BGM_APP_MARGIN,
	BGM_APP_MIN_VISIBLE_HEIGHT,
	BGM_APP_WIDTH,
	computeBgmAppPosition,
} from "../bgm-app-position";
import { UI_FONT_SCALES } from "../ui-font-scale";

function expectInside(
	pos: { top: number; left: number; width: number },
	viewport: { width: number; height: number },
) {
	expect(pos.left).toBeGreaterThanOrEqual(BGM_APP_MARGIN);
	expect(pos.left + pos.width).toBeLessThanOrEqual(
		viewport.width - BGM_APP_MARGIN,
	);
	expect(pos.top).toBeGreaterThanOrEqual(BGM_APP_MARGIN);
	expect(pos.top).toBeLessThanOrEqual(viewport.height - BGM_APP_MARGIN);
}

describe("computeBgmAppPosition", () => {
	const desktop = { width: 1920, height: 1080 };

	it("right-aligns the panel under the music pill", () => {
		const pos = computeBgmAppPosition({ right: 1880, bottom: 36 }, desktop);
		expect(pos).toEqual({
			top: 36 + BGM_APP_GAP,
			left: 1880 - BGM_APP_WIDTH,
			width: BGM_APP_WIDTH,
		});
	});

	it("clamps an anchor reported past the right edge (the x≈2377 zoom incident)", () => {
		const pos = computeBgmAppPosition(
			{ right: 2377 + 380, bottom: 60 },
			desktop,
		);
		expect(pos.left).toBe(desktop.width - BGM_APP_WIDTH - BGM_APP_MARGIN);
		expectInside(pos, desktop);
	});

	it("keeps the header visible when the anchor is near the bottom", () => {
		const pos = computeBgmAppPosition({ right: 900, bottom: 1070 }, desktop);
		expect(pos.top).toBe(
			desktop.height - BGM_APP_MIN_VISIBLE_HEIGHT - BGM_APP_MARGIN,
		);
		expectInside(pos, desktop);
	});

	it("shrinks to the window on a narrow (360px) window", () => {
		const phone = { width: 360, height: 640 };
		const pos = computeBgmAppPosition({ right: 300, bottom: 36 }, phone);
		expect(pos.width).toBe(360 - BGM_APP_MARGIN * 2);
		expect(pos.left).toBe(BGM_APP_MARGIN);
		expectInside(pos, phone);
	});

	it("never produces NaN from a broken measurement", () => {
		const pos = computeBgmAppPosition(
			{ right: Number.NaN, bottom: Number.POSITIVE_INFINITY },
			desktop,
		);
		expect(Number.isFinite(pos.left)).toBe(true);
		expect(Number.isFinite(pos.top)).toBe(true);
		expectInside(pos, desktop);
	});

	it.each(Object.entries(UI_FONT_SCALES))(
		"stays inside 1920×1080 and 1280×720 at font scale %s (%d)",
		(_id, factor) => {
			for (const viewport of [desktop, { width: 1280, height: 720 }]) {
				// Even if a caller hands us coordinates multiplied by the scale
				// (as CSS zoom did), the panel must still land on screen.
				const anchor = {
					right: (viewport.width - 44) * factor,
					bottom: 40 * factor,
				};
				expectInside(computeBgmAppPosition(anchor, viewport), viewport);
			}
		},
	);
});
