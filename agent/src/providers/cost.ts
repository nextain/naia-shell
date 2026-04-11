/**
 * Per-million-token pricing for supported models.
 * Source of truth: project-careti/src/shared/api.ts (ModelInfo.inputPrice / outputPrice)
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> =
	{
		// Gemini 3
		"gemini-3-pro-preview": { input: 2.0, output: 12.0 },
		"gemini-3-flash-preview": { input: 0.5, output: 3.0 },
		// Gemini 2.5
		"gemini-2.5-flash": { input: 0.3, output: 2.5 },
		"gemini-2.5-flash-lite-preview-06-17": { input: 0.15, output: 1.0 },
		"gemini-2.5-pro": { input: 1.25, output: 10.0 },
		// Gemini 2.0
		"gemini-2.0-flash-001": { input: 0.1, output: 0.4 },
		"gemini-2.0-flash-lite-preview-02-05": { input: 0.075, output: 0.3 },
		// xAI
		"grok-4": { input: 3.0, output: 15.0 },
		"grok-4-1-fast-reasoning": { input: 5.0, output: 25.0 },
		"grok-4-1-fast-non-reasoning": { input: 3.0, output: 15.0 },
		"grok-4-fast-reasoning": { input: 5.0, output: 25.0 },
		"grok-code-fast-1": { input: 3.0, output: 15.0 },
		"grok-3": { input: 3.0, output: 15.0 },
		"grok-3-fast": { input: 5.0, output: 25.0 },
		"grok-3-mini": { input: 0.3, output: 0.5 },
		"grok-3-mini-fast": { input: 0.6, output: 4.0 },
		// Anthropic
		"claude-sonnet-4-5-20250929": { input: 3.0, output: 15.0 },
		"claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
		"claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
		"claude-opus-4-5-20251101": { input: 15.0, output: 75.0 },
		"claude-opus-4-1-20250805": { input: 15.0, output: 75.0 },
		"claude-opus-4-20250514": { input: 15.0, output: 75.0 },
		"claude-opus-4-6": { input: 15.0, output: 75.0 },
		"claude-3-7-sonnet-20250219": { input: 3.0, output: 15.0 },
		// OpenAI
		"gpt-5-2025-08-07": { input: 1.25, output: 10.0 },
		"gpt-5-mini-2025-08-07": { input: 0.4, output: 1.6 },
		"gpt-5.1": { input: 1.25, output: 10.0 },
		"gpt-5.2": { input: 1.25, output: 10.0 },
		"gpt-4.1": { input: 2.0, output: 8.0 },
		"gpt-4.1-mini": { input: 0.4, output: 1.6 },
		"gpt-4.1-nano": { input: 0.1, output: 0.4 },
		"o4-mini": { input: 1.1, output: 4.4 },
		"o3-mini": { input: 1.1, output: 4.4 },
		"gpt-4o": { input: 2.5, output: 10.0 },
		"gpt-4o-mini": { input: 0.15, output: 0.6 },
	};

export function calculateCost(
	model: string,
	inputTokens: number,
	outputTokens: number,
): number {
	const pricing = MODEL_PRICING[model];
	if (!pricing) return 0;
	return (
		(pricing.input / 1_000_000) * inputTokens +
		(pricing.output / 1_000_000) * outputTokens
	);
}
