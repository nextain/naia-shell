/**
 * TTS/STT cost estimation.
 * For Naia Cloud (nextain): prefer server-reported costUsd.
 * Removed (#603): google / openai / elevenlabs direct pricing.
 */

const FLAT_RATE_PER_CHAR: Record<string, number> = {
	edge: 0,
	vllm: 0,
	"naia-local-voice": 0,
	browser: 0,
};

const NEXTAIN_FALLBACK_PER_M_CHARS = 16;

export function estimateTtsCost(
	provider: string,
	textLength: number,
	_voice?: string,
): number {
	if (provider in FLAT_RATE_PER_CHAR) {
		return (FLAT_RATE_PER_CHAR[provider] ?? 0) * textLength;
	}
	if (provider === "nextain") {
		return (NEXTAIN_FALLBACK_PER_M_CHARS / 1_000_000) * textLength;
	}
	return 0;
}

export function estimateSttCost(
	provider: string,
	_durationSeconds: number,
): number {
	void provider;
	return 0;
}
