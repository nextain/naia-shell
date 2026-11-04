// Types for the canonical speech-plan.js (vendored bytes, see VENDOR.json).
export type SpeechUnit =
	| "sil" | "closed" | "labiodental" | "dental" | "alveolar" | "postalveolar"
	| "palatal" | "velar" | "glottal"
	| "vowel-open" | "vowel-mid" | "vowel-spread" | "vowel-round";

export interface SpeechPlanEvent {
	unit: SpeechUnit | string;
	start_us: number;
	end_us: number;
	confidence?: number;
}

export interface SpeechPlan {
	version: "1";
	text?: string;
	quality_mode: "aligned" | "browser-timed";
	audio: { sha256?: string; duration_us: number };
	aligner?: { provider: string; version: string; model_sha256: string };
	events: SpeechPlanEvent[];
}

export const SPEECH_UNITS: readonly SpeechUnit[];
export function validateSpeechPlan(plan: unknown): { ok: boolean; errors: string[] };
export function normalizeShortSpeechEvents(
	events: SpeechPlanEvent[],
	minimumDurationUs?: number,
): SpeechPlanEvent[];
