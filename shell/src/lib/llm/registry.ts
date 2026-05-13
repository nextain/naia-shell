import type { LlmModelMeta, LlmProviderMeta, LlmVoiceMeta } from "./types";

const providers = new Map<string, LlmProviderMeta>();

/** Register an LLM provider. */
export function registerLlmProvider(meta: LlmProviderMeta): void {
	providers.set(meta.id, meta);
}

/** Get a registered LLM provider by id. */
export function getLlmProvider(id: string): LlmProviderMeta | undefined {
	return providers.get(id);
}

/** List all registered LLM providers (in registration order). */
export function listLlmProviders(): LlmProviderMeta[] {
	return Array.from(providers.values());
}

/** Get model metadata. */
export function getLlmModel(
	providerId: string,
	modelId: string,
): LlmModelMeta | undefined {
	return providers.get(providerId)?.models.find((m) => m.id === modelId);
}

/** Check if a model has a specific capability. */
export function modelHasCapability(
	providerId: string,
	modelId: string,
	capability: import("../types.js").ModelCapability,
): boolean {
	return (
		getLlmModel(providerId, modelId)?.capabilities.includes(capability) ?? false
	);
}

/** Check if a model is omni (built-in voice).
 * Falls back to model ID pattern for dynamically fetched models (e.g. vLLM)
 * that are not in the static registry. */
export function isOmniModel(providerId: string, modelId: string): boolean {
	if (modelHasCapability(providerId, modelId, "omni")) return true;
	const mid = modelId.toLowerCase();
	return mid.includes("minicpm-o") || mid.includes("minicpmo");
}

/** Get default model for a provider. */
export function getDefaultLlmModel(providerId: string): string {
	return providers.get(providerId)?.defaultModel ?? "";
}

/** Check if a provider does not require any API key (neither provider key nor Naia key). */
export function isApiKeyOptional(providerId: string): boolean {
	const p = providers.get(providerId);
	if (!p) return false;
	return !p.requiresApiKey && !p.requiresNaiaKey;
}

/** Build initial models record from all registered providers. */
export function getStaticModelsRecord(): Record<string, LlmModelMeta[]> {
	const record: Record<string, LlmModelMeta[]> = {};
	for (const p of providers.values()) {
		record[p.id] = [...p.models];
	}
	return record;
}

/** Fetch Ollama models with connection status. */
export async function fetchOllamaModels(
	host: string,
): Promise<{ models: LlmModelMeta[]; connected: boolean }> {
	const provider = providers.get("ollama");
	if (!provider?.fetchModels) return { models: [], connected: false };
	const models = await provider.fetchModels(host);
	return { models: models ?? [], connected: models !== null };
}

/** Fetch vLLM models with connection status. */
export async function fetchVllmModels(
	host: string,
): Promise<{ models: LlmModelMeta[]; connected: boolean }> {
	const provider = providers.get("vllm");
	if (!provider?.fetchModels) return { models: [], connected: false };
	const models = await provider.fetchModels(host);
	return { models: models ?? [], connected: models !== null };
}

/** Pricing entry shape returned by GET /v1/pricing on the Naia gateway. */
interface GatewayPricingEntry {
	model_key: string;
	input_price_per_million: number;
	output_price_per_million: number;
	cached_price_per_million: number | null;
}

/**
 * Fetch live pricing from the Naia gateway and return updated Naia model list.
 *
 * The Naia gateway DB is the single source of truth for pricing.
 * This function pulls `GET /v1/pricing`, filters `vertexai:*` entries, and
 * overlays the live prices onto the static Naia provider model list.
 *
 * Returns null if the gateway is unreachable (caller should keep static pricing).
 */
export async function fetchNaiaPricing(
	gatewayHttpUrl: string,
): Promise<LlmModelMeta[] | null> {
	try {
		const resp = await fetch(`${gatewayHttpUrl}/v1/pricing`, {
			signal: AbortSignal.timeout(5000),
		});
		if (!resp.ok) return null;
		const entries: GatewayPricingEntry[] = await resp.json();

		const provider = providers.get("nextain");
		if (!provider) return null;

		// Build modelId → [input, output] from gateway DB
		const pricingMap = new Map<string, [number, number]>();
		for (const entry of entries) {
			if (!entry.model_key.startsWith("vertexai:")) continue;
			const modelId = entry.model_key.replace("vertexai:", "");
			pricingMap.set(modelId, [
				entry.input_price_per_million,
				entry.output_price_per_million,
			]);
		}

		// Return a new model list with live pricing applied
		return provider.models.map((m) => {
			const live = pricingMap.get(m.id);
			return live ? { ...m, pricing: live as [number, number] } : { ...m };
		});
	} catch {
		return null;
	}
}

/** Format model label with pricing (e.g. "Gemini 3 Pro (Pricing: $2.00 / $12.00)") and capability icons. */
export function formatModelLabel(model: LlmModelMeta): string {
	const isAsr = model.capabilities.includes("asr");
	const base = isAsr ? `${model.label} (전용)` : model.label;
	if (!model.pricing) return base;
	const [input, output] = model.pricing;
	// Use localized "Pricing" label if possible, or fallback to English
	const pricingLabel = typeof (globalThis as any).t === "function" ? (globalThis as any).t("settings.pricing") : "Pricing";
	return `${base} (${pricingLabel}: $${input.toFixed(3)} / $${output.toFixed(3)})`;
}

