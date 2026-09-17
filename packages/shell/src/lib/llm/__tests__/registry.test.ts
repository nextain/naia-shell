import { describe, expect, it, vi } from "vitest";
import {
	fetchNaiaPricing,
	fetchNaiaModelMetadata,
	applyNaiaModelMetadata,
	formatModelLabel,
	getDefaultLlmModel,
	getLlmModel,
	getLlmProvider,
	isApiKeyOptional,
	isOmniModel,
	listLlmProviders,
	providerSupportsRole,
	sortModels,
} from "../registry";

describe("registry — provider registration", () => {
	it("lists only the Naia account, CLI (skills), and local providers", () => {
		const ids = listLlmProviders().map((p) => p.id);
		// 남는 공급자: 나이아 계정 + CLI(스킬 탭) + 로컬.
		expect(ids).toContain("nextain");
		expect(ids).toContain("claude-code-cli");
		expect(ids).toContain("codex");
		expect(ids).toContain("grok");
		expect(ids).toContain("ollama");
		expect(ids).toContain("vllm");
	});

	// #602: 타사 직결 클라우드 LLM API 공급자는 흔적 없이 제거됐다.
	it("no longer registers the third-party cloud LLM API providers", () => {
		const ids = listLlmProviders().map((p) => p.id);
		for (const removed of ["openai", "gemini", "anthropic", "xai", "zai"]) {
			expect(ids).not.toContain(removed);
			expect(getLlmProvider(removed)).toBeUndefined();
		}
	});

	it("no remaining provider requires a bring-your-own API key", () => {
		// 로그인=나이아 계정, 로그아웃=무료→로컬. BYO 키를 요구하는 공급자는 없다.
		for (const p of listLlmProviders()) {
			expect(p.requiresApiKey).toBe(false);
		}
	});

	it("getLlmProvider returns undefined for unknown id", () => {
		expect(getLlmProvider("unknown-xyz")).toBeUndefined();
	});

	it("Naia offline fallbacks keep every selectable model skill-capable without claiming live provenance", () => {
		expect(getLlmModel("nextain", "gemini-3.1-flash-lite")).toMatchObject({ supportsTools: true });
		expect(getLlmModel("nextain", "grok-4.3")).toMatchObject({ supportsTools: true, upstreamProvider: "unknown", lifecycle: "unknown" });
		expect(getLlmModel("nextain", "deepseek-v4-pro")).toMatchObject({ supportsTools: true, upstreamProvider: "unknown", lifecycle: "unknown" });
		expect(getLlmModel("nextain", "deepseek-v4-flash")).toMatchObject({ supportsTools: true, upstreamProvider: "unknown", lifecycle: "unknown" });
		expect(getLlmModel("nextain", "gpt-5.6-sol")).toMatchObject({ supportsTools: true, upstreamProvider: "unknown" });
		expect(getLlmModel("nextain", "gpt-5.6-luna")).toMatchObject({ supportsTools: true, upstreamProvider: "unknown" });
		expect(getLlmModel("nextain", "claude-opus-5")).toMatchObject({ protocol: "anthropic_messages", operationalStatus: "quota_blocked", comingSoon: true });
		const selectable = getLlmProvider("nextain")!.models.filter((model) => !model.comingSoon);
		expect(selectable.every((model) => model.supportsTools === true)).toBe(true);
	});
});

