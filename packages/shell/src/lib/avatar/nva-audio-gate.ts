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

export type NvaGateState = "idle" | "talking";

export class NvaAudioGate {
	private current: NvaGateState;
	private silenceMs = 0;

	constructor(
		private readonly threshold = NVA_GATE_THRESHOLD,
		private readonly holdMs = NVA_GATE_HOLD_MS,
		initial: NvaGateState = "idle",
	) {
		this.current = initial;
	}

	get state(): NvaGateState {
		return this.current;
	}

	process(rms: number, deltaMs: number): NvaGateState {
		if (rms >= this.threshold) {
			this.silenceMs = 0;
			this.current = "talking";
		} else if (this.current === "talking") {
			this.silenceMs += Math.max(0, deltaMs);
			if (this.silenceMs >= this.holdMs) this.current = "idle";
		}
		return this.current;
	}

	reset(initial: NvaGateState = "idle"): void {
		this.current = initial;
		this.silenceMs = 0;
	}
}
