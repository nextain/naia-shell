// ── Model Context Window Limits ──────────────────────────────────────────────
// Maps model IDs to their maximum context window sizes (in tokens).
// Used by token budget checks to prevent context overflow.

/** Context window size in tokens for known models. Synced with providers/cost.ts model list. */
export const MODEL_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
	// Anthropic (all 200K)
	["claude-sonnet-4-5-20250929", 200_000],
	["claude-sonnet-4-20250514", 200_000],
	["claude-haiku-4-5-20251001", 200_000],
	["claude-opus-4-5-20251101", 200_000],
	["claude-opus-4-1-20250805", 200_000],
	["claude-opus-4-20250514", 200_000],
	["claude-opus-4-6", 200_000],
	["claude-3-7-sonnet-20250219", 200_000],

	// Google Gemini
	// Gemini 3.x — global endpoint (Gemini Enterprise Agent Platform)
	["gemini-3.5-flash", 1_000_000],
	["gemini-3.1-pro-preview", 1_000_000],
	["gemini-3.1-flash-lite", 1_000_000],
	["gemini-3-flash-preview", 1_000_000],
	// Gemini 2.5
	["gemini-2.5-flash", 1_000_000],
	["gemini-2.5-flash-lite-preview-06-17", 1_000_000],
	["gemini-2.5-pro", 1_000_000],
	["gemini-2.0-flash-001", 1_000_000],
	["gemini-2.0-flash-lite-preview-02-05", 1_000_000],

	// OpenAI
	["gpt-5-2025-08-07", 256_000],
	["gpt-5-mini-2025-08-07", 256_000],
	["gpt-5.1", 256_000],
	["gpt-5.2", 256_000],
	["gpt-4.1", 1_000_000],
	["gpt-4.1-mini", 1_000_000],
	["gpt-4.1-nano", 1_000_000],
	["o4-mini", 200_000],
	["o3-mini", 200_000],
	["gpt-4o", 128_000],
	["gpt-4o-mini", 128_000],

	// xAI
	["grok-4", 131_072],
	["grok-4-1-fast-reasoning", 131_072],
	["grok-4-1-fast-non-reasoning", 131_072],
	["grok-4-fast-reasoning", 131_072],
	["grok-code-fast-1", 131_072],
	["grok-3", 131_072],
	["grok-3-fast", 131_072],
	["grok-3-mini", 131_072],
	["grok-3-mini-fast", 131_072],

	// zAI (GLM)
	["glm-4.7", 128_000],
	["glm-4.6", 128_000],
	["glm-4.5", 128_000],
	["glm-4.5-air", 128_000],

	// Local (vllm)
	["qwen3-8b", 32_768],
	["minicpm-o-2_6", 8_192],
]);

/** Default context window when model is unknown. Conservative. */
const DEFAULT_CONTEXT_WINDOW = 32_768;

/** Get the context window size for a model. Falls back to conservative default. */
export function getContextWindow(model: string): number {
	// Try exact match first
	const exact = MODEL_CONTEXT_WINDOWS.get(model);
	if (exact) return exact;

	// Try prefix match: model is a prefix of a known key
	// e.g., "claude-sonnet-4-5" → matches "claude-sonnet-4-5-20250929"
	// Only match if the input is at least 5 chars to avoid overly broad matches
	if (model.length >= 5) {
		for (const [key, value] of MODEL_CONTEXT_WINDOWS) {
			if (key.startsWith(model)) {
				return value;
			}
		}
	}

	return DEFAULT_CONTEXT_WINDOW;
}
