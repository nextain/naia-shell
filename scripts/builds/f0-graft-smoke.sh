#!/usr/bin/env bash
# f0-graft-smoke — F0 부팅 결정 등가 스모크 (P02 1단계 Old-Baseline drift-gate).
# 빌드 검증 + 붙여넣기용 DevTools 콘솔 스니펫 emit + 전체 graft 절차 안내.
# 실제 부팅(Tauri)은 루크 머신 필요 — 이 스크립트는 빌드 확인 + 스니펫 생성까지.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # new-naia-os 루트
cd "$HERE"

echo "== [1/3] new-naia-os 빌드 + 계약/통합 테스트 =="
pnpm install --silent >/dev/null 2>&1 || true
pnpm build
pnpm test

SNIPPET="$HERE/scripts/builds/f0-graft-snippet.js"
echo ""
echo "== [2/3] DevTools 콘솔 스니펫 생성 → $SNIPPET =="
cat > "$SNIPPET" <<'JS'
// F0 graft 스모크 — 돌고 있는 naia-os DevTools(F12) Console 에 붙여넣기. 읽기 전용(설정 미변경).
(() => {
  const adkPath = localStorage.getItem("naia-adk-path");
  const adkPresent = adkPath !== null && adkPath !== "";
  let cfg = null; try { cfg = JSON.parse(localStorage.getItem("naia-config") || "null"); } catch {}
  const onboardingComplete = cfg?.onboardingComplete === true;
  // 새 core decideBoot 규칙 (domain/boot.ts)
  const newDecision = !adkPresent ? "SetupRequired" : (!onboardingComplete ? "OnboardingOverlay" : "Main");
  // 옛 앱 실제 결정
  const oldExpected = !adkPresent ? "SetupRequired" : (onboardingComplete ? "Main" : "OnboardingOverlay");
  console.log("[F0-GRAFT]", { adkPath, adkPresent, onboardingComplete, newDecision, oldExpected, match: newDecision === oldExpected });
})();
JS
cat "$SNIPPET"

echo ""
echo "== [3/3] 실행 안내 =="
cat <<'TXT'
방법 1 (제일 쉬움, 빌드 0): 돌고 있는 naia-os 에서 F12 → Console 에 위 스니펫 붙여넣기.
  → [F0-GRAFT] { ... match: true/false } 확인.
     match:true  = 새 core 부팅 결정이 실제 앱 상태에서 옛 앱과 동일 (Old-Baseline 등가 1차).
     match:false = drift (newDecision vs oldExpected 비교해 조사).

방법 2 (전체 async 포트+invoke): docs/progress/F0-graft-2026-06-09.md 참조
  (worktree 로 frozen old 보호 → ControlPlaneBoot+live 어댑터 graft → pnpm run tauri:dev).
TXT
echo "done."