// -- Shared voice lists --

export const GEMINI_LIVE_VOICES: LlmVoiceMeta[] = [
	{ id: "Kore", label: "Kore (여성, 부드러움)" },
	{ id: "Puck", label: "Puck (남성, 익살)" },
	{ id: "Charon", label: "Charon (남성)" },
	{ id: "Aoede", label: "Aoede (여성)" },
	{ id: "Fenrir", label: "Fenrir (남성)" },
	{ id: "Leda", label: "Leda (여성)" },
	{ id: "Orus", label: "Orus (남성)" },
	{ id: "Zephyr", label: "Zephyr (중성)" },
];

export const OPENAI_REALTIME_VOICES: LlmVoiceMeta[] = [
	{ id: "alloy", label: "Alloy (중성)" },
	{ id: "ash", label: "Ash (남성)" },
	{ id: "ballad", label: "Ballad (남성)" },
	{ id: "coral", label: "Coral (여성)" },
	{ id: "echo", label: "Echo (남성)" },
	{ id: "sage", label: "Sage (여성)" },
	{ id: "shimmer", label: "Shimmer (여성)" },
	{ id: "verse", label: "Verse (남성)" },
	{ id: "marin", label: "Marin (여성)" },
	{ id: "cedar", label: "Cedar (남성)" },
];

// -- Provider registrations --