describe("registry — Codex app-server provider", () => {
	it("API key가 필요 없고 expert/main/sub 역할을 지원한다", () => {
		const provider = getLlmProvider("codex");
		expect(provider?.requiresApiKey).toBe(false);
		expect(getDefaultLlmModel("codex")).toBe("gpt-5.6-sol");
		expect(providerSupportsRole("codex", "main")).toBe(true);
		expect(providerSupportsRole("codex", "sub")).toBe(true);
		expect(providerSupportsRole("codex", "memory")).toBe(false);
	});

	it("Grok CLI는 API key가 필요 없고 expert/main/sub 역할을 지원한다", () => {
		const provider = getLlmProvider("grok");
		expect(provider?.requiresApiKey).toBe(false);
		expect(getDefaultLlmModel("grok")).toBe("grok-4.6");
		expect(providerSupportsRole("grok", "main")).toBe(true);
		expect(providerSupportsRole("grok", "sub")).toBe(true);
		expect(providerSupportsRole("grok", "memory")).toBe(false);
		expect(getLlmModel("grok", "grok-4.5")).toBeDefined();
	});

	it("일반 provider는 공통 registry 기본값으로 세 역할을 지원한다", () => {
		expect(providerSupportsRole("ollama", "main")).toBe(true);
		expect(providerSupportsRole("ollama", "sub")).toBe(true);
		expect(providerSupportsRole("ollama", "memory")).toBe(true);
	});

	it("제거된 공급자는 어떤 역할도 지원하지 않는다 (미등록)", () => {
		for (const removed of ["anthropic", "openai", "gemini", "xai", "zai"]) {
			expect(providerSupportsRole(removed, "main")).toBe(false);
			expect(providerSupportsRole(removed, "sub")).toBe(false);
			expect(providerSupportsRole(removed, "memory")).toBe(false);
		}
	});
});

describe("registry — Naia (nextain) provider models", () => {
	it("models have no static pricing (fetched from gateway at startup)", () => {
		const model = getLlmModel("nextain", "gemini-3.5-flash");
		expect(model).toBeDefined();
		expect(model?.pricing).toBeUndefined();
	});

	it("Gemini 2.5 Flash Live is registered", () => {
		const model = getLlmModel("nextain", "gemini-2.5-flash-live");
		expect(model).toBeDefined();
	});

	it("Gemini 2.5 Flash Live has omni capability", () => {
		expect(isOmniModel("nextain", "gemini-2.5-flash-live")).toBe(true);
	});

	it("azure-realtime is omni and hides pipeline STT/TTS", () => {
		const model = getLlmModel("nextain", "azure-realtime");
		expect(model?.capabilities).toEqual(["llm", "omni"]);
		expect(isOmniModel("nextain", "azure-realtime")).toBe(true);
		expect(model?.voices?.map((voice) => voice.id)).toEqual(["sunhi", "hyunsu"]);
	});

	it("does not offer gpt-4o-mini live on the Naia catalog", () => {
		const nextain = listLlmProviders().find((provider) => provider.id === "nextain");
		expect(
			nextain?.models.some((model) => model.id.includes("gpt-4o-mini")),
		).toBe(false);
	});

	it("Gemini 2.5 Flash Live is omni capable", () => {
		expect(isOmniModel("nextain", "gemini-2.5-flash-live")).toBe(true);
	});

	it("nextain provider does not require API key", () => {
		expect(isApiKeyOptional("nextain")).toBe(false); // requiresNaiaKey=true → not fully optional
		const p = getLlmProvider("nextain");
		expect(p?.requiresApiKey).toBe(false);
		expect(p?.requiresNaiaKey).toBe(true);
	});

	it("default model is deepseek-v4-flash", () => {
		expect(getDefaultLlmModel("nextain")).toBe("deepseek-v4-flash");
	});
});

describe("registry — Claude Code CLI provider", () => {
	it("claude-code-cli does not require API key", () => {
		const p = getLlmProvider("claude-code-cli");
		expect(p?.requiresApiKey).toBe(false);
	});

	it("claude-code-cli default model is claude-sonnet-5", () => {
		expect(getDefaultLlmModel("claude-code-cli")).toBe("claude-sonnet-5");
	});

	it("claude-code-cli has Fable, Opus, Sonnet, Haiku models", () => {
		const models = getLlmProvider("claude-code-cli")?.models ?? [];
		const ids = models.map((m) => m.id);
		expect(ids).toContain("claude-fable-5");
		expect(ids).toContain("claude-opus-4-8");
		expect(ids).toContain("claude-sonnet-5");
		expect(ids).toContain("claude-sonnet-4-6");
		expect(ids).toContain("claude-haiku-4-5-20251001");
	});
});

