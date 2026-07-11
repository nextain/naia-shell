import { describe, expect, it } from "vitest";
import { computePlaybackRate } from "../nva-sync-driver";

/**
 * P3 A/V 싱크 드라이버의 **비례제어 법칙** 단위 검증(결정론). drift=framePts−audioTime(ms).
 * drift>0=비디오 앞섬→rate<1(느리게), drift<0=뒤처짐→rate>1(빠르게), 데드밴드 안=1, [min,max] clamp.
 */
describe("nva-sync-driver computePlaybackRate — 비례제어", () => {
	it("데드밴드 안 = 1", () => {
		expect(computePlaybackRate(0)).toBe(1);
		expect(computePlaybackRate(10)).toBe(1); // |10| ≤ 12
		expect(computePlaybackRate(-11)).toBe(1);
	});
	it("비디오 앞섬(+) = 느리게(<1)", () => {
		expect(computePlaybackRate(50)).toBeCloseTo(1 - 0.8 * 0.05, 5); // 0.96
		expect(computePlaybackRate(50)).toBeLessThan(1);
	});
	it("비디오 뒤처짐(−) = 빠르게(>1)", () => {
		expect(computePlaybackRate(-50)).toBeCloseTo(1 + 0.8 * 0.05, 5); // 1.04
		expect(computePlaybackRate(-50)).toBeGreaterThan(1);
	});
	it("큰 drift = clamp", () => {
		expect(computePlaybackRate(1000)).toBe(0.85); // 1-0.8 = 0.2 → clamp 0.85
		expect(computePlaybackRate(-1000)).toBe(1.15);
	});
	it("NaN/비유한 = 1(안전)", () => {
		expect(computePlaybackRate(Number.NaN)).toBe(1);
		expect(computePlaybackRate(Number.POSITIVE_INFINITY)).toBe(1);
	});
	it("커스텀 게인/데드밴드/clamp", () => {
		expect(computePlaybackRate(100, { deadbandMs: 200 })).toBe(1); // 데드밴드 확대
		expect(computePlaybackRate(100, { gain: 2, minRate: 0.5 })).toBeCloseTo(
			1 - 2 * 0.1,
			5,
		); // 0.8
		expect(computePlaybackRate(100, { gain: 5, minRate: 0.7 })).toBe(0.7); // clamp
	});
	it("수렴 방향: 앞선 상태로 느려지면 다음 drift 는 줄어드는 부호", () => {
		// drift +100 → rate<1 → 비디오가 오디오 대비 느려져 drift 감소. rate<1 이 수렴 방향임을 확인.
		const r = computePlaybackRate(100);
		expect(r).toBeLessThan(1);
		expect(r).toBeGreaterThan(0.85); // clamp 안 걸린 비례 구간
	});
});
