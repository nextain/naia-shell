export interface BakeAvatarFrameOptions {
	/**
	 * Whether to apply post-topology boundary color refinement
	 * (dark matte fringe and green/cyan spill correction on outer semi-transparent pixels).
	 * Defaults to true.
	 */
	refineBoundary?: boolean;
}

const BG_FLOOD_ALPHA_THRESHOLD = 128;
const FG_COMPONENT_ALPHA_THRESHOLD = 16;

const MAIN_SUBJECT_MIN_HIGH_ALPHA_AREA = 256;
const MAIN_SUBJECT_MIN_BBOX_SIDE = 10;
const MAIN_SUBJECT_MIN_CORE_SQUARE = 5;

const DETACHED_PROP_ALPHA_THRESHOLD = 200;
const DETACHED_PROP_MIN_HIGH_ALPHA_AREA = 400;
const DETACHED_PROP_MIN_BBOX_SIDE = 16;
const DETACHED_PROP_MIN_CORE_SQUARE = 8;
const DETACHED_PROP_MIN_FILL_RATIO = 0.15;
const DETACHED_PROP_MIN_MEAN_ALPHA = 180;

const BOUNDARY_REFINE_MAX_RADIUS = 6;
const MAX_PIXEL_COUNT = 0x7fffffff;

interface ComponentStats {
	id: number;
	area: number;
	countA128: number;
	countA200: number;
	sumAlpha: number;
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
	maxSq: number;
}

function validateFrameInputs(
	rgba: Uint8Array | Uint8ClampedArray,
	width: number,
	height: number,
	bufferName: string,
): { pixelCount: number; expectedLength: number } {
	if (!Number.isSafeInteger(width) || width <= 0) {
		throw new RangeError(`width (${width}) must be a positive safe integer`);
	}
	if (!Number.isSafeInteger(height) || height <= 0) {
		throw new RangeError(`height (${height}) must be a positive safe integer`);
	}
	const pixelCount = width * height;
	const expectedLength = pixelCount * 4;
	if (!Number.isSafeInteger(expectedLength) || pixelCount > MAX_PIXEL_COUNT) {
		throw new RangeError(
			`frame dimensions (${width}x${height}) exceed maximum supported pixel count`,
		);
	}
	if (!rgba || typeof rgba.length !== "number") {
		throw new TypeError(
			`${bufferName} must be a Uint8Array or Uint8ClampedArray`,
		);
	}
	if (rgba.length < expectedLength) {
		throw new RangeError(
			`${bufferName} buffer length (${rgba.length}) is smaller than width*height*4 (${expectedLength})`,
		);
	}
	return { pixelCount, expectedLength };
}

function floodExteriorBackground(
	rgba: Uint8Array | Uint8ClampedArray,
	width: number,
	height: number,
	queue: Int32Array,
	exterior: Uint8Array,
	adoptedFg: Uint8Array | null,
): void {
	exterior.fill(0);
	let tail = 0;

	const trySeed = (p: number) => {
		if (exterior[p]) return;
		const isBarrier =
			rgba[p * 4 + 3] >= BG_FLOOD_ALPHA_THRESHOLD &&
			(adoptedFg === null || adoptedFg[p] === 1);
		if (!isBarrier) {
			exterior[p] = 1;
			queue[tail++] = p;
		}
	};

	for (let x = 0; x < width; x++) {
		trySeed(x);
		if (height > 1) {
			trySeed((height - 1) * width + x);
		}
	}
	for (let y = 1; y < height - 1; y++) {
		trySeed(y * width);
		if (width > 1) {
			trySeed(y * width + (width - 1));
		}
	}

	let head = 0;
	while (head < tail) {
		const p = queue[head++];
		const x = p % width;
		const y = (p - x) / width;

		if (x > 0) {
			const np = p - 1;
			if (
				!exterior[np] &&
				(rgba[np * 4 + 3] < BG_FLOOD_ALPHA_THRESHOLD ||
					(adoptedFg !== null && adoptedFg[np] === 0))
			) {
				exterior[np] = 1;
				queue[tail++] = np;
			}
		}
		if (x + 1 < width) {
			const np = p + 1;
			if (
				!exterior[np] &&
				(rgba[np * 4 + 3] < BG_FLOOD_ALPHA_THRESHOLD ||
					(adoptedFg !== null && adoptedFg[np] === 0))
			) {
				exterior[np] = 1;
				queue[tail++] = np;
			}
		}
		if (y > 0) {
			const np = p - width;
			if (
				!exterior[np] &&
				(rgba[np * 4 + 3] < BG_FLOOD_ALPHA_THRESHOLD ||
					(adoptedFg !== null && adoptedFg[np] === 0))
			) {
				exterior[np] = 1;
				queue[tail++] = np;
			}
		}
		if (y + 1 < height) {
			const np = p + width;
			if (
				!exterior[np] &&
				(rgba[np * 4 + 3] < BG_FLOOD_ALPHA_THRESHOLD ||
					(adoptedFg !== null && adoptedFg[np] === 0))
			) {
				exterior[np] = 1;
				queue[tail++] = np;
			}
		}
	}
}

