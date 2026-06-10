#!/usr/bin/env bash
# B3 라이브 — 실제 naia-os 앱 창에서 *새 core(이식)* + *new-naia-agent* + GLM 클라우드 LLM 채팅.
# UI=기존 그대로. 채팅 백엔드만 새 이식 스택. (디스플레이 필요 — GUI 창.)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"            # packages/shell
NEW_NAIA="$(cd "$HERE/../../.." && pwd)"                         # projects/new-naia
ADK_ROOT="$(cd "$NEW_NAIA/../.." && pwd)"                        # alpha-adk

# 1) GLM 키(데이터-프라이빗) — 없으면 ollama 로 대체 안내
KEYF="$ADK_ROOT/data-private/llm-keys/llm.env"
if [ -f "$KEYF" ]; then set -a; source "$KEYF"; set +a; fi
PROVIDER="${AGENT_PROVIDER:-glm}"   # glm(클라우드, GPU 0) 기본. ollama 쓰려면 AGENT_PROVIDER=ollama 로 호출.

# 2) 새 core 사용 + new-naia-agent spawn 지정(Rust 가 env 로 agent 결정)
export VITE_NAIA_NEW_CORE=1
export NAIA_AGENT_STANDALONE=1
export NAIA_AGENT_SCRIPT="$NEW_NAIA/new-naia-agent/scripts/builds/agent-stdio-entry.mjs"
export AGENT_PROVIDER="$PROVIDER"
# 셸 UI 가 보낸 model(naia-local 등)은 GLM 카탈로그에 없어 거부됨 → 유효 GLM 모델 강제.
export GLM_MODEL="${GLM_MODEL:-glm-4.6}"

echo "[B3] new core=on, agent=new-naia-agent, provider=$PROVIDER"
echo "[B3] agent script: $NAIA_AGENT_SCRIPT"
[ "$PROVIDER" = glm ] && echo "[B3] GLM_MODEL: $GLM_MODEL (UI 모델 무시·강제)"
[ "$PROVIDER" = glm ] && { [ -n "${GLM_KEY:-}" ] && echo "[B3] GLM_KEY: set" || echo "[B3] ⚠ GLM_KEY 없음 — data-private/llm-keys/llm.env 확인 or AGENT_PROVIDER=ollama"; }
[ "$PROVIDER" = ollama ] && echo "[B3] ⚠ ollama 사용 — GPU1 에 ollama serve(gemma4) 기동 필요(naia-omni 와 GPU 경합 주의)"

# 3) 빌드 산출물 보장(코어 dist + agent dist)
( cd "$NEW_NAIA/new-naia-os" && npx tsc -p tsconfig.json >/dev/null 2>&1 || true )
( cd "$NEW_NAIA/new-naia-agent" && npx tsc -p tsconfig.json >/dev/null 2>&1 || true )

# 4) 앱 창(vite dev + cargo + Tauri window). 첫 cargo 빌드는 수 분.
cd "$HERE"
exec pnpm tauri dev
