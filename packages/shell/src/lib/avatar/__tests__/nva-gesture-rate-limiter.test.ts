import { describe, expect, it } from "vitest";
import {
	NVA_AI_GESTURE_MIN_INTERVAL_MS,
	NVA_AI_GESTURE_SAME_KEY_COOLDOWN_MS,
	NvaGestureRateLimiter,
} from "../nva-gesture-rate-limiter";

describe("NvaGestureRateLimiter", () => {
	it("sets the minimum interval and same-key cooldown as explicit constants", () => {
		expect(NVA_AI_GESTURE_MIN_INTERVAL_MS).toBe(15_000);
		expect(NVA_AI_GESTURE_SAME_KEY_COOLDOWN_MS).toBe(60_000);
	});

	it("limits all AI gestures to one playback per minimum interval", () => {
		const limiter = new NvaGestureRateLimiter();
		expect(limiter.tryRecordAiAction("wave", 0)).toBe(true);
		expect(limiter.tryRecordAiAction("cheer", 14_999)).toBe(false);
		expect(limiter.tryRecordAiAction("cheer", 15_000)).toBe(true);
	});

	it("holds the same key for the full cooldown, even after another action", () => {
		const limiter = new NvaGestureRateLimiter();
		expect(limiter.tryRecordAiAction("wave", 0)).toBe(true);
		expect(limiter.tryRecordAiAction("cheer", 15_000)).toBe(true);
		expect(limiter.tryRecordAiAction("wave", 59_999)).toBe(false);
		expect(limiter.tryRecordAiAction("wave", 60_000)).toBe(true);
	});

	it("records manual actions for AI cooldowns without limiting manual use", () => {
		const limiter = new NvaGestureRateLimiter();
		limiter.recordManualAction("wave", 0);
		limiter.recordManualAction("wave", 1);
		expect(limiter.tryRecordAiAction("wave", 15_001)).toBe(false);
		expect(limiter.tryRecordAiAction("cheer", 15_001)).toBe(true);
	});

	it("rejects an empty action key", () => {
		const limiter = new NvaGestureRateLimiter();
		expect(limiter.canPlayAiAction("", 0)).toBe(false);
		expect(limiter.tryRecordAiAction("", 0)).toBe(false);
	});
});
