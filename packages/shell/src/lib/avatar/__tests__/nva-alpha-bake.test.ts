import { describe, expect, it } from "vitest";
import {
	bakeAvatarFrameAlpha,
	bakeAvatarFrameRgba,
	packStackedAlphaFrameRgba,
} from "../nva-alpha-bake";

interface SyntheticCanvas {
	width: number;
	height: number;
	rgba: Uint8ClampedArray;
	clearRect(x: number, y: number, w: number, h: number): void;
	fillRect(
		x: number,
		y: number,
		w: number,
		h: number,
		r?: number,
		g?: number,
		b?: number,
		a?: number,
	): void;
}

function createSyntheticCanvas(width: number, height: number): SyntheticCanvas {
	const rgba = new Uint8ClampedArray(width * height * 4);
	return {
		width,
		height,
		rgba,
		clearRect(x: number, y: number, w: number, h: number) {
			const x0 = Math.max(0, Math.floor(x));
			const y0 = Math.max(0, Math.floor(y));
			const x1 = Math.min(width, Math.floor(x + w));
			const y1 = Math.min(height, Math.floor(y + h));
			for (let py = y0; py < y1; py++) {
				for (let px = x0; px < x1; px++) {
					const idx = (py * width + px) * 4;
					rgba[idx] = 0;
					rgba[idx + 1] = 0;
					rgba[idx + 2] = 0;
					rgba[idx + 3] = 0;
				}
			}
		},
		fillRect(
			x: number,
			y: number,
			w: number,
			h: number,
			r = 20,
			g = 20,
			b = 25,
			a = 255,
		) {
			const x0 = Math.max(0, Math.floor(x));
			const y0 = Math.max(0, Math.floor(y));
			const x1 = Math.min(width, Math.floor(x + w));
			const y1 = Math.min(height, Math.floor(y + h));
			for (let py = y0; py < y1; py++) {
				for (let px = x0; px < x1; px++) {
					const idx = (py * width + px) * 4;
					rgba[idx] = r;
					rgba[idx + 1] = g;
					rgba[idx + 2] = b;
					rgba[idx + 3] = a;
				}
			}
		},
	};
}

function alphaAt(alpha: Uint8Array, width: number, x: number, y: number): number {
	return alpha[y * width + x];
}

function pixelAt(
	rgba: Uint8ClampedArray,
	width: number,
	x: number,
	y: number,
): [number, number, number, number] {
	const idx = (y * width + x) * 4;
	return [rgba[idx], rgba[idx + 1], rgba[idx + 2], rgba[idx + 3]];
}

