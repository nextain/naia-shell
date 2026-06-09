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

/** inspectAdkDir 결과 — app 이 clone/delete 결정에 사용 (codex HIGH 정정). */
export interface AdkDirState {
  readonly exists: boolean;
  readonly isAdk: boolean; // 이미 유효 ADK 디렉터리인가
}

/**
 * new/recreate 디렉터리 준비 결정 (순수 규칙).
 * new: 없으면 clone. recreate: 있으면 delete 후 clone.
 */
export type AdkPrepAction = "clone" | "delete-then-clone" | "none";
export function adkPrepAction(mode: "new" | "recreate", st: AdkDirState): AdkPrepAction {
  if (mode === "recreate") return st.exists ? "delete-then-clone" : "clone";
  // new
  return st.exists && st.isAdk ? "none" : "clone";
}
