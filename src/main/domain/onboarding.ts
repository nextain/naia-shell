// domain/onboarding — UC12 (온보딩) 순수 값객체 + 상태기계 (contract §B.1). I/O 0, import=domain only.
// Old-Baseline = UC12-baseline-2026-06-12.md (8단계 ↔ config 필드 매핑).
import type { NaiaConfig } from "./config.js";

/** 8단계 — 순서 권위 = STEPS (baseline OnboardingWizard). */
export type OnboardingStep =
  | "welcome"
  | "agentName"
  | "userName"
  | "speechStyle"
  | "character"
  | "background"
  | "provider"
  | "complete";

export const STEPS: readonly OnboardingStep[] = [
  "welcome", "agentName", "userName", "speechStyle", "character", "background", "provider", "complete",
];

/** categorized 초안(NaiaConfig {agent,secret,ui}+naiaKey 정합). 단계가 카테고리별 필드 set. */
export interface OnboardingDraft {
  readonly agent: Readonly<Record<string, unknown>>; // agentName·userName·honorific·speechStyle·extraPersona·provider·model·naiaGatewayUrl·locale·enableTools·memory*Provider(값)
  readonly ui: Readonly<Record<string, unknown>>; // vrmModel·background·theme·voiceMode·sttProvider·ttsProvider
  readonly secret: Readonly<Record<string, unknown>>; // apiKey
  readonly naiaKey?: string; // top-level (기존 NaiaConfig.naiaKey 정합)
}

export interface OnboardingState {
  readonly step: OnboardingStep;
  readonly draft: OnboardingDraft;
  readonly naiaLoginDone: boolean;
}

/** 단계별 resolved 입력(StepInput) — asset 목록 fetch/기본선택은 controller 가 미리 해 확정 값만 전달(advance 순수 유지, R15-2). */
export type StepInput =
  | { readonly step: "welcome" }
  | { readonly step: "agentName"; readonly agentName: string }
  | { readonly step: "userName"; readonly userName: string; readonly honorific?: string }
  | { readonly step: "speechStyle"; readonly speechStyle: string; readonly extraPersona?: string }
  | { readonly step: "character"; readonly vrmModel?: string } // controller 가 assets[0] 기본 적용한 확정값(빈목록=undefined=미설정)
  | { readonly step: "background"; readonly background?: string } // 기본 space, 없으면 assets[0]
  | { readonly step: "provider"; readonly provider: string; readonly model?: string; readonly apiKey?: string; readonly naiaGatewayUrl?: string }
  | { readonly step: "complete" };

const EMPTY_DRAFT: OnboardingDraft = { agent: {}, ui: {}, secret: {} };

export function initialOnboarding(): OnboardingState {
  return { step: "welcome", draft: EMPTY_DRAFT, naiaLoginDone: false };
}

function isNaiaProvider(p: string): boolean {
  return p === "nextain" || p === "naia";
}

/** naia(nextain) provider 분기만 OAuth 게이트(직접 provider 는 무게이트, R2-3). */
function providerGateBlocks(input: StepInput, naiaLoginDone: boolean): boolean {
  return input.step === "provider" && isNaiaProvider((input as { provider: string }).provider) && !naiaLoginDone;
}

/**
 * 순수: 현재 단계 input 적용 + 다음 단계로. step 불일치/건너뜀 금지(순서 불변식).
 * provider naia 분기 미로그인 시 전이 안 함(같은 단계 유지, draft 만 갱신).
 */
export function advance(state: OnboardingState, input: StepInput): OnboardingState {
  if (input.step !== state.step) return state; // 건너뜀/오입력 = 무변화(순서 불변식)
  const d = state.draft;
  let draft: OnboardingDraft = d;
  switch (input.step) {
    case "welcome":
      break;
    case "agentName":
      draft = { ...d, agent: { ...d.agent, agentName: input.agentName } };
      break;
    case "userName":
      draft = { ...d, agent: { ...d.agent, userName: input.userName, ...(input.honorific !== undefined ? { honorific: input.honorific } : {}) } };
      break;
    case "speechStyle":
      draft = { ...d, agent: { ...d.agent, speechStyle: input.speechStyle, ...(input.extraPersona !== undefined ? { extraPersona: input.extraPersona } : {}) } };
      break;
    case "character":
      draft = input.vrmModel !== undefined ? { ...d, ui: { ...d.ui, vrmModel: input.vrmModel } } : d;
      break;
    case "background":
      draft = input.background !== undefined ? { ...d, ui: { ...d.ui, background: input.background } } : d;
      break;
    case "provider":
      draft = {
        ...d,
        agent: { ...d.agent, provider: input.provider, ...(input.model !== undefined ? { model: input.model } : {}), ...(input.naiaGatewayUrl !== undefined ? { naiaGatewayUrl: input.naiaGatewayUrl } : {}) },
        secret: input.apiKey !== undefined ? { ...d.secret, apiKey: input.apiKey } : d.secret,
      };
      break;
    case "complete":
      break;
  }
  // provider naia 분기 미로그인 = 전이 보류(draft 는 갱신, step 유지).
  if (providerGateBlocks(input, state.naiaLoginDone)) {
    return { ...state, draft };
  }
  const idx = STEPS.indexOf(state.step);
  const nextStep = idx >= 0 && idx < STEPS.length - 1 ? STEPS[idx + 1] : state.step;
  return { step: nextStep, draft, naiaLoginDone: state.naiaLoginDone };
}

/** naia OAuth callback 도메인 반영(순수): naiaKey + naiaLoginDone + memory provider 자동 naia(값). idempotent(이미 done 이면 무변화, R2-5). */
export function applyNaiaLogin(state: OnboardingState, naiaKey: string): OnboardingState {
  if (state.naiaLoginDone) return state;
  const d = state.draft;
  return {
    ...state,
    naiaLoginDone: true,
    draft: { ...d, naiaKey, agent: { ...d.agent, memoryEmbeddingProvider: "naia", memoryLlmProvider: "naia" } },
  };
}

/** 완료 시 NaiaConfig 산출(순수): categorized draft + onboardingComplete=true. (영속은 app.) */
export function completeOnboarding(draft: OnboardingDraft): NaiaConfig {
  return {
    agent: draft.agent,
    secret: draft.secret,
    ui: draft.ui,
    ...(draft.naiaKey !== undefined ? { naiaKey: draft.naiaKey } : {}),
    onboardingComplete: true,
  };
}
