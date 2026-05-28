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

## 인증 흐름 (v2 — issue #337, 2026-05-28)

> 구 `auth_update` IPC 흐름은 아래 "구 auth_update" 절에 reference 로 보존.
> standalone naia-agent runtime (dev/prod 기본) 은 v2 흐름만 사용.

**Runtime 선택** — shell `spawn_agent_core` (`shell/src-tauri/src/lib.rs`) 가
agent binary 를 다음 순서로 resolve:

1. `NAIA_AGENT_STANDALONE_PATH` env override
2. `resources/agent-standalone/dist/index.js` (bundled standalone)
3. `../../naia-agent/bin/naia-agent.ts` (dev TypeScript, **자동 활성화**)
4. `../agent/src/index.ts` (embedded, legacy)
5. `agent/dist/index.js` (bundled embedded, legacy)

dev 모드에서는 조건 3 이 발동되어 standalone `naia-agent` repo 의 인증 코드가
사용됨. embedded `naia-os/agent/dist` 는 로그인 경로와 무관.

**Credential 소유** — `naia-agent` 가 naiaKey 를 end-to-end 소유. shell 은
Phase 6c (commit `c44fdd6c`) 이후 key 를 읽거나 쓰지 않음. 오직 raw `naia://`
deep-link URL 을 agent 에 그대로 전달.

**암호화 영속화** — `<NAIA_ADK_PATH>/naia-settings/auth/{dev,prod}.json.enc`
- 암호화: AES-256-GCM via `crypto-envelope` (magic `NAIA`, salt 16 / nonce 12 / authTag 16)
- 마스터 키: OS keyring (service `io.nextain.naia`, account `auth-master-v1`)
  Windows DPAPI / macOS Keychain / Linux secret-tool + headless degraded mode
- 원자적 쓰기: `.tmp` + rename. mode 별 RW lock 으로 dev/prod 독립.

**IPC 표면** (모두 `naia-agent/bin/naia-agent.ts:1603-1700` 에서 dispatch):

| Type | 방향 | 목적 |
|---|---|---|
| `auth_start` | shell → agent | `{ authUrl, state }` 반환. agent 가 64-hex state 토큰 생성, 5분 TTL in-memory `stateMap` 에 저장. authUrl 에 `state`, `app=naia-os`, `redirect=desktop`, `source=desktop`, `platform`, `scope?` 포함. |
| `auth_received` | shell → agent | raw `deepLinkUrl` 전달. agent 가 파싱, state map 검증, 암호화 파일 저장, `auth_changed loggedIn:true` emit. 응답에 naiaKey **절대** 포함 안 됨. |
| `auth_query` | shell → agent | `{ loggedIn, expiresAt?, userId?, scope? }` 반환. tri-state 배지 구동. |
| `auth_logout` | shell → agent | 암호화 파일 삭제, `auth_changed loggedIn:false` emit. |
| `auth_legacy_migrate` | shell → agent | Phase 8 일회성. 구 `secure-keys.dat:naiaKey` 에서 암호화 파일로 seed. ack 실패 시 hard-fail. |
| `lab_proxy_request` | shell → agent | shell 은 naiaKey 를 **절대** 보유 안 함. agent 가 암호화 파일에서 읽고 `X-AnyLLM-Key: Bearer …` 주입, upstream 응답만 반환. 401 → single-flight refresh + 1회 재시도. **경로 prefix 라우팅** (2026-05-28): `/v1/*` → mode-mapped Lab Gateway origin, 나머지 → portal issuer. 절대 URL 은 origin 이 issuer 또는 mode-mapped gateway 일 때만 허용; 그 외 → `disallowed_host`. |
| `auth_changed` | agent → shell push | `{ mode, loggedIn }` save/delete 시. |
| `auth_expired` | agent → shell push | `{ mode, reason: "refresh_failed" \| "revoked" }`. |

**OAuth URL 구성** (`naia-agent/packages/runtime/src/utils/oauth-flow.ts:118`):

```
{issuer}/{locale}/login
  ?state={64-hex-csrf}
  &app=naia-os
  &platform={win32|darwin|linux}
  &redirect=desktop
  &source=desktop
  &scope={csv}?
```

`issuer` 는 dev 모드에서 `http://localhost:3001` (로컬 naia.nextain.io dev
서버), prod 모드에서 `https://naia.nextain.io`.

**Lab Gateway URL** (lab_proxy_request `/v1/*` 라우팅):

- dev: `https://naia-gateway-dev-181404717065.asia-northeast3.run.app`
  (`NAIA_LAB_GATEWAY_URL_DEV` env override)
