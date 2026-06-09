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