describe("registry — 모델 카탈로그 정합 + 최신화 (2026-06-18)", () => {
	// cross-seam 계약: UI 카탈로그 자체 정합(default∈models, ID 중복 0) + 최신 ID 등록 단언.
	// 모델 ID ↔ 실제 provider API ID 일치는 별도 live /models 검증(키 인가 시, 무인 skip)으로 확인.
	const providers = listLlmProviders();

	it("모든 provider 의 defaultModel 은 자신의 models 에 존재(동적 fetch local provider 제외)", () => {
		for (const p of providers) {
			if (p.isLocal) continue; // ollama/vllm = 동적 fetch, defaultModel "" 정상
			const ids = p.models.map((m) => m.id);
			expect(ids, `${p.id} defaultModel=${p.defaultModel}`).toContain(p.defaultModel);
		}
	});

	it("provider 별 모델 ID 중복 없음", () => {
		for (const p of providers) {
			const ids = p.models.map((m) => m.id);
			expect(new Set(ids).size, `${p.id} 중복 ID`).toBe(ids.length);
		}
	});

	it("최신 CLI 모델 등록(claude-code-cli / codex)", () => {
		expect(getLlmModel("claude-code-cli", "claude-opus-4-8")).toBeDefined();
		expect(getLlmModel("claude-code-cli", "claude-sonnet-5")).toBeDefined();
		expect(getLlmModel("codex", "gpt-5.6-sol")).toBeDefined();
	});

	it("default 최신 승격(codex)", () => {
		expect(getDefaultLlmModel("codex")).toBe("gpt-5.6-sol");
	});

	it("구 모델 ID 제거(claude-code-cli 의 claude-opus-4-6)", () => {
		expect(getLlmModel("claude-code-cli", "claude-opus-4-6")).toBeUndefined();
	});

	// #602: 타사 직결(native per-token) 공급자는 제거됐다 — 어떤 모델도 조회되지 않는다.
	it("제거된 native provider 는 모델을 하나도 노출하지 않는다", () => {
		for (const id of ["anthropic", "openai", "gemini", "xai", "zai"]) {
			expect(getLlmProvider(id)).toBeUndefined();
			expect(getLlmProvider(id)?.models ?? []).toEqual([]);
		}
	});
});

describe("registry — isApiKeyOptional", () => {
	it("ollama is key-optional (no API key, no Naia key)", () => {
		expect(isApiKeyOptional("ollama")).toBe(true);
	});

	it("vllm is key-optional", () => {
		expect(isApiKeyOptional("vllm")).toBe(true);
	});

	it("removed cloud providers are not key-optional (unregistered)", () => {
		for (const removed of ["gemini", "openai", "anthropic", "xai", "zai"]) {
			expect(isApiKeyOptional(removed)).toBe(false);
		}
	});

	it("unknown provider is not key-optional", () => {
		expect(isApiKeyOptional("nonexistent")).toBe(false);
	});
});

