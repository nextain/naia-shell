/**
 * Real-time Microsoft Azure AI Speech Viseme ID (0..21) -> Naia Avatar Lip-Sync
 * converter, AudioPlaybackClock timeline driver, NVA SpeechPlan builder, and
 * deterministic PCM16 / Web Audio amplitude fallback analyzer.
 */

import type { SpeechClock } from "../avatar/nva-speech/speech-timing";
import {
	type SpeechPlan,
	type SpeechPlanEvent,
	type SpeechUnit,
	normalizeShortSpeechEvents,
	validateSpeechPlan,
} from "../avatar/nva-speech/vendor/speech-plan.js";

/** Microsoft Speech SDK Viseme ID range (`0` = silence, `1..21` = phonemes). */
export type AzureVisemeId =
	| 0
	| 1
	| 2
	| 3
	| 4
	| 5
	| 6
	| 7
	| 8
	| 9
	| 10
	| 11
	| 12
	| 13
	| 14
	| 15
	| 16
	| 17
	| 18
	| 19
	| 20
	| 21;

/** Canonical VRM 1.0 / 0.x vowel expression blendshape weights (`[0..1]`). */
export interface VrmMouthWeights {
	aa: number;
	ih: number;
	ou: number;
	ee: number;
	oh: number;
}

/** Static mouth pose specification for one Microsoft Viseme ID (`0..21`). */
export interface AzureVisemeSpec {
	readonly visemeId: AzureVisemeId;
	/** Representative IPA / ARPAbet phoneme group per Azure Speech docs. */
	readonly phonemes: string;
	/** Primary mouth opening `[0..1]` (`ParamMouthOpenY` / procedural jaw). */
	readonly mouthOpen: number;
	/** Mouth corner spread/round `[-1..1]` (`ParamMouthForm`: +spread, -round). */
	readonly live2dMouthForm: number;
	/** Whether this viseme represents active speech articulation (`false` only for `0`). */
	readonly talking: boolean;
	/** Canonical 13-unit NVA `SpeechUnit` mapping. */
	readonly nvaUnit: SpeechUnit;
	/** VRM vowel blendshape weights. */
	readonly vrmWeights: Readonly<VrmMouthWeights>;
}

/**
 * Authoritative 22-entry (`0..21`) Microsoft Azure Speech Viseme lookup table
 * calibrated for Naia VRM, Live2D, and NVA 13-unit avatars.
 */
