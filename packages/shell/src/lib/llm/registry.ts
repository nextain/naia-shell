import { MODEL_CAPABILITY_VALUES, type ModelCapability } from "../types.js";
import type {
	LlmModelMeta,
	LlmProviderMeta,
	LlmRoleId,
	ModelSortMode,
} from "./types";

const providers = new Map<string, LlmProviderMeta>();

/** Register an LLM provider. */
export function registerLlmProvider(meta: LlmProviderMeta): void {
	providers.set(meta.id, meta);
}

/** Get a registered LLM provider by id. */
export function getLlmProvider(id: string): LlmProviderMeta | undefined {
	return providers.get(id);
}

// UI display order (user-defined 2026-06-18): local/own-stack first, then by usage.
// Providers not listed here fall to the end (stable, in registration order).
// #602: 타사 클라우드 LLM API 공급자(openai/gemini/anthropic/xai/zai)는 제거했다 —
// 로그인=나이아 계정, 로그아웃=무료→로컬. 남는 건 나이아 계정·CLI(스킬)·로컬뿐이다.
const PROVIDER_DISPLAY_ORDER = [
	"nextain",
	"ollama",
	"vllm",
	"codex",
	"claude-code-cli",
	"grok",
];

/** List all registered LLM providers in the user-defined display order. */
export function listLlmProviders(): LlmProviderMeta[] {
	const rank = (id: string) => {
		const i = PROVIDER_DISPLAY_ORDER.indexOf(id);
		return i < 0 ? PROVIDER_DISPLAY_ORDER.length : i;
	};
	return Array.from(providers.values()).sort((a, b) => rank(a.id) - rank(b.id));
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
	capability: ModelCapability,
): boolean {
	return (
		getLlmModel(providerId, modelId)?.capabilities.includes(capability) ?? false
	);
}

/**
 * Check if a model is omni.
 * Falls back to model ID pattern for dynamically fetched models, such as vLLM.
 */
export function isOmniModel(providerId: string, modelId: string): boolean {
	if (modelHasCapability(providerId, modelId, "omni")) return true;
	const mid = modelId.toLowerCase();
	return (
		mid.includes("minicpm-o") ||
		mid.includes("minicpmo") ||
		// naia-<ver>-omni-<vram> (e.g. naia-0.9-omni-24g) — match the "omni" segment.
		mid.includes("omni") ||
		mid.includes("realtime")
	);
}

/** Get default model for a provider. */
export function getDefaultLlmModel(providerId: string): string {
	return providers.get(providerId)?.defaultModel ?? "";
}

/**
 * Naia-account ids that were deliberately retired from the `nextain` provider.
 * They move to the default even when the gateway still serves them:
 * #670 trimmed the picker to four cheap models (FR-NAIA-AZURE.1), and #603
 * removed the Naia Google live path.
 */
export const RETIRED_NEXTAIN_MODEL_IDS: ReadonlySet<string> = new Set([
	"gemini-3.1-flash-lite",
	"grok-4.3",
	"deepseek-v4-pro",
	"HCX-007",
	"HCX-DASH-002",
	"gpt-5.6-sol",
	"claude-opus-5",
	"gemini-3.5-flash",
	"azure-realtime",
	"naia-0.9-omni-24g",
	"gemini-2.5-flash-live",
]);

/**
 * Bare ids the Naia gateway currently serves, from `fetchNaiaModelMetadata`.
 * An entry counts when it has no operational status or its status is "live"
 * (e.g. `quota_blocked` does not count). `null` in → `null` out (catalog unknown).
 */
export function gatewayServedModelIds(
	metadata: ReadonlyMap<string, NaiaModelCatalogMetadata> | null,
): ReadonlySet<string> | null {
	if (metadata === null) return null;
	const served = new Set<string>();
	for (const [id, meta] of metadata.entries()) {
		if (
			meta.operationalStatus === undefined ||
			meta.operationalStatus === "live"
		) {
			served.add(id);
		}
	}
	return served;
}