- prod: `https://naia-gateway-181404717065.asia-northeast3.run.app`
  (`NAIA_LAB_GATEWAY_URL_PROD` env override)

**Cross-repo 결합 — Portal middleware**
(`projects/naia.nextain.io/src/proxy.ts`):

- desktop-auth 분기 진입은 `redirect=desktop` **AND** `app=naia-os` **둘 다**
  필요. 이전 OR 의미론은 조작된 phishing 링크가 인증된 사용자에게 desktop
  flow 를 silent 하게 트리거할 수 있었음.
- 매치 시: `/{lang}/callback` 로 redirect 하면서 **원래 query param 전체를
  forward** — `state` 보존됨. skip list: `source` (정규화됨), `callbackUrl`
  (SSO open-redirect guard 가 이미 처리), `redirect`, `app`.
- `state` 는 forward 전에 `/^[0-9a-f]{64}$/` 로 형식 검증 — 공격자의 임의
  state 값 주입 차단.

이 contract 없이는 callback 페이지가 `state=null` 을 받고,
`buildNaiaAuthDeepLink` 가 state 파라미터 생략, agent 의
`receiveOAuthDeepLink` 가 `missing_state` 로 reject — 2026-05-28 에 진단된
"로그인이 멈춘 듯 보이는" 증상이 됩니다.

**State token (CSRF)** — in-memory 만 (`oauth-flow.ts:92 stateMap`):
- 32 random byte → 64-char hex
- 5분 TTL
- 일회성: receive 시 TTL 검사 **전에** 삭제
- `mode`, `issuer`, `scope` 에 binding
- agent crash 시 re-login 강제 (state 손실)

**Shell UI** — tri-state 배지 `checking / logged_in / logged_out` — `useAuthStatus`
hook 이 `onAgentAuthChanged` 를 consume. 낙관적 render 없음 — agent process
spawn 후 부팅 SLA 목표 <200 ms p95. `auth_received ok:false` 시 에러
surface 는 현재 warn 로그만 (`App.tsx:559`); UI 배너는 follow-up.

**알려진 위험** (향후 hardening 을 위해 기록):

- `NAIA_ADK_PATH` poisoning (공격자 제어 env var → 잘못된 저장 디렉토리)
- OS keyring 이 단일 실패점 (macOS unlocked Keychain, Linux DBUS 노출,
  Windows DPAPI per-user 만)
