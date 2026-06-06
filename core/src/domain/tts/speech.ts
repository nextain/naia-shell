/** A request to synthesize speech. @see glossary.md#SynthesisRequest */
export interface SynthesisRequest {
	readonly text: string;
	readonly voiceId?: string;
}

/** Synthesized speech audio. @see glossary.md#SynthesizedSpeech */
export interface SynthesizedSpeech {
	/** base64-encoded MP3 audio. @see glossary.md#AudioEncoding */
	readonly audioBase64: string;
	/** Provider-reported cost in USD, if known. */
	readonly costUsd?: number;
}
