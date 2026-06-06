import type { SynthesisRequest, SynthesizedSpeech } from "../../domain/tts/speech.js";

/**
 * Driven port: the core asks an adapter to turn text into speech audio.
 * Adapters implement this; the core never imports an adapter. @see glossary.md#TtsPort
 */
export interface TtsPort {
	/** Synthesize speech for the request, or return null on failure (caller decides fallback). */
	synthesize(request: SynthesisRequest): Promise<SynthesizedSpeech | null>;
}