function computeSolidSquareSizes(
	rgba: Uint8Array | Uint8ClampedArray,
	width: number,
	height: number,
): Uint8Array {
	const sq = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		const rowOff = y * width;
		for (let x = 0; x < width; x++) {
			const p = rowOff + x;
			if (rgba[p * 4 + 3] >= BG_FLOOD_ALPHA_THRESHOLD) {
				if (x > 0 && y > 0) {
					const minPrev = Math.min(sq[p - 1], sq[p - width], sq[p - width - 1]);
					const nextSq = minPrev + 1;
					sq[p] = nextSq > 255 ? 255 : nextSq;
				} else {
					sq[p] = 1;
				}
			}
		}
	}
	return sq;
}

function labelForegroundComponents(
	rgba: Uint8Array | Uint8ClampedArray,
	width: number,
	height: number,
	sq: Uint8Array,
	queue: Int32Array,
	compId: Int32Array,
): ComponentStats[] {
	const components: ComponentStats[] = [
		{
			id: 0,
			area: 0,
			countA128: 0,
			countA200: 0,
			sumAlpha: 0,
			minX: 0,
			maxX: -1,
			minY: 0,
			maxY: -1,
			maxSq: 0,
		},
	];
	let nextId = 1;
	const pixelCount = width * height;

	for (let start = 0; start < pixelCount; start++) {
		if (
			compId[start] !== 0 ||
			rgba[start * 4 + 3] <= FG_COMPONENT_ALPHA_THRESHOLD
		) {
			continue;
		}
		const id = nextId++;
		compId[start] = id;
		let head = 0;
		let tail = 0;
		queue[tail++] = start;

		let area = 0;
		let countA128 = 0;
		let countA200 = 0;
		let sumAlpha = 0;
		const startX = start % width;
		const startY = (start - startX) / width;
		let minX = startX;
		let maxX = startX;
		let minY = startY;
		let maxY = startY;
		let maxSq = 0;

		while (head < tail) {
			const p = queue[head++];
			const px = p % width;
			const py = (p - px) / width;
			const a = rgba[p * 4 + 3];

			area++;
			sumAlpha += a;
			if (a >= BG_FLOOD_ALPHA_THRESHOLD) countA128++;
			if (a >= DETACHED_PROP_ALPHA_THRESHOLD) countA200++;
			if (sq[p] > maxSq) maxSq = sq[p];
			if (px < minX) minX = px;
			if (px > maxX) maxX = px;
			if (py < minY) minY = py;
			if (py > maxY) maxY = py;

			const yMin = py > 0 ? py - 1 : 0;
			const yMax = py + 1 < height ? py + 1 : height - 1;
			const xMin = px > 0 ? px - 1 : 0;
			const xMax = px + 1 < width ? px + 1 : width - 1;

			for (let ny = yMin; ny <= yMax; ny++) {
				const rowBase = ny * width;
				for (let nx = xMin; nx <= xMax; nx++) {
					const np = rowBase + nx;
					if (
						compId[np] === 0 &&
						rgba[np * 4 + 3] > FG_COMPONENT_ALPHA_THRESHOLD
					) {
						compId[np] = id;
						queue[tail++] = np;
					}
				}
			}
		}

		components.push({
			id,
			area,
			countA128,
			countA200,
			sumAlpha,
			minX,
			maxX,
			minY,
			maxY,
			maxSq,
		});
	}

	return components;
}

