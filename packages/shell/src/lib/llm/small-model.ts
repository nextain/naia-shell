import type { LlmRoleConfig } from "../config";
import {
	KIOSK_DEMO_LLM_MODEL,
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
 const luna = smallModelChoices(models).find(model => model.id.toLowerCase() === KIOSK_DEMO_LLM_MODEL);
 return luna ? { provider: "nextain", model: luna.id, thinkingLevel: "low" } : { inherit: "main" };
}

/** Only select a recommended server model actually reported by the catalog. */
export function defaultMainModel(models: readonly LlmModelMeta[]): LlmRoleConfig | undefined {
 if (isKioskDemo()) {
  const target = resolveKioskDemoMainModel().toLowerCase();
  const luna = smallModelChoices(models).find(model => model.id.toLowerCase() === target);
  if (luna) return { provider: "nextain", model: luna.id };
 }
 const first = sortModels(smallModelChoices(models).filter(model => model.id !== "solar-mini"), "recommended")[0];
 if (!first) return undefined;
 return { provider: "nextain", model: first.id, ...(first.id === "gpt-6.1-terra" ? { thinkingLevel: "xhigh" as const } : {}) };
}

/** Preserve live-only models while applying fresher metadata for known IDs. */
export function mergeCatalogModels(base: readonly LlmModelMeta[], updates: readonly LlmModelMeta[]): LlmModelMeta[] {
 const byId = new Map(base.map(model => [model.id, model]));
 for (const model of updates) byId.set(model.id, { ...byId.get(model.id), ...model });
 return [...byId.values()];
}
