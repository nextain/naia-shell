import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import type { SynthesisRequest, SynthesizedSpeech } from "../../domain/tts/speech.js";
import type { TtsPort } from "../../ports/tts/tts-port.js";

const DEFAULT_VOICE = "ko-KR-SunHiNeural";

/**
 * TtsPort backed by Microsoft Edge TTS (free, no API key).
 * Ported from agent/src/tts/edge-tts.ts — same contract as every other adapter.
 * @see glossary.md#Adapter
 */
export class EdgeTtsAdapter implements TtsPort {
	async synthesize(request: SynthesisRequest): Promise<SynthesizedSpeech | null> {
		const text = request.text.trim();
		if (!text) return null;
		try {
			const tts = new MsEdgeTTS();
			await tts.setMetadata(
				request.voiceId ?? DEFAULT_VOICE,
				OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
			);
			const { audioStream } = tts.toStream(text);
			const chunks: Buffer[] = [];
			for await (const chunk of audioStream) {
				chunks.push(Buffer.from(chunk));
			}
			tts.close();
			const buf = Buffer.concat(chunks);
			if (buf.length === 0) return null;
			return { audioBase64: buf.toString("base64") };
		} catch {
			return null;
		}
	}
}
