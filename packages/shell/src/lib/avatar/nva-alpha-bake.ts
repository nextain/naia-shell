export interface BakeAvatarFrameOptions {
	/**
	 * Whether to apply post-topology boundary alpha/color refinement
	 * (dark fringe / cyan-orange spill removal and silhouette contour smoothing).
	 * Defaults to true.
	 */
	refineBoundary?: boolean;
}

/**
 * Pure function that computes the baked RGBA frame for an NVA avatar clip at
 * native resolution using exact connected-component topology.
 *
 * Step 2 stub (RED before Step 3 implementation): returns a copy of input RGBA.
 */
export function bakeAvatarFrameRgba(
	rgba: Uint8Array | Uint8ClampedArray,
	width: number,
	height: number,
	_options?: BakeAvatarFrameOptions,
): Uint8ClampedArray {
	const expectedLength = width * height * 4;
	if (rgba.length < expectedLength) {
		throw new RangeError(
			`rgba buffer length (${rgba.length}) is smaller than width*height*4 (${expectedLength})`,
		);
	}
	const out = new Uint8ClampedArray(expectedLength);
	out.set(rgba.subarray(0, expectedLength));
	return out;
}

/**
 * Pure function that computes the baked alpha channel (width * height bytes)
 * from an input RGBA buffer at native resolution.
 */
export function bakeAvatarFrameAlpha(
	rgba: Uint8Array | Uint8ClampedArray,
	width: number,
	height: number,
	options?: BakeAvatarFrameOptions,
): Uint8Array {
	const baked = bakeAvatarFrameRgba(rgba, width, height, options);
	const pixelCount = width * height;
	const alpha = new Uint8Array(pixelCount);
	for (let i = 0; i < pixelCount; i++) {
		alpha[i] = baked[i * 4 + 3];
	}
	return alpha;
}

/**
 * Packs a baked RGBA frame (width x height) into a color-top-alpha-bottom
 * stacked RGBA buffer (width x (height * 2)) for encoding `.stacked.mp4`.
 */
export function packStackedAlphaFrameRgba(
	bakedRgba: Uint8Array | Uint8ClampedArray,
	width: number,
	height: number,
): Uint8ClampedArray {
	const pixelCount = width * height;
	const out = new Uint8ClampedArray(pixelCount * 2 * 4);
	for (let i = 0; i < pixelCount; i++) {
		const srcOff = i * 4;
		const a = bakedRgba[srcOff + 3];
		const topOff = i * 4;
		if (a > 0) {
			out[topOff] = bakedRgba[srcOff];
			out[topOff + 1] = bakedRgba[srcOff + 1];
			out[topOff + 2] = bakedRgba[srcOff + 2];
		}
		out[topOff + 3] = 255;

		const botOff = (pixelCount + i) * 4;
		out[botOff] = a;
		out[botOff + 1] = a;
		out[botOff + 2] = a;
		out[botOff + 3] = 255;
	}
	return out;
}
