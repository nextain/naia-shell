# Agent Bridges (한국어)

[이슈 #272](https://github.com/nextain/naia-os/issues/272) reconcile 이후의
**shell ↔ naia-agent ↔ naia-memory** wire SoT.

> English mirror: [`agent-bridges.md`](../agent-bridges.md)
> AI 최적화 계약: [`.agents/context/agent-bridges.yaml`](../../../.agents/context/agent-bridges.yaml)

## 배경

`#201` 이 OpenClaw gateway daemon 을 제거한 이후, Tauri shell + 임베드된
naia-agent 프로세스 + naia-memory R4 는 stdio JSON 으로만 조정됩니다.
3개 bridge + 5개 strangler-fig provider 어댑터가 그 역할.

## 3개 bridge

### 1. Protocol bridge — `agent/src/protocol-bridge.ts`

StdioFrame v1 envelope 코덱. 단일 stdio reader 가 여러 request type 을 다룰
수 있도록 legacy flat JSON 을 typed envelope 로 wrap.

| 함수 | 용도 |
|------|------|
| `looksLikeFrame(line)` | JSON parse 전 빠른 prechecker |
| `unwrapFrame(line)` | envelope → `{ type, payload }` 또는 `null` |

**활성화**: 기본 off. `NAIA_PROTOCOL_ENVELOPE_ONLY=1` 이면 legacy flat
frame 모두 거부 — opt-in 전용 (shell 측이 envelope 전송 준비 후). Phase 5 가
shell 측 wire 담당.

### 2. Memory bridge — `agent/src/memory-bridge.ts`

naia-memory `MemorySystem` 을 wrap 해서 `@nextain/agent-types`
`MemoryProvider` 인터페이스로 노출하는 어댑터.

```ts
const memorySystem = buildMemorySystem();              // naia-memory 네이티브
const memoryProvider = createNaiaMemoryProvider(       // bridge wrap
  memorySystem,
  { defaultProject: "naia-os" }
);
```

| 연산 | bridge 동작 |
|------|------------|
| `encode` | `MemoryInput.context` (`Record<string,string>`) ↔ naia-memory `MemoryInput.context` (단일 문자열). `scoring` 키가 그 문자열로, `project/sessionId/activeFile` 은 `EncodingContext` 로. |
| `recall` | `MemoryHit[]` 반환 (facts + episodes 통합, 정규화 score 정렬, `topK` cap). |
| `sessionRecall` | naia-memory `MemorySystem.sessionRecall` 로 pass-through. |

**Paired lifecycle**. `memorySystem` 과 `memoryProvider` 둘 다 모듈 스코프
`let` binding. `handleAuthUpdate` 가 둘을 atomic 하게 재빌드해서 naia
embedding + fact extractor 가 새 key 를 즉시 적용:

```ts
const old = memorySystem;
memorySystem = buildMemorySystem();
memorySystem.startConsolidation();
memoryProvider = createNaiaMemoryProvider(memorySystem, { defaultProject: "naia-os" });
void old.close().catch((err) => console.error(`[agent:memory] ...`));
```

**Race 주의**: `auth_update` 중 mid-flight 인 fire-and-forget
`memoryProvider.encode(...)` 가 OLD `MemorySystem` 에 떨어질 수 있음. 에러는
이제 로깅됨 (silent 였음 — #272 adversarial F4 fix). 완전한 drain barrier 는
follow-up.

### 3. Approval bridge — `agent/src/approval-bridge.ts`

IPC approval broker. 현재 `agent/src/index.ts` 에서 `void approvalBridge;` 로
inert. Phase 5 Day 6.3 가 `pendingApprovals` Map + `waitForApproval` 패턴을
`approvalBridge.decide()` 로 교체. compile time presence 가 downstream 테스트
import surface 안정성 보장.

## 5개 strangler-fig provider adapter

네이티브 LLM provider 보존. 가족(family) 별로 parallel `@nextain/agent-providers`
어댑터 추가. 라우팅은 호출 당:

- `NEXTAIN_AGENT_PROVIDERS=1` → 모든 가족 external
- `NEXTAIN_<FAMILY>=1` → 해당 가족만 external
- unset → 네이티브 (0 위험 기본)
- Truthy 값: `1` / `true` / `yes` / `on` (대소문자 무관)

| 파일 | 범위 |
|------|------|
| `nextain-openai-adapter.ts` | OpenAI / Ollama / vLLM / xAI / zai (OpenAI-compat 가족) |
| `nextain-gemini-adapter.ts` | Google Gemini 풀 SDK (`thoughtSignature` parity) |
| `nextain-claude-cli-adapter.ts` | Claude Code CLI subprocess |
| `nextain-lab-proxy-adapter.ts` | Naia Lab Proxy SSE (chat completions) |
| `nextain-lab-proxy-live-adapter.ts` | Naia Lab Proxy WebSocket (Live API, `-live` 모델 suffix) |

### 탐지 헬퍼

`agent/src/providers/factory.ts` 에서 export — 테스트는 반드시 여기서 import
(regex 복사 금지):

- `isOmni(model)` — vllm-omni audio-inline 탐지
- `isLive(model)` — Lab-proxy `-live` suffix 탐지

**Omni 의도**: 오디오 포함 모델 (`gpt-4o`, `minicpm-o`, `qwen-vl-omni` …) 은
`NEXTAIN_VLLM=1` 이라도 네이티브 path 유지. #272 가 광범위 `/[-_]o\b/i`
fallback 제거 — `claude-opus-4-o`, `gemma-4-o` 오분류 원인.

## 인증 흐름

Agent 가 credential 소유. Shell 은 `auth_update` 1회만 전송, 매 request 마다
`naiaKey` 보내지 않음.

```ts
// shell 측
agent.write({ type: "auth_update", naiaKey: "gw-..." });

// agent 측 (factory.ts)
let _agentNaiaKey: string | undefined;
export function setAgentNaiaKey(key: string): void { _agentNaiaKey = key; }

// 매 request
export function buildProvider(config: ProviderConfig): LLMProvider {
  const naiaKey = _agentNaiaKey;
  if (naiaKey) return /* lab-proxy 라우팅 */;
  return /* 네이티브 또는 env-gated strangler-fig */;
}
```

테스트 규율: `beforeEach` 에 `setAgentNaiaKey("gw-...")` 로 seed,
`afterEach` 에서 clear. 제거된 `config.naiaKey` 필드는 함정 — 아직 그걸
넘기는 테스트는 silent 하게 fall-through path 를 탑니다.

## Creds update 흐름 (#260 follow-up, 2026-05-12)

**모든** per-session 자격증명이 단일 `creds_update` 메시지로 흐름 — LLM API
key, TTS API key, gateway WS token. `auth_update` (naiaKey) + `notify_config`
(webhooks) 와 동일한 one-shot 패턴. per-request frame 은 자격증명 0개.

```ts
// shell 측 — startup 1회 + 설정 저장 시 1회
sendCredsUpdate({
  keys: {
    anthropic: "sk-ant-...",
    openai:    "sk-...",
    gemini:    "AIza...",
  },
  ttsKeys: {           // optional
    google:     "AIza...",
    openai:     "sk-...",
    elevenlabs: "el-...",
  },
  gatewayToken: "gw-token-...",  // optional
  // 빈 문자열은 agent 측 cached 값 clear
});

// agent 측
handleCredsUpdate(req) {
  // keys[provider]     → setProviderApiKey → _providerApiKeys Map
  // ttsKeys[provider]  → setTtsApiKey      → _ttsApiKeys Map
  // gatewayToken       → setGatewayToken   → _gatewayToken
}
```

스키마 레벨 강제:

- `SendChatOptions` 가 `ttsApiKey` / `gatewayToken` 받지 않음 (컴파일 차단).
- `directToolCall` opts 가 `gatewayToken` 받지 않음 (컴파일 차단).
- shell 빌더가 `send_to_agent_command` invoke 전에 `provider.apiKey` + `provider.naiaKey` 를 chat_request 페이로드에서 스트립.
- Agent 의 `ProviderConfig.apiKey` 는 `@deprecated` optional — buildProvider 는 하위호환 fallback 로 유지하지만 공식 shell 은 보내지 않음.

Agent resolution 우선순위 (자격증명별):

| 종류 | Lookup |
|---|---|
| LLM api key | `_providerApiKeys.get(provider)` → `config.apiKey` (deprecated) → envVar |
| TTS api key | `_ttsApiKeys.get(provider)` (req.ttsApiKey 는 deprecated, legacy 유지) |
| Gateway token | `_gatewayToken` (req.gatewayToken `??` fallback 유지) |

## Notify config 흐름 (#260)

Webhook URL + Discord 기본값은 `notify_config` 로 흐름 — per-request 아님.

```ts
// shell 측 — startup 1회 + 설정 저장 시 1회
sendNotifyConfig({
  slackWebhookUrl,
  discordWebhookUrl,
  googleChatWebhookUrl,
  discordDefaultUserId,
  discordDefaultTarget,
  discordDmChannelId,
});

// agent 측 (index.ts)
handleNotifyConfig(req) → applyNotifyWebhookEnv(...) // process.env 기록
```

`applyNotifyWebhookEnv` 의미:
- `undefined` 필드 → 기존 env 보존 (부분 업데이트 / 첫 startup)
- 빈 문자열 → env 삭제 (사용자가 textbox 지운 = 명시적 unset)
- non-empty → 기록

매 request `chat_request` / `tool_request` frame 은 이 필드들을 절대 carry
하지 않음. 하위 호환 위해 request type 에는 optional 로 선언만 남김 — shell
은 populate 안 함.

#260 의 자격증명 누출 차단: 모든 LLM 턴의 stdio frame 에 webhook URL 들이
더이상 안 보임 (logs, crash dumps, malicious npm wrappers 회피).

## 보안 hardening (#256-#260 + follow-up)

2026-05-12 적대적 리뷰에서 5건 P0-critical fix:

| 이슈 | 위치 | 내용 |
|---|---|---|
| #256 | `agent/src/index.ts` `handleToolRequest` | `executeTool` 전에 `needsApproval(toolName)` 게이트 (미매핑 도구는 default Tier 2). L759/L834 의 LLM-loop 게이트와 동일. |
| #257 | `agent/src/skills/built-in/panel.ts` `actionInstall` | `source` 가 `https://` 로 시작해야 함 — `file://` / `http://` / `git@` / `data:` / `javascript:` / bare path 거부. local-zip unzip fallback 제거. |
| #258 | `shell/src-tauri/tauri.conf.json` `assetProtocol.scope` | 명시적 allow + `requireLiteralLeadingDot: true` 의 full FsScope 객체. Bare `**` / drive-roots / bare `/tmp/**` 제거. Follow-up: #277 (runtime scope 확장). |
| #259 | `shell/src-tauri/tauri.conf.json` `csp.connect-src` | `discord.com` 제거. 모든 Discord API 는 Rust `invoke('discord_api', ...)` 경유. |
| #260 | 새 `notify_config` msg type | Webhook URL 을 per-request stdio 에서 제거 (위 "Notify config 흐름" 참고). |
| #248 | `shell/src/lib/llm/registry.ts` + `agent/src/providers/lab-proxy.ts` | Gateway GCP project 가 gemini-3.x Vertex access 없음 — Naia provider picker 에서 제거, `gemini-3.1-flash-live-preview` fallback fix, 0-byte SSE 정확한 에러. 저장된 config 마이그레이션 `shouldMigrateNextainModel`. |
| #254 | `shell/src-tauri/tauri.conf.json` + `App.tsx` `useAppReady` | Cold-start flash 위해 `windows[0].backgroundColor: [6, 13, 20, 255]`; `useAppReady` 가 `showOnboarding` 을 `showAdkSetup` 과 동일 처리 — 5초 splash deadlock 회피. |

2026-05-12 추가 완료:

- **#277** — runtime asset scope 확장. `protocol-asset` Cargo feature 활성화, `assetProtocol.enable: true`, `copy_bundled_assets` 가 `app_handle.asset_protocol_scope().allow_directory(adk_path, true)` 호출. 비표준 ADK path (`/mnt/external`, `/opt/custom`, `D:\custom\naia`) 도 자산 정상 서빙.
- **`creds_update` LLM keys** — `provider.apiKey` 가 `creds_update.keys` 로 1회 전송.
- **`creds_update` ttsKeys + gatewayToken** — 동일 메시지에 TTS provider keys + Naia Gateway WS token 까지 통합. `SendChatOptions` / `directToolCall` opts 가 컴파일 단계에서 해당 필드 차단. 모든 shell callsite 정리 (ChatPanel / SettingsTab / AgentsTab / SkillsTab / DiagnosticsTab / discord-relay).

남은 작업:

- Agent 의 `ProviderConfig.apiKey` 완전 제거 (현재 `@deprecated` optional). out-of-tree fork 와 조율 필요.

## Vendored 패키지

| 파일 | 용도 |
|------|------|
| `agent/vendor/nextain-agent-protocol-0.1.0.tgz` | Envelope 프로토콜 contract |
| `agent/vendor/nextain-agent-providers-0.1.0.tgz` | Strangler-fig 어댑터 |
| `agent/vendor/nextain-agent-types-0.1.0.tgz` | `MemoryProvider` / `ApprovalRequest` / 등 |

vendored 인 이유: 내부 Nextain 패키지로 npm 공개 안됨. 업데이트:
tgz 교체 + `agent/package.json` 의 version pin 올림.

## 크로스-repo 의존성

| Repo | 필수 exports | Pin |
|------|------------|-----|
| `naia-memory` | `MemorySystem`, `LocalAdapter`, embedding providers, `buildLLMFactExtractor`, **`HeuristicContradictionFilter`** (#272 추가) | alpha-adk submodule |
| `naia-adk/packages/skills-builtin` | 전체 23-skill 카탈로그 (#273 Phase 4.0 Day 3-7 + #274 OpenClaw 포팅) + `ALL_DESCRIPTORS` enum. Tier 분포: 8 T0 / 13 T1 / 2 T2. | file:path |
| `naia-adk/packages/openclaw-compat` | OpenClaw → naia 마이그레이션 도구 (CLI `naia-openclaw-migrate`). OpenClaw `SKILL.md` frontmatter 를 `SkillDescriptor` 로 변환. #275 로 추가. | file:path (standalone, naia-os agent 가 직접 import X) |
| `@nextain/agent-types` (vendored) | Bridge contract 타입 | `agent/vendor/` 내 tgz |

## 보류된 작업

- Phase 4.3 Day 6.2-6.4: 18-skill envelope wire, IpcApprovalBroker 직접 wire, `handleChatRequest` 분해 (1276 → ~300 LOC)
- Phase 4.4 Day 7.3: Claude-CLI Flatpak/Windows subprocess + partial-JSON
- `auth_update` drain barrier (현재 에러 로깅만; 완전 barrier 는 ref-counted op 필요)
- `approvalBridge` wire-in (현재 inert)
- `naia-adk/skills-builtin` 의 남은 9개 skill descriptor