registerLlmProvider({
	id: "nextain",
	name: "Naia",
	description: "Naia Cloud — no API key needed.",
	descKey: "onboard.lab.description",
	requiresApiKey: false,
	requiresNaiaKey: true,
	defaultModel: "gemini-2.5-pro",
	models: [
		// -- Gemini 3.1 --------------------------------------------------------------------
		{
			id: "gemini-3.1-pro-preview",
			label: "Gemini 3.1 Pro",
			capabilities: ["llm"],
			pricing: [2.20, 13.20],
		},
		{
			id: "gemini-3.1-flash-lite-preview",
			label: "Gemini 3.1 Flash Lite",
			capabilities: ["llm"],
			pricing: [0.275, 1.65],
		},
		// -- Gemini 3 ----------------------------------------------------------------------
		{
			id: "gemini-3-flash-preview",
			label: "Gemini 3.0 Flash",
			capabilities: ["llm"],
			pricing: [0.55, 3.30],
		},
		// -- Gemini 2.5 --------------------------------------------------------------------
		{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", capabilities: ["llm"], pricing: [1.375, 11.0] },
		{
			id: "gemini-2.5-flash",
			label: "Gemini 2.5 Flash",
			capabilities: ["llm"],
			pricing: [0.33, 2.75],
		},
		{
			id: "gemini-2.5-flash-lite",
			label: "Gemini 2.5 Flash Lite",
			capabilities: ["llm"],
			pricing: [0.11, 0.44],
		},
		{
			id: "gemini-2.5-flash-live",
			label: "Gemini 2.5 Flash Live",
			capabilities: ["llm", "omni"],
			pricing: [0.55, 2.20],
			voiceSelectable: true,
			voices: [...GEMINI_LIVE_VOICES],
			transcriptProvided: true,
		},
	],
});

registerLlmProvider({
	id: "claude-code-cli",
	name: "Claude Code",
	description: "Claude Code CLI — uses local Claude installation.",
	descKey: "provider.claudeCodeCli.desc",
	requiresApiKey: false,
	defaultModel: "claude-sonnet-4-6",
	models: [
		{ id: "claude-opus-4-6", label: "Claude Opus 4.6", capabilities: ["llm"] },
		{
			id: "claude-sonnet-4-6",
			label: "Claude Sonnet 4.6",
			capabilities: ["llm"],
		},
		{
			id: "claude-haiku-4-5-20251001",
			label: "Claude Haiku 4.5",
			capabilities: ["llm"],
		},
	],
});

registerLlmProvider({
	id: "gemini",
	name: "Google Gemini",
	description: "Google Gemini API — requires Google API key.",
	descKey: "provider.apiKeyRequired",
	requiresApiKey: true,
	defaultModel: "gemini-3-flash-preview",
	models: [
		{
			id: "gemini-3-pro-preview",
			label: "Gemini 3 Pro",
			capabilities: ["llm"],
			pricing: [2.0, 12.0],
		},
		{
			id: "gemini-3-flash-preview",
			label: "Gemini 3.0 Flash",
			capabilities: ["llm"],
			pricing: [0.5, 3.0],
		},
		{
			id: "gemini-2.5-pro",
			label: "Gemini 2.5 Pro",
			capabilities: ["llm"],
			pricing: [1.25, 10.0],
		},
		{
			id: "gemini-2.5-flash",
			label: "Gemini 2.5 Flash",
			capabilities: ["llm"],
			pricing: [0.3, 2.5],
		},
		{
			id: "gemini-2.5-flash-live",
			label: "Gemini 2.5 Flash Live (실시간)",
			capabilities: ["llm", "omni"],
			voiceSelectable: true,
			voices: [...GEMINI_LIVE_VOICES],
			transcriptProvided: true,
		},
	],
});

registerLlmProvider({
	id: "openai",
	name: "OpenAI",
	description: "OpenAI GPT models — requires OpenAI API key.",
	descKey: "provider.apiKeyRequired",
	requiresApiKey: true,
	defaultModel: "gpt-4o",
	models: [
		{
			id: "gpt-4o",
			label: "GPT-4o",
			capabilities: ["llm"],
			pricing: [2.5, 10.0],
		},
		{
			id: "gpt-4o-realtime",
			label: "GPT-4o Realtime (실시간)",
			capabilities: ["llm", "omni"],
			voiceSelectable: true,
			voices: [...OPENAI_REALTIME_VOICES],
			transcriptProvided: true,
		},
	],
});

registerLlmProvider({
	id: "anthropic",
	name: "Anthropic",
	description: "Claude models — requires Anthropic API key.",
	descKey: "provider.apiKeyRequired",
	requiresApiKey: true,
	defaultModel: "claude-sonnet-4-6",
	models: [
		{
			id: "claude-opus-4-6",
			label: "Claude Opus 4.6",
			capabilities: ["llm"],
			pricing: [15.0, 75.0],
		},
		{
			id: "claude-sonnet-4-6",
			label: "Claude Sonnet 4.6",
			capabilities: ["llm"],
			pricing: [3.0, 15.0],
		},
		{
			id: "claude-haiku-4-5-20251001",
			label: "Claude Haiku 4.5",
			capabilities: ["llm"],
			pricing: [0.8, 4.0],
		},
	],
});

registerLlmProvider({
	id: "xai",
	name: "xAI",
	description: "Grok models — requires xAI API key.",
	descKey: "provider.apiKeyRequired",
	requiresApiKey: true,
	defaultModel: "grok-3-mini",
	models: [
		{
			id: "grok-3-mini",
			label: "Grok 3 Mini",
			capabilities: ["llm"],
			pricing: [0.3, 0.5],
		},
	],
});

registerLlmProvider({
	id: "zai",
	name: "Z.AI",
	description: "GLM models via Z.AI Coding Plan — requires Z.AI API key.",
	descKey: "provider.apiKeyRequired",
	requiresApiKey: true,
	defaultModel: "glm-5.1",
	models: [
		{
			id: "glm-5.1",
			label: "GLM 5.1",
			capabilities: ["llm"],
		},
		{
			id: "glm-5-turbo",
			label: "GLM 5 Turbo",
			capabilities: ["llm"],
		},
		{
			id: "glm-4.7",
			label: "GLM 4.7",
			capabilities: ["llm"],
		},
		{
			id: "glm-4.5-air",
			label: "GLM 4.5 Air",
			capabilities: ["llm"],
		},
	],
});

registerLlmProvider({
	id: "ollama",
	name: "Ollama",
	description: "Local Ollama models — no API key, runs on your machine.",
	descKey: "provider.localRequired",
	requiresApiKey: false,
	isLocal: true,
	defaultModel: "",
	models: [],
	async fetchModels(host) {
		try {
			const resp = await fetch(`${host}/api/tags`);
			if (!resp.ok) return null;
			const data = await resp.json();
			return (data.models ?? []).map(
				(m: {
					name: string;
					size?: number;
					details?: { quantization_level?: string; parameter_size?: string };
				}) => {
					const sizeGB = m.size ? `${(m.size / 1e9).toFixed(1)}GB` : "";
					const quant = m.details?.quantization_level ?? "";
					const params = m.details?.parameter_size ?? "";
					const extra = [params, sizeGB, quant].filter(Boolean).join(", ");
					return {
						id: m.name,
						label: extra ? `${m.name} (${extra})` : m.name,
						capabilities: ["llm"] as const,
					};
				},
			);
		} catch {
			return null;
		}
	},
});

registerLlmProvider({
	id: "vllm",
	name: "vLLM",
	description: "Local vLLM server — OpenAI-compatible API, no API key required.",
	descKey: "provider.localRequired",
	requiresApiKey: false,
	isLocal: true,
	defaultModel: "",
	models: [],
	async fetchModels(host) {
		try {
			const resp = await fetch(`${host}/v1/models`);
			if (!resp.ok) return null;
			const data = await resp.json();
			return (data.data ?? []).map((m: { id: string }) => {
				const mid = m.id.toLowerCase();
				const isAsr = mid.includes("asr") || mid.includes("whisper");
				const isOmni = mid.includes("minicpm-o") || mid.includes("minicpmo");
				return {
					id: m.id,
					label: isOmni ? `${m.id} (실시간)` : m.id,
					capabilities: (isAsr
						? ["asr"]
						: isOmni
							? ["llm", "omni"]
							: ["llm"]) as any[],
				};
			});
		} catch {
			return null;
		}
	},
});