export type NextainModelMigrationDecision =
	| { migrate: false; needsCatalog?: false }
	| { migrate: false; needsCatalog: true }
	| { migrate: true; to: string };

/**
 * Migrate a saved config model that is no longer registered on the Naia provider.
 *
 * Scoped intentionally to the "nextain" provider; other providers may accept
 * dynamic or provider-side model IDs that are not present in this UI catalogue.
 *
 * Rules (#248, #670, #707):
 * 1. providerId !== "nextain" → { migrate: false }
 * 2. provider not registered → { migrate: false }
 * 3. modelId is in the static nextain model list → { migrate: false }
 * 4. modelId is in RETIRED_NEXTAIN_MODEL_IDS →
 *    { migrate: true, to: provider.defaultModel }
 *    (regardless of gatewayServed)
 * 5. gatewayServed === undefined
 *    (caller has not looked at the gateway yet) →
 *    { migrate: false, needsCatalog: true }
 * 6. gatewayServed === null (catalog fetch failed) → { migrate: false }
 *    (never rewrite a user choice on missing information)
 * 7. gatewayServed.has(modelId) → { migrate: false }
 * 8. otherwise → { migrate: true, to: provider.defaultModel }
 */
export function shouldMigrateNextainModel(
	providerId: string,
	modelId: string,
	gatewayServed?: ReadonlySet<string> | null,
): NextainModelMigrationDecision {
	if (providerId !== "nextain") return { migrate: false };
	const provider = providers.get(providerId);
	if (!provider) return { migrate: false };
	if (provider.models.some((m) => m.id === modelId)) return { migrate: false };
	if (RETIRED_NEXTAIN_MODEL_IDS.has(modelId)) {
		return { migrate: true, to: provider.defaultModel };
	}
	if (gatewayServed === undefined) {
		return { migrate: false, needsCatalog: true };
	}
	if (gatewayServed === null) {
		return { migrate: false };
	}
	if (gatewayServed.has(modelId)) {
		return { migrate: false };
	}
	return { migrate: true, to: provider.defaultModel };
}

/** Check if a provider does not require either a provider key or a Naia key. */
export function isApiKeyOptional(providerId: string): boolean {
	const p = providers.get(providerId);
	if (!p) return false;
	return !p.requiresApiKey && !p.requiresNaiaKey;
}

/** 역할별 별도 provider 배열을 만들지 않고 공통 registry capability로 판정한다. */
export function providerSupportsRole(
	providerId: string,
	role: LlmRoleId,
): boolean {
	const provider = providers.get(providerId);
	if (!provider || provider.disabled) return false;
	return provider.supportedRoles?.includes(role) ?? true;
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
	cache_write_price_per_million?: number | null;
}

/**
 * Fetch live pricing from the Naia gateway and return an updated Naia model list.
 *
 * Static Naia models intentionally do not carry pricing; the gateway is the
 * source of truth. Returned model objects are cloned so registry state remains
 * immutable for callers that keep their own model records.
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

		const pricingMap = new Map<
			string,
			{
				pricing: [number, number];
				cachePricing?: { read: number | null; write: number | null };
			}
		>();
		for (const entry of entries) {
			// Naia serves several upstreams under the nextain provider: Azure
			// (grok/deepseek/gpt), Vertex (gemini), and the Korean domestic direct
			// providers Upstage (solar) and CLOVA (HCX). All must pick up live
			// pricing here, else domestic models show no price.
			const isNaiaRoute =
				entry.model_key.startsWith("vertexai:") ||
				entry.model_key.startsWith("azure:") ||
				entry.model_key.startsWith("upstage:") ||
				entry.model_key.startsWith("clova:");
			if (!isNaiaRoute) continue;
			const modelId = entry.model_key.slice(entry.model_key.indexOf(":") + 1);
			const read = entry.cached_price_per_million;
			const write = entry.cache_write_price_per_million ?? null;
			pricingMap.set(modelId, {
				pricing: [
					entry.input_price_per_million,
					entry.output_price_per_million,
				],
				...(read !== null || write !== null
					? { cachePricing: { read, write } }
					: {}),
			});
		}

		return provider.models.map((model) => {
			const livePricing = pricingMap.get(model.id);
			return livePricing ? { ...model, ...livePricing } : { ...model };
		});
	} catch {
		return null;
	}
}

/** One model in the gateway's full catalog (all providers), derived from `GET /v1/pricing`. */
export interface GatewayCatalogModel {
	/** Bare model id (provider prefix stripped, e.g. `gpt-4o`). */
	id: string;
	/** Provider prefix from `model_key` (e.g. `openai`, `anthropic`, `zai`). */
	provider: string;
	/** Display name if the source supplies one (`/v1/pricing` does not → id used). */
	name?: string;
	price?: { input?: number; output?: number };
}

