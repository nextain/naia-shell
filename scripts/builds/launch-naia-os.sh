#!/usr/bin/env bash
# launch-naia-os — 실제 naia-os(projects/naia-os) dev 앱을 띄운다.
# graft/검증 워크플로용: 띄운 뒤 F12 Console 에 graft 스니펫(scripts/builds/f0-graft-snippet.js) 붙여
# 새 core 결정이 라이브 앱과 match 하는지 확인. 기존 dev 서버는 먼저 정리(포트 1420 충돌 방지).
# 사용: bash scripts/builds/launch-naia-os.sh [--bg]
#   (옵션 없음) = 포그라운드(로그 흐름, Ctrl+C 종료) / --bg = 백그라운드(로그 /tmp/naia-dev.log)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"          # new-naia-os 루트
NAIA_OS="${NAIA_OS_DIR:-$(cd "$HERE/../../naia-os" 2>/dev/null && pwd || true)}"  # projects/naia-os
[ -n "$NAIA_OS" ] && [ -d "$NAIA_OS/shell" ] || { echo "naia-os 못 찾음 (NAIA_OS_DIR 로 지정)"; exit 1; }

echo "== 기존 dev 서버 정리 (포트 1420) =="
pkill -f "tauri-with-mode.mjs dev" 2>/dev/null || true
pkill -f "pnpm run tauri dev"      2>/dev/null || true
sleep 1

cd "$NAIA_OS/shell"
echo "== naia-os dev 실행: $NAIA_OS/shell =="
echo "   (증분 빌드 수십초~수분 후 창이 뜸. 끄기: 포그라운드=Ctrl+C / 백그라운드=pkill -f tauri-with-mode)"
echo "   확인: 창 뜨면 F12 → Console 에 $HERE/scripts/builds/f0-graft-snippet.js 붙여넣기 → [F0-GRAFT] match 확인"
echo ""

if [ "${1:-}" = "--bg" ]; then
  nohup pnpm run tauri:dev > /tmp/naia-dev.log 2>&1 &
  echo "백그라운드 pid=$! · 로그=/tmp/naia-dev.log"
else
  exec pnpm run tauri:dev
fi
