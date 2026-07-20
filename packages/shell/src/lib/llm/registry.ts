import { MODEL_CAPABILITY_VALUES, type ModelCapability } from "../types.js";
import type { LlmModelMeta, LlmProviderMeta, LlmRoleId, LlmVoiceMeta } from "./types";

const NAIA_PRICE_MARKUP = 1.1;

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
const PROVIDER_DISPLAY_ORDER = [
	"nextain", "ollama", "vllm", "codex", "claude-code-cli", "zai", "openai", "gemini", "xai",
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
 * Migrate a saved config model that is no longer registered on the Naia provider.
 *
 * Scoped intentionally to the "nextain" provider; other providers may accept
 * dynamic or provider-side model IDs that are not present in this UI catalogue.
 */
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

/** Check if a provider does not require either a provider key or a Naia key. */
export function isApiKeyOptional(providerId: string): boolean {
	const p = providers.get(providerId);
	if (!p) return false;
	return !p.requiresApiKey && !p.requiresNaiaKey;
}

/** 역할별 별도 provider 배열을 만들지 않고 공통 registry capability로 판정한다. */
export function providerSupportsRole(providerId: string, role: LlmRoleId): boolean {
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

		const pricingMap = new Map<string, [number, number]>();
		for (const entry of entries) {
			if (!entry.model_key.startsWith("vertexai:")) continue;
			const modelId = entry.model_key.replace("vertexai:", "");
			pricingMap.set(modelId, [
				entry.input_price_per_million * NAIA_PRICE_MARKUP,
				entry.output_price_per_million * NAIA_PRICE_MARKUP,
			]);
		}

		return provider.models.map((model) => {
			const pricing = pricingMap.get(model.id);
			return pricing ? { ...model, pricing } : { ...model };
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
		const pricingLabel = tFn ? tFn("settings.pricing") : "Pricing";
		label = `${label} (${pricingLabel}: $${input.toFixed(3)} / $${output.toFixed(3)})`;
	}
	if (model.comingSoon) {
		label = `${label} (${tFn ? tFn("settings.comingSoonTag") : "준비중"})`;
	}
	return label;
}

// ─── Shared voice lists ──────────────────────────────────────────────────────

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

// ─── Provider registrations ─────────────────────────────────────────────────

registerLlmProvider({
	id: "nextain",
	name: "Naia",
	description: "Naia Cloud — no API key needed.",
	descKey: "onboard.lab.description",
	requiresApiKey: false,
	requiresNaiaKey: true,
	defaultModel: "gemini-3.1-flash-lite",
	// 사용자 확정 model lineup (순서 갱신, 2026-06-03):
	//   1) Gemini 3.1 Flash Lite  2) Naia Local (own GPU)
	//   3) Gemini 3.5 Flash  4) Gemini 2.5 Flash Live (Realtime Voice)
	//   5) Naia 0.9 Omni 24G (Realtime Voice) — 아직 미라이브: comingSoon 플래그로
	//      맨 아래에 "(준비중)" 표기, 선택해도 Apply(저장) 버튼 비활성.
	// Naia 공식 명칭 컨벤션: {모델명}-{버전}-{모델성격}-{필요vram} = naia-0.9-omni-24g
	// (SoT: naia-model-infra MODEL-NAMING.md). 서비스명 naia-talk 폐기 — 모델명으로 통합.
	// 2.5-flash-live 와 naia-omni 둘 다 realtime voice — 표기 통일.
	models: [
		{
			id: "gemini-3.1-flash-lite",
			label: "Gemini 3.1 Flash Lite",
			capabilities: ["llm"],
		},
		{
			// Naia Local — run the omni-24g container on your OWN GPU and point
			// Naia OS at it. Same realtime-voice wire as naia-0.9-omni-24g, but
			// the WebSocket goes direct to a local ws:// address (set in Settings)
			// instead of the cloud gateway. The logged-in Naia key is reused so the
			// container validates the subscription (no key input). id starts with
			// "naia-" + the omni capability → routes to liveProvider "naia-omni".
			id: "naia-local",
			label: "Naia Local (Realtime Voice · own GPU)",
			capabilities: ["llm", "omni"],
			transcriptProvided: true,
		},
		{
			id: "gemini-3.5-flash",
			label: "Gemini 3.5 Flash",
			capabilities: ["llm"],
		},
		{
			id: "gemini-2.5-flash-live",
			label: "Gemini 2.5 Flash Live (Realtime Voice)",
			capabilities: ["llm", "omni"],
			voiceSelectable: true,
			voices: [...GEMINI_LIVE_VOICES],
			transcriptProvided: true,
		},
		{
			// Not yet live. Kept registered so saved configs still resolve, but
			// flagged comingSoon → rendered LAST with a "(준비중)" tag and the
			// Apply (save) button is blocked while it is the selected model.
			id: "naia-0.9-omni-24g",
			label: "Naia 0.9 Omni 24G (Realtime Voice)",
			capabilities: ["llm", "omni"],
			transcriptProvided: true,
			comingSoon: true,
		},
	],
});

registerLlmProvider({
	id: "claude-code-cli",
	name: "Claude Code",
	description: "Claude Code CLI — uses local Claude installation.",
	descKey: "provider.claudeCodeCli.desc",
	requiresApiKey: false,
	supportedRoles: ["main"],
	defaultModel: "claude-sonnet-4-6",
	models: [
		{ id: "claude-opus-4-8", label: "Claude Opus 4.8", capabilities: ["llm"] },
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
	supportedRoles: ["main"],
	defaultModel: "gpt-5.4",
	models: [
		{ id: "gpt-5.4", label: "GPT-5.4 (Codex)", capabilities: ["llm"] },
	],
});

registerLlmProvider({
	id: "gemini",
	name: "Google Gemini",
	description: "Google Gemini API — requires Google API key.",
	descKey: "provider.apiKeyRequired",
	requiresApiKey: true,
	defaultModel: "gemini-3.5-flash",
	models: [
		{
			id: "gemini-3.5-flash",
			label: "Gemini 3.5 Flash",
			capabilities: ["llm"],
		},
		{
			id: "gemini-3.1-flash-lite",
			label: "Gemini 3.1 Flash Lite",
			capabilities: ["llm"],
		},
		{
			id: "gemini-3.1-pro-preview",
			label: "Gemini 3.1 Pro Preview",
			capabilities: ["llm"],
			pricing: [2.0, 12.0],
		},
		{
			id: "gemini-3-flash-preview",
			label: "Gemini 3 Flash Preview",
			capabilities: ["llm"],
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
			label: "Gemini 2.5 Flash Live (Realtime)",
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
	defaultModel: "gpt-5.5",
	models: [
		{ id: "gpt-5.5", label: "GPT-5.5", capabilities: ["llm"] },
		{ id: "gpt-5.4", label: "GPT-5.4", capabilities: ["llm"] },
		{ id: "gpt-4.1", label: "GPT-4.1", capabilities: ["llm"] },
		{ id: "gpt-4.1-mini", label: "GPT-4.1 Mini", capabilities: ["llm"] },
		{ id: "o4-mini", label: "o4 Mini", capabilities: ["llm"] },
		{
			id: "gpt-4o",
			label: "GPT-4o",
			capabilities: ["llm"],
			pricing: [2.5, 10.0],
		},
		{
			id: "gpt-4o-mini-realtime-preview",
			label: "GPT-4o Mini Realtime",
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
	supportedRoles: ["main"],
	defaultModel: "claude-sonnet-4-6",
	models: [
		{
			id: "claude-opus-4-8",
			label: "Claude Opus 4.8",
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
		{ id: "grok-4.3", label: "Grok 4.3", capabilities: ["llm"] },
		{ id: "grok-4", label: "Grok 4", capabilities: ["llm"] },
		{ id: "grok-4.1-fast", label: "Grok 4.1 Fast", capabilities: ["llm"] },
		{
			id: "grok-code-fast-1",
			label: "Grok Code Fast",
			capabilities: ["llm"],
		},
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
		{ id: "glm-5.2", label: "GLM 5.2", capabilities: ["llm"] },
		{ id: "glm-5.1", label: "GLM 5.1", capabilities: ["llm"] },
		{ id: "glm-5-turbo", label: "GLM 5 Turbo", capabilities: ["llm"] },
		{ id: "glm-4.7", label: "GLM 4.7", capabilities: ["llm"] },
		{ id: "glm-4.5-air", label: "GLM 4.5 Air", capabilities: ["llm"] },
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
	name: "vLLM",
	description:
		"Local vLLM server — OpenAI-compatible API, no API key required.",
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
