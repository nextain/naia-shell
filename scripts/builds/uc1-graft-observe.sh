#!/usr/bin/env bash
# uc1-graft-observe — UC1 수평 관측 스모크(Option A). 빌드+테스트+DevTools 관측 스니펫 emit.
# 실제 앱 무수정(관측 전용). 실 trace 전 "새 core 분류가 라이브 wire 와 등가인가" 1차 확인.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # new-naia-os 루트
cd "$HERE"

echo "== [1/3] new-naia-os 빌드 + UC1 계약/통합 테스트 =="
pnpm install --silent >/dev/null 2>&1 || true
pnpm build
pnpm test

echo ""
echo "== [2/3] 관측 스니펫 생성(dist 파생 = 드리프트 0) =="
node scripts/builds/uc1-graft-observe.mjs
SNIPPET="$HERE/scripts/builds/uc1-graft-snippet.js"

echo ""
echo "== [3/3] 관측 절차(앱 무수정) =="
cat <<TXT
1. 돌고 있는 naia-os 에서 F12 → Console.
2. $SNIPPET 내용을 통째로 붙여넣기 → window.uc1 준비.
3. window.uc1.observeConsole() 입력 → 채팅 한 턴 수행 → window.uc1.report().
   • 판정 "✅ 모든 관측 type 이 새 core 분류에 존재" = Old-Baseline 등가(관측 1차 통과).
   • "⚠ unknown 존재" = 새 core variant 세트가 라이브보다 부족(=drift) → domain/chat.ts CHAT_TURN/NONCHAT 보강.
4. (대안) 앱 로그에서 본 chunk 를 window.uc1.classifyMessage('{"type":"...",...}') 로 수동 확인.
주의: withGlobalTauri:false 라 IPC 직접 후킹 불가 — 콘솔 로그 관측/수동 분류 범위. 전수 wire 캡처는 Option C(격리 harness) 필요.
TXT
echo "done."