function selectAdoptedComponents(components: ComponentStats[]): {
	mainCompId: number;
	adopted: Uint8Array;
	hasRejectedOpaque: boolean;
} {
	const adopted = new Uint8Array(components.length);
	let mainComp: ComponentStats | null = null;

	for (let id = 1; id < components.length; id++) {
		const c = components[id];
		const bboxW = c.maxX - c.minX + 1;
		const bboxH = c.maxY - c.minY + 1;
		const minBbox = bboxW < bboxH ? bboxW : bboxH;

		const isMainEligible =
			c.countA128 >= MAIN_SUBJECT_MIN_HIGH_ALPHA_AREA &&
			minBbox >= MAIN_SUBJECT_MIN_BBOX_SIDE &&
			c.maxSq >= MAIN_SUBJECT_MIN_CORE_SQUARE;
		if (!isMainEligible) continue;

		if (
			mainComp === null ||
			c.area > mainComp.area ||
			(c.area === mainComp.area && c.countA128 > mainComp.countA128) ||
			(c.area === mainComp.area &&
				c.countA128 === mainComp.countA128 &&
				c.sumAlpha > mainComp.sumAlpha)
		) {
			mainComp = c;
		}
	}

	if (mainComp === null) {
		return { mainCompId: 0, adopted, hasRejectedOpaque: false };
	}

	adopted[mainComp.id] = 1;
	let hasRejectedOpaque = false;

	for (let id = 1; id < components.length; id++) {
		if (id === mainComp.id) continue;
		const c = components[id];
		const bboxW = c.maxX - c.minX + 1;
		const bboxH = c.maxY - c.minY + 1;
		const minBbox = bboxW < bboxH ? bboxW : bboxH;
		const fillRatio = c.area / (bboxW * bboxH);
		const meanAlpha = c.sumAlpha / c.area;

		const isIntentionalProp =
			c.countA200 >= DETACHED_PROP_MIN_HIGH_ALPHA_AREA &&
			minBbox >= DETACHED_PROP_MIN_BBOX_SIDE &&
			c.maxSq >= DETACHED_PROP_MIN_CORE_SQUARE &&
			fillRatio >= DETACHED_PROP_MIN_FILL_RATIO &&
			meanAlpha >= DETACHED_PROP_MIN_MEAN_ALPHA;

		if (isIntentionalProp) {
			adopted[id] = 1;
		} else if (c.countA128 > 0) {
			hasRejectedOpaque = true;
		}
	}

	return { mainCompId: mainComp.id, adopted, hasRejectedOpaque };
}

function propagateHoleColors(
	rgba: Uint8Array | Uint8ClampedArray,
	out: Uint8ClampedArray,
	width: number,
	height: number,
	isHole: Uint8Array,
	adoptedFg: Uint8Array,
	queue: Int32Array,
): void {
	const pixelCount = width * height;
	const srcPixel = new Int32Array(pixelCount);
	srcPixel.fill(-1);
	let tail = 0;

	for (let p = 0; p < pixelCount; p++) {
		if (adoptedFg[p] !== 1 || rgba[p * 4 + 3] < BG_FLOOD_ALPHA_THRESHOLD) {
			continue;
		}
		const x = p % width;
		const y = (p - x) / width;
		const touchesHole =
			(x > 0 && isHole[p - 1] === 1) ||
			(x + 1 < width && isHole[p + 1] === 1) ||
			(y > 0 && isHole[p - width] === 1) ||
			(y + 1 < height && isHole[p + width] === 1);
		if (touchesHole) {
			srcPixel[p] = p;
			queue[tail++] = p;
		}
	}

	let head = 0;
	while (head < tail) {
		const cur = queue[head++];
		const sIdx = srcPixel[cur];
		const x = cur % width;
		const y = (cur - x) / width;

		if (x > 0) {
			const np = cur - 1;
			if (isHole[np] === 1 && srcPixel[np] === -1) {
				srcPixel[np] = sIdx;
				queue[tail++] = np;
			}
		}
		if (x + 1 < width) {
			const np = cur + 1;
			if (isHole[np] === 1 && srcPixel[np] === -1) {
				srcPixel[np] = sIdx;
				queue[tail++] = np;
			}
		}
		if (y > 0) {
			const np = cur - width;
			if (isHole[np] === 1 && srcPixel[np] === -1) {
				srcPixel[np] = sIdx;
				queue[tail++] = np;
			}
		}
		if (y + 1 < height) {
			const np = cur + width;
			if (isHole[np] === 1 && srcPixel[np] === -1) {
				srcPixel[np] = sIdx;
				queue[tail++] = np;
			}
		}
	}

	for (let p = 0; p < pixelCount; p++) {
		if (isHole[p] !== 1) continue;
		const sIdx = srcPixel[p];
		const outOff = p * 4;
		if (sIdx >= 0) {
			const srcOff = sIdx * 4;
			out[outOff] = rgba[srcOff];
			out[outOff + 1] = rgba[srcOff + 1];
			out[outOff + 2] = rgba[srcOff + 2];
		}
		out[outOff + 3] = 255;
	}
}

