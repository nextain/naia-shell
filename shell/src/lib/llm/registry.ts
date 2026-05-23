import type { LlmModelMeta, LlmProviderMeta, LlmVoiceMeta } from "./types";
import {
  listProviders as agentListProviders,
  fetchNaiaPricing as agentFetchNaiaPricing,
  GEMINI_LIVE_VOICES as agentGeminiVoices,
} from "@nextain/agent-providers/registry";

// ─── UI-specific overlay data ────────────────────────────────────────────────

const UI_OVERLAY: Record<string, { descKey?: string; disabled?: boolean; apiKeyConfigField?: string }> = {
  nextain: { descKey: "onboard.lab.description" },
  "claude-code-cli": { descKey: "provider.claudeCodeCli.desc" },
  gemini: { descKey: "provider.apiKeyRequired" },
  openai: { descKey: "provider.apiKeyRequired" },
  anthropic: { descKey: "provider.apiKeyRequired" },
  xai: { descKey: "provider.apiKeyRequired" },
  zai: { descKey: "provider.apiKeyRequired" },
  ollama: { descKey: "provider.localRequired" },
  vllm: { descKey: "provider.localRequired" },
};

// ─── Provider map (local state for UI consumers) ─────────────────────────────

const providers = new Map<string, LlmProviderMeta>();

function buildProviders(): void {
  for (const p of agentListProviders()) {
    const ui = UI_OVERLAY[p.id] ?? {};

    providers.set(p.id, {
      ...p,
      models: p.models as LlmModelMeta[],
      fetchModels: p.fetchModels as ((host: string) => Promise<LlmModelMeta[] | null>) | undefined,
      descKey: ui.descKey,
      disabled: ui.disabled,
      apiKeyConfigField: ui.apiKeyConfigField,
    });
  }
}
buildProviders();

// ─── Registry API (preserved for backward compat) ────────────────────────────

export function registerLlmProvider(meta: LlmProviderMeta): void {
  providers.set(meta.id, meta);
}

export function getLlmProvider(id: string): LlmProviderMeta | undefined {
  return providers.get(id);
}

export function listLlmProviders(): LlmProviderMeta[] {
  return Array.from(providers.values());
}

export function getLlmModel(providerId: string, modelId: string): LlmModelMeta | undefined {
  return providers.get(providerId)?.models.find((m) => m.id === modelId);
}

export function modelHasCapability(
  providerId: string,
  modelId: string,
  capability: import("../types.js").ModelCapability,
): boolean {
  return getLlmModel(providerId, modelId)?.capabilities.includes(capability) ?? false;
}

export function isOmniModel(providerId: string, modelId: string): boolean {
  if (modelHasCapability(providerId, modelId, "omni")) return true;
  const mid = modelId.toLowerCase();
  return mid.includes("minicpm-o") || mid.includes("minicpmo");
}

export function getDefaultLlmModel(providerId: string): string {
  return providers.get(providerId)?.defaultModel ?? "";
}

export function shouldMigrateNextainModel(
  providerId: string,
  modelId: string,
): { migrate: false } | { migrate: true; to: string } {
  if (providerId !== "nextain") return { migrate: false };
  const provider = providers.get(providerId);
  if (!provider) return { migrate: false };
  if (provider.models.some((m) => m.id === modelId)) return { migrate: false };
  return { migrate: true, to: provider.defaultModel };
}

export function isApiKeyOptional(providerId: string): boolean {
  const p = providers.get(providerId);
  if (!p) return false;
  return !p.requiresApiKey && !p.requiresNaiaKey;
}

export function getStaticModelsRecord(): Record<string, LlmModelMeta[]> {
  const record: Record<string, LlmModelMeta[]> = {};
  for (const p of providers.values()) {
    record[p.id] = [...p.models];
  }
  return record;
}

export async function fetchOllamaModels(
  host: string,
): Promise<{ models: LlmModelMeta[]; connected: boolean }> {
  const provider = providers.get("ollama");
  if (!provider?.fetchModels) return { models: [], connected: false };
  const models = await provider.fetchModels(host);
  return { models: models ?? [], connected: models !== null };
}

export async function fetchVllmModels(
  host: string,
): Promise<{ models: LlmModelMeta[]; connected: boolean }> {
  const provider = providers.get("vllm");
  if (!provider?.fetchModels) return { models: [], connected: false };
  const models = await provider.fetchModels(host);
  return { models: models ?? [], connected: models !== null };
}

export async function fetchNaiaPricing(
  gatewayHttpUrl: string,
): Promise<LlmModelMeta[] | null> {
  return agentFetchNaiaPricing(gatewayHttpUrl) as Promise<LlmModelMeta[] | null>;
}

export function formatModelLabel(model: LlmModelMeta): string {
  const isAsr = model.capabilities.includes("asr");
  const base = isAsr ? `${model.label} (전용)` : model.label;
  if (!model.pricing) return base;
  const [input, output] = model.pricing;
  const pricingLabel =
    typeof (globalThis as any).t === "function"
      ? (globalThis as any).t("settings.pricing")
      : "Pricing";
  return `${base} (${pricingLabel}: $${input.toFixed(3)} / $${output.toFixed(3)})`;
}

// ─── Shared voice lists ──────────────────────────────────────────────────────

export const GEMINI_LIVE_VOICES: LlmVoiceMeta[] = agentGeminiVoices as LlmVoiceMeta[];

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