export const AZURE_VISEME_TABLE: readonly AzureVisemeSpec[] = [
	{
		visemeId: 0,
		phonemes: "sil",
		mouthOpen: 0,
		live2dMouthForm: 0,
		talking: false,
		nvaUnit: "sil",
		vrmWeights: { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 },
	},
	{
		visemeId: 1,
		phonemes: "ae, ax, ah",
		mouthOpen: 0.78,
		live2dMouthForm: 0.2,
		talking: true,
		nvaUnit: "vowel-open",
		vrmWeights: { aa: 0.8, ih: 0, ou: 0, ee: 0.15, oh: 0.05 },
	},
	{
		visemeId: 2,
		phonemes: "aa",
		mouthOpen: 0.92,
		live2dMouthForm: 0,
		talking: true,
		nvaUnit: "vowel-open",
		vrmWeights: { aa: 0.95, ih: 0, ou: 0, ee: 0, oh: 0.1 },
	},
	{
		visemeId: 3,
		phonemes: "ao",
		mouthOpen: 0.76,
		live2dMouthForm: -0.45,
		talking: true,
		nvaUnit: "vowel-round",
		vrmWeights: { aa: 0.25, ih: 0, ou: 0.15, ee: 0, oh: 0.85 },
	},
	{
		visemeId: 4,
		phonemes: "ey, eh, uh",
		mouthOpen: 0.58,
		live2dMouthForm: 0.35,
		talking: true,
		nvaUnit: "vowel-mid",
		vrmWeights: { aa: 0.2, ih: 0.15, ou: 0, ee: 0.72, oh: 0 },
	},
	{
		visemeId: 5,
		phonemes: "er",
		mouthOpen: 0.48,
		live2dMouthForm: -0.1,
		talking: true,
		nvaUnit: "vowel-mid",
		vrmWeights: { aa: 0.15, ih: 0.1, ou: 0.25, ee: 0.35, oh: 0.2 },
	},
	{
		visemeId: 6,
		phonemes: "y, iy, ih, ix",
		mouthOpen: 0.38,
		live2dMouthForm: 0.65,
		talking: true,
		nvaUnit: "vowel-spread",
		vrmWeights: { aa: 0, ih: 0.88, ou: 0, ee: 0.25, oh: 0 },
	},
	{
		visemeId: 7,
		phonemes: "w, uw",
		mouthOpen: 0.36,
		live2dMouthForm: -0.75,
		talking: true,
		nvaUnit: "vowel-round",
		vrmWeights: { aa: 0, ih: 0, ou: 0.92, ee: 0, oh: 0.15 },
	},
	{
		visemeId: 8,
		phonemes: "ow",
		mouthOpen: 0.68,
		live2dMouthForm: -0.55,
		talking: true,
		nvaUnit: "vowel-round",
		vrmWeights: { aa: 0.1, ih: 0, ou: 0.25, ee: 0, oh: 0.88 },
	},
	{
		visemeId: 9,
		phonemes: "aw",
		mouthOpen: 0.82,
		live2dMouthForm: -0.15,
		talking: true,
		nvaUnit: "vowel-open",
		vrmWeights: { aa: 0.72, ih: 0, ou: 0.2, ee: 0, oh: 0.35 },
	},
	{
		visemeId: 10,
		phonemes: "oy",
		mouthOpen: 0.64,
		live2dMouthForm: -0.3,
		talking: true,
		nvaUnit: "vowel-round",
		vrmWeights: { aa: 0.1, ih: 0.3, ou: 0.15, ee: 0, oh: 0.72 },
	},
	{
		visemeId: 11,
		phonemes: "ay",
		mouthOpen: 0.84,
		live2dMouthForm: 0.25,
		talking: true,
		nvaUnit: "vowel-open",
		vrmWeights: { aa: 0.78, ih: 0.25, ou: 0, ee: 0.15, oh: 0 },
	},
	{
		visemeId: 12,
		phonemes: "h",
		mouthOpen: 0.34,
		live2dMouthForm: 0,
		talking: true,
		nvaUnit: "glottal",
		vrmWeights: { aa: 0.28, ih: 0.08, ou: 0, ee: 0.12, oh: 0.05 },
	},
	{
		visemeId: 13,
		phonemes: "r",
		mouthOpen: 0.32,
		live2dMouthForm: -0.25,
		talking: true,
		nvaUnit: "postalveolar",
		vrmWeights: { aa: 0.05, ih: 0.1, ou: 0.38, ee: 0.1, oh: 0.2 },
	},
	{
		visemeId: 14,
		phonemes: "l",
		mouthOpen: 0.35,
		live2dMouthForm: 0.15,
		talking: true,
		nvaUnit: "alveolar",
		vrmWeights: { aa: 0.2, ih: 0.25, ou: 0, ee: 0.2, oh: 0 },
	},
	{
		visemeId: 15,
		phonemes: "s, z",
		mouthOpen: 0.18,
		live2dMouthForm: 0.45,
		talking: true,
		nvaUnit: "alveolar",
		vrmWeights: { aa: 0, ih: 0.45, ou: 0, ee: 0.15, oh: 0 },
	},
	{
		visemeId: 16,
		phonemes: "sh, ch, jh, zh",
		mouthOpen: 0.26,
		live2dMouthForm: -0.35,
		talking: true,
		nvaUnit: "postalveolar",
		vrmWeights: { aa: 0, ih: 0.15, ou: 0.48, ee: 0, oh: 0.2 },
	},
	{
		visemeId: 17,
		phonemes: "th, dh",
		mouthOpen: 0.22,
		live2dMouthForm: 0.2,
		talking: true,
		nvaUnit: "dental",
		vrmWeights: { aa: 0.1, ih: 0.28, ou: 0, ee: 0.2, oh: 0 },
	},
	{
		visemeId: 18,
		phonemes: "f, v",
		mouthOpen: 0.14,
		live2dMouthForm: 0.1,
		talking: true,
		nvaUnit: "labiodental",
		vrmWeights: { aa: 0.05, ih: 0.22, ou: 0.12, ee: 0, oh: 0 },
	},
	{
		visemeId: 19,
		phonemes: "d, t, n",
		mouthOpen: 0.25,
		live2dMouthForm: 0.2,
		talking: true,
		nvaUnit: "dental",
		vrmWeights: { aa: 0.15, ih: 0.28, ou: 0, ee: 0.15, oh: 0 },
	},
	{
		visemeId: 20,
		phonemes: "k, g, ng",
		mouthOpen: 0.3,
		live2dMouthForm: 0.05,
		talking: true,
		nvaUnit: "velar",
		vrmWeights: { aa: 0.24, ih: 0.12, ou: 0, ee: 0.15, oh: 0.1 },
	},
	{
		visemeId: 21,
		phonemes: "p, b, m",
		mouthOpen: 0,
		live2dMouthForm: -0.1,
		talking: true,
		nvaUnit: "closed",
		vrmWeights: { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 },
	},
] as const;

/** Normalize an arbitrary numeric viseme ID into `0..21` (`0` on invalid input). */
export function normalizeAzureVisemeId(visemeId: number): AzureVisemeId {
	if (!Number.isFinite(visemeId)) return 0;
	const rounded = Math.round(visemeId);
	if (rounded < 0 || rounded > 21) return 0;
	return rounded as AzureVisemeId;
}

/** Look up the calibrated `AzureVisemeSpec` for a Viseme ID (`0..21`). */
export function getAzureVisemeSpec(visemeId: number): AzureVisemeSpec {
	return AZURE_VISEME_TABLE[normalizeAzureVisemeId(visemeId)];
}