/**
 * Fetch the gateway's **full multi-provider model catalog** via `GET /v1/pricing`
 * (E1 셸-직결, 구 `directToolCall(skill_config,models)` 대체 — 신코어 tool_request 미지원).
 *
 * The gateway is the SoT for "어떤 provider 의 어떤 모델이 가용한가 + 가격". `model_key` 는
 * `<provider>:<id>` 형식 — prefix 를 provider 로, suffix 를 bare id 로 분해. nextain(vertexai)
 * 가격은 `fetchNaiaPricing` 가 별도로 다루므로(중복 회피) 호출부가 grouping 시 dedup 한다.
 * 실패 = null(호출부는 static 폴백 유지).
 */
export async function fetchGatewayModelCatalog(
	gatewayHttpUrl: string,
): Promise<GatewayCatalogModel[] | null> {
	try {
		const resp = await fetch(`${gatewayHttpUrl}/v1/pricing`, {
			signal: AbortSignal.timeout(5000),
		});
		if (!resp.ok) return null;
		const entries: GatewayPricingEntry[] = await resp.json();
		return entries.map((e) => {
			const sep = e.model_key.indexOf(":");
			const provider = sep > 0 ? e.model_key.slice(0, sep) : "";
			const id = sep > 0 ? e.model_key.slice(sep + 1) : e.model_key;
			return {
				id,
				provider,
				price: {
					input: e.input_price_per_million,
					output: e.output_price_per_million,
				},
			};
		});
	} catch {
		return null;
	}
}

const _CAP_SET: ReadonlySet<string> = new Set(MODEL_CAPABILITY_VALUES);

function _isModelCapability(value: string): value is ModelCapability {
	return _CAP_SET.has(value);
}

/**
 * Fetch the gateway capability catalog (#365): `GET /v1/models`.
 *
 * The gateway is the SoT for model capabilities; this lets a newly-declared
 * capability reach the UI without a client release. Returns a map of bare model
 * id → capabilities, or null on failure (caller keeps the static fallback).
 */
export async function fetchNaiaModelCapabilities(
	gatewayHttpUrl: string,
): Promise<Map<string, ModelCapability[]> | null> {
	try {
		const resp = await fetch(`${gatewayHttpUrl}/v1/models`, {
			signal: AbortSignal.timeout(5000),
		});
		if (!resp.ok) return null;
		const entries = (await resp.json()) as {
			model_key: string;
			capabilities: string[];
		}[];
		const map = new Map<string, ModelCapability[]>();
		for (const entry of entries) {
			const bareKey = entry.model_key.includes(":")
				? (entry.model_key.split(":").pop() ?? entry.model_key)
				: entry.model_key;
			map.set(bareKey, (entry.capabilities ?? []).filter(_isModelCapability));
		}
		return map;
	} catch {
		return null;
	}
}

export interface NaiaModelCatalogMetadata {
	capabilities: ModelCapability[];
	supportsTools?: boolean;
	upstreamProvider?: string;
	lifecycle?: string;
	protocol?: string;
	operationalStatus?: string;
}

