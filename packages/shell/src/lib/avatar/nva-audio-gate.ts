/**
 * Voice-activity gate for a pre-baked NVA talking loop.
 *
 * Same rule and defaults as the naia.land Studio clip engine
 * (`src/features/studio/audio-gate.ts`, threshold 0.015 RMS, 200 ms hold), so
 * one .nva avatar moves its mouth the same way on the web and in the shell:
 * the talking clip shows while the voice is above the threshold, and the idle
 * clip (mouth closed) returns after the voice has stayed below it for the hold
 * time.
 */
export const NVA_GATE_THRESHOLD = 0.015;
export const NVA_GATE_HOLD_MS = 200;
/**
 * Shell only: once the gate has closed, it stays closed at least this long.
 * A pause just over the hold time otherwise shows the idle clip for one or
 * two frames between two words. When the idle and talking clips are not
 * framed alike (head size, hair), that flash looks like the head jumping
 * (2026-09-25 IR recording: 71 of 205 idle stretches were under 250 ms).
 * The web engine has no such rule, so the default is 0.
 */
export const NVA_SHELL_MIN_IDLE_MS = 250;

export type NvaGateState = "idle" | "talking";

export class NvaAudioGate {
	private current: NvaGateState;
	private silenceMs = 0;
	private idleMs = 0;

	constructor(
		private readonly threshold = NVA_GATE_THRESHOLD,
		private readonly holdMs = NVA_GATE_HOLD_MS,
		initial: NvaGateState = "idle",
		private readonly minIdleMs = 0,
	) {
		this.current = initial;
		this.idleMs = Number.POSITIVE_INFINITY;
	}

	get state(): NvaGateState {
		return this.current;
	}

	process(rms: number, deltaMs: number): NvaGateState {
		const step = Math.max(0, deltaMs);
		if (this.current === "idle") {
			this.idleMs += step;
			if (rms >= this.threshold && this.idleMs >= this.minIdleMs) {
				this.silenceMs = 0;
				this.current = "talking";
			}
		} else if (rms >= this.threshold) {
			this.silenceMs = 0;
		} else {
			this.silenceMs += step;
			if (this.silenceMs >= this.holdMs) {
				this.current = "idle";
				this.idleMs = 0;
			}
		}
		return this.current;
	}

	reset(initial: NvaGateState = "idle"): void {
		this.current = initial;
		this.silenceMs = 0;
		// A reset starts a new utterance: the first word opens the mouth at once.
		this.idleMs = Number.POSITIVE_INFINITY;
	}
}