describe("nva-alpha-bake exact connected-component counterexamples (result-fix7hrev1)", () => {
	it("fills an enclosed 30x30 interior hole inside an 88x100 subject (Finding 1: no interior aperture seed)", () => {
		const c = createSyntheticCanvas(128, 256);
		c.fillRect(20, 20, 88, 100, 20, 20, 25, 255);
		c.clearRect(45, 45, 30, 30);

		const alpha = bakeAvatarFrameAlpha(c.rgba, c.width, c.height);
		expect(alphaAt(alpha, c.width, 60, 60)).toBe(255);
		expect(alphaAt(alpha, c.width, 46, 46)).toBe(255);
	});

	it.each([128, 720])(
		"keeps a 1px bent exterior-connected channel transparent at width %d while preserving a 1px connected line (Finding 1 & Finding 5)",
		(width) => {
			// 1px bent exterior channel
			const ch = createSyntheticCanvas(width, 256);
			ch.fillRect(20, 20, 88, 180, 20, 20, 25, 255);
			ch.clearRect(60, 20, 1, 100);
			ch.clearRect(60, 119, 20, 1);
			ch.clearRect(79, 119, 1, 40);

			const chAlpha = bakeAvatarFrameAlpha(ch.rgba, ch.width, ch.height);
			expect(alphaAt(chAlpha, ch.width, 60, 50)).toBe(0);
			expect(alphaAt(chAlpha, ch.width, 70, 119)).toBe(0);
			expect(alphaAt(chAlpha, ch.width, 79, 150)).toBe(0);

			// 1px connected opaque vertical line
			const line = createSyntheticCanvas(width, 256);
			line.fillRect(20, 20, 88, 64, 20, 20, 25, 255);
			line.fillRect(60, 84, 1, 35, 20, 20, 25, 255);

			const lineAlpha = bakeAvatarFrameAlpha(line.rgba, line.width, line.height);
			expect(alphaAt(lineAlpha, line.width, 60, 90)).toBe(255);
			expect(alphaAt(lineAlpha, line.width, 60, 115)).toBe(255);
		},
	);

	it("keeps a 25-turn 4px exterior-connected maze transparent to the very end at 64x256 and 256x256 (Finding 1: no pass cap)", () => {
		// 64x256 25-turn 4px maze
		const m64 = createSyntheticCanvas(64, 256);
		m64.fillRect(0, 0, 64, 256, 20, 20, 25, 255);
		for (let i = 0; i < 25; i++) {
			const y = 8 + i * 9;
			m64.clearRect(8, y, 48, 4);
			if (i < 24) {
				m64.clearRect(i % 2 === 0 ? 52 : 8, y, 4, 13);
			}
		}
		m64.clearRect(0, 8, 8, 4);

		const a64 = bakeAvatarFrameAlpha(m64.rgba, m64.width, m64.height);
		expect(alphaAt(a64, m64.width, 20, 10)).toBe(0);
		expect(alphaAt(a64, m64.width, 20, 226)).toBe(0);

		// 256x256 long 230px 25-turn 4px maze
		const m256 = createSyntheticCanvas(256, 256);
		m256.fillRect(0, 0, 256, 256, 20, 20, 25, 255);
		for (let i = 0; i < 25; i++) {
			const y = 8 + i * 9;
			m256.clearRect(8, y, 230, 4);
			if (i < 24) {
				m256.clearRect(i % 2 === 0 ? 234 : 8, y, 4, 13);
			}
		}
		m256.clearRect(0, 8, 8, 4);

		const a256 = bakeAvatarFrameAlpha(m256.rgba, m256.width, m256.height);
		expect(alphaAt(a256, m256.width, 20, 10)).toBe(0);
		expect(alphaAt(a256, m256.width, 20, 226)).toBe(0);
		expect(alphaAt(a256, m256.width, 230, 226)).toBe(0);
	});

	it.each([0.84, 0.86])(
		"fills an enclosed 4x4 hole inside a wall with alpha=%f without threshold discontinuity (Finding 2)",
		(wallAlphaFloat) => {
			const c = createSyntheticCanvas(128, 256);
			const wallA = Math.round(wallAlphaFloat * 255);
			c.fillRect(20, 20, 88, 100, 20, 20, 25, wallA);
			c.fillRect(20, 20, 15, 100, 20, 20, 25, 255);
			c.clearRect(60, 60, 4, 4);

			const alpha = bakeAvatarFrameAlpha(c.rgba, c.width, c.height);
			expect(alphaAt(alpha, c.width, 60, 60)).toBe(255);
			expect(alphaAt(alpha, c.width, 62, 62)).toBe(255);
		},
	);

	it.each([5, 6])(
		"fills an enclosed 4x4 hole invariants of directional sample count n=%d (Finding 3)",
		(dirCount) => {
			const c = createSyntheticCanvas(128, 256);
			c.fillRect(20, 20, 88, 100, 20, 20, 25, Math.round(0.84 * 255));
			c.fillRect(20, 20, 15, 100, 20, 20, 25, 255);
			const dirs: Array<[number, number]> = [
				[1, 0],
				[0, 1],
				[-1, 0],
				[0, -1],
				[1, 1],
				[-1, 1],
				[1, -1],
				[-1, -1],
			];
			for (const [dx, dy] of dirs.slice(0, dirCount)) {
				c.fillRect(62 + dx * 6 - 1, 62 + dy * 6 - 1, 3, 3, 20, 20, 25, 255);
			}
			c.clearRect(60, 60, 4, 4);

			const alpha = bakeAvatarFrameAlpha(c.rgba, c.width, c.height);
			expect(alphaAt(alpha, c.width, 60, 60)).toBe(255);
			expect(alphaAt(alpha, c.width, 61, 61)).toBe(255);
			expect(alphaAt(alpha, c.width, 62, 62)).toBe(255);
		},
	);

	it("removes a detached 8x8 island next to a larger 48x48 subject (Finding 4)", () => {
		const c = createSyntheticCanvas(128, 256);
		c.fillRect(20, 120, 48, 48, 235, 235, 235, 255);
		c.fillRect(61, 50, 8, 8, 235, 235, 235, 255);

		const alpha = bakeAvatarFrameAlpha(c.rgba, c.width, c.height);
		expect(alphaAt(alpha, c.width, 65, 54)).toBe(0);
		expect(alphaAt(alpha, c.width, 44, 144)).toBe(255);
	});

	it.each([128, 720])(
		"preserves a 2x2 component touching the subject at a single diagonal corner at width %d (Finding 5)",
		(width) => {
			const c = createSyntheticCanvas(width, 256);
			c.fillRect(40, 30, 24, 24, 20, 20, 25, 255);
			c.fillRect(64, 54, 2, 2, 20, 20, 25, 255);

			const alpha = bakeAvatarFrameAlpha(c.rgba, c.width, c.height);
			expect(alphaAt(alpha, c.width, 64, 54)).toBe(255);
			expect(alphaAt(alpha, c.width, 65, 55)).toBe(255);
		},
	);

	it("preserves connected 2x20 vertical lines and 2x2 45-degree diagonal lines while removing detached 2x20 islands", () => {
		// Connected 2x20 vertical line
		const vert = createSyntheticCanvas(128, 256);
		vert.fillRect(40, 0, 22, 10, 20, 20, 25, 255);
		vert.fillRect(50, 10, 2, 180, 20, 20, 25, 255);
		const vertA = bakeAvatarFrameAlpha(vert.rgba, vert.width, vert.height);
		for (const y of [10, 45, 100, 170]) {
			expect(alphaAt(vertA, vert.width, 50, y)).toBe(255);
		}

		// Connected 2x2 45-degree diagonal line (dark and bright)
		for (const [r, g, b] of [
			[20, 20, 25],
			[230, 230, 220],
		] as const) {
			const diag = createSyntheticCanvas(128, 256);
			diag.fillRect(50, 30, 24, 20, r, g, b, 255);
			for (let i = 0; i <= 19; i++) {
				diag.fillRect(61 + i, 50 + i, 2, 2, r, g, b, 255);
			}
			const diagA = bakeAvatarFrameAlpha(diag.rgba, diag.width, diag.height);
			expect(alphaAt(diagA, diag.width, 70, 59)).toBe(255);
		}

		// Detached 2x20 island alone
		const detAlone = createSyntheticCanvas(128, 256);
		detAlone.fillRect(61, 50, 2, 20, 20, 20, 25, 255);
		const detAloneA = bakeAvatarFrameAlpha(
			detAlone.rgba,
			detAlone.width,
			detAlone.height,
		);
		expect(alphaAt(detAloneA, detAlone.width, 61, 60)).toBe(0);

		// Detached 2x20 island alongside subject
		const detWithSub = createSyntheticCanvas(128, 256);
		detWithSub.fillRect(20, 120, 48, 48, 20, 20, 25, 255);
		detWithSub.fillRect(61, 50, 2, 20, 20, 20, 25, 255);
		const detWithSubA = bakeAvatarFrameAlpha(
			detWithSub.rgba,
			detWithSub.width,
			detWithSub.height,
		);
		expect(alphaAt(detWithSubA, detWithSub.width, 61, 60)).toBe(0);
	});

	it("fills 4x4 interior holes identically across dark, mid-gray, and bright colors and vertical positions while keeping exterior-connected 4px gaps transparent", () => {
		function evalHole(
			rgb: [number, number, number],
			patchTop: number,
			openToExterior = false,
		): [number, number, number, number] {
			const c = createSyntheticCanvas(128, 256);
			c.fillRect(40, patchTop, 48, 48, rgb[0], rgb[1], rgb[2], 255);
			const holeTop = patchTop + 20;
			c.clearRect(62, holeTop, 4, 4);
			if (openToExterior) {
				c.clearRect(62, patchTop, 4, 20);
			}
			const out = bakeAvatarFrameRgba(c.rgba, c.width, c.height);
			return pixelAt(out, c.width, 64, holeTop + 2);
		}

		const darkTop = evalHole([20, 20, 25], 30);
		const darkMid = evalHole([20, 20, 25], 70);
		const darkBot = evalHole([20, 20, 25], 140);
		expect(darkTop).toEqual([20, 20, 25, 255]);
		expect(darkMid).toEqual(darkTop);
		expect(darkBot).toEqual(darkTop);

		const grayTop = evalHole([68, 68, 68], 30);
		const grayMid = evalHole([68, 68, 68], 70);
		expect(grayTop).toEqual([68, 68, 68, 255]);
		expect(grayMid).toEqual(grayTop);

		const brightTop = evalHole([230, 230, 220], 30);
		const brightMid = evalHole([230, 230, 220], 70);
		expect(brightTop).toEqual([230, 230, 220, 255]);
		expect(brightMid).toEqual(brightTop);

		expect(evalHole([20, 20, 25], 30, true)[3]).toBe(0);
		expect(evalHole([230, 230, 220], 30, true)[3]).toBe(0);
	});

	it("preserves intentional detached star decoration (jina-anime idea 1.717s bbox x[209,250] y[164,210]) while removing matting shreds", () => {
		const c = createSyntheticCanvas(720, 1280);
		// Main character body
		c.fillRect(260, 120, 240, 900, 50, 44, 42, 255);
		// Intentional detached star decoration at bbox x[209,250] y[164,210]
		c.fillRect(212, 168, 34, 38, 238, 240, 106, 255);
		// Unwanted 1x17 semi-transparent matting shred
		c.fillRect(252, 632, 1, 17, 100, 10, 20, 35);
		// Unwanted 8x8 gray detached noise island
		c.fillRect(100, 100, 8, 8, 235, 235, 235, 255);

		const alpha = bakeAvatarFrameAlpha(c.rgba, c.width, c.height);
		// Star decoration center preserved
		expect(alphaAt(alpha, c.width, 229, 187)).toBe(255);
		// Unwanted matting shred and 8x8 noise removed
		expect(alphaAt(alpha, c.width, 252, 640)).toBe(0);
		expect(alphaAt(alpha, c.width, 104, 104)).toBe(0);
	});

	it("packs baked RGBA into color-top-alpha-bottom stacked frame", () => {
		const c = createSyntheticCanvas(4, 4);
		c.fillRect(1, 1, 2, 2, 120, 80, 40, 200);
		const packed = packStackedAlphaFrameRgba(c.rgba, 4, 4);
		expect(packed.length).toBe(4 * 8 * 4);
		expect(pixelAt(packed, 4, 1, 1)).toEqual([120, 80, 40, 255]);
		expect(pixelAt(packed, 4, 1, 5)).toEqual([200, 200, 200, 255]);
		expect(pixelAt(packed, 4, 0, 0)).toEqual([0, 0, 0, 255]);
		expect(pixelAt(packed, 4, 0, 4)).toEqual([0, 0, 0, 255]);
	});
});

