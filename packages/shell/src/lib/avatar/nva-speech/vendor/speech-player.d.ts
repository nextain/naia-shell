// Types for the canonical speech-player.js (vendored bytes, see VENDOR.json).
import type { SpeechPlan } from "./speech-plan.js";

export interface SpeechMediaElement {
	currentTime: number;
	readyState: number;
	play(): Promise<void>;
	pause(): void;
	load(): void;
	addEventListener(type: string, listener: () => void, options?: unknown): void;
	removeEventListener(type: string, listener: () => void): void;
	removeAttribute(name: string): void;
}

export interface SpeechPlayerOptions {
	audio: SpeechMediaElement | HTMLAudioElement;
	canvas: HTMLCanvasElement;
	bodyVideo: HTMLVideoElement;
	speechVideos: [HTMLVideoElement, HTMLVideoElement];
	urlApi?: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };
	imageLoader?: (blob: Blob) => Promise<unknown>;
	videoFactory?: () => HTMLVideoElement;
	requestFrame?: (callback: () => void) => number;
	cancelFrame?: (handle: number) => void;
}

export interface SpeechLoadInput {
	manifest: unknown;
	assets: Map<string, Blob>;
	plan: SpeechPlan;
}

export interface SpeechLoadResult {
	quality_mode: SpeechPlan["quality_mode"];
	transitions: number;
}

export class SpeechPlayer {
	constructor(options: SpeechPlayerOptions);
	readonly state: "empty" | "loading" | "ready" | "speaking" | "disposed";
	readonly mode: "audio" | "external" | "audio-clock" | null;
	load(input: SpeechLoadInput & { audioBlob: Blob }): Promise<SpeechLoadResult>;
	loadExternal(input: SpeechLoadInput): Promise<SpeechLoadResult>;
	loadAudioClock(input: SpeechLoadInput): Promise<SpeechLoadResult>;
	updateExternalPlan(plan: SpeechPlan): SpeechLoadResult;
	play(): Promise<void>;
	playExternal(clock: () => number): Promise<void>;
	playAudioClock(clock: () => number): Promise<void>;
	stop(outcome?: "complete" | "cancel" | "error"): void;
	dispose(): void;
}