/** Fetch the richer `/v1/models` contract used for Naia route provenance and tool policy. */
export async function fetchNaiaModelMetadata(
	gatewayHttpUrl: string,
): Promise<Map<string, NaiaModelCatalogMetadata> | null> {
	try {
		const resp = await fetch(`${gatewayHttpUrl}/v1/models`, {
			signal: AbortSignal.timeout(5000),
		});
		if (!resp.ok) return null;
		const entries = (await resp.json()) as Array<{
			model_key: string;
			capabilities?: string[];
			supports_tools?: boolean;
			upstream_provider?: string;
			lifecycle?: string;
			protocol?: string;
			operational_status?: string;
		}>;
		const map = new Map<string, NaiaModelCatalogMetadata>();
		for (const entry of entries) {
			const id = entry.model_key.includes(":")
				? (entry.model_key.split(":").pop() ?? entry.model_key)
				: entry.model_key;
			map.set(id, {
				capabilities: (entry.capabilities ?? []).filter(_isModelCapability),
				...(typeof entry.supports_tools === "boolean"
					? { supportsTools: entry.supports_tools }
					: {}),
				...(typeof entry.upstream_provider === "string"
					? { upstreamProvider: entry.upstream_provider }
					: {}),
				...(typeof entry.lifecycle === "string"
					? { lifecycle: entry.lifecycle }
					: {}),
				...(typeof entry.protocol === "string"
					? { protocol: entry.protocol }
					: {}),
				...(typeof entry.operational_status === "string"
					? { operationalStatus: entry.operational_status }
					: {}),
			});
		}
		return map;
	} catch {
		return null;
	}
}

export function applyNaiaModelMetadata(
	models: LlmModelMeta[],
	metadata: Map<string, NaiaModelCatalogMetadata> | null,
): LlmModelMeta[] {
	return models.map((model) => {
		if (!metadata) {
			return { ...model, upstreamProvider: "unknown", lifecycle: "unknown" };
		}
		const live = metadata.get(model.id);
		if (!live) {
			return {
				...model,
				upstreamProvider: "unknown",
				lifecycle: "unknown",
				operationalStatus: "catalog_missing",
				comingSoon: true,
			};
		}
		const merged = {
			...model,
			...(live.capabilities.length > 0
				? { capabilities: live.capabilities }
				: {}),
			...(live.supportsTools !== undefined
				? { supportsTools: live.supportsTools }
				: {}),
			...(live.upstreamProvider
				? { upstreamProvider: live.upstreamProvider }
				: {}),
			...(live.lifecycle ? { lifecycle: live.lifecycle } : {}),
			...(live.protocol ? { protocol: live.protocol } : {}),
			...(live.operationalStatus
				? { operationalStatus: live.operationalStatus }
				: {}),
			...(live.operationalStatus
				? { comingSoon: live.operationalStatus !== "live" }
				: {}),
		};
		return merged;
	});
}

/**
 * Apply gateway-declared capabilities onto a model list (gateway = SoT).
 * Models the gateway doesn't mention keep their static capabilities (fallback).
 * Returns cloned models so registry state stays immutable.
 */
export function applyCapabilityOverrides(
	models: LlmModelMeta[],
	capMap: Map<string, ModelCapability[]> | null,
): LlmModelMeta[] {
	if (!capMap) return models;
	return models.map((model) => {
		const caps = capMap.get(model.id);
		return caps && caps.length > 0 ? { ...model, capabilities: caps } : model;
	});
}

