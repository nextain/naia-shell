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

/** A stretch of measured audio placed on one playback clock (seconds). */
export interface LevelBlock {
	start: number;
	envelope: ArrayLike<number>;
}

/** What the time past the last known block is: real silence, or not known yet. */
export type LevelEdge = "silence" | "unknown";

/** Levels around one moment of playback, for `NvaAudioGate.processAround`. */
export interface LevelsAround {
	/** One level per envelope window, oldest first. */
	levels: number[];
	/** Index in `levels` of the window at the asked time (-1: not known). */
	now: number;
	/** Real time one window lasts: the window length divided by the playback rate. */
	stepMs: number;
}

/** How much the avatar wants to see around the audible moment (real seconds). */
export interface LevelsAroundQuery {
	/** Read this much after the sound leaving the speaker now (display lead). */
	leadSec: number;
	backSec: number;
	aheadSec: number;
}

/**
 * Levels of the windows around `time`, read from `blocks`.
 *
 * - Before the first block nothing is known (the list stops there).
 * - A gap between two blocks is silence. The caller places a block it only
 *   predicts (the sentence queued next) at the EARLIEST moment it can start,
 *   so a pause is never measured longer than it really is.
 * - Past the last block the time is `after`: silence once nothing more is
 *   coming, unknown while more audio may still arrive.
 *
 * Every window is sampled at `time ± k * windowSec` on the media clock, so
 * inside one block the samples land on consecutive envelope windows whatever
 * the video frame rate or phase is. `rate` is the playback rate: one window
 * lasts `windowSec / rate` of real time, and the real `backSec`/`aheadSec`
 * cover `rate` times as much media.
 */
export function levelsAround(
	blocks: readonly LevelBlock[],
	time: number,
	backSec: number,
	aheadSec: number,
	after: LevelEdge,
	rate = 1,
	windowSec = VOICE_LEVEL_WINDOW_SEC,
): LevelsAround {
	const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
	const stepMs = (windowSec * 1000) / r;
	const known = blocks
		.filter((b) => b.envelope.length > 0)
		.slice()
		.sort((a, b) => a.start - b.start);
	let lastEnd = Number.NEGATIVE_INFINITY;
	for (const b of known)
		lastEnd = Math.max(lastEnd, b.start + b.envelope.length * windowSec);
	const at = (t: number): number | undefined => {
		if (known.length === 0) return after === "silence" ? 0 : undefined;
		// Times on window edges come out of float sums; compare with slack.
		const eps = windowSec * 1e-6;
		if (t < known[0].start - eps) return undefined;
		for (const b of known) {
			const i = Math.floor((t - b.start + eps) / windowSec);
			if (i >= 0 && i < b.envelope.length) return b.envelope[i];
		}
		if (t >= lastEnd - eps) return after === "silence" ? 0 : undefined;
		return 0;
	};
	const current = at(time);
	if (current === undefined) return { levels: [], now: -1, stepMs };
	const backCount = Math.round((Math.max(0, backSec) * r) / windowSec);
	const aheadCount = Math.round((Math.max(0, aheadSec) * r) / windowSec);
	const past: number[] = [];
	for (let k = 1; k <= backCount; k++) {
		const level = at(time - k * windowSec);
		if (level === undefined) break;
		past.push(level);
	}
	const levels = past.reverse();
	const now = levels.length;
	levels.push(current);
	for (let k = 1; k <= aheadCount; k++) {
		const level = at(time + k * windowSec);
		if (level === undefined) break;
		levels.push(level);
	}
	return { levels, now, stepMs };
}

/**
 * Envelope segments placed on one playback clock (seconds). Time between or
 * after the segments reads as silence for the level now (`levelAt`); what the
 * gap past the last segment means for the time AHEAD is the caller's call
 * (see `levelsAround`).
 */
export class VoiceLevelTimeline {
	private segments: LevelBlock[] = [];

	add(start: number, envelope: Float32Array): void {
		if (envelope.length === 0) return;
		this.segments.push({ start, envelope });
	}

	/** Forget segments that ended more than `keepSec` before `time`. */
	private prune(time: number, keepSec = 2): void {
		while (this.segments.length > 0) {
			const first = this.segments[0];
			const end = first.start + first.envelope.length * VOICE_LEVEL_WINDOW_SEC;
			if (end + keepSec >= time) break;
			this.segments.shift();
		}
	}

