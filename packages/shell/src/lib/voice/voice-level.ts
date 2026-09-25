/**
 * Voice level of the TTS audio that is playing right now.
 *
 * A pre-baked NVA avatar has one looping talking clip, not a clip per
 * sentence. The naia.land Studio clip engine makes that loop look lip-synced
 * by measuring the RMS of the real audio every frame and showing the talking
 * clip only while the voice is above a threshold (idle clip, mouth closed, in
 * the pauses). The shell used to show the talking loop for the whole playback
 * span instead, so the mouth kept moving through every pause. This module gives
 * the shell the same per-frame audio level so the avatar renderer can gate the
 * talking clip the same way.
 *
 * The level is read from the audio data itself (PCM chunks or a WAV payload)
 * and looked up by the playback clock, so no Web Audio graph rewiring is
 * needed and the output device routing (setSinkId) stays untouched.
 */

/** Envelope window. 20 ms is finer than one video frame at 30 fps. */
export const VOICE_LEVEL_WINDOW_SEC = 0.02;

/** RMS per window over samples already normalised to [-1, 1] by `scale`. */
export function rmsEnvelope(
	samples: ArrayLike<number>,
	sampleRate: number,
	windowSec = VOICE_LEVEL_WINDOW_SEC,
	scale = 1,
): Float32Array {
	const size = Math.max(1, Math.round(sampleRate * windowSec));
	const count = Math.ceil(samples.length / size);
	const envelope = new Float32Array(count);
	for (let w = 0; w < count; w++) {
		const start = w * size;
		const end = Math.min(samples.length, start + size);
		let sum = 0;
		for (let i = start; i < end; i++) {
			const value = samples[i] * scale;
			sum += value * value;
		}
		envelope[w] = end > start ? Math.sqrt(sum / (end - start)) : 0;
	}
	return envelope;
}

/**
 * Envelope of the first channel of a 16-bit PCM RIFF/WAVE base64 payload.
 * Returns null for anything else (MP3, float WAV, broken header), which the
 * caller treats as "level unknown".
 */
export function wavEnvelope(
	audioBase64: string,
	windowSec = VOICE_LEVEL_WINDOW_SEC,
): Float32Array | null {
	try {
		const binary = atob(audioBase64);
		if (
			binary.length < 44 ||
			binary.slice(0, 4) !== "RIFF" ||
			binary.slice(8, 12) !== "WAVE"
		) {
			return null;
		}
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		const view = new DataView(bytes.buffer);
		let offset = 12;
		let format = 0;
		let channels = 0;
		let sampleRate = 0;
		let bits = 0;
		while (offset + 8 <= bytes.length) {
			const id = binary.slice(offset, offset + 4);
			const size = view.getUint32(offset + 4, true);
			const body = offset + 8;
			if (id === "fmt " && size >= 16 && body + 16 <= bytes.length) {
				format = view.getUint16(body, true);
				channels = view.getUint16(body + 2, true);
				sampleRate = view.getUint32(body + 4, true);
				bits = view.getUint16(body + 14, true);
			} else if (id === "data") {
				if (format !== 1 || bits !== 16 || channels < 1 || sampleRate <= 0)
					return null;
				const available = Math.min(size, Math.max(0, bytes.length - body));
				const frames = Math.floor(available / (2 * channels));
				const mono = new Int16Array(frames);
				for (let i = 0; i < frames; i++)
					mono[i] = view.getInt16(body + i * 2 * channels, true);
				return rmsEnvelope(mono, sampleRate, windowSec, 1 / 0x8000);
			}
			offset = body + size + (size % 2);
		}
		return null;
	} catch {
		return null;
	}
}

interface Segment {
	start: number;
	envelope: Float32Array;
	windowSec: number;
}

/**
 * Envelope segments placed on one playback clock (seconds). Time outside
 * every segment reads as silence (0).
 */
export class VoiceLevelTimeline {
	private segments: Segment[] = [];

	add(
		start: number,
		envelope: Float32Array,
		windowSec = VOICE_LEVEL_WINDOW_SEC,
	): void {
		if (envelope.length === 0) return;
		this.segments.push({ start, envelope, windowSec });
	}