/** Format model label with pricing and capability hints. */
export function formatModelLabel(model: LlmModelMeta): string {
	const tFn =
		typeof (globalThis as any).t === "function"
			? ((globalThis as any).t as (k: string) => string)
			: null;
	const isAsr = model.capabilities.includes("asr");
	let label = isAsr ? `${model.label} (ASR)` : model.label;
	if (model.pricing) {
		const [input, output] = model.pricing;
		const pricingLabel = tFn
			? tFn("settings.pricingPerMillionTokens")
			: "Price per 1M tokens";
		const inputLabel = tFn ? tFn("settings.priceInput") : "Input";
		const outputLabel = tFn ? tFn("settings.priceOutput") : "Output";
		label = `${label} (${pricingLabel}: ${inputLabel} $${input.toFixed(3)} / ${outputLabel} $${output.toFixed(3)})`;
	}
	if (model.comingSoon) {
		label = `${label} (${tFn ? tFn("settings.comingSoonTag") : "준비중"})`;
	}
	return label;
}

// Product recommendation order for general chat, reviewed 2026-08-08.
// This is a tier-based Naia recommendation, not a fabricated cross-vendor score.
// Evidence: Microsoft Foundry benchmark methodology and model cards, plus the
// official Google/DeepSeek model cards. The sources do not expose one directly
// comparable score for every route, so tiers and intended workloads are used.
// https://learn.microsoft.com/azure/ai-foundry/concepts/model-benchmarks
// https://ai.azure.com/catalog/models/gpt-5.6-sol
// https://ai.azure.com/catalog/models/grok-4.3
// https://ai.azure.com/catalog/models/DeepSeek-V4-Pro
// https://developers.openai.com/api/docs/models/gpt-5.6-luna
// https://deepmind.google/models/gemini/flash/
// https://deepmind.google/models/model-cards/gemini-3-1-flash-lite/
// https://api-docs.deepseek.com/news/news260424/
// DeepSeek V4 Flash (tier added 2026-08-08): official GA release (0731) —
// https://ai.azure.com/catalog/models/DeepSeek-V4-Flash (Azure model card: "Flash-Max
// achieves comparable reasoning performance to Pro given a larger thinking budget,
// though its smaller activated-parameter scale places it slightly behind on pure
// knowledge tasks and the most complex agentic workflows"); DeepSeek's own release
// notes report the GA Flash beating the V4-Pro *preview* build across nine agent
// benchmarks; Artificial Analysis lists Flash-0731 (Reasoning, Max Effort) at
// Intelligence Index 52, #3/101 open-weight models (median 26) —
// https://artificialanalysis.ai/models/deepseek-v4-flash . Tiered alongside
// deepseek-v4-pro rather than the lighter gemini-3.1-flash-lite/gpt-5.6-luna tier.
const NAIA_GENERAL_CHAT_RECOMMENDATION: Readonly<Record<string, number>> = {
	"gpt-5.6-sol": 1,
	"gemini-3.7-flash": 1,
	"gemini-3.1-pro-preview": 1,
	"grok-4.3": 2,
	"deepseek-v4-pro": 2,
	"deepseek-v4-flash": 2,
	"gemini-3.6-flash": 2,
	"gemini-3.5-flash": 2,
	"solar-pro4": 2,
	"HCX-007": 2,
	"gpt-5.6-luna": 3,
	"solar-mini": 3,
	"HCX-DASH-002": 3,
	"gemini-3.5-flash-lite": 3,
	"gemini-3.1-flash-lite": 3,
	"azure-realtime": 4,
	"naia-0.9-omni-24g": 5,
	"claude-opus-5": 5,
};

/** General-chat cost estimate: three uncached input tokens per output token. */
export function getModelPriceScore(model: LlmModelMeta): number {
	return model.pricing
		? model.pricing[0] * 3 + model.pricing[1]
		: Number.POSITIVE_INFINITY;
}

