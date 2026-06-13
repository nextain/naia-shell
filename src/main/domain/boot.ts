// domain/boot — F0 (contract §B.1 AdkPath, BootDecision)
// 순수 결정 로직. localStorage/storage 접근 0 (포트 경유).

export type AdkPath =
  | { readonly present: true; readonly path: string }
  | { readonly present: false };

export const adkPresent = (path: string): AdkPath => ({ present: true, path });
export const adkAbsent = (): AdkPath => ({ present: false });

/**
 * 부팅 게이트 순수 결정 (App.tsx showAdkSetup/onboarding 게이트, codex R1·R3).
 * 입력 둘 다 포트로 조회된 값 (직접 read 금지).
 */
export type BootDecision = "SetupRequired" | "OnboardingOverlay" | "Main";

export function decideBoot(
  adkPathPresent: boolean,
  onboardingComplete: boolean,
): BootDecision {
  if (!adkPathPresent) return "SetupRequired";
  if (!onboardingComplete) return "OnboardingOverlay"; // main shell 유지+우측 OnboardingWizard
  return "Main";
}

/** setup 분기 모드 (path 부재 → 사용자 확정). login 카드는 disabled(계약 §A). */
export type SetupMode = "new" | "load" | "use-existing" | "recreate";

/** inspectAdkDir 결과 — Rust inspect_adk_dir 의 4-state 그대로(신규 계약 §F0-1, 2026-06-13 리뷰).
 *  이전 {exists,isAdk} 2-state 는 has_other_files(비어있지 않은 non-ADK)를 표현 못 해 blind clone→#325 에러 유발. */
export type AdkDirStatus = "missing" | "empty" | "has_settings" | "has_other_files";
export interface AdkDirState {
  readonly status: AdkDirStatus;
}

/**
 * new/recreate 디렉터리 준비 결정 (순수 규칙, old AdkSetupScreen 충실 이식).
 * - recreate: 항상 delete 후 clone (old handleNewRecreate 는 무조건 delete→clone).
 * - new: missing/empty → clone. has_settings/has_other_files(비어있지 않음) → needs-decision
 *   (old 는 둘 다 new_exists 로 사용자 선택; blind clone 금지 #325). 자동 결정 안 함.
 */
export type AdkPrepAction = "clone" | "delete-then-clone" | "none" | "needs-decision";
export function adkPrepAction(mode: "new" | "recreate", st: AdkDirState): AdkPrepAction {
  if (mode === "recreate") return "delete-then-clone";
  if (st.status === "missing" || st.status === "empty") return "clone";
  return "needs-decision"; // has_settings | has_other_files → 사용자 결정 필요(use-as-is/recreate/다른 경로)
}

/** new 모드에서 대상 디렉터리가 비어있지 않아 자동 진행 불가 — 사용자 결정 필요(blind clone 금지, #325 충실 이식). */
export class AdkDirNeedsDecisionError extends Error {
  constructor(readonly path: string, readonly status: AdkDirStatus) {
    super(`naia-adk 디렉터리가 비어있지 않습니다(${status}): ${path}. 기존 사용/재생성(recreate)/다른 경로 중 선택하세요.`);
    this.name = "AdkDirNeedsDecisionError";
  }
}