	/**
	 * Levels from `time` to `time + aheadSec`, one per window. The audio is
	 * already decoded, so the avatar can see a pause coming instead of
	 * waiting it out (see `NvaAudioGate.processAhead`). The list stops where
	 * the scheduled audio ends: what comes after it is not known yet (the
	 * next chunk or sentence may follow at once), so it must not read as
	 * silence.
	 */
	levelsAhead(
		time: number,
		aheadSec: number,
		stepSec = VOICE_LEVEL_WINDOW_SEC,
	): number[] {
		const out: number[] = [];
		const end = this.end();
		const steps = Math.max(1, Math.ceil(aheadSec / stepSec));
		for (let i = 0; i <= steps; i++) {
			const at = time + i * stepSec;
			if (at >= end) break;
			out.push(this.levelAt(at));
		}
		return out;
	}

	/** End of the last scheduled segment on the clock (-Infinity if none). */
	private end(): number {
		let end = Number.NEGATIVE_INFINITY;
		for (const segment of this.segments)
			end = Math.max(
				end,
				segment.start + segment.envelope.length * segment.windowSec,
			);
		return end;
	}

	levelAt(time: number): number {
		// Forget segments that ended more than a second ago.
		while (this.segments.length > 0) {
			const first = this.segments[0];
			const end = first.start + first.envelope.length * first.windowSec;
			if (end + 1 >= time) break;
			this.segments.shift();
		}
		for (const segment of this.segments) {
			const index = Math.floor((time - segment.start) / segment.windowSec);
			if (index >= 0 && index < segment.envelope.length)
				return segment.envelope[index];
		}
		return 0;
	}

	clear(): void {
		this.segments = [];
	}
}

/** Level of a whole-payload envelope at `time` seconds (0 outside it). */
export function envelopeLevelAt(
	envelope: Float32Array,
	time: number,
	windowSec = VOICE_LEVEL_WINDOW_SEC,
): number {
	const index = Math.floor(time / windowSec);
	return index >= 0 && index < envelope.length ? envelope[index] : 0;
}

/**
 * Levels of a whole-payload envelope from `time` to `time + aheadSec`. The
 * list stops at the end of the payload: the next sentence may start right
 * after it, so the time past the end is unknown, not silent. (Reading it as
 * silence closed the mouth on every short pause between two sentences.)
 */
export function envelopeLevelsAhead(
	envelope: Float32Array,
	time: number,
	aheadSec: number,
	windowSec = VOICE_LEVEL_WINDOW_SEC,
): number[] {
	const out: number[] = [];
	const end = envelope.length * windowSec;
	const steps = Math.max(1, Math.ceil(aheadSec / windowSec));
	for (let i = 0; i <= steps; i++) {
		const at = Math.max(0, time) + i * windowSec;
		if (at >= end) break;
		out.push(envelopeLevelAt(envelope, at, windowSec));
	}
	return out;
}

/**
 * Levels ahead of `time` in the playing envelope and, past its end, in the
 * envelope of the sentence queued right after it (null = next unknown, the
 * list then stops at the end of the current one). Sentences play back to
 * back, so the pause between two sentences is the tail silence of one plus
 * the lead silence of the next; without the next envelope that pause could
 * only be waited out.
 */
export function envelopeLevelsAheadThen(
	current: Float32Array,
	time: number,
	aheadSec: number,
	next: Float32Array | null,
	windowSec = VOICE_LEVEL_WINDOW_SEC,
): number[] {
	const levels = envelopeLevelsAhead(current, time, aheadSec, windowSec);
	if (!next) return levels;
	const coveredSec = levels.length * windowSec;
	const restSec = aheadSec - coveredSec;
	if (restSec < 0) return levels;
	const nextStart = Math.max(0, time) + coveredSec - current.length * windowSec;
	return levels.concat(
		envelopeLevelsAhead(next, nextStart, restSec, windowSec),
	);
}

/**
 * How far `HTMLMediaElement.currentTime` may trail the wall clock before the
 * clock stops trusting the wall clock (a real stall, not a slow counter).
 */