/** Return a stable, non-mutating view of the model catalog. */
export function sortModels(
	models: readonly LlmModelMeta[],
	mode: ModelSortMode,
): LlmModelMeta[] {
	return models
		.map((model, index) => ({ model, index }))
		.sort((left, right) => {
			if (left.model.comingSoon !== right.model.comingSoon) {
				return left.model.comingSoon ? 1 : -1;
			}
			let delta = 0;
			if (mode === "price") {
				delta =
					getModelPriceScore(left.model) - getModelPriceScore(right.model);
			} else {
				delta =
					(NAIA_GENERAL_CHAT_RECOMMENDATION[left.model.id] ??
						Number.POSITIVE_INFINITY) -
					(NAIA_GENERAL_CHAT_RECOMMENDATION[right.model.id] ??
						Number.POSITIVE_INFINITY);
			}
			return Number.isNaN(delta) || delta === 0
				? left.index - right.index
				: delta;
		})
		.map(({ model }) => model);
}

/**
 * 대화 모델로 고를 수 있는 후보만 남긴다. ASR(전용 STT) 모델은 대화 선택지가
 * 아니므로 제외한다 — 두뇌 모델 선택기 `<select>` 가 렌더하는 집합과 같다.
 */
export function selectableConversationModels(
	models: readonly LlmModelMeta[],
): LlmModelMeta[] {
	return models.filter((model) => !model.capabilities.includes("asr"));
}

/**
 * 선택기 숨김 규칙 (에픽 #589 할 일 2): 제공자가 고를 수 있는 대화 모델이
 * 하나뿐이면 모델 선택기를 그리지 않는다. 판정은 등록부(모델 목록)로 한다 —
 * 나이아 계정이 게이트웨이에서 단일 모델로 줄면 이 규칙이 자동으로 선택기를 숨긴다.
 * 호출부는 이미 comingSoon 을 거른 표시용 목록을 넘긴다.
 */
export function shouldHideModelPicker(
	models: readonly LlmModelMeta[],
): boolean {
	return selectableConversationModels(models).length <= 1;
}

// ─── Provider registrations ─────────────────────────────────────────────────

registerLlmProvider({
	id: "nextain",
	name: "Naia",
	description: "Naia Cloud — no API key needed.",
	descKey: "onboard.lab.description",
	requiresApiKey: false,
	requiresNaiaKey: true,
	defaultModel: "deepseek-v4-flash",
	// #670: Naia-account / nextain picker is the four cheap chat models.
	// Codex ChatGPT models stay on the codex provider below. Retired ids
	// migrate via shouldMigrateNextainModel and other gateway-served ids are
	// kept (#707).
	models: [
		{
			// Gateway routes/prices this model and advertises verified tool calling.
			// Keep the offline fallback aligned so a transient catalog outage cannot
			// silently strip Shell skills from the default model.
			id: "deepseek-v4-flash",
			label: "DeepSeek V4 Flash",
			capabilities: ["llm"],
			supportsTools: true,
			upstreamProvider: "unknown",
			lifecycle: "unknown",
		},
		{
			// Korean domestic. Tool calling verified against the Upstage
			// deployment and wired through the gateway (naia-anyllm#64).
			id: "solar-pro4",
			label: "Solar Pro 4",
			capabilities: ["llm"],
			supportsTools: true,
			upstreamProvider: "unknown",
			lifecycle: "unknown",
		},
		{
			id: "solar-mini",
			label: "Solar Mini",
			capabilities: ["llm"],
			supportsTools: true,
			upstreamProvider: "unknown",
			lifecycle: "unknown",
		},
		{
			id: "gpt-5.6-luna",
			label: "Naia Luna",
			capabilities: ["llm"],
			supportsTools: true,
			upstreamProvider: "unknown",
			lifecycle: "unknown",
		},
	],
});