describe("registry — fetchNaiaPricing", () => {
	it("returns null on network failure", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));
		const result = await fetchNaiaPricing("https://unreachable.example");
		expect(result).toBeNull();
		vi.restoreAllMocks();
	});

	it("returns null on non-ok response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(null, { status: 503 }),
		);
		const result = await fetchNaiaPricing("https://example.com");
		expect(result).toBeNull();
		vi.restoreAllMocks();
	});

	it("uses final customer pricing from the gateway without double markup", async () => {
		const gatewayResponse = [
			{ model_key: "vertexai:gemini-3.1-flash-lite", input_price_per_million: 0.15, output_price_per_million: 0.6, cached_price_per_million: 0.04 },
			{ model_key: "vertexai:gemini-3.5-flash", input_price_per_million: 1.25, output_price_per_million: 10.0, cached_price_per_million: null },
			{ model_key: "openai:gpt-4o", input_price_per_million: 2.5, output_price_per_million: 10.0, cached_price_per_million: null },
			{ model_key: "azure:grok-4.3", input_price_per_million: 0.4, output_price_per_million: 1.2, cached_price_per_million: 0.08, cache_write_price_per_million: 0.5 },
		];
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify(gatewayResponse), { status: 200 }),
		);
		const models = await fetchNaiaPricing("https://example.com");
		expect(models).not.toBeNull();

		const flashLite = models!.find((m) => m.id === "gemini-3.1-flash-lite");
		expect(flashLite?.pricing).toEqual([0.15, 0.6]);

		const flash = models!.find((m) => m.id === "gemini-3.5-flash");
		expect(flash?.pricing).toEqual([1.25, 10.0]);

		const gpt4o = models!.find((m) => m.id === "gpt-4o");
		expect(gpt4o).toBeUndefined();
		expect(models!.find((m) => m.id === "grok-4.3")).toMatchObject({
			pricing: [0.4, 1.2],
			cachePricing: { read: 0.08, write: 0.5 },
		});

		vi.restoreAllMocks();
	});

	it("applies live pricing to Korean domestic models (upstage:/clova:)", async () => {
		// Regression: the Naia-route filter previously accepted only azure:/vertexai:,
		// so Solar and CLOVA prices were silently dropped and shown as no-price.
		const gatewayResponse = [
			{ model_key: "upstage:solar-pro4", input_price_per_million: 0.33, output_price_per_million: 1.32, cached_price_per_million: 0.066 },
			{ model_key: "upstage:solar-mini", input_price_per_million: 0.165, output_price_per_million: 0.165, cached_price_per_million: null },
			{ model_key: "clova:HCX-007", input_price_per_million: 0.97, output_price_per_million: 3.88, cached_price_per_million: null },
			{ model_key: "clova:HCX-DASH-002", input_price_per_million: 0.388, output_price_per_million: 1.552, cached_price_per_million: null },
		];
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify(gatewayResponse), { status: 200 }),
		);
		const models = await fetchNaiaPricing("https://example.com");
		expect(models).not.toBeNull();

		expect(models!.find((m) => m.id === "solar-pro4")).toMatchObject({
			pricing: [0.33, 1.32],
			cachePricing: { read: 0.066, write: null },
		});
		// CLOVA ids are uppercase and carry no cache price.
		const hcx = models!.find((m) => m.id === "HCX-007");
		expect(hcx?.pricing).toEqual([0.97, 3.88]);
		expect(hcx?.cachePricing).toBeUndefined();
		expect(models!.find((m) => m.id === "HCX-DASH-002")?.pricing).toEqual([0.388, 1.552]);

		vi.restoreAllMocks();
	});

	it("models not in gateway response have no pricing", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify([
				{ model_key: "vertexai:gemini-3.1-flash-lite", input_price_per_million: 0.15, output_price_per_million: 0.6, cached_price_per_million: null },
			]), { status: 200 }),
		);
		const models = await fetchNaiaPricing("https://example.com");
		expect(models).not.toBeNull();

		const flash = models!.find((m) => m.id === "gemini-3.5-flash");
		expect(flash?.pricing).toBeUndefined();

		vi.restoreAllMocks();
	});

	it("does not mutate original provider models (returns new objects)", async () => {
		const staticFlashBefore = getLlmModel("nextain", "gemini-3.5-flash");

		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify([
				{ model_key: "vertexai:gemini-3.5-flash", input_price_per_million: 99.0, output_price_per_million: 99.0, cached_price_per_million: null },
			]), { status: 200 }),
		);
		await fetchNaiaPricing("https://example.com");

		const staticFlashAfter = getLlmModel("nextain", "gemini-3.5-flash");
		expect(staticFlashAfter?.pricing).toEqual(staticFlashBefore?.pricing);

		vi.restoreAllMocks();
	});
});