export const MEDIA_CLOCK_MAX_LEAD_SEC = 0.25;

/**
 * Audible position of an `<audio>` element.
 *
 * Measured on WebKitGTK 2.52 (2026-09-25 lipsync probe, see
 * `.agents/work/naia-res/studio-impl/lipsync-lag-diagnosis-20260925.md`):
 * `currentTime` of a playing `<audio>` trails the sound actually coming out
 * by 60-170 ms and the amount changes from one playback to the next, while
 * the wall clock counted from the `playing` event matched the sound within a
 * frame. A mouth driven by `currentTime` therefore opened late by that much.
 *
 * This clock runs on the wall clock from the moment the element reports
 * `playing`, and falls back to `currentTime` whenever the two disagree the
 * other way (`currentTime` ahead: re-anchor on it) or by more than
 * `MEDIA_CLOCK_MAX_LEAD_SEC` (a real stall or buffering: follow the element).
 * Before `playing` has fired it reports `currentTime` unchanged.
 */
export class AudibleMediaClock {
	private anchorWallMs: number | null = null;
	private anchorMediaSec = 0;

	constructor(
		private readonly nowMs: () => number = () => performance.now(),
		private readonly maxLeadSec = MEDIA_CLOCK_MAX_LEAD_SEC,
	) {}

	/** Call from the element's `playing` event (and again after a resume). */
	playing(currentTime: number): void {
		this.anchorWallMs = this.nowMs();
		this.anchorMediaSec = Math.max(0, currentTime || 0);
	}

	/** Call from the element's `pause`, `waiting` or `ended` event. */
	halt(): void {
		this.anchorWallMs = null;
	}

	/** Audible position in seconds, given the element's `currentTime` now. */
	time(currentTime: number): number {
		const media = Math.max(0, currentTime || 0);
		if (this.anchorWallMs == null) return media;
		const wall =
			this.anchorMediaSec + (this.nowMs() - this.anchorWallMs) / 1000;
		if (media >= wall) {
			this.anchorWallMs = this.nowMs();
			this.anchorMediaSec = media;
			return media;
		}
		return Math.min(wall, media + this.maxLeadSec);
	}
}

/**
 * Time on an AudioContext clock of the sound leaving the speaker now.
 * `currentTime` is where the graph is rendering; the device plays that
 * `baseLatency + outputLatency` later (WebKitGTK 2.52 reports 0.0029 s and 0,
 * browsers with a real output latency report tens of ms).
 */
export function audibleContextTime(ctx: {
	currentTime: number;
	baseLatency?: number;
	outputLatency?: number;
}): number {
	return ctx.currentTime - (ctx.baseLatency || 0) - (ctx.outputLatency || 0);
}

/** Anything that can report the level of the audio it is playing now. */
export interface VoiceLevelSource {
	/** RMS of the audio playing now, or null when it cannot be measured. */
	voiceLevel(): number | null;
	/**
	 * Levels from now to `aheadSec` later, one per `VOICE_LEVEL_WINDOW_SEC`
	 * (index 0 = now). Optional: a source that cannot see ahead leaves it out
	 * and the avatar falls back to waiting out each pause. Null = unknown.
	 */
	voiceLevelsAhead?(aheadSec: number): number[] | null;
}

let activeSource: VoiceLevelSource | null = null;

/** The queue that just started audible playback becomes the level source. */
export function setActiveVoiceLevelSource(source: VoiceLevelSource): void {
	activeSource = source;
}

/** Drop the source only if it is still the active one. */
export function releaseVoiceLevelSource(source: VoiceLevelSource): void {
	if (activeSource === source) activeSource = null;
}

/** Level of whatever TTS audio is playing now, or null when unknown. */
export function readActiveVoiceLevel(): number | null {
	return activeSource ? activeSource.voiceLevel() : null;
}

/**
 * Levels of the active TTS audio from now to `aheadSec` later, or null when
 * nothing is playing or the source cannot look ahead.
 */
export function readActiveVoiceLevelsAhead(aheadSec: number): number[] | null {
	if (!activeSource?.voiceLevelsAhead) return null;
	return activeSource.voiceLevelsAhead(aheadSec);
}
