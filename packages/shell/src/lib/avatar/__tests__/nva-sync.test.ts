import { describe, expect, it } from "vitest";
import { bboxToPx } from "../nva-core";
import { SyncMeter, syncDecision } from "../nva-sync";

describe("nva-sync SyncMeter — drift 백분위 통계", () => {
	it("빈 미터 = 0", () => {
		expect(new SyncMeter().stats()).toMatchObject({ n: 0, p95: 0, max: 0 });
	});
	it("|drift| 백분위 + 부호평균", () => {
		const m = new SyncMeter();
		for (const v of [10, -20, 30, -5, 100]) m.record(v);
		const s = m.stats();
		expect(s.n).toBe(5);
		expect(s.max).toBe(100);
		expect(s.meanAbs).toBeCloseTo((10 + 20 + 30 + 5 + 100) / 5, 5);
		expect(s.meanSigned).toBeCloseTo((10 - 20 + 30 - 5 + 100) / 5, 5); // = 23
		expect(s.p50).toBeGreaterThan(0);
	});
});

describe("nva-sync syncDecision — draw/skip/wait (seek 없이 판정만)", () => {
	it("근접 = draw", () => {
		expect(syncDecision(1000, 1000)).toBe("draw");
		expect(syncDecision(1050, 1000)).toBe("draw"); // 50ms 앞섬 < 80
	});
	it("비디오가 너무 앞섬 = wait", () => {
		expect(syncDecision(1200, 1000)).toBe("wait"); // +200 > 80
	});
	it("비디오가 너무 뒤처짐 = skip", () => {
		expect(syncDecision(800, 1000)).toBe("skip"); // -200 < -80
	});
	it("임계 커스텀", () => {
		expect(syncDecision(1120, 1000, { skipAheadMs: 150 })).toBe("draw"); // +120 < 150
	});
});

describe("nva-core bboxToPx — face_bbox → 캔버스 픽셀", () => {
	it("[x,y,l] 정사각", () => {
		expect(bboxToPx([0.1, 0.2, 0.5], 400, 800)).toEqual([40, 160, 200, 200]); // side=0.5*400
	});
	it("[x,y,w,h] 직사각", () => {
		expect(bboxToPx([0.1, 0.1, 0.8, 0.4], 400, 800)).toEqual([
			40, 80, 320, 320,
		]);
	});
});
