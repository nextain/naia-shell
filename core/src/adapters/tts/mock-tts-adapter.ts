import type { SynthesisRequest, SynthesizedSpeech } from "../../domain/tts/speech.js";
import type { TtsPort } from "../../ports/tts/tts-port.js";

/**
 * Deterministic in-memory TtsPort for tests and demos — no network, no provider.
 * Real adapters (edge, openai, …) will be ported in later, guarded by the same contract.
 * @see glossary.md#Adapter
 */
export class MockTtsAdapter implements TtsPort {
	async synthesize(request: SynthesisRequest): Promise<SynthesizedSpeech | null> {
		const text = request.text.trim();
		if (!text) return null;
		const audioBase64 = Buffer.from(`mock-audio:${text}`, "utf8").toString("base64");
		return { audioBase64 };
	}
}