/** Convert Azure Speech 100-nanosecond ticks (`AudioOffset`) to milliseconds. */
export function azureTicksToMs(audioOffsetTicks: number): number {
	if (!Number.isFinite(audioOffsetTicks) || audioOffsetTicks <= 0) return 0;
	return audioOffsetTicks / 10_000;
}

/** Convert Azure Speech 100-nanosecond ticks (`AudioOffset`) to integer microseconds. */
export function azureTicksToUs(audioOffsetTicks: number): number {
	if (!Number.isFinite(audioOffsetTicks) || audioOffsetTicks <= 0) return 0;
	return Math.round(audioOffsetTicks / 10);
}

/** Timestamped Viseme event emitted by Azure AI Speech or Gateway proxy. */
export interface AzureVisemeCue {
	/** Playback offset from start of utterance in milliseconds (`>= 0`). */
	offsetMs: number;
	/** Microsoft Viseme ID (`0..21`). */
	visemeId: AzureVisemeId;
	/** Optional raw 55-blendshape FacialExpression JSON or frame array if requested. */
	animation?: string;
}

/** Timestamped fallback amplitude envelope cue derived from audio samples. */
export interface AmplitudeLipSyncCue {
	offsetMs: number;
	mouthOpen: number;
	talking: boolean;
	vrmWeights: VrmMouthWeights;
}

export type LipSyncSourceKind = "viseme" | "amplitude" | "idle";

/** Real-time avatar lip-sync frame delivered to VRM / Live2D / NVA / UI consumers. */
export interface AvatarLipSyncFrame {
	/** Playback clock position in milliseconds (`>= 0`). */
	timeMs: number;
	/** Active Azure Viseme ID (`0..21`; `0` when silent or driven by amplitude fallback). */
	visemeId: AzureVisemeId;
	/** Calibrated continuous jaw/mouth opening `[0..1]`. */
	mouthOpen: number;
	/** Calibrated mouth spread/round `[-1..1]`. */
	live2dMouthForm: number;
	/** Whether the avatar is actively speaking (`true` across brief inter-phoneme dips). */
	talking: boolean;
	/** Canonical NVA 13-unit phoneme class. */
	nvaUnit: SpeechUnit;
	/** VRM 1.0 / 0.x blendshape weights (`aa`, `ih`, `ou`, `ee`, `oh`). */
	vrmWeights: VrmMouthWeights;
	/** Which signal generated this frame (`"viseme"`, `"amplitude"`, or `"idle"`). */
	source: LipSyncSourceKind;
}

export const IDLE_AVATAR_LIP_SYNC_FRAME: Readonly<AvatarLipSyncFrame> = {
	timeMs: 0,
	visemeId: 0,
	mouthOpen: 0,
	live2dMouthForm: 0,
	talking: false,
	nvaUnit: "sil",
	vrmWeights: { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 },
	source: "idle",
};

/** Immediate stateless conversion from a single Viseme ID (`0..21`) to `AvatarLipSyncFrame`. */
export function visemeIdToAvatarFrame(
	visemeId: number,
	timeMs = 0,
): AvatarLipSyncFrame {
	const spec = getAzureVisemeSpec(visemeId);
	return {
		timeMs: Math.max(0, timeMs),
		visemeId: spec.visemeId,
		mouthOpen: spec.mouthOpen,
		live2dMouthForm: spec.live2dMouthForm,
		talking: spec.talking,
		nvaUnit: spec.nvaUnit,
		vrmWeights: { ...spec.vrmWeights },
		source: spec.visemeId === 0 ? "idle" : "viseme",
	};
}

/** Deterministic SHA-256 marker identifying Azure Speech Viseme aligner provenance. */
export const AZURE_VISEME_ALIGNER_MODEL_SHA256 =
	"a20e59eec4000000000000000000000000000000000000000000000000000021";

const ZERO_AUDIO_SHA256 =
	"0000000000000000000000000000000000000000000000000000000000000000";

export interface VisemeSpeechPlanOptions {
	text?: string;
	durationMs: number;
	/** Hex SHA-256 of the exact RIFF/WAV bytes when binding an `"aligned"` plan. */
	audioSha256?: string;
	/** Minimum event duration in microseconds for `normalizeShortSpeechEvents` (default `40_000`). */
	minimumDurationUs?: number;
}

/**
 * Convert Azure Viseme cues (`0..21`) into a canonical NVA `SpeechPlan`
 * (`version: "1"`, `quality_mode: "aligned"`) that passes `validateSpeechPlan`.
 */