describe("registry — Naia Azure model metadata", () => {
	it("maps gateway provenance/tool policy without overriding verified DeepSeek support", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify([
			{ model_key: "grok-4.3", capabilities: ["llm"], supports_tools: true, upstream_provider: "azure", lifecycle: "preview" },
			{ model_key: "deepseek-v4-pro", capabilities: ["llm"], supports_tools: true, upstream_provider: "wrong", lifecycle: "ga" },
			{ model_key: "deepseek-v4-flash", capabilities: ["llm"], supports_tools: true, upstream_provider: "azure", lifecycle: "preview" },
			{ model_key: "gpt-5.6-sol", capabilities: ["llm"], supports_tools: true, upstream_provider: "azure", lifecycle: "ga", protocol: "openai_chat_completions", operational_status: "live" },
			{ model_key: "claude-opus-5", capabilities: ["llm"], supports_tools: true, upstream_provider: "azure", lifecycle: "ga", protocol: "anthropic_messages", operational_status: "quota_blocked" },
		]), { status: 200 }));
		const metadata = await fetchNaiaModelMetadata("https://example.com");
		const models = applyNaiaModelMetadata(getLlmProvider("nextain")!.models, metadata);
		expect(models.find((m) => m.id === "grok-4.3")).toMatchObject({ supportsTools: true, upstreamProvider: "azure" });
		expect(models.find((m) => m.id === "deepseek-v4-pro")).toMatchObject({ supportsTools: true, upstreamProvider: "wrong" });
		expect(models.find((m) => m.id === "deepseek-v4-flash")).toMatchObject({ supportsTools: true, upstreamProvider: "azure" });
		expect(models.find((m) => m.id === "gpt-5.6-sol")).toMatchObject({ protocol: "openai_chat_completions", operationalStatus: "live", comingSoon: false });
		expect(models.find((m) => m.id === "claude-opus-5")).toMatchObject({ protocol: "anthropic_messages", operationalStatus: "quota_blocked", comingSoon: true });
		vi.restoreAllMocks();
	});

	it("keeps a network fallback but fails closed when a successful catalog omits a model", () => {
		const base = getLlmProvider("nextain")!.models;
		const fallback = applyNaiaModelMetadata(base, null);
		expect(fallback.find((m) => m.id === "grok-4.3")?.comingSoon).toBeUndefined();

		const omitted = applyNaiaModelMetadata(base, new Map());
		expect(omitted.find((m) => m.id === "grok-4.3")).toMatchObject({
			operationalStatus: "catalog_missing",
			comingSoon: true,
		});
		expect(omitted.find((m) => m.id === "deepseek-v4-pro")).toMatchObject({
			supportsTools: true,
			comingSoon: true,
		});
	});
});

describe("registry — formatModelLabel", () => {
	it("returns base label when no pricing", () => {
		const model = getLlmModel("nextain", "gemini-3.5-flash")!;
		const label = formatModelLabel(model);
		expect(label).toBe("Gemini 3.5 Flash");
	});

	it("formats label with pricing when provided", () => {
		const label = formatModelLabel({ id: "test", label: "Test Model", capabilities: ["llm"], pricing: [1.5, 10.0] });
		expect(label).toBe(
			"Test Model (Price per 1M tokens: Input $1.500 / Output $10.000)",
		);
	});
});

describe("registry — sortModels", () => {
	const models = [
		{ id: "input-heavy", label: "Input heavy", capabilities: ["llm"], pricing: [3, 0] },
		{ id: "unknown", label: "Unknown", capabilities: ["llm"] },
		{ id: "output-heavy", label: "Output heavy", capabilities: ["llm"], pricing: [0, 5] },
		{ id: "soon", label: "Soon", capabilities: ["llm"], pricing: [0, 0], comingSoon: true },
	] as Parameters<typeof sortModels>[0];

	it("sorts by a 3:1 uncached input/output chat estimate with unknown and unavailable last", () => {
		expect(sortModels(models, "price").map((model) => model.id)).toEqual([
			"output-heavy",
			"input-heavy",
			"unknown",
			"soon",
		]);
	});

	it("keeps registry order for equal weighted price scores", () => {
		const tied = [
			{ id: "first", label: "First", capabilities: ["llm"], pricing: [1, 3] },
			{ id: "second", label: "Second", capabilities: ["llm"], pricing: [2, 0] },
		] as Parameters<typeof sortModels>[0];
		expect(sortModels(tied, "price").map((model) => model.id)).toEqual([
			"first",
			"second",
		]);
	});

	it("uses the dated Naia recommendation while keeping unavailable routes last", () => {
		const naia = getLlmProvider("nextain")!.models;
		const sorted = sortModels(naia, "performance").map((model) => model.id);
		expect(sorted.slice(0, 8)).toEqual([
			"gpt-5.6-sol",
			"grok-4.3",
			"deepseek-v4-pro",
			"deepseek-v4-flash",
			"solar-pro4",
			"HCX-007",
			"gemini-3.5-flash",
			"gemini-3.1-flash-lite",
		]);
		expect(sorted.slice(-2)).toEqual([
			"claude-opus-5",
			"naia-0.9-omni-24g",
		]);
	});
});
