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
