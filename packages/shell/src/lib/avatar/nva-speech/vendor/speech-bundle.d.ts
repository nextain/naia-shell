// Types for the canonical speech-bundle.js (vendored bytes, see VENDOR.json).
export interface SpeechMotionManifest {
	version: string;
	representation?: string;
	neutral_head: string;
	atlas: string;
	atlas_index: string;
	validation_report: string;
	quality_report: string;
	provenance: string;
	region?: number[];
}
export const GENERATION_RECEIPT_PATH: string;
export function speechBundlePaths(speechMotion: SpeechMotionManifest | null | undefined): string[];
