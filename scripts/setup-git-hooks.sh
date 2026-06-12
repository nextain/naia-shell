#!/usr/bin/env bash
# setup-git-hooks — 커밋 무결성 게이트 활성화(clone 당 1회). Luke "항상 깨끗한 상태 유지".
# core.hooksPath 는 .git/config 로컬설정이라 커밋이 안 됨 → 새 clone/PC 는 이걸 1회 실행해야 게이트가 산다.
# (세션시작 점검이 hooksPath 미설정을 RED 로 잡아 재실행 안내.)
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
git config core.hooksPath scripts/git-hooks
echo "✅ core.hooksPath = $(git config core.hooksPath) (pre-commit 무결성 게이트 활성)"
echo "   검사: 미스테이지 source 차단 + 컴파일 무결성(scripts/check-compile-integrity.mjs)."
