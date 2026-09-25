/**
 * Voice-activity gate for a pre-baked NVA talking loop.
 *
 * Same rule and threshold as the naia.land Studio clip engine
 * (`src/features/studio/audio-gate.ts`, threshold 0.015 RMS): the talking
 * clip shows while the voice is above the threshold, and the idle clip
 * (mouth closed) returns after the voice has stayed below it for the hold
 * time. The hold time itself differs by surface — see `NVA_GATE_HOLD_MS` and
 * `NVA_SHELL_HOLD_MS` below.
 */
export const NVA_GATE_THRESHOLD = 0.015;
/** Web (naia.land Studio clip engine) hold time. Unchanged. */
export const NVA_GATE_HOLD_MS = 200;
/**
 * Shell only: hold time before the gate closes (talking clip → idle clip).
 * Longer than the web's 200 ms so a pause inside a sentence (breath, comma)
 * keeps the mouth moving instead of snapping shut and reopening a fraction
 * of a second later — the "발음을 하다가 입을 탁 닫아버리는" effect Luke flagged
 * after the 2026-09-25 IR recording (take 2).
 *
 * An earlier fix (`NVA_SHELL_MIN_IDLE_MS`, 2026-09-25) instead kept the gate
 * closed for a minimum time once it *had* closed, which stopped the closed
 * clip from flashing for only a few frames but still let it close early on a
 * short in-sentence pause, so the first syllable after that pause still came
 * out of a closed mouth. Raising the hold time itself avoids closing on a
 * short pause in the first place, so that minimum-closed rule is gone.
 *
 * Value: measured from take2's own silence-gap distribution (RMS over
 * 20 ms windows, the same 0.015 threshold, `nextain-ir-0924-deck-luke-avatar-
 * 0925c-slides-app-20260925-take2.mp4`, 646.9 s / 968 gaps). Gap lengths are
 * not smoothly spread: about 85 % of gaps are under ~380 ms (breath/comma
 * pauses inside a sentence and between words), the population thins out
 * sharply from there, and a second cluster of longer gaps (sentence
 * boundaries, then page turns at ~1.0-1.5 s) starts back up past ~640 ms.
 * 400 ms sits just past the short-pause tail (85th percentile ≈ 380 ms) and
 * inside that thin stretch, so it keeps the mouth moving through nearly all
 * in-sentence pauses while still closing well before the next sentence or
 * page.
 */
export const NVA_SHELL_HOLD_MS = 400;

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
		const step = Math.max(0, deltaMs);
		if (this.current === "idle") {
			if (rms >= this.threshold) {
				this.silenceMs = 0;
				this.current = "talking";
			}
		} else if (rms >= this.threshold) {
			this.silenceMs = 0;
		} else {
			this.silenceMs += step;
			if (this.silenceMs >= this.holdMs) {
				this.current = "idle";
			}
		}
		return this.current;
	}

	/**
	 * Same rule, judged on the audio clock alone (shell, levels known around
	 * the audible moment). `levels[now]` is the window playing now; the entries
	 * before it are the windows already heard and the ones after it the windows
	 * still to come, each lasting `stepMs`. The list stops where the level is
	 * not known (before the audio started, or audio not synthesized yet).
	 *
	 * A pause is measured as the run of silent windows through `now`: the
	 * silent windows behind it, this one, and the silent windows ahead of it.
	 * The mouth closes when that run reaches the hold time and stays open while
	 * it is shorter. When the run reaches an end of the list without meeting
	 * voice, the part beyond is not known, so a run still under the hold keeps
	 * the current state; as the pause goes on, the windows behind it grow until
	 * they alone reach the hold.
	 *
	 * No frame time enters the count. The earlier `processAhead` added the
	 * frame deltas of the silence already passed to 20 ms windows of the
	 * silence to come, so at 30 fps or 24 fps the two could add up past the
	 * hold on a pause shorter than it (2026-09-25 review, hole 1).
	 */
	processAround(
		levels: ArrayLike<number>,
		now: number,
		stepMs: number,
	): NvaGateState {
		if (!(now >= 0 && now < levels.length)) return this.current;
		this.silenceMs = 0;
		if (levels[now] >= this.threshold) {
			this.current = "talking";
			return this.current;
		}
		if (this.current === "idle") return this.current;
		let run = 1;
		for (let i = now - 1; i >= 0 && levels[i] < this.threshold; i--) run++;
		for (let i = now + 1; i < levels.length && levels[i] < this.threshold; i++)
			run++;
		if (run * stepMs >= this.holdMs) this.current = "idle";
		return this.current;
	}

	reset(initial: NvaGateState = "idle"): void {
		this.current = initial;
		this.silenceMs = 0;
	}
}