	/** Segments still kept, in the order they were added. */
	blocks(time: number): readonly LevelBlock[] {
		this.prune(time);
		return this.segments;
	}

	/** End of the last scheduled segment (-Infinity if none). */
	end(): number {
		let end = Number.NEGATIVE_INFINITY;
		for (const s of this.segments)
			end = Math.max(end, s.start + s.envelope.length * VOICE_LEVEL_WINDOW_SEC);
		return end;
	}

	levelAt(time: number): number {
		this.prune(time);
		for (const s of this.segments) {
			const index = Math.floor((time - s.start) / VOICE_LEVEL_WINDOW_SEC);
			if (index >= 0 && index < s.envelope.length) return s.envelope[index];
		}
		return 0;
	}

	clear(): void {
		this.segments = [];
	}
}

/** Level of a whole-payload envelope at `time` seconds (0 outside it). */
export function envelopeLevelAt(
	envelope: ArrayLike<number>,
	time: number,
	windowSec = VOICE_LEVEL_WINDOW_SEC,
): number {
	const index = Math.floor(time / windowSec);
	return index >= 0 && index < envelope.length ? envelope[index] : 0;
}

/** Upper bound for a believable device latency (Bluetooth sits near 0.2-0.3 s). */
export const MAX_OUTPUT_LATENCY_SEC = 1;

/** The part of an AudioContext the latency function reads. */
export interface LatencyClock {
	currentTime?: number;
	baseLatency?: number;
	outputLatency?: number;
	getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number };
}

function finiteNonNegative(value: unknown): number {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Seconds between the moment an AudioContext renders a sample
 * (`currentTime`) and the moment the speaker plays it. The one function every
 * AudioContext-based "audible" time in the shell uses: the AudioQueue start
 * and audible timers and the avatar's voice-level clock.
 *
 * 1. `getOutputTimestamp()` when it gives a real reading: it reports the
 *    context time of the sample leaving the device at a performance time, so
 *    the delay is measured, not declared. Chromium/WebView2 and Safari fill
 *    it; an engine that returns zeros is skipped.
 * 2. Otherwise `baseLatency + outputLatency`. They are two consecutive stages
 *    (context to audio system, audio system to device), so they add up. Either
 *    may be missing (older WebKit has no `outputLatency`), 0 (WebKitGTK 2.52
 *    reports 0.0029 s and 0), or large (WebView2 commonly 0.02-0.15 s,
 *    Bluetooth 0.2-0.3 s).
 *
 * Capped at `MAX_OUTPUT_LATENCY_SEC` so a broken reading cannot push the
 * mouth seconds away from the voice.
 */
export function outputLatencySeconds(
	ctx: LatencyClock | null | undefined,
	nowMs: number = typeof performance !== "undefined" ? performance.now() : 0,
): number {
	if (!ctx) return 0;
	const current = finiteNonNegative(ctx.currentTime);
	try {
		const ts = ctx.getOutputTimestamp?.();
		const contextTime = finiteNonNegative(ts?.contextTime);
		const performanceTime = finiteNonNegative(ts?.performanceTime);
		if (current > 0 && contextTime > 0 && performanceTime > 0) {
			const heard = contextTime + Math.max(0, nowMs - performanceTime) / 1000;
			const measured = current - heard;
			if (measured >= 0 && measured <= MAX_OUTPUT_LATENCY_SEC) return measured;
		}
	} catch {
		// fall through to the declared latencies
	}
	return Math.min(
		MAX_OUTPUT_LATENCY_SEC,
		finiteNonNegative(ctx.baseLatency) + finiteNonNegative(ctx.outputLatency),
	);
}

/** Anything that can report the level of the audio it is playing now. */
export interface VoiceLevelSource {
	/** RMS of the audio playing now, or null when it cannot be measured. */
	voiceLevel(): number | null;
	/**
	 * Levels around the audible moment (see `LevelsAround`). Optional: a
	 * source that cannot see around leaves it out and the avatar waits out
	 * each pause. Null = the level cannot be measured (MP3, nothing played).
	 */
	voiceLevelsAround?(query: LevelsAroundQuery): LevelsAround | null;
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

/** Levels around the audible moment of the active TTS audio, or null. */
export function readActiveVoiceLevelsAround(
	query: LevelsAroundQuery,
): LevelsAround | null {
	if (!activeSource?.voiceLevelsAround) return null;
	return activeSource.voiceLevelsAround(query);
}
