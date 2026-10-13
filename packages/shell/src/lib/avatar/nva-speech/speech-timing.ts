/**
 * NVA speech timing contract for the Shell (naia-shell#760).
 *
 * Source of truth: alpha-adk docs/developer/product/studio/nva-lipsync-sot.md
 * (sections 5 and 8). The Shell only plays two plan kinds through the
 * canonical SpeechPlayer (vendor/, byte-identical to naia-video-avatar):
 *
 *  - "aligned": a plan made for the exact sound the Shell is playing (Shell
 *    TTS, whole WAV/MP3 or streamed PCM). It is driven by that sound's own
 *    playback position (`AudioPlaybackClock`). Timers and character-count
 *    clocks are not audio clocks and must never drive an aligned plan.
 *  - "browser-timed": browser/system speechSynthesis has no readable sound,
 *    so the plan is driven by time since the utterance started and revised on
 *    every `boundary` event (`updateSpeechPlan`).
 *
 * Plan generation itself is NOT implemented here. It belongs to the gateway
 * aligned-plan route and the shared browser plan builder (studio work, luna
 * branch studio-104-bvoice). This module only fixes the call sites and the
 * shapes the Shell expects; until a source is registered the avatar stays on
 * its idle clip while speaking (no approximation, no mouth loop).
 */
import type { PcmStreamSource } from "../../voice/audio-queue";
import type { SpeechPlan } from "./vendor/speech-plan.js";

export type { SpeechPlan } from "./vendor/speech-plan.js";

/** Returns the playback position, in seconds, of the sound actually playing. */
export type SpeechClock = () => number;

/** Handed to a per-sentence onPlaybackStart by the AudioQueue. */
export interface AudioPlaybackClock {
	/** Playback position of this sentence's sound (seconds, >= 0). */
	clock: SpeechClock;
}

export interface AvatarSpeechTiming {
	plan: SpeechPlan;
	clock: SpeechClock;
}

/** What an aligned plan source receives for one Shell TTS sentence. */
export type AlignedSpeechAudio =
	| { kind: "whole"; audioBase64: string; durationSeconds: number | null }
	| { kind: "pcm-stream"; stream: PcmStreamSource };

export interface AlignedSpeechPlanRequest {
	text: string;
	lang?: string;
	audio: AlignedSpeechAudio;
	signal?: AbortSignal;
}

/**
 * Gateway aligned plan route (not yet available for arbitrary Shell TTS
 * audio). Must resolve to an "aligned" plan for exactly this sound, or null.
 */
export type AlignedSpeechPlanSource = (
	request: AlignedSpeechPlanRequest,
) => Promise<SpeechPlan | null>;

/**
 * One browser speechSynthesis utterance. `ready` resolves to the initial
 * browser-timed plan (or null = keep idle). `boundary` and `end` return the
 * revised plan, or null when nothing changed. Times are microseconds since
 * the utterance's onstart.
 */
export interface BrowserSpeechPlanSession {
	ready: Promise<SpeechPlan | null>;
	boundary(charIndex: number, elapsedUs: number): SpeechPlan | null;
	end(elapsedUs: number): SpeechPlan | null;
}

/** Shared browser plan builder (same contract as the web studio). */
export type BrowserSpeechPlanSource = (request: {
	text: string;
	lang: string;
}) => BrowserSpeechPlanSession | null;

let alignedSource: AlignedSpeechPlanSource | null = null;
let browserSource: BrowserSpeechPlanSource | null = null;

export function setAlignedSpeechPlanSource(
	source: AlignedSpeechPlanSource | null,
): void {
	alignedSource = source;
}

export function getAlignedSpeechPlanSource(): AlignedSpeechPlanSource | null {
	return alignedSource;
}

export function setBrowserSpeechPlanSource(
	source: BrowserSpeechPlanSource | null,
): void {
	browserSource = source;
}

export function getBrowserSpeechPlanSource(): BrowserSpeechPlanSource | null {
	return browserSource;
}

/** Plan kinds the Shell accepts for each clock (SoT 8). */
export function isAlignedPlan(plan: SpeechPlan | null | undefined): boolean {
	return plan?.quality_mode === "aligned";
}

export function isBrowserTimedPlan(
	plan: SpeechPlan | null | undefined,
): boolean {
	return plan?.quality_mode === "browser-timed";
}
