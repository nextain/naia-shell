import type { LlmRoleConfig } from "../config";
import {
	KIOSK_DEMO_LLM_MODEL,
	KIOSK_DEMO_THINKING_LEVEL,
	resolveKioskDemoMainModel,
} from "../config-seed";
import { isKioskDemo } from "../kiosk-demo/flag";
import type { LlmModelMeta } from "./types";
import {
	fetchNaiaModelMetadata,
	gatewayServedModelIds,
	getDefaultLlmModel,
	sortModels,
} from "./registry";

export const LOCAL_SMALL_MODEL = "huihui_ai/qwen3.5-abliterated:4B";

export function smallModelChoices(models: readonly LlmModelMeta[]): LlmModelMeta[] {
 return models.filter(model => !/nano/i.test(model.id) && !model.comingSoon && !model.capabilities.includes("asr"));
}

export function defaultSmallModel(models: readonly LlmModelMeta[]): LlmRoleConfig {
	if (isKioskDemo()) {
		const kiosk = smallModelChoices(models).find(model => model.id.toLowerCase() === KIOSK_DEMO_LLM_MODEL);
		return kiosk ? { provider: "nextain", model: kiosk.id, thinkingLevel: KIOSK_DEMO_THINKING_LEVEL } : { inherit: "main" };
	}
	const choices = smallModelChoices(models);
	const preferred = ["gpt-6-luna", "deepseek-v4.1-flash", "gpt-5.6-luna"];
	const selected = preferred.map(id => choices.find(model => model.id.toLowerCase() === id)).find((model): model is LlmModelMeta => Boolean(model));
	return selected ? { provider: "nextain", model: selected.id, thinkingLevel: "low" } : { inherit: "main" };
}

export function defaultThinkingLevel(modelId: string): "high" | "xhigh" | "max" | undefined {
	if (modelId === "gpt-6-luna") return "high";
	if (modelId === "deepseek-v4.1-flash" || modelId === "gpt-6.1-terra") return "xhigh";
	return undefined;
}

/** The registered default is the offline fallback when the gateway list is unavailable. */
export function fallbackNaiaMainModel(): LlmRoleConfig {
	const model = getDefaultLlmModel("nextain");
	return { provider: "nextain", model, thinkingLevel: defaultThinkingLevel(model) };
}

export async function fetchNaiaChatModels(gatewayUrl: string): Promise<LlmModelMeta[] | null> {
	const metadata = await fetchNaiaModelMetadata(gatewayUrl);
	if (!metadata) return null;
	const served = gatewayServedModelIds(metadata);
	return Array.from(metadata, ([id, { capabilities }]) => ({
		id,
		label: id,
		capabilities,
	})).filter((model) => served?.has(model.id) && model.capabilities.includes("llm"));
}

/** Only select a recommended server model actually reported by the catalog. */
export function defaultMainModel(models: readonly LlmModelMeta[]): LlmRoleConfig | undefined {
	const kiosk = isKioskDemo();
	const eligible = smallModelChoices(models);
	if (kiosk) {
		const target = resolveKioskDemoMainModel().toLowerCase();
		const selected = eligible.find((model) => model.id.toLowerCase() === target);
		if (selected) return { provider: "nextain", model: selected.id, thinkingLevel: KIOSK_DEMO_THINKING_LEVEL };
	}
	const choices = eligible.filter((model) => model.id !== "solar-mini");
	const preferred = kiosk
		? ["deepseek-v4.1-flash", "gpt-6.1-terra", "gpt-6-luna", "solar-pro4"]
		: ["gpt-6-luna", "deepseek-v4.1-flash", "gpt-6.1-terra", "solar-pro4"];
	const first = preferred
		.map((id) => choices.find((model) => model.id === id))
		.find((model) => model !== undefined) ?? sortModels(choices, "recommended")[0];
	if (!first) return undefined;
	const thinkingLevel = kiosk && first.id === "gpt-6-luna" ? "max" : defaultThinkingLevel(first.id);
	return { provider: "nextain", model: first.id, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

/** Preserve live-only models while applying fresher metadata for known IDs. */
export function mergeCatalogModels(base: readonly LlmModelMeta[], updates: readonly LlmModelMeta[]): LlmModelMeta[] {
 const byId = new Map(base.map(model => [model.id, model]));
 for (const model of updates) byId.set(model.id, { ...byId.get(model.id), ...model });
 return [...byId.values()];
}
