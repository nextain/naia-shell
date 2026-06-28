import { describe, expect, it } from "vitest";
import {
  STEPS,
  advance,
  applyNaiaLogin,
  completeOnboarding,
  initialOnboarding,
  type OnboardingState,
} from "../main/domain/onboarding.js";
import { resolveAgentEnvKey, stripSecret } from "../main/domain/config.js";

/**
 * UC12 domain 계약 테스트 — Old-Baseline(UC12-baseline-2026-06-12.md) golden trace 대조.
 * 순수 domain(advance/applyNaiaLogin/completeOnboarding + stripSecret/resolveAgentEnvKey).
 */
describe("UC12 domain — 온보딩 8단계 상태기계 (contract §B.1)", () => {
  it("STEPS = baseline 8단계 순서 verbatim", () => {
    expect(STEPS).toEqual(["welcome", "agentName", "userName", "speechStyle", "character", "background", "provider", "complete"]);
  });

  it("initial = welcome, 빈 draft, 미로그인", () => {
    const s = initialOnboarding();
    expect(s.step).toBe("welcome");
    expect(s.draft).toEqual({ agent: {}, ui: {}, secret: {} });
    expect(s.naiaLoginDone).toBe(false);
  });

  it("각 단계가 올바른 카테고리에 필드 set + 다음 단계로", () => {
    let s = initialOnboarding();
    s = advance(s, { step: "welcome" });
    expect(s.step).toBe("agentName");
    s = advance(s, { step: "agentName", agentName: "나이아" });
    expect(s.draft.agent.agentName).toBe("나이아");
    expect(s.step).toBe("userName");
    s = advance(s, { step: "userName", userName: "루크", honorific: "님" });
    expect(s.draft.agent.userName).toBe("루크");
    expect(s.draft.agent.honorific).toBe("님"); // honorific = agent (R2-2)
    s = advance(s, { step: "speechStyle", speechStyle: "반말" });
    expect(s.draft.agent.speechStyle).toBe("반말");
    s = advance(s, { step: "character", vrmModel: "/a/x.vrm" });
    expect(s.draft.ui.vrmModel).toBe("/a/x.vrm"); // vrmModel = ui
    expect(s.step).toBe("background");
  });

  it("step 불일치 입력 = 무변화 (건너뜀 금지)", () => {
    const s = initialOnboarding(); // step=welcome
    const s2 = advance(s, { step: "provider", provider: "glm" }); // mismatch
    expect(s2).toBe(s); // 무변화
  });

  it("provider naia(nextain) 분기 = 미로그인 시 전이 보류, draft 만 갱신", () => {
    let s: OnboardingState = { step: "provider", draft: { agent: {}, ui: {}, secret: {} }, naiaLoginDone: false };
    s = advance(s, { step: "provider", provider: "nextain" });
    expect(s.step).toBe("provider"); // 보류
    expect(s.draft.agent.provider).toBe("nextain"); // draft 는 갱신
  });

  it("provider 직접(glm apiKey) = 게이트 없이 전이, apiKey=secret", () => {
    let s: OnboardingState = { step: "provider", draft: { agent: {}, ui: {}, secret: {} }, naiaLoginDone: false };
    s = advance(s, { step: "provider", provider: "glm", model: "glm-4.6", apiKey: "k" });
    expect(s.step).toBe("complete"); // 전이됨
    expect(s.draft.agent.provider).toBe("glm");
    expect(s.draft.secret.apiKey).toBe("k"); // apiKey = secret
  });

	it("naia 로그인 후 provider 전이 가능 + memory provider 자동 적용(R2-1: embed=offline, sub=naia)", () => {
		let s: OnboardingState = { step: "provider", draft: { agent: {}, ui: {}, secret: {} }, naiaLoginDone: false };
		s = applyNaiaLogin(s, "nk");
		expect(s.naiaLoginDone).toBe(true);
		expect(s.draft.naiaKey).toBe("nk");
		expect(s.draft.agent.memoryEmbeddingProvider).toBe("offline");
		expect(s.draft.agent.memoryOfflineModel).toBe("all-MiniLM-L6-v2");
		expect(s.draft.agent.memoryLlmProvider).toBe("naia");
		s = advance(s, { step: "provider", provider: "nextain" });
		expect(s.step).toBe("complete"); // 이제 전이
	});

  it("applyNaiaLogin idempotent (이미 done → 무변화, R2-5)", () => {
    const base: OnboardingState = { step: "provider", draft: { agent: {}, ui: {}, secret: {} }, naiaLoginDone: true };
    expect(applyNaiaLogin(base, "another")).toBe(base);
  });

  it("completeOnboarding = categorized + onboardingComplete=true", () => {
    const cfg = completeOnboarding({ agent: { agentName: "나이아" }, ui: { vrmModel: "x" }, secret: { apiKey: "k" }, naiaKey: "nk" });
    expect(cfg.agent.agentName).toBe("나이아");
    expect(cfg.ui.vrmModel).toBe("x");
    expect(cfg.secret.apiKey).toBe("k");
    expect(cfg.naiaKey).toBe("nk");
    expect(cfg.onboardingComplete).toBe(true);
  });
});

describe("UC12 domain — config 순수 헬퍼 (secret strip · envKey 매핑)", () => {
  it("stripSecret = secret:{} + naiaKey 제거, 나머지 보존 (R4/R6/R8)", () => {
    const c = stripSecret({ agent: { agentName: "n" }, ui: { theme: "dark" }, secret: { apiKey: "k" }, naiaKey: "nk", onboardingComplete: true });
    expect(c.secret).toEqual({});
    expect(c.naiaKey).toBeUndefined();
    expect(c.agent.agentName).toBe("n");
    expect(c.ui.theme).toBe("dark");
    expect(c.onboardingComplete).toBe(true);
  });

  it("resolveAgentEnvKey: apiKey→provider별, naiaKey→NAIA_ANYLLM_API_KEY", () => {
    expect(resolveAgentEnvKey("anthropic", "apiKey")).toBe("ANTHROPIC_API_KEY");
    expect(resolveAgentEnvKey("openai", "apiKey")).toBe("OPENAI_API_KEY");
    expect(resolveAgentEnvKey("glm", "apiKey")).toBe("GLM_API_KEY");
    expect(resolveAgentEnvKey("nextain", "naiaKey")).toBe("NAIA_ANYLLM_API_KEY");
  });

  it("resolveAgentEnvKey: 키 없는 provider = null (R11)", () => {
    expect(resolveAgentEnvKey("gemini", "apiKey")).toBeNull();
    expect(resolveAgentEnvKey("ollama", "apiKey")).toBeNull();
    expect(resolveAgentEnvKey("vllm", "apiKey")).toBeNull();
    expect(resolveAgentEnvKey("claude-code-cli", "apiKey")).toBeNull();
  });
});
