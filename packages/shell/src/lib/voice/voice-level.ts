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

/** Anything that can report the level of the audio it is playing now. */
export interface VoiceLevelSource {
	/** RMS of the audio playing now, or null when it cannot be measured. */
	voiceLevel(): number | null;
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