function runComponentRefBfs(
	width: number,
	height: number,
	adoptedFg: Uint8Array,
	compId: Int32Array,
	queue: Int32Array,
	refPixel: Int32Array,
	initialTail: number,
): void {
	let head = 0;
	let tail = initialTail;
	for (
		let radius = 0;
		radius < BOUNDARY_REFINE_MAX_RADIUS && head < tail;
		radius++
	) {
		const levelEnd = tail;
		while (head < levelEnd) {
			const cur = queue[head++];
			const ref = refPixel[cur];
			const cid = compId[cur];
			const x = cur % width;
			const y = (cur - x) / width;

			if (x > 0) {
				const np = cur - 1;
				if (adoptedFg[np] === 1 && compId[np] === cid && refPixel[np] === -1) {
					refPixel[np] = ref;
					queue[tail++] = np;
				}
			}
			if (x + 1 < width) {
				const np = cur + 1;
				if (adoptedFg[np] === 1 && compId[np] === cid && refPixel[np] === -1) {
					refPixel[np] = ref;
					queue[tail++] = np;
				}
			}
			if (y > 0) {
				const np = cur - width;
				if (adoptedFg[np] === 1 && compId[np] === cid && refPixel[np] === -1) {
					refPixel[np] = ref;
					queue[tail++] = np;
				}
			}
			if (y + 1 < height) {
				const np = cur + width;
				if (adoptedFg[np] === 1 && compId[np] === cid && refPixel[np] === -1) {
					refPixel[np] = ref;
					queue[tail++] = np;
				}
			}
		}
	}
}

function hasEightNeighborMatching(
	width: number,
	height: number,
	x: number,
	y: number,
	buf: Uint8Array | Uint8ClampedArray,
	stride: number,
	offset: number,
	target: number,
): boolean {
	const yMin = y > 0 ? y - 1 : 0;
	const yMax = y + 1 < height ? y + 1 : height - 1;
	const xMin = x > 0 ? x - 1 : 0;
	const xMax = x + 1 < width ? x + 1 : width - 1;
	for (let ny = yMin; ny <= yMax; ny++) {
		const rowBase = ny * width;
		for (let nx = xMin; nx <= xMax; nx++) {
			if (buf[(rowBase + nx) * stride + offset] === target) {
				return true;
			}
		}
	}
	return false;
}

function markOuterSemiTransparentRim(
	out: Uint8ClampedArray,
	isHole: Uint8Array,
	width: number,
	height: number,
	ring1: Uint8Array,
	isOuterRim: Uint8Array,
): boolean {
	let hasOuterCandidate = false;
	for (let y = 0; y < height; y++) {
		const rowBase = y * width;
		for (let x = 0; x < width; x++) {
			const p = rowBase + x;
			const outA = out[p * 4 + 3];
			if (outA === 0) continue;
			if (hasEightNeighborMatching(width, height, x, y, out, 4, 3, 0)) {
				ring1[p] = 1;
				isOuterRim[p] = 1;
				if (outA < 255 && isHole[p] === 0) {
					hasOuterCandidate = true;
				}
			}
		}
	}

	for (let y = 0; y < height; y++) {
		const rowBase = y * width;
		for (let x = 0; x < width; x++) {
			const p = rowBase + x;
			const outA = out[p * 4 + 3];
			if (
				outA === 0 ||
				outA === 255 ||
				isHole[p] === 1 ||
				isOuterRim[p] === 1
			) {
				continue;
			}
			if (hasEightNeighborMatching(width, height, x, y, ring1, 1, 0, 1)) {
				isOuterRim[p] = 1;
				hasOuterCandidate = true;
			}
		}
	}
	return hasOuterCandidate;
}