export function visemesToSpeechPlan(
	cues: readonly AzureVisemeCue[],
	options: VisemeSpeechPlanOptions,
): SpeechPlan | null {
	const durationUs = Math.max(0, Math.round(options.durationMs * 1000));
	if (!Number.isSafeInteger(durationUs) || durationUs <= 0) return null;

	const sorted = [...cues]
		.filter((cue) => Number.isFinite(cue.offsetMs) && cue.offsetMs >= 0)
		.map((cue) => ({
			startUs: Math.min(
				durationUs,
				Math.max(0, Math.round(cue.offsetMs * 1000)),
			),
			unit: getAzureVisemeSpec(cue.visemeId).nvaUnit,
		}))
		.sort((a, b) => a.startUs - b.startUs);

	// Deduplicate identical start_us timestamps (keep latest cue at same timestamp).
	const deduped: Array<{ startUs: number; unit: SpeechUnit }> = [];
	for (const item of sorted) {
		if (item.startUs >= durationUs) continue;
		const prev = deduped[deduped.length - 1];
		if (prev && prev.startUs === item.startUs) {
			prev.unit = item.unit;
		} else {
			deduped.push({ ...item });
		}
	}

	const rawEvents: SpeechPlanEvent[] = [];
	if (deduped.length === 0) {
		rawEvents.push({ unit: "sil", start_us: 0, end_us: durationUs });
	} else {
		if (deduped[0].startUs > 0) {
			rawEvents.push({
				unit: "sil",
				start_us: 0,
				end_us: deduped[0].startUs,
			});
		}
		for (let i = 0; i < deduped.length; i++) {
			const startUs = deduped[i].startUs;
			const endUs =
				i + 1 < deduped.length ? deduped[i + 1].startUs : durationUs;
			if (endUs > startUs) {
				rawEvents.push({
					unit: deduped[i].unit,
					start_us: startUs,
					end_us: endUs,
				});
			}
		}
	}

	// Merge adjacent events sharing the exact same unit before short-event normalization.
	const mergedAdjacent: SpeechPlanEvent[] = [];
	for (const ev of rawEvents) {
		const last = mergedAdjacent[mergedAdjacent.length - 1];
		if (last && last.unit === ev.unit && last.end_us === ev.start_us) {
			last.end_us = ev.end_us;
		} else {
			mergedAdjacent.push({ ...ev });
		}
	}

	const events = normalizeShortSpeechEvents(
		mergedAdjacent,
		options.minimumDurationUs ?? 40_000,
	);
	const sha =
		options.audioSha256 && /^[a-f0-9]{64}$/i.test(options.audioSha256)
			? options.audioSha256.toLowerCase()
			: ZERO_AUDIO_SHA256;

	const plan: SpeechPlan = {
		version: "1",
		text: options.text ?? "",
		quality_mode: "aligned",
		audio: {
			sha256: sha,
			duration_us: durationUs,
		},
		aligner: {
			provider: "azure-ai-speech-viseme",
			version: "1.0.0",
			model_sha256: AZURE_VISEME_ALIGNER_MODEL_SHA256,
		},
		events,
	};

	const validation = validateSpeechPlan(plan);
	return validation.ok ? plan : null;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	if (value >= 1) return 1;
	return value;
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function lerpWeights(
	a: Readonly<VrmMouthWeights>,
	b: Readonly<VrmMouthWeights>,
	t: number,
): VrmMouthWeights {
	return {
		aa: lerp(a.aa, b.aa, t),
		ih: lerp(a.ih, b.ih, t),
		ou: lerp(a.ou, b.ou, t),
		ee: lerp(a.ee, b.ee, t),
		oh: lerp(a.oh, b.oh, t),
	};
}

/** Minimal interface matching Web Audio `AnalyserNode` for live MP3/MediaElement fallback. */
export interface AnalyserNodeLike {
	readonly fftSize: number;
	getFloatTimeDomainData?: (array: Float32Array) => void;
	getByteTimeDomainData?: (array: Uint8Array) => void;
}

export interface AmplitudeAnalyzerOptions {
	/** RMS noise floor below which mouth remains closed (`0..1`, default `0.015`). */
	noiseFloor?: number;
	/** Linear pre-curve gain multiplier (default `4.2`). */
	gain?: number;
	/** Minimum smoothed mouthOpen threshold to trigger `talking: true` (default `0.04`). */
	talkingThreshold?: number;
	/** Exponential smoothing factor on rising amplitude (`0..1`, default `0.62`). */
	attackAlpha?: number;
	/** Exponential smoothing factor on falling amplitude (`0..1`, default `0.28`). */
	releaseAlpha?: number;
	/** Window duration in milliseconds for PCM16 timeline slicing (default `25`). */
	windowMs?: number;
}

/** Compute normalized `[0..1]` RMS energy of a signed 16-bit PCM sample slice. */
export function computePcm16Rms(samples: Int16Array): number {
	if (samples.length === 0) return 0;
	let sumSq = 0;
	for (let i = 0; i < samples.length; i++) {
		const norm = samples[i] / 32768;
		sumSq += norm * norm;
	}
	return Math.sqrt(sumSq / samples.length);
}

/** Convert a normalized `[0..1]` RMS value into calibrated `mouthOpen` and VRM weights. */
export function rmsToMouthPose(
	rms: number,
	options: AmplitudeAnalyzerOptions = {},
): {
	mouthOpen: number;
	talking: boolean;
	vrmWeights: VrmMouthWeights;
} {
	const floor = options.noiseFloor ?? 0.015;
	const gain = options.gain ?? 4.2;
	const threshold = options.talkingThreshold ?? 0.04;

	if (!Number.isFinite(rms) || rms <= floor) {
		return {
			mouthOpen: 0,
			talking: false,
			vrmWeights: { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 },
		};
	}

	const gated = (rms - floor) / Math.max(1e-6, 1 - floor);
	const mouthOpen = clamp01((gated * gain) ** 0.72);
	const talking = mouthOpen >= threshold;

	return {
		mouthOpen,
		talking,
		vrmWeights: {
			aa: clamp01(mouthOpen * 0.85),
			ih: clamp01(mouthOpen * 0.12),
			ou: 0,
			ee: clamp01(mouthOpen * 0.18),
			oh: clamp01(mouthOpen * 0.32),
		},
	};
}

/**
 * Sample a live Web Audio `AnalyserNode` (e.g. attached to `HTMLAudioElement` for MP3)
 * and convert its current time-domain waveform into an `AvatarLipSyncFrame`.
 */
export function sampleAnalyserNodeLipSync(
	analyser: AnalyserNodeLike,
	timeMs = 0,
	options: AmplitudeAnalyzerOptions = {},
): AvatarLipSyncFrame {
	const size = Math.max(32, Math.min(2048, analyser.fftSize || 256));
	let rms = 0;

	if (typeof analyser.getFloatTimeDomainData === "function") {
		const buf = new Float32Array(size);
		analyser.getFloatTimeDomainData(buf);
		let sumSq = 0;
		for (let i = 0; i < buf.length; i++) {
			sumSq += buf[i] * buf[i];
		}
		rms = Math.sqrt(sumSq / buf.length);
	} else if (typeof analyser.getByteTimeDomainData === "function") {
		const buf = new Uint8Array(size);
		analyser.getByteTimeDomainData(buf);
		let sumSq = 0;
		for (let i = 0; i < buf.length; i++) {
			const centered = (buf[i] - 128) / 128;
			sumSq += centered * centered;
		}
		rms = Math.sqrt(sumSq / buf.length);
	}

	const pose = rmsToMouthPose(rms, options);
	return {
		timeMs: Math.max(0, timeMs),
		visemeId: 0,
		mouthOpen: pose.mouthOpen,
		live2dMouthForm: 0,
		talking: pose.talking,
		nvaUnit: pose.talking
			? pose.mouthOpen >= 0.55
				? "vowel-open"
				: "vowel-mid"
			: "sil",
		vrmWeights: pose.vrmWeights,
		source: pose.talking ? "amplitude" : "idle",
	};
}

/**
 * Stateful streaming PCM16 amplitude analyzer that converts incoming `Int16Array`
 * chunks into timestamped `AmplitudeLipSyncCue` envelopes aligned to sample offsets.
 */
export class Pcm16AmplitudeTracker {
	private readonly sampleRate: number;
	private readonly windowSamples: number;
	private readonly options: AmplitudeAnalyzerOptions;
	private carry = new Int16Array(0);
	private processedSamples = 0;
	private smoothedOpen = 0;
	private readonly cues: AmplitudeLipSyncCue[] = [];

	constructor(sampleRate = 24000, options: AmplitudeAnalyzerOptions = {}) {
		this.sampleRate = Math.max(8000, sampleRate);
		this.options = options;
		const windowMs = Math.max(10, options.windowMs ?? 25);
		this.windowSamples = Math.max(
			80,
			Math.round((this.sampleRate * windowMs) / 1000),
		);
	}

	/** Ingest a streaming PCM16 chunk and return newly generated timeline cues. */
	pushChunk(chunk: Int16Array): AmplitudeLipSyncCue[] {
		if (chunk.length === 0) return [];
		let combined: Int16Array;
		if (this.carry.length === 0) {
			combined = chunk;
		} else {
			combined = new Int16Array(this.carry.length + chunk.length);
			combined.set(this.carry, 0);
			combined.set(chunk, this.carry.length);
		}

		const emitted: AmplitudeLipSyncCue[] = [];
		let offset = 0;
		while (offset + this.windowSamples <= combined.length) {
			const slice = combined.subarray(offset, offset + this.windowSamples);
			const cue = this.processWindow(slice);
			emitted.push(cue);
			this.cues.push(cue);
			offset += this.windowSamples;
		}

		this.carry =
			offset < combined.length ? combined.slice(offset) : new Int16Array(0);
		return emitted;
	}

	/** Flush any trailing partial window and append a terminal silence cue at stream end. */
	flush(): AmplitudeLipSyncCue[] {
		const emitted: AmplitudeLipSyncCue[] = [];
		if (this.carry.length > 0) {
			const cue = this.processWindow(this.carry);
			emitted.push(cue);
			this.cues.push(cue);
			this.carry = new Int16Array(0);
		}
		const endOffsetMs = (this.processedSamples / this.sampleRate) * 1000;
		this.smoothedOpen = 0;
		const tailSilence: AmplitudeLipSyncCue = {
			offsetMs: endOffsetMs,
			mouthOpen: 0,
			talking: false,
			vrmWeights: { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 },
		};
		emitted.push(tailSilence);
		this.cues.push(tailSilence);
		return emitted;
	}

	getCues(): readonly AmplitudeLipSyncCue[] {
		return this.cues;
	}

	getDurationMs(): number {
		return (this.processedSamples / this.sampleRate) * 1000;
	}

	reset(): void {
		this.carry = new Int16Array(0);
		this.processedSamples = 0;
		this.smoothedOpen = 0;
		this.cues.length = 0;
	}

	private processWindow(windowSlice: Int16Array): AmplitudeLipSyncCue {
		const offsetMs = (this.processedSamples / this.sampleRate) * 1000;
		this.processedSamples += windowSlice.length;

		const rawRms = computePcm16Rms(windowSlice);
		const rawPose = rmsToMouthPose(rawRms, this.options);
		const alpha =
			rawPose.mouthOpen >= this.smoothedOpen
				? (this.options.attackAlpha ?? 0.62)
				: (this.options.releaseAlpha ?? 0.28);
		this.smoothedOpen = lerp(this.smoothedOpen, rawPose.mouthOpen, alpha);
		const finalOpen = this.smoothedOpen < 0.01 ? 0 : clamp01(this.smoothedOpen);
		const threshold = this.options.talkingThreshold ?? 0.04;
		const talking = finalOpen >= threshold;

		return {
			offsetMs,
			mouthOpen: finalOpen,
			talking,
			vrmWeights: {
				aa: clamp01(finalOpen * 0.85),
				ih: clamp01(finalOpen * 0.12),
				ou: 0,
				ee: clamp01(finalOpen * 0.18),
				oh: clamp01(finalOpen * 0.32),
			},
		};
	}
}

export interface FrameScheduler {
	request: (cb: () => void) => number;
	cancel: (handle: number) => void;
}

function defaultFrameScheduler(): FrameScheduler {
	if (
		typeof globalThis.requestAnimationFrame === "function" &&
		typeof globalThis.cancelAnimationFrame === "function"
	) {
		return {
			request: (cb) => globalThis.requestAnimationFrame(() => cb()),
			cancel: (id) => globalThis.cancelAnimationFrame(id),
		};
	}
	return {
		request: (cb) => setTimeout(cb, 16) as unknown as number,
		cancel: (id) =>
			clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
	};
}

export interface AzureVisemeTimelineDriverOptions {
	/** Coarticulation blend window between consecutive visemes in ms (default `35`). */
	coarticulationMs?: number;
	/** Silence hold duration in ms before `talking` transitions from `true` -> `false` (default `120`). */
	silenceHoldMs?: number;
	/** Optional live Web Audio `AnalyserNode` used when neither visemes nor PCM cues exist. */
	analyserNode?: AnalyserNodeLike | null;
	/** Amplitude fallback tuning options. */
	amplitudeOptions?: AmplitudeAnalyzerOptions;
	/** Callback invoked on every sampled frame during active playback. */
	onFrame?: (frame: AvatarLipSyncFrame) => void;
	/** Callback invoked only when `talking` boolean state transitions (`false <-> true`). */
	onTalkingChange?: (talking: boolean) => void;
	/** Custom animation frame scheduler (injectable for deterministic tests). */
	scheduler?: FrameScheduler;
}

/**
 * Synchronizes streaming Azure Viseme ID (`0..21`) cues (or fallback amplitude
 * envelopes when visemes are absent) against an `AudioPlaybackClock` (`SpeechClock`).
 */
export class AzureVisemeTimelineDriver {
	private readonly coarticulationMs: number;
	private readonly silenceHoldMs: number;
	private readonly scheduler: FrameScheduler;
	private analyserNode: AnalyserNodeLike | null;
	private readonly amplitudeOptions: AmplitudeAnalyzerOptions;
	private readonly onFrame?: (frame: AvatarLipSyncFrame) => void;
	private readonly onTalkingChange?: (talking: boolean) => void;

	private visemeCues: AzureVisemeCue[] = [];
	private amplitudeCues: AmplitudeLipSyncCue[] = [];
	private activeClock: SpeechClock | null = null;
	private rafHandle: number | null = null;
	private running = false;
	private lastTalking = false;
	private lastActiveSpeechMs: number | null = null;
	private currentFrame: AvatarLipSyncFrame = { ...IDLE_AVATAR_LIP_SYNC_FRAME };

	constructor(options: AzureVisemeTimelineDriverOptions = {}) {
		this.coarticulationMs = Math.max(0, options.coarticulationMs ?? 35);
		this.silenceHoldMs = Math.max(0, options.silenceHoldMs ?? 120);
		this.analyserNode = options.analyserNode ?? null;
		this.amplitudeOptions = options.amplitudeOptions ?? {};
		this.onFrame = options.onFrame;
		this.onTalkingChange = options.onTalkingChange;
		this.scheduler = options.scheduler ?? defaultFrameScheduler();
	}

	setAnalyserNode(analyser: AnalyserNodeLike | null): void {
		this.analyserNode = analyser;
	}

	/** Append a single streaming Azure Viseme event (keeps timeline sorted by `offsetMs`). */
	pushViseme(cue: {
		offsetMs: number;
		visemeId: number;
		animation?: string;
	}): void {
		if (!Number.isFinite(cue.offsetMs)) return;
		const normalized: AzureVisemeCue = {
			offsetMs: Math.max(0, cue.offsetMs),
			visemeId: normalizeAzureVisemeId(cue.visemeId),
			animation: cue.animation,
		};
		const last = this.visemeCues[this.visemeCues.length - 1];
		if (!last || normalized.offsetMs > last.offsetMs) {
			this.visemeCues.push(normalized);
			return;
		}
		if (normalized.offsetMs === last.offsetMs) {
			this.visemeCues[this.visemeCues.length - 1] = normalized;
			return;
		}
		this.visemeCues.push(normalized);
		this.visemeCues.sort((a, b) => a.offsetMs - b.offsetMs);
	}

	pushVisemes(
		cues: ReadonlyArray<{
			offsetMs: number;
			visemeId: number;
			animation?: string;
		}>,
	): void {
		for (const cue of cues) this.pushViseme(cue);
	}

	/** Append fallback PCM16 amplitude cues used automatically if no visemes arrive. */
	pushAmplitudeCues(cues: readonly AmplitudeLipSyncCue[]): void {
		for (const cue of cues) {
			if (!Number.isFinite(cue.offsetMs)) continue;
			this.amplitudeCues.push({
				offsetMs: Math.max(0, cue.offsetMs),
				mouthOpen: clamp01(cue.mouthOpen),
				talking: cue.talking,
				vrmWeights: { ...cue.vrmWeights },
			});
		}
		this.amplitudeCues.sort((a, b) => a.offsetMs - b.offsetMs);
	}

	hasVisemes(): boolean {
		return this.visemeCues.length > 0;
	}

	getVisemeCues(): readonly AzureVisemeCue[] {
		return this.visemeCues;
	}

	getCurrentFrame(): AvatarLipSyncFrame {
		return this.currentFrame;
	}

	isRunning(): boolean {
		return this.running;
	}

	/**
	 * Sample the synchronized avatar lip-sync state at `timeMs` along the audio clock,
	 * updating `currentFrame` and notifying `onFrame` / `onTalkingChange`.
	 */
	sampleAt(timeMs: number): AvatarLipSyncFrame {
		const clampedTimeMs = Math.max(0, Number.isFinite(timeMs) ? timeMs : 0);
		let rawFrame: AvatarLipSyncFrame;

		if (this.visemeCues.length > 0) {
			rawFrame = this.sampleVisemeTimeline(clampedTimeMs);
		} else if (this.amplitudeCues.length > 0) {
			rawFrame = this.sampleAmplitudeTimeline(clampedTimeMs);
		} else if (this.analyserNode) {
			rawFrame = sampleAnalyserNodeLipSync(
				this.analyserNode,
				clampedTimeMs,
				this.amplitudeOptions,
			);
		} else {
			rawFrame = { ...IDLE_AVATAR_LIP_SYNC_FRAME, timeMs: clampedTimeMs };
		}

		let effectiveTalking = rawFrame.talking;
		if (rawFrame.talking) {
			this.lastActiveSpeechMs = clampedTimeMs;
		} else if (
			this.lastTalking &&
			this.lastActiveSpeechMs !== null &&
			clampedTimeMs >= this.lastActiveSpeechMs &&
			clampedTimeMs - this.lastActiveSpeechMs < this.silenceHoldMs
		) {
			effectiveTalking = true;
		}

		const finalFrame: AvatarLipSyncFrame = {
			...rawFrame,
			talking: effectiveTalking,
		};
		this.currentFrame = finalFrame;

		if (effectiveTalking !== this.lastTalking) {
			this.lastTalking = effectiveTalking;
			this.onTalkingChange?.(effectiveTalking);
		}
		this.onFrame?.(finalFrame);
		return finalFrame;
	}

	/** Begin continuous frame synchronization locked to `clock` (`() => seconds`). */
	start(clock: SpeechClock): void {
		this.cancelLoop();
		this.activeClock = clock;
		this.running = true;

		const tick = () => {
			if (!this.running || !this.activeClock) return;
			const nowSec = this.activeClock();
			const nowMs = Math.max(0, (Number.isFinite(nowSec) ? nowSec : 0) * 1000);
			this.sampleAt(nowMs);
			if (this.running) {
				this.rafHandle = this.scheduler.request(tick);
			}
		};

		this.sampleAt(Math.max(0, clock() * 1000));
		if (this.running) {
			this.rafHandle = this.scheduler.request(tick);
		}
	}

	/** Stop clock loop and immediately close the avatar mouth (`mouthOpen: 0, talking: false`). */
	stop(): void {
		this.cancelLoop();
		this.activeClock = null;
		this.lastActiveSpeechMs = null;
		const idleFrame: AvatarLipSyncFrame = {
			...IDLE_AVATAR_LIP_SYNC_FRAME,
			vrmWeights: { ...IDLE_AVATAR_LIP_SYNC_FRAME.vrmWeights },
		};
		this.currentFrame = idleFrame;
		if (this.lastTalking) {
			this.lastTalking = false;
			this.onTalkingChange?.(false);
		}
		this.onFrame?.(idleFrame);
	}

	/** Clear all buffered viseme/amplitude cues and reset avatar mouth state to idle. */
	reset(): void {
		this.stop();
		this.visemeCues = [];
		this.amplitudeCues = [];
	}

	private cancelLoop(): void {
		this.running = false;
		if (this.rafHandle !== null) {
			this.scheduler.cancel(this.rafHandle);
			this.rafHandle = null;
		}
	}

	private sampleVisemeTimeline(timeMs: number): AvatarLipSyncFrame {
		const cues = this.visemeCues;
		if (timeMs < cues[0].offsetMs) {
			return { ...IDLE_AVATAR_LIP_SYNC_FRAME, timeMs };
		}

		// Binary search for the latest cue with offsetMs <= timeMs.
		let lo = 0;
		let hi = cues.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (cues[mid].offsetMs <= timeMs) {
				lo = mid;
			} else {
				hi = mid - 1;
			}
		}

		const currentCue = cues[lo];
		const currentSpec = getAzureVisemeSpec(currentCue.visemeId);

		// When in a silence cue that follows an active speech cue, advance
		// lastActiveSpeechMs to the exact timeline boundary where silence began
		// so rAF frame skips never truncate `silenceHoldMs`.
		if (!currentSpec.talking && lo > 0) {
			let silRunStart = lo;
			while (
				silRunStart > 0 &&
				!getAzureVisemeSpec(cues[silRunStart - 1].visemeId).talking
			) {
				silRunStart--;
			}
			if (silRunStart > 0) {
				const boundaryMs = cues[silRunStart].offsetMs;
				if (
					this.lastActiveSpeechMs === null ||
					boundaryMs > this.lastActiveSpeechMs
				) {
					this.lastActiveSpeechMs = boundaryMs;
				}
			}
		}

		// Coarticulation blend from previous cue into currentCue over coarticulationMs,
		// except bilabial closure (21) and silence (0) which snap crisply on closure.
		if (
			lo > 0 &&
			this.coarticulationMs > 0 &&
			currentSpec.visemeId !== 21 &&
			currentSpec.visemeId !== 0
		) {
			const elapsedInCue = timeMs - currentCue.offsetMs;
			if (elapsedInCue >= 0 && elapsedInCue < this.coarticulationMs) {
				const prevSpec = getAzureVisemeSpec(cues[lo - 1].visemeId);
				const t = clamp01(elapsedInCue / this.coarticulationMs);
				return {
					timeMs,
					visemeId: currentSpec.visemeId,
					mouthOpen: lerp(prevSpec.mouthOpen, currentSpec.mouthOpen, t),
					live2dMouthForm: lerp(
						prevSpec.live2dMouthForm,
						currentSpec.live2dMouthForm,
						t,
					),
					talking: currentSpec.talking || prevSpec.talking,
					nvaUnit: currentSpec.nvaUnit,
					vrmWeights: lerpWeights(
						prevSpec.vrmWeights,
						currentSpec.vrmWeights,
						t,
					),
					source: "viseme",
				};
			}
		}

		return {
			timeMs,
			visemeId: currentSpec.visemeId,
			mouthOpen: currentSpec.mouthOpen,
			live2dMouthForm: currentSpec.live2dMouthForm,
			talking: currentSpec.talking,
			nvaUnit: currentSpec.nvaUnit,
			vrmWeights: { ...currentSpec.vrmWeights },
			source: currentSpec.visemeId === 0 ? "idle" : "viseme",
		};
	}

	private sampleAmplitudeTimeline(timeMs: number): AvatarLipSyncFrame {
		const cues = this.amplitudeCues;
		if (timeMs < cues[0].offsetMs) {
			return { ...IDLE_AVATAR_LIP_SYNC_FRAME, timeMs };
		}

		let lo = 0;
		let hi = cues.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (cues[mid].offsetMs <= timeMs) {
				lo = mid;
			} else {
				hi = mid - 1;
			}
		}

		const cur = cues[lo];
		const next = lo + 1 < cues.length ? cues[lo + 1] : null;
		let mouthOpen = cur.mouthOpen;
		let vrmWeights = { ...cur.vrmWeights };

		if (next && next.offsetMs > cur.offsetMs) {
			const t = clamp01(
				(timeMs - cur.offsetMs) / (next.offsetMs - cur.offsetMs),
			);
			mouthOpen = lerp(cur.mouthOpen, next.mouthOpen, t);
			vrmWeights = lerpWeights(cur.vrmWeights, next.vrmWeights, t);
		}

		const threshold = this.amplitudeOptions.talkingThreshold ?? 0.04;
		const talking = mouthOpen >= threshold;
		return {
			timeMs,
			visemeId: 0,
			mouthOpen,
			live2dMouthForm: 0,
			talking,
			nvaUnit: talking
				? mouthOpen >= 0.55
					? "vowel-open"
					: "vowel-mid"
				: "sil",
			vrmWeights,
			source: talking ? "amplitude" : "idle",
		};
	}
}