- TPM / Secure Enclave 하드웨어 binding 없음 (follow-up, #337 §6)
- forensic 로그 버퍼 (`oauth-flow.ts:96-112`) 가 start event 시 full 64-hex
  state 를 기록. `onOAuthLog` subscriber 가 plaintext 로 볼 수 있음 —
  defense-in-depth truncation 보류

## Observability — 로그 SoT + AI 자가 진단

> **이 프로젝트에서 작업하는 AI 에게**: 런타임 증상을 조사할 때,
> **로그 파일을 직접 읽으십시오**. 사용자에게 paste 를 요청하지 마십시오.
> 사용자의 역할은 앱에서 액션을 취하는 것; AI 의 역할은 로그에서 상태를
> 관찰하는 것.

### 로그 파일 (Single Source of Truth)

모든 Tauri-side 및 agent-side 로그는 `$HOME/.naia/logs/` 아래 위치
(Windows 에서는 `%USERPROFILE%\.naia\logs\` — 예: `C:\Users\<user>\.naia\logs\`).

| 파일 | Owner | 언제 읽나 |
|---|---|---|
| `naia.log` | Rust shell | 세션 lifecycle, deep-link 수신, agent spawn, gateway sync |
| `agent-stderr.log` | naia-agent stderr | **모든 IPC timeout** — agent 가 import 중 crash 했을 수 있음 |
| `node-host.log` | Legacy openclaw (#201 이후 inert) | 현재 거의 무용 |
| `gateway.log` | Legacy Naia Gateway (#201 제거) | Inert |
| `bgm-server-stderr.log` | BGM tsx subprocess | 오디오 loop 오류 |
| `llm-debug.log` | LLM client (`NAIA_LLM_DEBUG=1` 일 때만) | opt-in 시 상세 request/response |

### 결정 트리 — 흔한 증상

**증상: DevTools 또는 `naia.log` 에 `agent-ipc timeout: <responseType>`**

1. `agent-stderr.log` tail 을 읽으십시오. `SyntaxError` 또는 처리되지 않은
   오류 = agent 가 module import 중 crash. 가장 흔한 원인: runtime `dist/`
   가 `src/` 와 sync 안 됨. 수정:
   ```bash
   cd projects/naia-agent && pnpm exec tsc --build packages/runtime
   ```
2. `naia.log` tail. `agent-core started` 확인 + 즉시 `Session ended` 가
   따라오지 않는지 확인.
3. agent 가 살아있는데 모든 IPC 가 timeout 이면: Windows keyring 부트스트랩.
   `bin/naia-agent.ts:runStdio()` 에서 `await prewarmKeyring()` 이 `ready`
   신호 **전에** 호출되는지 확인.
4. stdio probe 를 직접 실행하십시오. 사용자를 기다리지 마십시오. 아래
   **probe recipe** 참조.

**증상: Lab 로그인이 멈춤 — 시스템 브라우저는 열리지만 앱이 `logged_in`
도달 못 함**

1. `naia.log` — `Deep link received` 라인 찾기. 없으면 portal redirect 가
   발사 안 됐거나 `naia://` 스킴이 등록 안 됨.
2. Portal middleware (`projects/naia.nextain.io/src/proxy.ts`) 가 `state`
   query param 을 forward 하는지 확인. 2026-05-28 fix 이후 필수.
3. `agent-stderr.log` 에서 `receiveOAuthDeepLink` reject 이유 (`missing_state`
   / `unknown_state` / `expired_state`) 찾기.
4. `<NAIA_ADK_PATH>/naia-settings/auth/{mode}.json.enc` 가 실제로 생성됐는지
   확인.

**증상: chat 이 `no LLM provider configured` 반환**

1. `naia.log` — mount 시 `sendCredsUpdate` emit 확인.
2. `agent-stderr.log` 에서 credential 파싱 실패 찾기.
3. `AppConfig.provider` / `AppConfig.model` 이 비어있지 않은지 (shell
   `config.ts`) 확인.

### Probe recipe — Tauri shell 없이 직접 stdio 검증

```bash
cd projects/naia-agent
node -e "
const { spawn } = require('child_process');
const child = spawn('node',
  ['node_modules/tsx/dist/cli.mjs', 'bin/naia-agent.ts', '--stdio'],
  { env: { ...process.env, NAIA_ADK_PATH: '<your-adk-path>',
           NAIA_AGENT_MODE: 'dev' },
    stdio: ['pipe','pipe','pipe'] });
let buf = '';
child.stdout.on('data', d => {
  buf += d.toString();
  for (const line of buf.split(/\r?\n/).slice(0,-1)) {
    try {
      const j = JSON.parse(line);
      if (j.type === 'ready') {
        child.stdin.write(JSON.stringify({type:'auth_query',id:'p1',mode:'dev'})+'\n');
      } else if (j.type === 'auth_query_response') {
        console.log(JSON.stringify(j));
        child.kill(); process.exit(0);
      }
    } catch {}
  }
  buf = buf.split(/\r?\n/).slice(-1)[0];
});
setTimeout(() => process.exit(1), 60000);
"
```

기대 (Windows): `ready` 가 ~10초 이내 (keyring 사전 워밍) + `auth_query_response`
가 <5ms. 그보다 느리면 머신 특정 이슈.

### Anti-patterns

- **사용자에게 로그 paste 요청 금지** — `agent-stderr.log` 를 Read 도구로 직접 읽기.
- **단일 timeout 만 보고 IPC wiring 추정 금지** — `agent-stderr.log` 에서 agent 가 살아있는지 먼저 확인.
- **shell timeout 을 60s 이상으로 늘리기 금지** — 진짜 원인 (build artifact, keyring, 파일시스템) 을 찾으십시오. 현재 `KEYRING_IPC_TIMEOUT_MS = 45_000` 은 Windows 첫 부팅 keyring 부트스트랩 최악 케이스만 cover 하기 위함.

### 구 auth_update (#337 이전, embedded agent 만)

#337 이전 흐름은 단일 `auth_update` IPC 사용; shell 이 startup 에서
`secure-keys.dat` 에서 key 를 읽어 agent 의 module-scope `_agentNaiaKey`
cache 로 push:

```ts
agent.write({ type: "auth_update", naiaKey: "gw-..." });
```

이 경로는 `naia-os/agent/src/index.ts` 에 backward compat 용으로 남아있지만
dev 모드에서는 bypass 됨 (standalone runtime 우선 — 위 spawn resolution 순서
참조). `naia-agent` sibling repo 없이 cold clone 된 `naia-os` 만 이 경로를
사용; legacy 코드는 maintenance only.

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
