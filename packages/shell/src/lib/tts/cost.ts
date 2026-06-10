/**
 * TTS/STT cost estimation.
 * Returns estimated cost in USD.
 *
 * For Naia Cloud (nextain): use server-reported costUsd instead of client estimation.
 * For direct providers: estimate based on voice tier (Google) or flat rate (OpenAI/ElevenLabs).
 */

/** Google Cloud TTS pricing per 1M characters by voice tier. */
const GOOGLE_TIER_PRICING: Record<string, number> = {
	neural2: 16,
	wavenet: 16,
	chirp3: 16,
	standard: 4,
};

/** Flat-rate providers ($/char). */
const FLAT_RATE_PER_CHAR: Record<string, number> = {
	edge: 0,
	openai: 15 / 1_000_000, // $15/1M chars (tts-1)
	elevenlabs: 0.3 / 1_000, // $0.30/1K chars
};

/** Detect Google TTS voice tier from voice name (mirrors gateway _voice_tier). */
function voiceTier(voice: string): string {
	const lower = voice.toLowerCase();
	if (lower.includes("neural2")) return "neural2";
	if (lower.includes("wavenet")) return "wavenet";
	if (lower.includes("chirp3") || lower.includes("chirp-3")) return "chirp3";
	return "standard";
}

/**
 * Estimate TTS cost in USD.
 * For Google/Nextain: uses voice tier pricing. For OpenAI/ElevenLabs: flat rate.
 * For Naia Cloud, prefer server-reported cost (costUsd from gateway response).
 */
export function estimateTtsCost(
	provider: string,
	textLength: number,
	voice?: string,
): number {
	if (provider in FLAT_RATE_PER_CHAR) {
		return (FLAT_RATE_PER_CHAR[provider] ?? 0) * textLength;
	}
	// Voice tier-based providers: google, nextain (fallback when server cost unavailable)
	const tier = voice ? voiceTier(voice) : "neural2"; // conservative default
	const rate = (GOOGLE_TIER_PRICING[tier] ?? 16) / 1_000_000;
	return rate * textLength;
}

/** Estimate STT cost in USD. $0.006 per 15-second increment. */
export function estimateSttCost(
	provider: string,
	durationSeconds: number,
): number {
	if (provider === "vosk" || provider === "whisper") return 0; // offline, free
	if (provider === "edge") return 0;
	// Google / Naia Cloud / ElevenLabs — billed per 15s increment
	const increments = Math.max(1, Math.ceil(durationSeconds / 15));
	return increments * 0.006;
}
