import { describe, expect, it, vi } from "vitest";
import {
	fetchNaiaPricing,
	formatModelLabel,
	getDefaultLlmModel,
	getLlmModel,
	getLlmProvider,
	isApiKeyOptional,
	isOmniModel,
	listLlmProviders,
	modelHasCapability,
	providerSupportsRole,
} from "../registry";

describe("registry — provider registration", () => {
	it("lists all expected providers", () => {
		const ids = listLlmProviders().map((p) => p.id);
		expect(ids).toContain("nextain");
		expect(ids).toContain("gemini");
		expect(ids).toContain("openai");
		expect(ids).toContain("anthropic");
		expect(ids).toContain("xai");
		expect(ids).toContain("zai");
		expect(ids).toContain("claude-code-cli");
		expect(ids).toContain("codex");
		expect(ids).toContain("ollama");
		expect(ids).toContain("vllm");
	});

	it("getLlmProvider returns undefined for unknown id", () => {
		expect(getLlmProvider("unknown-xyz")).toBeUndefined();
	});
});

describe("registry — Codex app-server provider", () => {
	it("API key가 필요 없고 main 역할만 지원한다", () => {
		const provider = getLlmProvider("codex");
		expect(provider?.requiresApiKey).toBe(false);
		expect(getDefaultLlmModel("codex")).toBe("gpt-5.4");
		expect(providerSupportsRole("codex", "main")).toBe(true);
		expect(providerSupportsRole("codex", "sub")).toBe(false);
		expect(providerSupportsRole("codex", "memory")).toBe(false);
	});

	it("일반 provider는 공통 registry 기본값으로 세 역할을 지원한다", () => {
		expect(providerSupportsRole("ollama", "main")).toBe(true);
		expect(providerSupportsRole("ollama", "sub")).toBe(true);
		expect(providerSupportsRole("ollama", "memory")).toBe(true);
	});

	it("Anthropic Messages API는 OpenAI-compat batch/memory 역할에서 제외", () => {
		expect(providerSupportsRole("anthropic", "main")).toBe(true);
		expect(providerSupportsRole("anthropic", "sub")).toBe(false);
		expect(providerSupportsRole("anthropic", "memory")).toBe(false);
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

	it("Gemini 2.5 Flash Live is omni capable", () => {
		expect(isOmniModel("nextain", "gemini-2.5-flash-live")).toBe(true);
	});

	it("nextain provider does not require API key", () => {
		expect(isApiKeyOptional("nextain")).toBe(false); // requiresNaiaKey=true → not fully optional
		const p = getLlmProvider("nextain");
		expect(p?.requiresApiKey).toBe(false);
		expect(p?.requiresNaiaKey).toBe(true);
	});

	it("default model is gemini-3.1-flash-lite", () => {
		expect(getDefaultLlmModel("nextain")).toBe("gemini-3.1-flash-lite");
	});
});

describe("registry — Z.AI (zai) provider", () => {
	it("zai provider exists and requires API key", () => {
		const p = getLlmProvider("zai");
		expect(p).toBeDefined();
		expect(p?.requiresApiKey).toBe(true);
		expect(p?.name).toBe("Z.AI");
	});

	it("zai default model is glm-5.1", () => {
		expect(getDefaultLlmModel("zai")).toBe("glm-5.1");
	});

	it("zai has GLM models registered", () => {
		const models = getLlmProvider("zai")?.models ?? [];
		const ids = models.map((m) => m.id);
		expect(ids).toContain("glm-5.1");
		expect(ids).toContain("glm-5-turbo");
		expect(ids).toContain("glm-4.7");
		expect(ids).toContain("glm-4.5-air");
	});

	it("zai models have llm capability", () => {
		expect(modelHasCapability("zai", "glm-5.1", "llm")).toBe(true);
	});
});

describe("registry — Claude Code CLI provider", () => {
	it("claude-code-cli does not require API key", () => {
		const p = getLlmProvider("claude-code-cli");
		expect(p?.requiresApiKey).toBe(false);
	});

	it("claude-code-cli default model is claude-sonnet-4-6", () => {
		expect(getDefaultLlmModel("claude-code-cli")).toBe("claude-sonnet-4-6");
	});

	it("claude-code-cli has Opus, Sonnet, Haiku models", () => {
		const models = getLlmProvider("claude-code-cli")?.models ?? [];
		const ids = models.map((m) => m.id);
		expect(ids).toContain("claude-opus-4-8");
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

	it("최신 모델 등록(opus-4-8 / gpt-5.5 / gemini-3.5-flash / grok-4.3 / glm-5.2)", () => {
		expect(getLlmModel("anthropic", "claude-opus-4-8")).toBeDefined();
		expect(getLlmModel("claude-code-cli", "claude-opus-4-8")).toBeDefined();
		expect(getLlmModel("openai", "gpt-5.5")).toBeDefined();
		expect(getLlmModel("gemini", "gemini-3.5-flash")).toBeDefined();
		expect(getLlmModel("xai", "grok-4.3")).toBeDefined();
		expect(getLlmModel("zai", "glm-5.2")).toBeDefined();
	});

	it("default 최신 승격(openai=gpt-5.5, gemini=gemini-3.5-flash)", () => {
		expect(getDefaultLlmModel("openai")).toBe("gpt-5.5");
		expect(getDefaultLlmModel("gemini")).toBe("gemini-3.5-flash");
	});

	it("구 모델 ID 제거(anthropic/claude-code-cli 의 claude-opus-4-6)", () => {
		expect(getLlmModel("anthropic", "claude-opus-4-6")).toBeUndefined();
		expect(getLlmModel("claude-code-cli", "claude-opus-4-6")).toBeUndefined();
	});

	// cross-repo 정합 SoT: 이 스냅샷이 곧 agent cost.ts MODEL_PRICING / uc-provider-provenance
	// REGISTRY_PRICED_MODELS 의 동기화 기준. registry 에서 native(per-token) 모델 추가·삭제·오타 시
	// 이 테스트가 실패 → agent cost.ts 와 그쪽 배열도 같이 갱신해야 한다(과금 0 회귀 차단).
	// (자동 단일 SoT(빌드 생성)는 후속 과제 — 지금은 '변경 감지'로 정합 보장. codex HIGH3 대응.)
	it("native(per-token) provider 모델 ID 스냅샷 — agent cost.ts 와 수동 동기화", () => {
		const nativeProviders = ["anthropic", "openai", "gemini", "xai", "zai"];
		const snapshot: Record<string, string[]> = {};
		for (const id of nativeProviders) {
			snapshot[id] = (getLlmProvider(id)?.models ?? [])
				.filter((m) => !m.capabilities.includes("omni")) // realtime/omni = 시간 과금(per-token 제외)
				.map((m) => m.id);
		}
		expect(snapshot).toEqual({
			anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
			openai: ["gpt-5.5", "gpt-5.4", "gpt-4.1", "gpt-4.1-mini", "o4-mini", "gpt-4o"],
			gemini: ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
			xai: ["grok-4.3", "grok-4", "grok-4.1-fast", "grok-code-fast-1", "grok-3-mini"],
			zai: ["glm-5.2", "glm-5.1", "glm-5-turbo", "glm-4.7", "glm-4.5-air"],
		});
	});
});

describe("registry — isApiKeyOptional", () => {
	it("ollama is key-optional (no API key, no Naia key)", () => {
		expect(isApiKeyOptional("ollama")).toBe(true);
	});

	it("vllm is key-optional", () => {
		expect(isApiKeyOptional("vllm")).toBe(true);
	});

	it("gemini is not key-optional", () => {
		expect(isApiKeyOptional("gemini")).toBe(false);
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

	it("overlays gateway pricing with 1.1x markup onto Naia model list", async () => {
		const gatewayResponse = [
			{ model_key: "vertexai:gemini-3.1-flash-lite", input_price_per_million: 0.15, output_price_per_million: 0.6, cached_price_per_million: 0.04 },
			{ model_key: "vertexai:gemini-3.5-flash", input_price_per_million: 1.25, output_price_per_million: 10.0, cached_price_per_million: null },
			{ model_key: "openai:gpt-4o", input_price_per_million: 2.5, output_price_per_million: 10.0, cached_price_per_million: null },
		];
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify(gatewayResponse), { status: 200 }),
		);
		const models = await fetchNaiaPricing("https://example.com");
		expect(models).not.toBeNull();

		const flashLite = models!.find((m) => m.id === "gemini-3.1-flash-lite");
		expect(flashLite?.pricing).toEqual([0.165, 0.66]);

		const flash = models!.find((m) => m.id === "gemini-3.5-flash");
		expect(flash?.pricing).toEqual([1.375, 11.0]);

		const gpt4o = models!.find((m) => m.id === "gpt-4o");
		expect(gpt4o).toBeUndefined();

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

describe("registry — formatModelLabel", () => {
	it("returns base label when no pricing", () => {
		const model = getLlmModel("nextain", "gemini-3.5-flash")!;
		const label = formatModelLabel(model);
		expect(label).toBe("Gemini 3.5 Flash");
	});

	it("formats label with pricing when provided", () => {
		const label = formatModelLabel({ id: "test", label: "Test Model", capabilities: ["llm"], pricing: [1.5, 10.0] });
		expect(label).toContain("Test Model");
		expect(label).toContain("$1.500");
		expect(label).toContain("$10.000");
	});
});
