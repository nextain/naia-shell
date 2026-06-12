#!/usr/bin/env bash
# Luke-로컬 편의 런처 — `pnpm tauri:dev` 에 위임.
# ⚠️ provider 강제(옛 AGENT_PROVIDER=glm/GLM_MODEL) **삭제됨**: provider 는 이제 config(naia-settings)가 결정한다.
#    "온보딩/설정 → naia-adk/naia-settings → 셸이 req.provider+creds 로 전달 → agent resolver 가 lab-proxy/native/ollama 라우팅."
# 빌드(코어+에이전트 tsc)·env(VITE_NAIA_NEW_CORE/NAIA_AGENT_SCRIPT/GDK_BACKEND)·stale 정리 = tauri:dev(scripts/dev-setup + tauri-with-mode)가 담당.
# (디스플레이 필요 — GUI 창. 첫 cargo 빌드 수 분.)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # packages/shell

echo "[run-new-core-dev] config-driven provider(naia-settings) → pnpm tauri:dev"
echo "[run-new-core-dev] (헤드리스 fake LLM 으로 띄우려면: AGENT_PROVIDER=fake ./run-new-core-dev.sh)"

cd "$HERE"
exec pnpm tauri:dev
