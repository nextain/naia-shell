import type { LLMProvider } from "./types.js";

/** Factory function signature for creating an LLM provider instance. */
export type LlmProviderFactory = (
	apiKey: string,
	model: string,
	options?: {
		ollamaHost?: string;
		vllmHost?: string;
		labGatewayUrl?: string;
		enableThinking?: boolean;
		ollamaNumCtx?: number;
	},
) => LLMProvider;

/** Agent-side LLM provider definition for self-registration. */
export interface LlmProviderDefinition {
	id: string;
	name: string;
	/** Fallback env var for API key (e.g. "GEMINI_API_KEY"). */
	envVar?: string;
	/** Factory function to create a provider instance. */
	create: LlmProviderFactory;
}

const providers = new Map<string, LlmProviderDefinition>();

/** Register an LLM provider. Call at module scope in each provider file. */
export function registerLlmProvider(def: LlmProviderDefinition): void {
	providers.set(def.id, def);
}

/** Get a registered provider definition by id. */
export function getLlmProviderDef(
	id: string,
): LlmProviderDefinition | undefined {
	return providers.get(id);
}

/** List all registered provider definitions. */
export function listLlmProviderDefs(): LlmProviderDefinition[] {
	return Array.from(providers.values());
}
