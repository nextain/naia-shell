export const NVA_AI_GESTURE_MIN_INTERVAL_MS = 15_000;
export const NVA_AI_GESTURE_SAME_KEY_COOLDOWN_MS = 60_000;

/** Limits AI gestures while still allowing every manual button/shortcut use. */
export class NvaGestureRateLimiter {
	private lastGestureAt: number | null = null;
	private readonly lastGestureAtByKey = new Map<string, number>();

	canPlayAiAction(key: string, now = Date.now()): boolean {
		if (!key) return false;
		if (
			this.lastGestureAt !== null &&
			now - this.lastGestureAt < NVA_AI_GESTURE_MIN_INTERVAL_MS
		) {
			return false;
		}
		const sameKeyAt = this.lastGestureAtByKey.get(key);
		return (
			sameKeyAt === undefined ||
			now - sameKeyAt >= NVA_AI_GESTURE_SAME_KEY_COOLDOWN_MS
		);
	}

	/** Atomically reserve an allowed AI playback and start both cooldowns. */
	tryRecordAiAction(key: string, now = Date.now()): boolean {
		if (!this.canPlayAiAction(key, now)) return false;
		this.recordGesture(key, now);
		return true;
	}

	/** Manual playback is never blocked; it only informs the next AI decision. */
	recordManualAction(key: string, now = Date.now()): void {
		if (!key) return;
		this.recordGesture(key, now);
	}

	private recordGesture(key: string, now: number): void {
		this.lastGestureAt = now;
		for (const [previousKey, timestamp] of this.lastGestureAtByKey) {
			if (now - timestamp >= NVA_AI_GESTURE_SAME_KEY_COOLDOWN_MS)
				this.lastGestureAtByKey.delete(previousKey);
		}
		this.lastGestureAtByKey.set(key, now);
	}
}
