# DEPLOY.md — Phase 4.1 ~ Phase 5 production deploy 가이드

> **status**: post-#272 reconcile (main 위 통합)
> **branch**: `main`
> **본 docs**: Phase 4.1 + 4.2 production wire + naia-memory R4 reconcile 결과 + 검증 순서

---

## 빠른 검증 순서 (사용자 우선순위)

### 1. install + naia-memory dist integrity (P0)

```bash
cd projects/naia-os/agent
pnpm install

# naia-memory dist 검증 (post-#272 — symlink 스키마 제거, 실 디렉토리 직접 참조)
ls -la node_modules/@nextain/naia-memory
# 정상: → /var/home/luke/alpha-adk/projects/naia-memory (pnpm file:path)
# 비정상 (dist 손상): "Cannot find module .../dist/memory/index.js"
#   fix: cd ../../naia-memory && pnpm build
bash scripts/verify-symlink.sh   # dist 자동 검증
```

### 2. 환경 변수 옵션 (Phase 4.2 ~ Phase 5 기능)

#### LLM provider 라우팅 (per-provider strangler fig)

| env var | 효과 |
|---|---|
| `NEXTAIN_AGENT_PROVIDERS=1` | **모든** provider를 external @nextain adapter로 라우팅 |
| `NEXTAIN_ANTHROPIC=1` | Anthropic만 external (AnthropicClient) |
| `NEXTAIN_OPENAI=1` | OpenAI만 external (OpenAICompatClient) |
| `NEXTAIN_GEMINI=1` | Gemini full GeminiClient (thoughtSignature parity) |
| `NEXTAIN_GEMINI=openai-compat` | Gemini OpenAI-compat (legacy, signature loss) |
| `NEXTAIN_ZAI=1` | Zhipu GLM external |
| `NEXTAIN_XAI=1` | xAI external |
| `NEXTAIN_CLAUDE_CODE_CLI=1` | Claude CLI external (ClaudeCliClient) |
| `NEXTAIN_LAB_PROXY=1` | Lab-proxy external (Gateway SSE/WebSocket) |
| `NEXTAIN_VLLM=1` | vLLM (non-omni) external |

**unset = native (기존 코드 그대로, 안전)**.

#### Protocol envelope 모드

| env var | 효과 |
|---|---|
| `NAIA_PROTOCOL_ENVELOPE_ONLY=1` | **모든 legacy flat protocol 거부** — StdioFrame v1 envelope만 허용 |

**⚠️ 주의 (P0)**: `NAIA_PROTOCOL_ENVELOPE_ONLY=1`은 **opt-in** — 실수로 set하면 모든 chat request 즉시 reject됨. shell 측 (Tauri Rust)이 envelope 형식으로 frame 송신하도록 변경되기 전까지는 unset 권장. **default = unset (transition window 양립)**.

### 3. 실 LLM 라운드트립 검증 (smoke-chat.ts)

```bash
# env source
set -a; source ../../../data-private/llm-keys/llm.env; set +a

# 보유 KEY로 즉시 검증
pnpm exec tsx scripts/smoke-chat.ts gemini              # 네이티브 @google/genai SDK
pnpm exec tsx scripts/smoke-chat.ts gemini-external     # NEXTAIN_GEMINI=1 (full GeminiClient)
pnpm exec tsx scripts/smoke-chat.ts gemini-compat       # NEXTAIN_GEMINI=openai-compat
pnpm exec tsx scripts/smoke-chat.ts zai                 # GLM_API_KEY 네이티브
pnpm exec tsx scripts/smoke-chat.ts zai-external        # NEXTAIN_ZAI=1
pnpm exec tsx scripts/smoke-chat.ts lab-proxy           # GATEWAY_URL + GATEWAY_MASTER_KEY
pnpm exec tsx scripts/smoke-chat.ts lab-proxy-external  # NEXTAIN_LAB_PROXY=1
```

각 5-30초 소요. break 시 stack trace 공유.

### 4. Tauri shell + agent E2E (가장 critical)

```bash
cd ../shell && pnpm run tauri:dev
# UI에서 chat "hi" 입력 → response 받음 = full E2E PASS
```

shell ↔ agent stdio handshake + memoryProvider + provider stream 전체 라운드트립 검증.

---

## 본 세션 production-ready 분류 (정직)

### ✅ production-ready (Phase 4.1+4.2)
- IpcApprovalBroker / StdioDispatcher / 5 strangler fig adapter (anthropic/openai/gemini/claude-cli/lab-proxy)
- memory-bridge / approval-bridge / protocol-bridge (transition wire)
- per-provider env flag + ClaudeCliClient env allowlist
- envelope-aware readline (transition window)

### ⚠️ pre-production (Phase 4.3 + 4.5 partial + Phase 5 P2)
- envelope-only mode (사용자 opt-in only, shell wire 미완)
- legacy "always" 변환기 (D40 transition, Phase 5+ Day 6.3에 정식 wire)
- Gemini full parity (실 SDK call 미검증)
- Lab-proxy live WebSocket (실 Naia Lab Gateway 정합 미검증)
- ClaudeCli Flatpak/Windows (실 환경 검증 미)

### ⬜ spec only (Phase 5 P1 deferred)
- 18 skills wire (naia-adk skills-builtin Day 3-7 의존)
- IpcApprovalBroker 직접 wire (gateway/event-handler.ts sync 의존)
- handleChatRequest 분해 (1276 → ~300 LOC, 6.2+6.3 의존)

---

## 검증 통계

- naia-os agent: **1190 PASS** / 2 fail (TTS Edge 외부 네트워크, 무관)
- naia-agent providers: **29 PASS** (10 mock + 19 integration)
- naia-agent cli-app: **84 PASS**
- regression **0건** (Phase 4 → Phase 5 → integration 보강 누적)
- 적대적 review 8 사이클 → TWO consecutive PASS (7+8차)
- 78 integration tests (실 naia-memory / spawn / WebSocket / PassThrough — mock 의존 줄임)

---

## 다음 세션 우선순위

1. 사용자 검증 결과 → break 시 stack trace 공유, 즉시 fix
2. naia-adk skills-builtin Day 3-7 (Day 6.2 unblock)
3. gateway/event-handler.ts sync (Day 6.3 unblock)
4. Day 6.4 handleChatRequest 분해
5. naia-os#231 PR review + main merge (사용자 결정)
