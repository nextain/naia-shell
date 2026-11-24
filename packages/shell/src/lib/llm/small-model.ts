import type { LlmRoleConfig } from "../config";
import {
	KIOSK_DEMO_LLM_MODEL,
	KIOSK_DEMO_THINKING_LEVEL,
	resolveKioskDemoMainModel,
} from "../config-seed";
import { isKioskDemo } from "../kiosk-demo/flag";
import type { LlmModelMeta } from "./types";
import { sortModels } from "./registry";

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
	const preferred = ["deepseek-v4.1-flash", "gpt-6-luna", "gpt-5.6-luna"];
	const selected = preferred.map(id => choices.find(model => model.id.toLowerCase() === id)).find((model): model is LlmModelMeta => Boolean(model));
	return selected ? { provider: "nextain", model: selected.id, thinkingLevel: "low" } : { inherit: "main" };
}

export function defaultThinkingLevel(modelId: string): "xhigh" | "max" | undefined {
	if (modelId === "gpt-6-luna") return "max";
	if (modelId === "deepseek-v4.1-flash" || modelId === "gpt-6.1-terra") return "xhigh";
	return undefined;
}

/** Only select a recommended server model actually reported by the catalog. */
export function defaultMainModel(models: readonly LlmModelMeta[]): LlmRoleConfig | undefined {
 if (isKioskDemo()) {
  const target = resolveKioskDemoMainModel().toLowerCase();
  const luna = smallModelChoices(models).find(model => model.id.toLowerCase() === target);
  if (luna) return { provider: "nextain", model: luna.id, thinkingLevel: KIOSK_DEMO_THINKING_LEVEL };
 }
	const choices = smallModelChoices(models).filter(model => model.id !== "solar-mini");
	const first = ["deepseek-v4.1-flash", "gpt-6.1-terra", "gpt-6-luna", "solar-pro4"].map(id => choices.find(model => model.id === id)).find((model): model is LlmModelMeta => Boolean(model))
		?? sortModels(choices, "recommended")[0];
	if (!first) return undefined;
	const thinkingLevel = defaultThinkingLevel(first.id);
	return { provider: "nextain", model: first.id, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

/** Preserve live-only models while applying fresher metadata for known IDs. */
export function mergeCatalogModels(base: readonly LlmModelMeta[], updates: readonly LlmModelMeta[]): LlmModelMeta[] {
 const byId = new Map(base.map(model => [model.id, model]));
 for (const model of updates) byId.set(model.id, { ...byId.get(model.id), ...model });
 return [...byId.values()];
}