registerLlmProvider({
	id: "claude-code-cli",
	name: "Claude Code",
	description: "Claude Code CLI — uses local Claude installation.",
	descKey: "provider.claudeCodeCli.desc",
	requiresApiKey: false,
	supportedRoles: ["expert", "main", "sub"],
	defaultModel: "claude-sonnet-5",
	models: [
		{ id: "claude-fable-5", label: "Claude Fable 5", capabilities: ["llm"] },
		{ id: "claude-opus-4-8", label: "Claude Opus 4.8", capabilities: ["llm"] },
		{ id: "claude-sonnet-5", label: "Claude Sonnet 5", capabilities: ["llm"] },
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
	id: "codex",
	name: "Codex",
	description: "Codex app-server — uses your local Codex login.",
	descKey: "provider.codex.desc",
	requiresApiKey: false,
	supportedRoles: ["expert", "main", "sub"],
	// Codex CLI + ChatGPT 계정 라인업: gpt-5.6 sol/terra/luna + gpt-5.5.
	// gpt-5.4 는 ChatGPT 연동 Codex가 거절한다(invalid_request_error).
	defaultModel: "gpt-5.6-sol",
	models: [
		{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol (Codex)", capabilities: ["llm"] },
		{
			id: "gpt-5.6-terra",
			label: "GPT-5.6 Terra (Codex)",
			capabilities: ["llm"],
		},
		{
			id: "gpt-5.6-luna",
			label: "GPT-5.6 Luna (Codex)",
			capabilities: ["llm"],
		},
		{ id: "gpt-5.5", label: "GPT-5.5 (Codex)", capabilities: ["llm"] },
	],
});

registerLlmProvider({
	id: "grok",
	name: "Grok",
	description: "Grok Build CLI — uses local SuperGrok / X Premium+ login.",
	descKey: "provider.grok.desc",
	requiresApiKey: false,
	supportedRoles: ["expert", "main", "sub"],
	defaultModel: "grok-4.6",
	models: [
		{ id: "grok-4.6", label: "Grok 4.6", capabilities: ["llm"] },
		{ id: "grok-4.5", label: "Grok 4.5", capabilities: ["llm"] },
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
				(model: {
					name: string;
					size?: number;
					details?: {
						quantization_level?: string;
						parameter_size?: string;
					};
				}) => {
					const sizeGB = model.size ? `${(model.size / 1e9).toFixed(1)}GB` : "";
					const quant = model.details?.quantization_level ?? "";
					const params = model.details?.parameter_size ?? "";
					const extra = [params, sizeGB, quant].filter(Boolean).join(", ");
					return {
						id: model.name,
						label: extra ? `${model.name} (${extra})` : model.name,
						capabilities: ["llm"] as ModelCapability[],
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
	// 이름이 vLLM 이라 vLLM 으로 띄운 서버만 되는 것으로 읽힌다. 실제로는
	// /v1/models 와 /v1/chat/completions 를 내주는 OpenAI 호환 서버면 무엇이든
	// 붙는다. openai 공급자는 models 가 하드코딩이고 fetchModels 가 없어 사용자가
	// 자기 서버의 모델을 고를 수 없으므로, 자체 서버를 붙이는 길은 여기뿐이다 (#533).
	// id 는 vllm 그대로 둔다 — 바꾸면 기존 설정이 깨진다.
	name: "vLLM / OpenAI-compatible",
	description:
		"Any server that exposes an OpenAI-compatible API — vLLM, llama.cpp, or your own. No API key. Models are read from the host.",
	descKey: "provider.openaiCompatible",
	requiresApiKey: false,
	isLocal: true,
	defaultModel: "",
	models: [],
	async fetchModels(host) {
		try {
			const resp = await fetch(`${host}/v1/models`);
			if (!resp.ok) return null;
			const data = await resp.json();
			return (data.data ?? []).map((model: { id: string }) => {
				const mid = model.id.toLowerCase();
				const isAsr = mid.includes("asr") || mid.includes("whisper");
				const isOmni = mid.includes("minicpm-o") || mid.includes("minicpmo");
				const capabilities: ModelCapability[] = isAsr
					? ["asr"]
					: isOmni
						? ["llm", "omni"]
						: ["llm"];
				return {
					id: model.id,
					label: isOmni ? `${model.id} (Realtime)` : model.id,
					capabilities,
				};
			});
		} catch {
			return null;
		}
	},
});
