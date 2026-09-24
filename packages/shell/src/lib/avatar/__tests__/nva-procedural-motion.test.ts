// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_MOTION_SPEC,
	type HeadTrackFrame,
	type HeadTrackSpec,
	type MotionSpec,
	applyHeadTrackToRect,
	drawWithMotion,
	headTrackFrameAt,
	isReducedMotion,
	motionAt,
	parseHeadTrack,
	parseMotionSpec,
	sliceGeometry,
} from "../nva-procedural-motion";

describe("nva-procedural-motion", () => {
	describe("parseMotionSpec", () => {
		it("returns default spec when motion field is absent", () => {
			const spec = parseMotionSpec({});
			expect(spec).toEqual(DEFAULT_MOTION_SPEC);
		});

		it("returns null when motion is false", () => {
			const spec = parseMotionSpec({ motion: false });
			expect(spec).toBeNull();
		});

		it("returns default spec when motion is true", () => {
			const spec = parseMotionSpec({ motion: true });
			expect(spec).toEqual(DEFAULT_MOTION_SPEC);
		});

		it("parses valid custom fields and falls back to defaults for omitted ones", () => {
			const spec = parseMotionSpec({
				motion: {
					breath: 0.02,
					sway_deg: 2.5,
				},
			});
			expect(spec).toEqual({
				breath: 0.02,
				breath_period_s: DEFAULT_MOTION_SPEC.breath_period_s,
				sway_deg: 2.5,
				sway_period_s: DEFAULT_MOTION_SPEC.sway_period_s,
				chest_y: DEFAULT_MOTION_SPEC.chest_y,
				pivot_y: DEFAULT_MOTION_SPEC.pivot_y,
			});
		});

		it("falls back to default for out-of-range or invalid fields individually", () => {
			const spec = parseMotionSpec({
				motion: {
					breath: -0.01, // < 0 -> default
					breath_period_s: 50, // > 20 -> default
					sway_deg: "invalid" as unknown as number, // non-number -> default
					sway_period_s: 15.0, // valid 1~30
					chest_y: 0.1, // < 0.3 -> default
					pivot_y: Number.NaN, // NaN -> default
				},
			});
			expect(spec).toEqual({
				breath: DEFAULT_MOTION_SPEC.breath,
				breath_period_s: DEFAULT_MOTION_SPEC.breath_period_s,
				sway_deg: DEFAULT_MOTION_SPEC.sway_deg,
				sway_period_s: 15.0,
				chest_y: DEFAULT_MOTION_SPEC.chest_y,
				pivot_y: DEFAULT_MOTION_SPEC.pivot_y,
			});
		});

		it("accepts valid boundary values", () => {
			const spec = parseMotionSpec({
				motion: {
					breath: 0.05,
					breath_period_s: 1.0,
					sway_deg: 5.0,
					sway_period_s: 30.0,
					chest_y: 0.3,
					pivot_y: 1.5,
				},
			});
			expect(spec).toEqual({
				breath: 0.05,
				breath_period_s: 1.0,
				sway_deg: 5.0,
				sway_period_s: 30.0,
				chest_y: 0.3,
				pivot_y: 1.5,
			});
		});
	});

	describe("motionAt", () => {
		const spec: MotionSpec = {
			breath: 0.02,
			breath_period_s: 4.0,
			sway_deg: 2.0,
			sway_period_s: 8.0,
			chest_y: 0.72,
			pivot_y: 1.0,
		};

		it("calculates breath and sway at t = 0", () => {
			const m = motionAt(0, spec);
			expect(m.breath).toBeCloseTo(0, 5);
			expect(m.angleDeg).toBeCloseTo(0, 5);
		});

		it("calculates peak breath at half period", () => {
			// At t = 2.0s (2000ms), cos(pi) = -1, (0.5 - 0.5 * (-1)) = 1.0
			const m = motionAt(2000, spec);
			expect(m.breath).toBeCloseTo(0.02, 5);
		});

		it("calculates zero breath at full period", () => {
			const m = motionAt(4000, spec);
			expect(m.breath).toBeCloseTo(0, 5);
		});

		it("calculates peak sway at quarter period", () => {
			// At t = 2.0s (2000ms), sin(2pi * 2 / 8) = sin(pi/2) = 1.0
			const m = motionAt(2000, spec);
			expect(m.angleDeg).toBeCloseTo(2.0, 5);
		});

		it("calculates negative peak sway at three-quarter period", () => {
			// At t = 6.0s (6000ms), sin(3pi/2) = -1.0
			const m = motionAt(6000, spec);
			expect(m.angleDeg).toBeCloseTo(-2.0, 5);
		});

		it("is continuous across time without reset", () => {
			const m1 = motionAt(1000, spec);
			const m2 = motionAt(1001, spec);
			expect(Math.abs(m2.breath - m1.breath)).toBeLessThan(0.001);
			expect(Math.abs(m2.angleDeg - m1.angleDeg)).toBeLessThan(0.01);
		});
	});

	describe("sliceGeometry", () => {
		const rect = { dx: 100, dy: 50, dw: 200, dh: 400 };
		const chestY = 0.72; // cy = 50 + 0.72 * 400 = 338
		const breath = 0.01;

		it("computes matching contact line between top and bottom slices without overlap", () => {
			const { top, bottom, cy, lift } = sliceGeometry(rect, chestY, breath, 0);

			expect(cy).toBeCloseTo(338, 4);
			// below height = (50 + 400 - 338) = 112
			// lift = 112 * 0.01 = 1.12
			expect(lift).toBeCloseTo(1.12, 4);

			// Top piece
			expect(top.sx).toBe(100);
			expect(top.sy).toBe(50);
			expect(top.sw).toBe(200);
			expect(top.sh).toBeCloseTo(288, 4); // 338 - 50

			expect(top.dx).toBe(100);
			expect(top.dy).toBeCloseTo(50 - 1.12, 4);
			expect(top.dw).toBe(200);
			expect(top.dh).toBeCloseTo(288, 4);

			// Top piece bottom edge
			const topBottomEdge = top.dy + top.dh;
			expect(topBottomEdge).toBeCloseTo(338 - 1.12, 4);

			// Bottom piece top edge
			expect(bottom.dy).toBeCloseTo(338 - 1.12, 4);
			expect(topBottomEdge).toBeCloseTo(bottom.dy, 4);

			// Bottom piece bottom edge remains at rect bottom (50 + 400 = 450)
			const bottomBottomEdge = bottom.dy + bottom.dh;
			expect(bottomBottomEdge).toBeCloseTo(450, 4);
		});

		it("applies 1px overlap by extending the bottom piece upward", () => {
			const { top, bottom } = sliceGeometry(rect, chestY, breath, 1);
			const topBottomEdge = top.dy + top.dh;
			// bottom.dy starts 1px higher than topBottomEdge
			expect(bottom.dy).toBeCloseTo(topBottomEdge - 1, 4);
			// bottom piece bottom edge remains at 450
			expect(bottom.dy + bottom.dh).toBeCloseTo(450, 4);
		});
	});

	describe("drawWithMotion", () => {
		let targetCtx: any;
		let sourceCanvas: any;
		const rect = { dx: 100, dy: 50, dw: 200, dh: 400 };
		const spec: MotionSpec = {
			breath: 0.01,
			breath_period_s: 4.0,
			sway_deg: 2.0,
			sway_period_s: 8.0,
			chest_y: 0.72,
			pivot_y: 1.0,
		};

		beforeEach(() => {
			targetCtx = {
				canvas: { width: 400, height: 600 },
				save: vi.fn(),
				restore: vi.fn(),
				translate: vi.fn(),
				rotate: vi.fn(),
				drawImage: vi.fn(),
				clearRect: vi.fn(),
			};
			sourceCanvas = { width: 400, height: 600 };
		});

		it("draws two slices with rotation transformation when motion is active", () => {
			// At t = 2000ms: breath = 0.01, sway = 2.0 deg
			drawWithMotion(targetCtx, sourceCanvas, rect, spec, 2000);

			expect(targetCtx.save).toHaveBeenCalledOnce();
			expect(targetCtx.restore).toHaveBeenCalledOnce();

			// Pivot: x = 100 + 200/2 = 200, y = 50 + 1.0 * 400 = 450
			expect(targetCtx.translate).toHaveBeenNthCalledWith(1, 200, 450);
			const expectedAngleRad = (2.0 * Math.PI) / 180;
			expect(targetCtx.rotate).toHaveBeenCalledWith(expectedAngleRad);
			expect(targetCtx.translate).toHaveBeenNthCalledWith(2, -200, -450);

			// Draws bottom slice then top slice
			expect(targetCtx.drawImage).toHaveBeenCalledTimes(2);
		});

		it("draws plain source when spec is null", () => {
			drawWithMotion(targetCtx, sourceCanvas, rect, null, 2000);

			expect(targetCtx.save).not.toHaveBeenCalled();
			expect(targetCtx.rotate).not.toHaveBeenCalled();
			expect(targetCtx.drawImage).toHaveBeenCalledTimes(1);
			expect(targetCtx.drawImage).toHaveBeenCalledWith(
				sourceCanvas,
				rect.dx,
				rect.dy,
				rect.dw,
				rect.dh,
				rect.dx,
				rect.dy,
				rect.dw,
				rect.dh,
			);
		});

		it("draws plain source when reduced motion is preferred", () => {
			const originalMatchMedia = window.matchMedia;
			window.matchMedia = vi.fn().mockImplementation((query) => ({
				matches: query === "(prefers-reduced-motion: reduce)",
				media: query,
				onchange: null,
				addListener: vi.fn(),
				removeListener: vi.fn(),
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				dispatchEvent: vi.fn(),
			}));

			drawWithMotion(targetCtx, sourceCanvas, rect, spec, 2000);

			expect(targetCtx.save).not.toHaveBeenCalled();
			expect(targetCtx.rotate).not.toHaveBeenCalled();
			expect(targetCtx.drawImage).toHaveBeenCalledTimes(1);

			window.matchMedia = originalMatchMedia;
		});
	});

	describe("head_track", () => {
		describe("parseHeadTrack", () => {
			it("parses valid head_track spec", () => {
				const track = parseHeadTrack({
					head_track: {
						fps: 25,
						frames: [
							[0, 0, 0, 1],
							[0.01, -0.02, 1.5, 1.05],
						],
					},
				});
				expect(track).toEqual({
					fps: 25,
					frames: [
						[0, 0, 0, 1],
						[0.01, -0.02, 1.5, 1.05],
					],
				});
			});

			it("returns null if head_track is missing or not an object", () => {
				expect(parseHeadTrack({})).toBeNull();
				expect(parseHeadTrack({ head_track: null })).toBeNull();
				expect(parseHeadTrack({ head_track: false })).toBeNull();
			});

			it("returns null if fps is invalid", () => {
				expect(
					parseHeadTrack({ head_track: { fps: 0, frames: [[0, 0, 0, 1]] } }),
				).toBeNull();
				expect(
					parseHeadTrack({ head_track: { fps: -25, frames: [[0, 0, 0, 1]] } }),
				).toBeNull();
				expect(
					parseHeadTrack({
						head_track: { fps: Number.NaN, frames: [[0, 0, 0, 1]] },
					}),
				).toBeNull();
			});

			it("returns null if frames is empty or exceeds 100,000", () => {
				expect(
					parseHeadTrack({ head_track: { fps: 25, frames: [] } }),
				).toBeNull();
				const huge = new Array(100001).fill([0, 0, 0, 1]);
				expect(
					parseHeadTrack({ head_track: { fps: 25, frames: huge } }),
				).toBeNull();
			});

			it("returns null if any frame element is not 4 numbers", () => {
				expect(
					parseHeadTrack({
						head_track: {
							fps: 25,
							frames: [[0, 0, 0]], // only 3 elements
						},
					}),
				).toBeNull();
				expect(
					parseHeadTrack({
						head_track: {
							fps: 25,
							frames: [[0, 0, 0, "1" as unknown as number]],
						},
					}),
				).toBeNull();
			});
		});

		describe("headTrackFrameAt", () => {
			const track: HeadTrackSpec = {
				fps: 25,
				frames: [
					[0, 0, 0, 1],
					[0.1, 0.2, 1.0, 1.0],
					[0.2, 0.4, 2.0, 1.0],
				],
			};

			it("selects frame based on currentTime and fps", () => {
				// 0.0s -> frame 0
				expect(headTrackFrameAt(track, 0.0)).toEqual([0, 0, 0, 1]);
				// 0.04s -> frame 1 (0.04 * 25 = 1)
				expect(headTrackFrameAt(track, 0.04)).toEqual([0.1, 0.2, 1.0, 1.0]);
				// 0.08s -> frame 2 (0.08 * 25 = 2)
				expect(headTrackFrameAt(track, 0.08)).toEqual([0.2, 0.4, 2.0, 1.0]);
				// 0.12s -> frame 0 (3 % 3 = 0)
				expect(headTrackFrameAt(track, 0.12)).toEqual([0, 0, 0, 1]);
			});
		});

		describe("applyHeadTrackToRect", () => {
			const headRect = { x: 150, y: 100, w: 100, h: 100 };
			const drawRect = { dx: 100, dy: 50, dw: 200, dh: 400 };

			it("returns unchanged head rect when frame is omitted", () => {
				const result = applyHeadTrackToRect(headRect, drawRect);
				expect(result.rect).toEqual(headRect);
				expect(result.rotDeg).toBe(0);
			});

			it("applies offset, center-based scale and rotation", () => {
				// frame: dx=0.05, dy=0.1, rotDeg=5.0, scale=1.2
				// dx offset = 0.05 * 200 = 10 -> x = 160
				// dy offset = 0.1 * 400 = 40 -> y = 140
				// center = (160 + 50, 140 + 50) = (210, 190)
				// newW = 100 * 1.2 = 120, newH = 100 * 1.2 = 120
				// newX = 210 - 60 = 150, newY = 190 - 60 = 130
				const frame: HeadTrackFrame = [0.05, 0.1, 5.0, 1.2];
				const result = applyHeadTrackToRect(headRect, drawRect, frame);

				expect(result.rect.x).toBeCloseTo(150, 4);
				expect(result.rect.y).toBeCloseTo(130, 4);
				expect(result.rect.w).toBeCloseTo(120, 4);
				expect(result.rect.h).toBeCloseTo(120, 4);
				expect(result.cx).toBeCloseTo(210, 4);
				expect(result.cy).toBeCloseTo(190, 4);
				expect(result.rotDeg).toBe(5.0);
			});
		});
	});
});