describe("nva-alpha-bake topology, boundary, and contract counterexamples", () => {
	it("removes standalone 8x8, thin 2x200, low-alpha shred, and transparent frames when no eligible subject exists", () => {
		const empty = createSyntheticCanvas(64, 64);
		const emptyOut = bakeAvatarFrameRgba(empty.rgba, empty.width, empty.height);
		expect(emptyOut.every((v) => v === 0)).toBe(true);

		const lone8x8 = createSyntheticCanvas(64, 64);
		lone8x8.fillRect(28, 28, 8, 8, 235, 235, 235, 255);
		const lone8x8Out = bakeAvatarFrameRgba(
			lone8x8.rgba,
			lone8x8.width,
			lone8x8.height,
		);
		expect(lone8x8Out.every((v) => v === 0)).toBe(true);

		const loneThin = createSyntheticCanvas(64, 256);
		loneThin.fillRect(30, 10, 2, 200, 20, 20, 25, 255);
		const loneThinOut = bakeAvatarFrameRgba(
			loneThin.rgba,
			loneThin.width,
			loneThin.height,
		);
		expect(loneThinOut.every((v) => v === 0)).toBe(true);

		const loneShred = createSyntheticCanvas(64, 64);
		loneShred.fillRect(10, 10, 30, 30, 100, 180, 120, 35);
		const loneShredOut = bakeAvatarFrameRgba(
			loneShred.rgba,
			loneShred.width,
			loneShred.height,
		);
		expect(loneShredOut.every((v) => v === 0)).toBe(true);
	});

	it("does not resurrect ghost foreground inside deleted hollow ring noise islands or leak deleted island colors into subject holes", () => {
		// Standalone hollow 20x20 2px-walled ring must vanish completely (including its interior)
		const loneRing = createSyntheticCanvas(64, 64);
		loneRing.fillRect(20, 20, 20, 20, 220, 40, 40, 255);
		loneRing.clearRect(22, 22, 16, 16);
		const loneRingOut = bakeAvatarFrameRgba(
			loneRing.rgba,
			loneRing.width,
			loneRing.height,
		);
		expect(loneRingOut.every((v) => v === 0)).toBe(true);

		// Detached hollow 32x32 3px-walled ring next to a 48x48 subject
		const c = createSyntheticCanvas(128, 256);
		c.fillRect(20, 140, 48, 48, 20, 20, 25, 255);
		c.clearRect(36, 156, 16, 16);
		// Trapped magenta 4x4 noise speck inside the subject's enclosed hole
		c.fillRect(42, 162, 4, 4, 255, 0, 255, 255);
		// Rejected 32x32 3px-walled hollow ring in exterior
		c.fillRect(70, 30, 32, 32, 180, 220, 180, 255);
		c.clearRect(73, 33, 26, 26);

		const out = bakeAvatarFrameRgba(c.rgba, c.width, c.height);
		// Rejected ring wall and its interior must both be completely transparent and zeroed
		expect(pixelAt(out, c.width, 71, 31)).toEqual([0, 0, 0, 0]);
		expect(pixelAt(out, c.width, 86, 46)).toEqual([0, 0, 0, 0]);
		expect(pixelAt(out, c.width, 80, 40)).toEqual([0, 0, 0, 0]);

		// Subject's enclosed hole and trapped speck site must fill cleanly from subject color, not magenta
		expect(pixelAt(out, c.width, 38, 158)).toEqual([20, 20, 25, 255]);
		expect(pixelAt(out, c.width, 44, 164)).toEqual([20, 20, 25, 255]);
	});

	it("handles alpha threshold boundaries (16/17 and 127/128) and preserves semi-transparent connected strands", () => {
		const c = createSyntheticCanvas(128, 128);
		c.fillRect(20, 20, 48, 48, 40, 50, 60, 255);
		// Connected 1px semi-transparent strand (A=64, in overlap 17..127 and exposed to E)
		c.fillRect(68, 44, 18, 1, 40, 50, 60, 64);
		// Connected 1px threshold-17 strand (A=17 > 16) vs detached A=16 speck
		c.fillRect(68, 50, 10, 1, 40, 50, 60, 17);
		c.fillRect(90, 50, 6, 6, 40, 50, 60, 16);
		// Attached pocket closed by a 1px top bridge of A=127 (< 128, must stay open to E)
		// Connected to main body via left leg at x=20..29, y=68..89 while y=68..69 above bridge is open to E
		c.fillRect(20, 68, 10, 22, 40, 50, 60, 255);
		c.fillRect(30, 70, 10, 1, 40, 50, 60, 127);
		c.fillRect(40, 70, 10, 20, 40, 50, 60, 255);
		c.fillRect(30, 89, 10, 1, 40, 50, 60, 255);
		// Enclosed pocket at (35, 78) has top bridge A=127 (< 128), so E passes through

		for (const refineBoundary of [false, true]) {
			const out = bakeAvatarFrameRgba(c.rgba, c.width, c.height, {
				refineBoundary,
			});
			expect(pixelAt(out, c.width, 75, 44)).toEqual([40, 50, 60, 64]);
			expect(pixelAt(out, c.width, 72, 50)).toEqual([40, 50, 60, 17]);
			expect(pixelAt(out, c.width, 92, 52)).toEqual([0, 0, 0, 0]);
			expect(pixelAt(out, c.width, 35, 70)).toEqual([40, 50, 60, 127]);
			expect(pixelAt(out, c.width, 35, 78)[3]).toBe(0);
		}

		// Raise that single top bridge to A=128 -> must block E and fill pocket to A=255
		c.fillRect(30, 70, 10, 1, 40, 50, 60, 128);
		const closedOut = bakeAvatarFrameRgba(c.rgba, c.width, c.height);
		expect(pixelAt(closedOut, c.width, 35, 78)).toEqual([40, 50, 60, 255]);
	});

	it("does not leak 4-connected exterior background through 1px diagonal corners of an 8-connected wall", () => {
		const c = createSyntheticCanvas(128, 128);
		// Main body base + 1px diagonal-cornered diamond wall enclosing an interior cavity
		c.fillRect(20, 20, 40, 40, 90, 120, 150, 255);
		// Diamond cavity centered around (90, 40) attached to main body at x=59..86
		c.fillRect(60, 39, 25, 3, 90, 120, 150, 255);
		for (let d = 0; d <= 5; d++) {
			c.fillRect(85 + d, 40 - d, 1, 1, 90, 120, 150, 255);
			c.fillRect(85 + d, 40 + d, 1, 1, 90, 120, 150, 255);
			c.fillRect(95 - d, 40 - d, 1, 1, 90, 120, 150, 255);
			c.fillRect(95 - d, 40 + d, 1, 1, 90, 120, 150, 255);
		}
		const out = bakeAvatarFrameRgba(c.rgba, c.width, c.height);
		expect(pixelAt(out, c.width, 90, 40)).toEqual([90, 120, 150, 255]);
		expect(pixelAt(out, c.width, 90, 37)).toEqual([90, 120, 150, 255]);
		// Outside the diagonal wall remains transparent
		expect(pixelAt(out, c.width, 96, 40)).toEqual([0, 0, 0, 0]);
	});

	it("propagates nearest multi-color boundary RGB into enclosed holes without exterior bleed or row wraparound", () => {
		const c = createSyntheticCanvas(128, 128);
		// Left half crimson, right half cobalt
		c.fillRect(30, 30, 24, 48, 200, 30, 40, 255);
		c.fillRect(54, 30, 24, 48, 30, 60, 210, 255);
		// Enclosed 6x6 hole straddling the seam at x=51..56, y=50..55
		c.clearRect(51, 50, 6, 6);
		// Detached 8x8 island ending at right edge (127, 29), adjacent in linear memory to (0, 30)
		c.fillRect(120, 22, 8, 8, 255, 255, 0, 255);
		// Subject touches left edge at y=30 only via a separate test block at (0, 30)
		c.fillRect(0, 30, 30, 20, 200, 30, 40, 255);

		const out = bakeAvatarFrameRgba(c.rgba, c.width, c.height);
		// Left side of hole receives nearest crimson wall, right side receives nearest cobalt wall
		expect(pixelAt(out, c.width, 51, 52)).toEqual([200, 30, 40, 255]);
		expect(pixelAt(out, c.width, 56, 52)).toEqual([30, 60, 210, 255]);
		// Right-edge 8x8 island touching (127, 29) must NOT wrap around to (0, 30)
		expect(pixelAt(out, c.width, 127, 29)).toEqual([0, 0, 0, 0]);
		expect(pixelAt(out, c.width, 123, 25)).toEqual([0, 0, 0, 0]);
		expect(pixelAt(out, c.width, 0, 30)).toEqual([200, 30, 40, 255]);
	});

	it("preserves intentional detached decorations invariant of position, color, and scale while removing same-color noise", () => {
		for (const [starX, starY, starW, starH, rgb] of [
			[60, 950, 34, 38, [238, 240, 106]],
			[560, 220, 24, 24, [80, 200, 240]],
		] as const) {
			const c = createSyntheticCanvas(720, 1280);
			c.fillRect(240, 160, 220, 880, 50, 44, 42, 255);
			c.fillRect(starX, starY, starW, starH, rgb[0], rgb[1], rgb[2], 255);
			// Same-color small noise island and thin strip
			c.fillRect(100, 100, 10, 10, rgb[0], rgb[1], rgb[2], 255);
			c.fillRect(620, 600, 2, 120, rgb[0], rgb[1], rgb[2], 255);

			const alpha = bakeAvatarFrameAlpha(c.rgba, c.width, c.height);
			expect(
				alphaAt(
					alpha,
					c.width,
					starX + Math.floor(starW / 2),
					starY + Math.floor(starH / 2),
				),
			).toBe(255);
			expect(alphaAt(alpha, c.width, 105, 105)).toBe(0);
			expect(alphaAt(alpha, c.width, 620, 650)).toBe(0);
		}
	});

	it("keeps exact topology identical between refineBoundary false and true while correcting dark/green outer spill only when true", () => {
		const c = createSyntheticCanvas(128, 128);
		// Burgundy subject with 4x4 interior hole, 1px connected hair line, and 2x2 diagonal touch
		c.fillRect(30, 30, 40, 40, 72, 9, 16, 255);
		c.clearRect(48, 48, 4, 4);
		c.fillRect(50, 70, 1, 20, 72, 9, 16, 255);
		c.fillRect(70, 70, 2, 2, 72, 9, 16, 255);
		// Dark matte fringe at right outer edge (x=70, y=35..55)
		c.fillRect(70, 35, 1, 20, 8, 9, 14, 240);
		// Green matte spill fringe at left outer edge (x=29, y=35..55)
		c.fillRect(29, 35, 1, 20, 45, 130, 55, 160);

		const snapshot = new Uint8ClampedArray(c.rgba);
		const outFalse = bakeAvatarFrameRgba(c.rgba, c.width, c.height, {
			refineBoundary: false,
		});
		const outTrue = bakeAvatarFrameRgba(c.rgba, c.width, c.height, {
			refineBoundary: true,
		});

		// Input buffer must remain completely immutable
		expect(c.rgba).toEqual(snapshot);

		// Alpha channel must be byte-for-byte identical between refineBoundary false and true
		for (let i = 0; i < c.width * c.height; i++) {
			expect(outTrue[i * 4 + 3]).toBe(outFalse[i * 4 + 3]);
		}

		// Connected 1px line, 2x2 diagonal touch, and interior hole preserved identically
		expect(pixelAt(outTrue, c.width, 50, 85)).toEqual([72, 9, 16, 255]);
		expect(pixelAt(outTrue, c.width, 71, 71)).toEqual([72, 9, 16, 255]);
		expect(pixelAt(outTrue, c.width, 50, 50)).toEqual([72, 9, 16, 255]);

		// refineBoundary: false keeps original edge RGB untouched
		expect(pixelAt(outFalse, c.width, 70, 45)).toEqual([8, 9, 14, 240]);
		expect(pixelAt(outFalse, c.width, 29, 45)).toEqual([45, 130, 55, 160]);

		// refineBoundary: true moves dark fringe & green spill RGB toward burgundy interior while preserving alpha
		const refinedDark = pixelAt(outTrue, c.width, 70, 45);
		expect(refinedDark[3]).toBe(240);
		expect(refinedDark[0]).toBeGreaterThanOrEqual(60);
		expect(refinedDark[0]).toBeGreaterThan(refinedDark[2] * 3);

		const refinedGreen = pixelAt(outTrue, c.width, 29, 45);
		expect(refinedGreen[3]).toBe(160);
		expect(refinedGreen[1]).toBeLessThan(40);
		expect(refinedGreen[0]).toBeGreaterThan(refinedGreen[1] * 2);
	});

	it("validates dimensions and buffer lengths across all three APIs and supports Uint8Array, excess buffers, and output independence", () => {
		const validBuf = new Uint8Array(64 * 64 * 4);
		for (const badDim of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => bakeAvatarFrameRgba(validBuf, badDim, 64)).toThrow(
				RangeError,
			);
			expect(() => bakeAvatarFrameRgba(validBuf, 64, badDim)).toThrow(
				RangeError,
			);
			expect(() => bakeAvatarFrameAlpha(validBuf, badDim, 64)).toThrow(
				RangeError,
			);
			expect(() => packStackedAlphaFrameRgba(validBuf, 64, badDim)).toThrow(
				RangeError,
			);
		}

		// Overflow check
		expect(() =>
			bakeAvatarFrameRgba(validBuf, 1_000_000_000, 1_000_000_000),
		).toThrow(RangeError);

		// Short buffer check in all three functions
		const shortBuf = new Uint8ClampedArray(64 * 64 * 4 - 1);
		expect(() => bakeAvatarFrameRgba(shortBuf, 64, 64)).toThrow(RangeError);
		expect(() => bakeAvatarFrameAlpha(shortBuf, 64, 64)).toThrow(RangeError);
		expect(() => packStackedAlphaFrameRgba(shortBuf, 64, 64)).toThrow(
			RangeError,
		);

		// Uint8Array + trailing excess bytes + immutability + output independence
		const c = createSyntheticCanvas(40, 40);
		c.fillRect(5, 5, 30, 30, 120, 80, 40, 255);
		const excess = new Uint8Array(40 * 40 * 4 + 32);
		excess.set(c.rgba, 0);
		excess.fill(99, 40 * 40 * 4);
		const excessCopy = new Uint8Array(excess);

		const rgbaOut = bakeAvatarFrameRgba(excess, 40, 40);
		const alphaOut = bakeAvatarFrameAlpha(excess, 40, 40);
		const packedOut = packStackedAlphaFrameRgba(rgbaOut, 40, 40);

		expect(rgbaOut.length).toBe(40 * 40 * 4);
		expect(alphaOut.length).toBe(40 * 40);
		expect(packedOut.length).toBe(40 * 80 * 4);
		expect(excess).toEqual(excessCopy);

		rgbaOut[0] = 250;
		expect(excess[0]).toBe(0);
	});
});
