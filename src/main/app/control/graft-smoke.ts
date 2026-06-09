// graft-smoke — F0 검증 테스트(P02 1단계: Old-Baseline 등가). ⚠️ **읽기 전용**(루크 설정 미변경).
// graft 시 old 앱에서 호출 → 새 core 가 *실제 백엔드* 로 계산한 부팅 결정이 old 의 실제 결정과 같은지 비교.
// = drift-gate 의 시작: 새 코드가 GREEN(계약테스트 통과)이어도 *옛 동작과 다르면* 여기서 잡힌다.
import { decideBoot, type BootDecision } from "../../domain/boot.js";
import type { LiveDeps } from "../../adapters/tauri/live.js";

export interface GraftSmokeResult {
  readonly newDecision: BootDecision; // 새 core 가 계산한 결정
  readonly oldShowAdkSetup: boolean; // old: !isAdkInitialized
  readonly oldOnboardingComplete: boolean; // old: isOnboardingComplete
  readonly oldExpectedDecision: BootDecision; // old 신호를 같은 규칙으로 환산
  readonly match: boolean; // 등가? (다르면 drift = 조사 필요)
}

/**
 * 읽기 전용 부팅 결정 등가 스모크.
 * old 신호(getAdkPath 유무 = showAdkSetup, isOnboardingComplete)를 읽어
 * 새 decideBoot 와 비교. **어떤 set/save 도 호출 안 함** — 안전.
 */
export async function graftBootDecisionSmoke(d: LiveDeps): Promise<GraftSmokeResult> {
  // panel list 는 게이트 이전 호출이지만 비파괴 read 라 스모크에 포함(non-fatal)
  try { await d.invoke("panel_list_installed"); } catch { /* non-fatal */ }

  const adkPath = d.getAdkPath();
  const adkPresent = adkPath !== null && adkPath !== "";
  const onboardingComplete = d.isOnboardingComplete();

  const newDecision = decideBoot(adkPresent, onboardingComplete);

  // old: 첫 렌더 showAdkSetup = !isAdkInitialized(); onboarding = isOnboardingComplete()
  const oldShowAdkSetup = !adkPresent;
  const oldExpectedDecision: BootDecision = oldShowAdkSetup
    ? "SetupRequired"
    : onboardingComplete ? "Main" : "OnboardingOverlay";

  return {
    newDecision,
    oldShowAdkSetup,
    oldOnboardingComplete: onboardingComplete,
    oldExpectedDecision,
    match: newDecision === oldExpectedDecision,
  };
}
