/**
 * Voice-activity gate for a pre-baked NVA talking loop.
 *
 * Same base threshold (0.015 RMS) as the naia.land Studio clip engine
 * (`src/features/studio/audio-gate.ts`): the talking clip shows while voice is
 * detected, and the idle clip (mouth closed) returns when speech ends.
 *
 * In the presentation recording (643s, 125 sentence ends), the median delay
 * from voice ending to mouth closing was 0.52s (IQR 0.43~0.55s). The cause was
 * that NvaAudioGate waited for 400ms (NVA_SHELL_HOLD_MS) of silence before
 * closing, plus 100ms switch crossfade. The 400ms hold remains essential to
 * prevent mouth snapping shut on short in-sentence pauses (breaths, commas).
 * Because TTS audio waveform is known ahead of playback (WAV envelope / buffered
 * PCM stream), lookahead eliminates the trailing lag without dropping in-sentence
 * hold: closing starts 50ms before voice ends (NVA_SHELL_CLOSE_LEAD_MS) so the
 * fade finishes right as sound ends, and opening starts 250ms early
 * (NVA_SHELL_OPEN_LEAD_MS) because post-LM-2 measurement showed mouth opening was median 0.11s slower than audio.
 */
export const NVA_GATE_THRESHOLD = 0.015;
/** Web (naia.land Studio clip engine) hold time. Unchanged. */
export const NVA_GATE_HOLD_MS = 200;
/** Shell hold time (ms) to keep mouth moving through short in-sentence pauses. */
export const NVA_SHELL_HOLD_MS = 400;
/** Lead time (ms) to open the gate early before audible voice begins (post-LM-2 measurement showed mouth opening was median 0.11s slower than audio). */
export const NVA_SHELL_OPEN_LEAD_MS = 250;
/** Lead time (ms) before silence to begin closing the gate (half of 100ms fade). */
export const NVA_SHELL_CLOSE_LEAD_MS = 50;

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

	process(
		rms: number,
		deltaMs: number,
		ahead?: (offsetSec: number) => number | null,
	): NvaGateState {
		if (ahead) {
			let hasNull = false;
			let allCloseSilent = true;
			const closeLeadSec = NVA_SHELL_CLOSE_LEAD_MS / 1000;
			const sampleIntervalSec = 0.02;
			const sampleCount = Math.round(NVA_SHELL_HOLD_MS / 20); // 20 samples (i = 0..19)

			for (let i = 0; i < sampleCount; i++) {
				const val = ahead(closeLeadSec + i * sampleIntervalSec);
				if (val === null) {
					hasNull = true;
					break;
				}
				if (val >= this.threshold) {
					allCloseSilent = false;
				}
			}

			if (!hasNull) {
				// 닫기 판정이 열기보다 우선: 마지막 50ms 동안 지금 샘플이 아직 커도 다시 열지 않음
				if (allCloseSilent) {
					this.current = "idle";
					this.silenceMs = 0;
					return this.current;
				}

				// 하나라도 문턱 이상이면 닫지 않음 (짧은 쉼). 지금 샘플만 보고 닫지 않음.
				// 열기 판정: 지금 크기 또는 NVA_SHELL_OPEN_LEAD_MS 뒤의 크기가 문턱 이상이면 talking
				const openLeadSec = NVA_SHELL_OPEN_LEAD_MS / 1000;
				const futureVal = ahead(openLeadSec);
				if (
					rms >= this.threshold ||
					(futureVal !== null && futureVal >= this.threshold)
				) {
					this.current = "talking";
					this.silenceMs = 0;
					return this.current;
				}

				if (this.current === "talking") {
					this.silenceMs = 0;
					return this.current;
				}
				return this.current;
			}
		}

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

	reset(initial: NvaGateState = "idle"): void {
		this.current = initial;
		this.silenceMs = 0;
	}
}