function isCleanInteriorSeed(
	rgba: Uint8Array | Uint8ClampedArray,
	adoptedFg: Uint8Array,
	ring1: Uint8Array,
	width: number,
	height: number,
	x: number,
	y: number,
	p: number,
): boolean {
	if (adoptedFg[p] !== 1 || ring1[p] === 1 || rgba[p * 4 + 3] < 250) {
		return false;
	}
	if (x > 0 && (adoptedFg[p - 1] !== 1 || rgba[(p - 1) * 4 + 3] < 224)) {
		return false;
	}
	if (
		x + 1 < width &&
		(adoptedFg[p + 1] !== 1 || rgba[(p + 1) * 4 + 3] < 224)
	) {
		return false;
	}
	if (
		y > 0 &&
		(adoptedFg[p - width] !== 1 || rgba[(p - width) * 4 + 3] < 224)
	) {
		return false;
	}
	if (
		y + 1 < height &&
		(adoptedFg[p + width] !== 1 || rgba[(p + width) * 4 + 3] < 224)
	) {
		return false;
	}
	return true;
}

function findNearestInteriorRefPixels(
	rgba: Uint8Array | Uint8ClampedArray,
	width: number,
	height: number,
	ring1: Uint8Array,
	adoptedFg: Uint8Array,
	compId: Int32Array,
	queue: Int32Array,
): Int32Array {
	const pixelCount = width * height;
	const refPixel = new Int32Array(pixelCount);
	refPixel.fill(-1);
	let tail = 0;

	for (let y = 0; y < height; y++) {
		const rowBase = y * width;
		for (let x = 0; x < width; x++) {
			const p = rowBase + x;
			if (isCleanInteriorSeed(rgba, adoptedFg, ring1, width, height, x, y, p)) {
				refPixel[p] = p;
				queue[tail++] = p;
			}
		}
	}
	if (tail > 0) {
		runComponentRefBfs(width, height, adoptedFg, compId, queue, refPixel, tail);
	}

	let fallbackTail = 0;
	for (let p = 0; p < pixelCount; p++) {
		if (
			refPixel[p] === -1 &&
			adoptedFg[p] === 1 &&
			rgba[p * 4 + 3] >= BG_FLOOD_ALPHA_THRESHOLD
		) {
			refPixel[p] = p;
			queue[fallbackTail++] = p;
		}
	}
	if (fallbackTail > 0) {
		runComponentRefBfs(
			width,
			height,
			adoptedFg,
			compId,
			queue,
			refPixel,
			fallbackTail,
		);
	}
	return refPixel;
}

function correctBoundaryPixelSpill(
	rgba: Uint8Array | Uint8ClampedArray,
	out: Uint8ClampedArray,
	pixelIdx: number,
	refIdx: number,
): void {
	const outOff = pixelIdx * 4;
	const r = out[outOff];
	const g = out[outOff + 1];
	const b = out[outOff + 2];

	const refOff = refIdx * 4;
	const rr = rgba[refOff];
	const rg = rgba[refOff + 1];
	const rb = rgba[refOff + 2];

	const curLuma = 0.299 * r + 0.587 * g + 0.114 * b;
	const refLuma = 0.299 * rr + 0.587 * rg + 0.114 * rb;
	const lumaDrop = refLuma - curLuma;

	const curGreenExcess = g - (r > b ? r : b);
	const refGreenExcess = rg - (rr > rb ? rr : rb);
	const greenSpill = curGreenExcess - (refGreenExcess > 0 ? refGreenExcess : 0);

	const cyanG = g - r - (rg - rr);
	const cyanB = b - r - (rb - rr);
	const cyanSpill = cyanG < cyanB ? cyanG : cyanB;

	const hasDarkFringe = lumaDrop > 10 && curLuma < refLuma * 0.78;
	const hasGreenSpill = greenSpill > 8;
	const hasCyanSpill = cyanSpill > 10;
	if (!hasDarkFringe && !hasGreenSpill && !hasCyanSpill) return;

	const darkT = hasDarkFringe
		? Math.min(1, Math.max(0.5, lumaDrop / Math.max(refLuma * 0.6, 12)))
		: 0;
	const greenT = hasGreenSpill
		? Math.min(1, Math.max(0.5, greenSpill / 24))
		: 0;
	const cyanT = hasCyanSpill ? Math.min(1, Math.max(0.5, cyanSpill / 24)) : 0;
	const t = Math.max(darkT, greenT, cyanT);

	const nr = Math.round(r + (rr - r) * t);
	let ng = Math.round(g + (rg - g) * t);
	const nb = Math.round(b + (rb - b) * t);

	if (hasGreenSpill) {
		const maxAllowedG =
			(nr > nb ? nr : nb) + (refGreenExcess > 3 ? refGreenExcess : 3);
		if (ng > maxAllowedG) {
			ng = Math.round(maxAllowedG);
		}
	}

	out[outOff] = nr;
	out[outOff + 1] = ng;
	out[outOff + 2] = nb;
}

function refineOuterBoundaryRgb(
	rgba: Uint8Array | Uint8ClampedArray,
	out: Uint8ClampedArray,
	width: number,
	height: number,
	isHole: Uint8Array,
	adoptedFg: Uint8Array,
	compId: Int32Array,
	queue: Int32Array,
): void {
	const pixelCount = width * height;
	const ring1 = new Uint8Array(pixelCount);
	const isOuterRim = new Uint8Array(pixelCount);

	if (
		!markOuterSemiTransparentRim(out, isHole, width, height, ring1, isOuterRim)
	) {
		return;
	}

	const refPixel = findNearestInteriorRefPixels(
		rgba,
		width,
		height,
		ring1,
		adoptedFg,
		compId,
		queue,
	);

	for (let p = 0; p < pixelCount; p++) {
		if (isOuterRim[p] !== 1 || isHole[p] === 1) continue;
		const outA = out[p * 4 + 3];
		if (outA === 0 || outA === 255) continue;
		const ref = refPixel[p];
		if (ref >= 0) {
			correctBoundaryPixelSpill(rgba, out, p, ref);
		}
	}
}

/**
 * Pure function that computes the baked RGBA frame for an NVA avatar clip at
 * native resolution using exact O(N) connected-component topology, closed-hole
 * restoration with multi-source boundary color propagation, and optional outer
 * boundary color refinement.
 */
export function bakeAvatarFrameRgba(
	rgba: Uint8Array | Uint8ClampedArray,
	width: number,
	height: number,
	options?: BakeAvatarFrameOptions,
): Uint8ClampedArray {
	const { pixelCount, expectedLength } = validateFrameInputs(
		rgba,
		width,
		height,
		"rgba",
	);

	const out = new Uint8ClampedArray(expectedLength);
	const queue = new Int32Array(pixelCount);
	const exterior = new Uint8Array(pixelCount);

	// 1. Exact 4-connected exterior background BFS from canvas border (alpha < 128)
	floodExteriorBackground(rgba, width, height, queue, exterior, null);

	// 2. Compute core square sizes and label 8-connected foreground components (alpha > 16)
	const sq = computeSolidSquareSizes(rgba, width, height);
	const compId = new Int32Array(pixelCount);
	const components = labelForegroundComponents(
		rgba,
		width,
		height,
		sq,
		queue,
		compId,
	);

	// 3. Select eligible main subject and intentional detached decorations
	const { mainCompId, adopted, hasRejectedOpaque } =
		selectAdoptedComponents(components);
	if (mainCompId === 0) {
		return out;
	}

	const adoptedFg = new Uint8Array(pixelCount);
	for (let p = 0; p < pixelCount; p++) {
		const cid = compId[p];
		if (cid > 0 && adopted[cid] === 1) {
			adoptedFg[p] = 1;
		}
	}

	// Re-evaluate exterior reachability through rejected barriers so interiors of
	// deleted hollow noise rings never resurrect as ghost foreground.
	if (hasRejectedOpaque) {
		floodExteriorBackground(rgba, width, height, queue, exterior, adoptedFg);
	}

	// 4. Populate adopted foreground pixels and classify enclosed interior holes
	const isHole = new Uint8Array(pixelCount);
	let holeCount = 0;

	for (let p = 0; p < pixelCount; p++) {
		const off = p * 4;
		const a = rgba[off + 3];
		if (adoptedFg[p] === 1) {
			if (a >= BG_FLOOD_ALPHA_THRESHOLD || exterior[p] === 1) {
				out[off] = rgba[off];
				out[off + 1] = rgba[off + 1];
				out[off + 2] = rgba[off + 2];
				out[off + 3] = a;
			} else {
				isHole[p] = 1;
				holeCount++;
			}
		} else if (exterior[p] === 0) {
			isHole[p] = 1;
			holeCount++;
		}
	}

	if (holeCount > 0) {
		propagateHoleColors(rgba, out, width, height, isHole, adoptedFg, queue);
	}

	// 5. Optional outer semi-transparent boundary spill/fringe RGB refinement
	if (options?.refineBoundary !== false) {
		refineOuterBoundaryRgb(
			rgba,
			out,
			width,
			height,
			isHole,
			adoptedFg,
			compId,
			queue,
		);
	}

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
	const { pixelCount } = validateFrameInputs(
		bakedRgba,
		width,
		height,
		"bakedRgba",
	);
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
