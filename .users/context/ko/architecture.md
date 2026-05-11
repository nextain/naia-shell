# Naia Architecture

## 현 상태 (post-#201, #272/#273/#274/#275 로 검증됨)

Naia OS 는 현재 **임베드 에이전트** 구조 — hybrid daemon 스택이 아닙니다. 현재 wire 의 SoT 는 [`.agents/context/agent-bridges.yaml`](../../../.agents/context/agent-bridges.yaml).

```
┌─────────────────────────────────────────────────────────┐
│  Naia Shell (Tauri 2 + React + Three.js VRM Avatar)     │
│  역할: UI, avatar, panels, device IO, channel adapters   │
└────────────────────┬────────────────────────────────────┘
                     │ stdio JSON lines
                     │  + StdioFrame v1 envelope (#272 전환 중)
┌────────────────────▼────────────────────────────────────┐
│  naia-agent (임베드 child process)                       │
│  - protocol-bridge: envelope 코덱                        │
│  - memory-bridge:   MemorySystem → MemoryProvider       │
│  - approval-bridge: IPC approval broker (Phase 5 wire)  │
│  - factory.ts:      _agentNaiaKey + 5 strangler-fig     │
│  - 23 built-in skills (naia-adk 의 descriptor)          │
└────────────────────┬────────────────────────────────────┘
                     │ MemoryProvider contract
┌────────────────────▼────────────────────────────────────┐
│  naia-memory R4                                         │
│  LocalAdapter + embedding providers + fact extractor +  │
│  HeuristicContradictionFilter                           │
└─────────────────────────────────────────────────────────┘
```

**현재 pillars**:
- **naia-os shell** — Tauri 2 desktop host, UI, avatar, device IO
- **naia-agent** — 임베드 child process (#201 이전엔 별도 daemon). stdio JSON. 3 bridges + 5 strangler-fig LLM 어댑터 + 23 skills.
- **naia-memory R4** — 벡터 + LLM fact extractor + contradiction filter
- **naia-adk** — 워크스페이스 + skill SoT (`skill-spec`, `skills-builtin`, `openclaw-compat`)

OpenClaw 는 #201 이전 gateway daemon 이었으며 **런타임에서 제거됨**. 아래 historical hybrid framing 은 맥락 보존용 — 현재 design 으로 보면 안됨.

## 최근 hardening (2026-05-12 적대적 리뷰 배치)

한 번의 자율 세션에서 7건 closed — 상세는 [`agent-bridges.md > 보안 hardening`](./agent-bridges.md#보안-hardening-256-260--follow-up).

| 이슈 | 분류 | 내용 |
|---|---|---|
| #256 | P0-보안 | `handleToolRequest` tier 게이트 (LLM-loop 경로 외 진입점 우회 차단) |
| #257 | P0-보안 | `panel_install` HTTPS-only (file:// / http:// / git@ / bare path 거부) |
| #258 | P0-보안 | `assetProtocol.scope` 강화 (bare `**` 제거, `requireLiteralLeadingDot: true`) |
| #259 | P0-보안 | `discord.com` CSP `connect-src` 제거 (모든 Discord 는 Rust invoke 경유) |
| #260 | P0-보안 | Webhook URL 을 per-request stdio 에서 제거 (새 `notify_config` 메시지) |
| #248 | P1-버그 | Naia gateway 가 gemini-3.x Vertex 접근 없음 — picker 에서 제거 + 저장된 config 마이그레이션 |
| #254 | P0-UX | Startup white flash + onboarding splash deadlock |

처음 작성 후 추가 완료:

- **#277** — runtime asset-scope 확장 완료. `protocol-asset` Cargo feature + `assetProtocol.enable: true` + `copy_bundled_assets` 가 `app_handle.asset_protocol_scope().allow_directory(adk_path, true)` 호출. 비표준 ADK path (`/mnt/external`, `D:\custom`, …) 자산 서빙 OK.
- **`creds_update`** — `provider.apiKey` one-shot 푸시로 이동. per-request `config.apiKey` 는 마이그레이션 윈도우 동안 하위호환으로 유지.

여전히 open: schema 정리 (`ChatRequest.provider` 의 `config.apiKey` 제거 — 모든 shell caller 가 `creds_update` 푸시 확인 후), 그리고 `ttsApiKey` + `gatewayToken` 도 동일 one-shot 패턴 (현재 per-request 상태).

---

# Naia 하이브리드 아키텍처 (historical, pre-#201)

## 핵심 설계 철학

> **처음부터 만들지 않는다. 검증된 3개 생태계를 조합한다.**

Naia는 3개의 모체 프로젝트에서 각각의 강점을 가져와 조합하는 **하이브리드** 방식:

| 모체 | 역할 | 가져오는 것 |
|------|------|------------|
| **OpenClaw** | 런타임 백엔드 | Gateway 데몬, 명령 실행, 채널, 스킬, 메모리 |
| **project-careti** | 에이전트 지능 | 멀티 LLM, 도구 정의, Alpha 페르소나, 비용 추적 |
| **OpenCode** | 아키텍처 패턴 | 클라이언트/서버 분리, 프로바이더 추상화 |

---

## 왜 하이브리드인가?

### 하나만 쓰면 안 되는 이유

**OpenClaw만?** → CLI 전용, 아바타 없음, Claude Code에 종속, 멀티 LLM 미지원
**Careti만?** → VS Code 확장, always-on 불가, 채널/스킬 없음
**OpenCode만?** → TUI 전용, Gateway/데몬 없음, 채널 없음

### 하이브리드 해법

```
OpenClaw의 데몬+실행+채널+스킬 생태계 (런타임 백엔드)
+ Careti의 멀티 LLM+도구+페르소나 (에이전트 지능)
+ OpenCode의 클라이언트/서버 분리 패턴 (아키텍처)
= Tauri 데스크톱 셸 + VRM 아바타로 포장 (접근성)
```

---

## 런타임 아키텍처

```
┌─────────────────────────────────────────────────────────┐
│  Naia Shell (Tauri 2 + React + Three.js VRM Avatar) │
│  역할: 데스크톱 UI, 아바타 렌더링, 채팅 패널           │
│  출처: Naia 자체 + AIRI (VRM) + shadcn/ui            │
└──────────────────────┬──────────────────────────────────┘
                       │ stdio JSON lines
┌──────────────────────▼──────────────────────────────────┐
│  Naia Agent (Node.js)                                │
│  역할: LLM 연결, 도구 오케스트레이션, Alpha 페르소나    │
│  출처: Careti 프로바이더 + OpenCode 패턴                │
│  기능: 멀티 LLM, TTS, 감정, 비용 추적                  │
└──────────────────────┬──────────────────────────────────┘
                       │ WebSocket (ws://127.0.0.1:18789)
┌──────────────────────▼──────────────────────────────────┐
│  Naia Gateway (systemd user service)                │
│  역할: 명령 실행, 보안, 채널, 스킬, 메모리             │
│  출처: naia-agent (Node.js, pnpm dev / dist/index.js)  │
│  인증: 디바이스 ID + 토큰 스코프 (protocol v3)          │
│  메서드: 프로파일별 동적 노출 (agent, node.invoke,      │
│  sessions, browser.request, skills, channels 등)         │
└─────────────────────────────────────────────────────────┘
```

## 3대 축 상세

### 축 1: OpenClaw (런타임 백엔드)

OpenClaw이 제공하는 것:
- **Gateway 데몬**: systemd 유저 서비스, 항상 실행
- **명령 실행**: exec.bash 우선 + node.invoke(system.run) 폴백
- **보안**: 디바이스 인증, 토큰 스코프, exec approval
- **채널**: Discord, Telegram, WhatsApp, Slack, IRC 등
- **스킬**: 50+ 내장 (날씨, 시간, 메모 등)
- **메모리**: 대화 영속, 컨텍스트 리콜
- **세션**: 멀티 세션, sub-agent spawn
- **ACP**: Agent Control Protocol (클라이언트↔에이전트 브릿지)
- **TTS**: 통합 프로바이더 셀렉터 (Edge TTS 무료, Google Cloud, OpenAI, ElevenLabs) — 직접 API 호출

### 축 2: project-careti (에이전트 지능)

Careti가 제공하는 것:
- **멀티 LLM (레지스트리)**: Naia, Claude Code CLI, Gemini, OpenAI, Anthropic, xAI, Zhipu, Ollama, vLLM
- **도구 정의**: GATEWAY_TOOLS (8개 도구)
- **Function calling**: Gemini 네이티브 (xAI/Claude = 기술 부채)
- **Alpha 페르소나**: 시스템 프롬프트, 감정 매핑
- **비용 추적**: 요청별 비용 표시
- **stdio 프로토콜**: Shell ↔ Agent JSON lines

### 축 3: OpenCode (아키텍처 패턴)

OpenCode가 제공하는 것:
- **클라이언트/서버 분리**: Shell (클라이언트) / Agent (서버)
- **프로바이더 레지스트리 패턴**: registerLlmProvider → buildProvider (확장 가능)
- **모듈 경계**: shell / agent / gateway 분리

---

## Shell UI 레이아웃

```
App
├── TitleBar (패널 토글 버튼 + 창 컨트롤)
└── .app-layout [data-panel-position="left"|"right"|"bottom"]
    ├── .side-panel (ChatPanel — panelVisible=true일 때만 렌더링)
    └── .main-area (AvatarCanvas — 항상 표시)
```

- **panelPosition**: `"left" | "right" | "bottom"` — CSS flex-direction으로 패널 위치 제어
- **panelVisible**: `boolean` — 채팅 패널 토글; 아바타는 항상 표시
- **panelSize**: `number (0-100)` — 채팅 패널이 뷰포트에서 차지하는 비율. 기본값: **70**
- **아바타 리사이즈**: `ResizeObserver`로 컨테이너 크기 변경 감지 (window resize 아님)
- **설정 동기화**: panelPosition + panelVisible + panelSize + liveVoice + liveModel + voiceConversation은 Lab에 동기화 (`LAB_SYNC_FIELDS`)

---

## 데이터 흐름

| 시나리오 | 흐름 |
|---------|------|
| **채팅** | User → Shell → Agent → LLM → Agent → Shell → User |
| **도구 실행** | LLM → Agent (tool_use) → Gateway (exec.bash 또는 node.invoke) → OS → result → LLM |
| **승인** | Gateway → Agent (approval_request) → Shell (모달) → 사용자 결정 → Agent → Gateway |
| **외부 채널** | Discord msg → Gateway → Agent → LLM → Agent → Gateway → Discord reply |

## 자격 증명 저장소 아키텍처

> 최종 업데이트: 2026-03-05

### naiaKey 이중 저장소 (localStorage + Tauri 보안 저장소)

`naiaKey` (Naia Lab API 키)는 안정성을 위해 **두 곳**에 저장된다:

| 저장소 | 특성 | 사용처 |
|--------|------|--------|
| **localStorage** | 동기, 빠름 | 모든 UI 컴포넌트 (`saveConfig`/`loadConfig`) |
| **Tauri 보안 저장소** | 비동기, 암호화 | 브라우저 스토리지 초기화 시에도 유지 |

**쓰기 지점:**
- **로그인** (SettingsTab/OnboardingWizard): `saveConfig({naiaKey})` + `saveSecretKey("naiaKey", key)`
- **저장** (SettingsTab): `saveConfig()` + `void saveSecretKey()`
- **로그아웃** (SettingsTab): `saveConfig({naiaKey: undefined})` + `deleteSecretKey("naiaKey")`

**읽기 병합** (`loadConfigWithSecrets()`):
1. localStorage 값 읽기 (동기)
2. 보안 저장소 값 읽기 (비동기)
3. **localStorage 우선** — 다르면 보안 저장소에 동기화
4. 보안 저장소에만 값이 있으면 → 사용 (마이그레이션/복구 케이스)

### naiaKey의 LLM 프로바이더 독립성

`naiaKey`는 `ChatRequest`에서 `provider` 설정과 별도의 **최상위 필드**로 전달된다. 이를 통해 LLM 프로바이더가 gemini/openai/xai/anthropic으로 설정되어 있어도 Naia Cloud TTS가 동작한다.

- ChatPanel은 `naiaKey`를 `provider.naiaKey` (LLM용)와 요청 수준 `naiaKey` (TTS용) 양쪽에 전달
- Agent 해석: `effectiveNaiaKey = request.naiaKey || provider.naiaKey`

**핵심 파일:** `config.ts`, `secure-store.ts`, `SettingsTab.tsx`, `OnboardingWizard.tsx`, `agent/src/index.ts`, `agent/src/protocol.ts`

---

## 데스크톱 아바타 로컬 파일 파이프라인

VRM/배경을 로컬 파일에서 안정적으로 로드하기 위한 규칙:

- `file://` 경로는 저장/렌더 전에 절대 경로로 정규화한다.
- 경로가 `http://localhost/...` 형태로 들어오면 Tauri 자산 프로토콜 호환을 위해 `http://asset.localhost/...`로 변환한다.
- 절대 로컬 VRM은 Rust 커맨드 `read_local_binary`로 바이트를 읽고, 프론트엔드에서 `ArrayBuffer`로 직접 parse한다.
  URL fetch 방식의 CORS/접근 제어 실패를 피하기 위함.
- 배경 이미지는 자산 URL 변환을 사용하고, 실패 시 기본 그라데이션 배경으로 폴백한다.

### E2E 실행 주의

- `e2e-tauri`는 `src-tauri/target/debug/naia-shell` 고정 바이너리를 실행한다 (`pnpm build` 산출물과 별개).
- Rust `#[tauri::command]` 또는 `invoke_handler` 변경 후에는 E2E 전에 반드시 `src-tauri`에서 `cargo build`를 실행한다.

### Agent 빌드 파이프라인 주의

Agent는 `shell/src-tauri/target/debug/agent/dist/index.js`에서 실행된다 (사전 빌드). **Vite HMR은 agent 코드에 적용되지 않는다.** `agent/src/` 수정 후:
1. `cd agent && pnpm build` (tsc가 `agent/dist/`로 컴파일)
2. `cp -r agent/dist/ shell/src-tauri/target/debug/agent/dist/`
3. 또는 `pnpm run tauri dev` 재시작 (자동 재빌드)

## 채널/온보딩 Discord 라우팅 규칙

- Discord 봇 추가 플로우는 Shell에서 직접 토큰/웹훅을 다루지 않고 `naia.nextain.io` 라우팅을 사용한다.
- Channels 탭의 Discord 로그인 버튼과 온보딩 마지막 단계 선택 버튼은 모두 아래 경로를 연다.
  `https://naia.nextain.io/ko/discord/connect?source=naia-shell`
- 보안 원칙:
  - `DISCORD_BOT_TOKEN`은 shell 프론트엔드에서 사용/노출하지 않는다.
  - 봇 비밀키는 `naia.nextain.io` 서버 환경변수에서만 관리한다.

## 딥링크 저장 계약 (중요)

OAuth 딥링크 페이로드는 특정 탭(설정/온보딩) 렌더 여부와 무관하게 반드시 저장되어야 한다.

- 필수 규칙:
  - 런타임 동작에 영향 주는 딥링크 이벤트(`discord_auth_complete` 등)는 **항상 마운트된 계층(App 루트)** 에서 수신/저장한다.
  - Settings/Onboarding 리스너는 UI 상태 동기화 용도로만 쓰고, 저장 로직은 공통 라이브러리로 단일화한다.
  - Agent 기본 전송 타깃 결정은 "설정 탭이 열려 있었는지"에 의존하면 안 된다.
- 금지 패턴:
  - 탭 컴포넌트 내부에서만 인증 페이로드를 저장하는 구조
  - 컴포넌트별로 서로 다른 fallback 규칙을 중복 구현하는 구조

## 메모리 아키텍처 (3-레이어)

메모리는 **세 시스템**에 나뉘어 있으며, 세션 경계에서 연결된다.

- **Shell**이 "사용자가 누구인지" (facts)를 소유
- **Naia Gateway**가 "무슨 일이 있었는지" (세션 트랜스크립트)를 소유
- **Agent**가 "시맨틱 리콜 + 모순 필터링"을 `@nextain/naia-memory` (R3)로 담당

### Shell 메모리 (Tauri)

#### 단기기억 (Short-Term Memory)

| 항목 | 내용 |
|------|------|
| **저장소** | Zustand (인메모리) + SQLite messages 테이블 |
| **범위** | 현재 세션 전체 메시지 |
| **수명** | 현재 세션 ~ 최근 7일 |
| **구현** | Rust `memory.rs` + Frontend `db.ts` + Chat store |

#### 장기기억 — Facts

| 항목 | 내용 |
|------|------|
| **저장소** | `~/.config/naia-os/memory.db` (SQLite, facts 테이블) |
| **범위** | 세션 간 사용자 지식 (이름, 생일, 선호, 결정사항) |
| **추출** | `memory-processor.ts` `extractFacts()` — LLM이 대화를 파싱 → `{key, value}[]` |
| **주입** | `persona.ts` `buildSystemPrompt()` → `"Known facts about the user: ..."` 시스템 프롬프트에 삽입 |

### Naia Gateway 메모리 (데몬)

#### 세션 트랜스크립트

| 항목 | 내용 |
|------|------|
| **저장소** | `~/.naia/sessions/` (`sessions.json` + 세션별 `*.jsonl`) |
| **범위** | 세션 키별 전체 대화 이력 (`agent:main:main`, `discord:dm:*` 등) |
| **RPC** | `sessions.list`, `chat.history`, `sessions.transcript`, `sessions.compact` |
| **Hook** | `session-memory` — `/new` 또는 `/reset` 시 대화를 `workspace/memory/*.md`로 저장 |

#### 시맨틱 검색 인덱스

| 항목 | 내용 |
|------|------|
| **저장소** | `~/.naia/memory/main.sqlite` (SQLite, 임베딩 포함) |
| **도구** | `memory_search` (시맨틱 검색), `memory_get` (항목 조회) |
| **범위** | 세션 간 검색 가능한 인덱스 (세션 + `workspace/memory/*.md` 파일) |

#### 워크스페이스 부트스트랩 파일

| 항목 | 내용 |
|------|------|
| **저장소** | `~/.naia/workspace/` (`SOUL.md`, `IDENTITY.md`, `USER.md`) |
| **동기화** | Shell이 설정 변경 시 `sync_gateway_config` (`lib.rs`)로 기록 |
| **참고** | Shell 설정에서 재생성 가능 — 원본 데이터 아님 |

### 데이터 흐름 (두 시스템의 연결)

```
세션 시작
  Shell: buildMemoryContext() → Shell DB에서 getAllFacts()
  Shell: buildSystemPrompt(persona, {facts, userName, locale, ...})
  → 사용자 facts가 포함된 시스템 프롬프트를 Agent에 전달

세션 진행 중
  Agent ↔ Naia Gateway: 메시지가 세션 트랜스크립트(*.jsonl)에 저장
  Naia Gateway: memory_search 도구로 LLM이 과거 세션 검색 가능
  Shell: Zustand store가 UI용 현재 메시지 보관

세션 종료 (사용자가 "새 대화" 클릭)
  Shell [fire-and-forget]:
    1. summarizeSession(messages) → LLM이 2-3문장 요약 생성
    2. patchGatewaySession("agent:main:main", {summary}) → Naia Gateway 세션 메타데이터
    3. extractFacts(messages, summary) → LLM이 {key, value}[] 사용자 facts 추출
    4. upsertFact() × N → Shell facts DB (memory.db)
  Naia Gateway:
    session-memory hook이 대화를 workspace/memory/YYYY-MM-DD-slug.md로 저장
    시맨틱 인덱스에 새 세션 내용 업데이트

다음 세션
  Shell: facts 로드 → 시스템 프롬프트에 주입 ("Known facts about the user")
  Naia Gateway: memory_search로 이전 세션 내용 검색 가능
  → 사용자는 시스템 프롬프트 facts + 검색 가능한 이력 양쪽으로 "기억"됨
```

### Discord 채널 메모리

Discord 메시지는 Naia Gateway 세션(`agent:main:discord:direct:<userId>`)을 통해 흐른다.
Naia Gateway 세션 트랜스크립트에 저장되고 `memory_search`로 검색 가능.
다만 Shell fact 추출(`summarizePreviousSession`)은 Shell 채팅 세션에서만 실행 —
**Discord 대화에서는 아직 fact 추출이 트리거되지 않음**.

### 기기 변경 시 백업 가이드

| 경로 | 내용 | 필수? |
|------|------|-------|
| `~/.config/naia-os/memory.db` | Shell facts (사용자 지식) | **필수** |
| `~/.naia/memory/main.sqlite` | 시맨틱 검색 인덱스 | **필수** (재구축 가능하나 느림) |
| `~/.naia/sessions/` | 대화 트랜스크립트 | 권장 |
| `~/.naia/gateway.json` | Gateway 설정 (API 키, 모델) | 권장 |
| `~/.naia/workspace/` | SOUL/IDENTITY/USER.md | Shell에서 재생성 가능 |
| `~/.naia/credentials/` | OAuth 토큰 | 재인증 가능 |

### Agent 메모리 — @nextain/naia-memory R3 (2026-05-07 추가, #226)

**agent 프로세스**에 전용 시맨틱 메모리 시스템이 추가되었다.

| 항목 | 내용 |
|------|------|
| **패키지** | `@nextain/naia-memory` (로컬 서브모듈 `file:../../naia-memory`) |
| **설정** | `~/.naia/memory-config.json` (선택사항) |
| **어댑터** | `LocalAdapter` — `~/.naia/memory/agent-store.json` |
| **임베딩** | vLLM/Ollama → `OpenAICompatEmbeddingProvider`; Naia → `NaiaGatewayEmbeddingProvider`; 없음 → 키워드 전용 |
| **R3 기능** | `HeuristicContradictionFilter`, Reconsolidation, HyDE, MMR |

**API** (R3 올바른 메서드명 — storeEpisode/recallEpisodes 아님):
```typescript
ms.encode(input: MemoryInput, context: EncodingContext): Promise<Episode>
ms.recall(query: string, context: RecallContext): Promise<{episodes, facts, reflections}>
ms.sessionRecall(firstMessage, context, tokenBudget?): Promise<string>
ms.close(): Promise<void>
```

> ⚠️ `HeuristicContradictionFilter`는 `@nextain/naia-memory` 최상위 index에서 **export 안 됨**.
> 서브패스에서 import: `import { HeuristicContradictionFilter } from ".../contradiction-filter.js"`

Shell 설정 UI: SettingsTab → **Memory** 섹션 — 임베딩 프로바이더, Base URL, 모델, LLM 프로바이더.

### 검색 엔진 진화

```
4.4a: SQLite LIKE (키워드 매칭)
4.4b: SQLite FTS5 BM25 (전문검색)
4.5:  Gemini Embedding API (의미 검색)
5+:   Agent @nextain/naia-memory R3 — vLLM/Ollama 로컬 임베딩 + HeuristicContradictionFilter
```

### DB 스키마

```sql
-- Shell facts (사용자 지식, 세션 간 영구)
CREATE TABLE facts (id TEXT PK, key TEXT UNIQUE, value TEXT,
                    source_session TEXT, created_at INT, updated_at INT);

-- Naia Gateway 세션: ~/.naia/sessions/sessions.json (메타데이터)
--                  + 세션별 *.jsonl (트랜스크립트)
-- Naia Gateway 시맨틱: ~/.naia/memory/main.sqlite (임베딩 인덱스)
```

---

## 스킬 시스템

스킬 관리: 빌트인 스킬, Gateway 스킬, 설치 흐름. *(업데이트: 2026-03-05)*

### 빌트인 스킬

- **개수**: 20개
- **동기화 위치** (4곳 모두 동일한 20개 나열 필수):
  1. `shell/src-tauri/src/lib.rs` — `list_skills` Tauri 커맨드
  2. `shell/src/components/ChatPanel.tsx` — `BUILTIN_SKILLS` Set (비활성화 방지)
  3. `agent/src/skills/built-in/*.ts` — tool-bridge 레지스트리
  4. `agent/scripts/generate-skill-manifests.ts` — `SKIP_BUILT_IN` 리스트
- **규칙**: 새 빌트인 스킬 추가 시 4곳 모두 업데이트 필요.

### Gateway 스킬

- **소스**: Naia Gateway `skills.status` RPC
- **응답 필드**: `name`, `description`, `eligible`, `missing[]`, `install[]` (`{ id, kind, label }`)
- **설치 종류**: `brew`, `node`, `go`, `uv`, `download`

### 설치 흐름

```
1. Shell SkillsTab에서 fetchGatewayStatus() 호출
   → directToolCall({ action: "gateway_status" })
   → Agent skill_skill_manager → Gateway skills.status RPC
   → skills[] (install[] 배열 포함) 반환

2. 사용자가 Install 버튼 클릭
   → Shell이 gs.install[0].id에서 installId 결정
   → directToolCall({ action: "install", skillName, installId })
   → Agent skill_skill_manager → Gateway skills.install RPC
   → Gateway가 설치 프로그램 실행 (brew/npm/go 등)
   → 성공/에러 반환

3. Shell이 설치 결과 피드백 표시
   → Gateway 상태 재조회하여 UI 업데이트
```

- **RPC 파라미터**: `skills.status: { agentId? }`, `skills.install: { name, installId }` — `installId` 필수 (`install[].id`에서 가져옴)
- **directToolCall 흐름**: Shell → Tauri stdin → Agent `handleToolRequest()` → `executeTool(skill_skill_manager)` → Gateway RPC → Shell로 결과 반환
- **이벤트 정리**: `delegateStreaming` 완료 후 `GatewayAdapter.offEvent(handler)` 호출 필수 (이벤트 핸들러 메모리 누수 방지).

---

## 보안 4계층 (심층 방어)

| 계층 | 역할 | 설정 |
|------|------|------|
| **OS** | Bazzite immutable rootfs + SELinux | 시스템 파일 보호 |
| **Gateway** | Naia Gateway 디바이스 인증 + 토큰 스코프 + exec approval | protocol v3, Ed25519 |
| **Agent** | Permission tiers 0-3 + 도구별 차단 | Tier 3: rm -rf, sudo 등 차단 |
| **Shell** | 사용자 승인 모달 + 도구 on/off 토글 | 사용자가 직접 제어 |

**원칙: 각 계층이 독립적. 한 계층이 뚫려도 나머지가 방어.**

---

## GatewayAdapter 추상화

> **#64 (2026-03-17)** — 게이트웨이 직접 의존 탈피를 위한 인터페이스 레이어

| 항목 | 내용 |
|------|------|
| 인터페이스 | `GatewayAdapter` (`agent/src/gateway/types.ts`) |
| 현재 구현체 | `GatewayClient implements GatewayAdapter` (`client.ts`) |
| 사용 범위 | proxy 14개, tool-bridge, skills/types, skills/loader, index.ts — `GatewayAdapter`만 참조 |
| 예외 | `connectGatewayWithRetry` 내부에서만 `new GatewayClient()` 사용 |
| 다음 이슈 | `#78` — 첫 실행 시 게이트웨이 선택 + 온디맨드 버전 고정 설치 |

**인터페이스 메서드:** `request`, `onEvent`, `offEvent`, `close`, `isConnected`, `availableMethods`

**배경:** 추상화 레이어가 게이트웨이 프로토콜 변경으로부터 에이전트 코드를 격리. 없으면 전면 재작업 필요.

---

## Gateway 연결 프로토콜

Naia Agent가 Naia Gateway에 연결하는 과정:

```
1. WebSocket 연결: ws://127.0.0.1:18789
2. Gateway → connect.challenge 이벤트 (nonce 포함)
3. Agent → connect 요청 (토큰 + protocol v3 + client info)
4. Gateway → hello-ok 응답 (88개 메서드 + 기능 목록)
5. Agent → req/res 프레임으로 도구 실행 (exec.bash / node.invoke 등)
```

### 인증 파라미터

| 파라미터 | 값 | 설명 |
|---------|-----|------|
| auth.token | gateway.auth.token | Gateway 설정의 공유 토큰 |
| client.id | "cli" | 페어링된 디바이스 ID |
| client.platform | "linux" | 플랫폼 |
| client.mode | "cli" | 클라이언트 모드 |
| minProtocol | 3 | 최소 프로토콜 버전 |
| maxProtocol | 3 | 최대 프로토콜 버전 |

---

## 음성 아키텍처

> 최종 업데이트: 2026-03-14

### 개요

음성 상호작용은 **LLM 모델 capabilities**에 따라 결정된다:

- **Omni 모델** (Gemini Live, OpenAI Realtime): 음성 I/O가 LLM에 내장. 별도 STT/TTS 불필요 — 모델이 음성 입출력을 직접 처리한다. `capabilities.includes("omni")`로 감지.
- **일반 LLM 모델**: 독립적인 **STT → LLM → TTS 파이프라인**을 통한 음성 대화. STT와 TTS는 각각 독립 프로바이더.

Omni 모델이 활성화되면 STT/TTS 프로바이더 설정은 비활성화된다. **STT 프로바이더, TTS 프로바이더, LLM 프로바이더는 세 개의 독립 카테고리**이다.

---

### Omni 모델 (내장 음성 LLM)

양방향 음성 I/O가 내장된 LLM 모델 — 음성은 LLM의 기능이지, 별도의 STT/TTS 관심사가 아니다.

**타입:** `LiveProviderId = "naia" | "gemini-live" | "openai-realtime" | "minicpm-o" | "vllm-omni" | "edge-tts"`

**팩토리:** `createVoiceSession(provider, options?) → VoiceSession` (`shell/src/lib/voice/index.ts`)

#### 프로바이더

| 프로바이더 | 경로 | 인증 | 파일 |
|-----------|------|------|------|
| **naia** | 브라우저 WS → any-llm gateway `/v1/live` → Gemini Live API | naiaKey | `voice/gemini-live.ts` |
| **gemini-live** | Tauri 커맨드 → Rust WS 프록시 → Gemini Live API | Google API key | `voice/gemini-live-proxy.ts` |
| **openai-realtime** | 브라우저 WS → `wss://api.openai.com/v1/realtime` | OpenAI API key | `voice/openai-realtime.ts` |
| **minicpm-o** | 브라우저 WS → self-hosted vllm-omni `/v1/realtime` | 없음 (LAN/Tailscale) | `voice/minicpm-o.ts` (+ voice clone용 `voice/ref-audio.ts`) |

#### VoiceSession 인터페이스

모든 프로바이더는 통일된 `VoiceSession` 인터페이스를 구현:
- **메서드:** `connect()`, `sendAudio(base64)`, `sendText(text)`, `sendToolResponse(id, result)`, `disconnect()`
- **이벤트:** `onAudio`, `onInputTranscript`, `onOutputTranscript`, `onTurnEnd`, `onInterrupted`, `onToolCall`, `onError`, `onDisconnect`

#### 음성 설정

설정 필드: `liveVoice` (짧은 이름, 예: "Kore", "Puck")

사용 가능한 음성: Kore (여성, 차분), Puck (남성, 활발), Charon (남성, 깊은), Aoede (여성, 밝은), Fenrir (남성, 낮은), Leda (여성, 부드러운), Orus (남성, 단단한), Zephyr (중성) 등

**Gemini Direct 참고:** WebKitGTK가 Gemini WSS에 직접 연결 불가 (조용히 행). Rust tokio-tungstenite 프록시를 Tauri 커맨드로 사용.

---

### STT 프로바이더 (독립, 파이프라인 모드)

독립적인 STT 프로바이더 레지스트리 — 일반 LLM 모델용 파이프라인 모드에서만 사용. Omni 모델은 내장 음성 인식을 사용하며 이 프로바이더를 사용하지 않는다.

**레지스트리 파일:**
- `shell/src/lib/stt/types.ts` — `SttProviderMeta`, `SttModelMeta`, `SttEngineType`
- `shell/src/lib/stt/registry.ts` — `registerSttProvider()`, `getSttProvider()`, `listSttProviders()`

**`SttEngineType`:** `"tauri"` (오프라인 Rust) | `"api"` (클라우드 API) | `"web"` (Web Speech) | `"vllm"` (로컬 vLLM 서버)

`SttProviderMeta`는 로컬 서버 프로바이더(예: vLLM 기반 ASR)를 위해 `isLocal?`, `requiresEndpointUrl?`, `endpointUrlConfigField?` 필드를 지원한다.

#### 프로바이더

| 프로바이더 | 엔진 | 타입 | 설명 |
|-----------|------|------|------|
| **vosk** | vosk | 오프라인, 스트리밍 | 경량, 언어별 ~40-80MB 모델 |
| **whisper** | whisper | 오프라인, 배치 | 높은 정확도, GPU 가속 (whisper-rs) |
| google | — | 비활성화 | 향후 API 지원 |
| elevenlabs | — | 비활성화 | 향후 API 지원 |

**설정 필드:** `sttProvider` ("vosk"|"whisper"), `sttModel` (model_id 문자열)
**설정 UI:** STT 프로바이더 드롭다운 + 모델 목록 (용량/WER 표시), 다운로드/삭제 버튼
**첫 설치:** `sttProvider` 미설정 → 음성 버튼 누르면 팝업 → 설정으로 이동

**Vosk 모델:** ko-KR (82MB), en-US (40MB), ja-JP (48MB) — 스트리밍, 자동 다운로드
**Whisper 모델:** tiny (75MB) → large-v3 (3GB) — 배치 추론 (2초 주기 또는 1.5초 무음 감지)

**CUDA:** upstream whisper-rs `cuda` 피처를 통한 NVIDIA GPU 가속. 빌드 시 CUDA 툴킷 필요. upstream whisper-rs를 직접 사용 (codeberg.org/tazz4843/whisper-rs).

---

### TTS 프로바이더 (독립, 파이프라인 모드 + 채팅 자동 TTS)

독립적인 TTS 프로바이더 레지스트리 — 파이프라인 모드 및 채팅 자동 TTS에서 사용. Omni 모델은 음성 출력을 직접 생성하며 이 프로바이더를 사용하지 않는다.

**기본 프로바이더:** `edge` (무료, 로그인 불필요)

**레지스트리 파일:**
- Agent: `agent/src/tts/types.ts`, `registry.ts`, `index.ts` — 런타임 디스패치
- Shell: `shell/src/lib/tts/types.ts`, `registry.ts` — Settings UI 메타데이터

**새 TTS 프로바이더 추가 방법:**
1. `agent/src/tts/{name}.ts` 생성 — `TtsProviderDefinition` 구현
2. 모듈 스코프에서 `registerTtsProvider({...})` 호출
3. `agent/src/tts/index.ts`에 import 추가
4. `shell/src/lib/tts/registry.ts`에 `TtsProviderMeta` 추가

#### 프로바이더

| 프로바이더 | 경로 | 인증 |
|-----------|------|------|
| **edge** | agent → Naia Gateway → Edge TTS | 없음 (무료) |
| **nextain** | agent → any-llm gateway → Google Cloud TTS | naiaKey |
| **google** | agent → Naia Gateway → Google Cloud TTS | Google API key |
| **openai** | agent → Naia Gateway → OpenAI TTS | OpenAI API key |
| **elevenlabs** | agent → Naia Gateway → ElevenLabs | ElevenLabs API key |

**naiaKey 라우팅:** TTS 인증은 LLM 프로바이더 선택과 독립적. `ChatRequest`가 `naiaKey`를 최상위 필드로 전달.

**설정 UI:** TTS 프로바이더 드롭다운 + API key 입력 + 음성 선택 (레지스트리 기반 자동 탐색).

**가격:** Edge (무료) | Naia Cloud (게이트웨이 `cost_usd` 실제 비용) | Google (음성 티어별: Neural2/Wavenet $16/1M, Standard $4/1M, Chirp3-HD $16/1M) | OpenAI ($15/1M 글자) | ElevenLabs ($0.30/1K 글자)

**비용 추적:** Naia Cloud는 게이트웨이가 반환한 실제 `cost_usd` 사용. 직접 API 연동(Google/OpenAI/ElevenLabs)은 `estimateTtsCost(provider, length, voice)`로 클라이언트 측 추정. Agent `TtsSynthesizeResult`가 `{ audio, costUsd? }`를 파이프라인으로 전달.

**STT 비용 추적:** `estimateSttCost()` API 호출 단위로 측정 → `addSessionCostEntry()`로 `sessionCostEntries[]`에 저장. CostDashboard 상세 패널에 provider/model별로 표시 (예: `stt:nextain`). 메시지에 첨부하지 않음 (assistant 메시지의 LLM 토큰 데이터 덮어쓰기 방지).

**동적 음성:** Google과 ElevenLabs는 API key 입력 시 런타임 음성 목록 가져오기 지원.

---

### 음성 E2E 테스트 (총 97개: Tauri 87 + Playwright 10)

E2E = 실제 앱 UI. 모든 테스트가 실제 Tauri 앱을 실행하고, API key를 입력 필드에 타이핑하고, 버튼을 클릭하고, 채팅 메시지를 보내서 결과를 검증한다. API 호출을 mock하지 않음 — 실제 `.env` 키 사용.

| 스펙 | 수 | 커버리지 |
|------|---|----------|
| `76-tts-provider-switching` | 12 | TTS 드롭다운, API key, 음성, Edge 미리듣기 |
| `77-stt-provider-switching` | 7 | STT 드롭다운, 순서 무료→Naia→유료, API key |
| `78-voice-pipeline-mode` | 11 | UI 라벨, 음성 선택, 버튼 상태, 🗣️ 아이콘 |
| `79-pipeline-voice-activation` | 9 | 음성 버튼 생명주기, CSS 3-state |
| `80-tts-preview-all-providers` | 5 | 실제 API key 미리듣기: Edge/OpenAI/Google/ElevenLabs |
| `81-chat-tts-response` | 9 | 채팅 → AI 응답 → TTS 오디오 재생 |
| `82-chat-tts-multi-model` | 6 | 모델 전환 후 TTS 유지 |
| `83-tts-per-model-verification` | 15 | 5개 LLM 프로바이더×모델별 채팅+TTS |
| `84-chat-tts-per-provider` | 12 | 4개 TTS 프로바이더: UI key 입력 → 저장 → 채팅 → 검증 |
| `pipeline-voice` (Playwright) | 10 | STT mock → LLM → TTS, 디바운스, 인터럽트, Whisper |

```bash
cd shell && source ../my-envs/naia-os-shell.env
npx wdio run e2e-tauri/wdio.conf.ts --spec e2e-tauri/specs/80-tts-preview-all-providers.spec.ts
npx wdio run e2e-tauri/wdio.conf.ts --spec e2e-tauri/specs/84-chat-tts-per-provider.spec.ts
npx wdio run e2e-tauri/wdio.conf.ts --spec e2e-tauri/specs/83-tts-per-model-verification.spec.ts
npx playwright test e2e/pipeline-voice.spec.ts
```

---

### 파이프라인 음성 (STT → LLM → TTS)

일반(비-omni) LLM 모델을 위한 음성 대화. 독립 STT → LLM → TTS 파이프라인.

**아키텍처:**
```
사용자 음성 → STT 프로바이더 (Vosk/Whisper) → 인식된 텍스트
→ sendChatMessage (일반 LLM 경로, 도구 비활성화)
→ LLM 텍스트 스트림 → SentenceChunker (문장 경계 감지)
→ 문장별 tts_request → TTS 프로바이더 (Edge 기본값)
→ MP3 base64 → AudioQueue (순차 재생)
```

| 컴포넌트 | 파일 | 역할 |
|----------|------|------|
| SentenceChunker | `voice/sentence-chunker.ts` | 한/영 혼합 텍스트 문장 분리 (최소 10자, 최대 120자) |
| AudioQueue | `voice/audio-queue.ts` | MP3 순차 재생, 인터럽트, 아바타 speaking 상태 |
| TTS 요청 | `agent/src/index.ts`, `chat-service.ts` | 문장별 TTS 합성 |

**상태 흐름:** LISTENING → PROCESSING → SPEAKING → LISTENING
**인터럽트:** 재생 중 사용자 발화 감지 시 AudioQueue 클리어 + LLM 스트림 취소
**규칙:** 도구 비활성화, Agent 자동 TTS 비활성화, 감정 태그 제거

---

### 음성 성별 기본값

VRM 아바타 성별에 따라 기본 음성이 자동 설정됨:
- VRM 모델 1,3 (여성) → liveVoice: "Kore", Edge TTS: "ko-KR-SunHiNeural", Google TTS: "ko-KR-Neural2-A"
- VRM 모델 2,4 (남성) → liveVoice: "Puck", Edge TTS: "ko-KR-InJoonNeural", Google TTS: "ko-KR-Neural2-C"

### 과금

- **Omni 모델:** 프로바이더별 상이 (Gemini: $0.10/M 입력 + $0.40/M 출력, OpenAI: ~$0.10/분)
- **TTS:** 프로바이더별 상이 (Chirp 3 HD, Neural2, Edge 무료, OpenAI, ElevenLabs)

#### 음성 도구 (패널 레지스트리에서 수집)

> 추가: 2026-03-20 (#95)

음성 세션 시작 시 `ChatPanel`이 `panelRegistry`에서 활성 패널의 도구를 읽어 `session.connect()`에 전달한다. 이 없으면 `config.enableTools=true`여도 Gemini Live가 "도구 사용이 꺼져 있습니다"라고 응답함.

```tsx
const panelTools = panelRegistry.get(activePanelId)?.tools ?? [];
const voiceTools = panelTools.map((t) => ({ name, description, parameters }));
await session.connect({ tools: voiceTools, systemInstruction: voiceSystemPrompt });
```

시스템 프롬프트에도 도구 목록과 "적극적으로 호출하라"는 지시가 추가됨.

---

## 워크스페이스 패널 (#119, 2026-03-23)

Claude Code 세션 모니터링 + PTY 터미널 탭 기능을 제공하는 내장 패널. keepAlive로 항상 마운트된 상태 유지.

### 도구

| 도구 | Tier | 설명 |
|------|------|------|
| `skill_workspace_get_sessions` | 0 (자동) | 전체 세션 상태 |
| `skill_workspace_open_file` | 1 (알림) | 파일을 에디터에 열기 |
| `skill_workspace_focus_session` | 1 (알림) | 세션 카드 스크롤+하이라이트 |
| `skill_workspace_new_session` | 2 (확인) | bash PTY 생성, 터미널 탭 열기 |
| `skill_workspace_classify_dirs` | 0 (자동) | ~/dev 하위 폴더 분류 |

### PTY 터미널

- **Rust**: `shell/src-tauri/src/pty.rs` — portable-pty 0.9.0; 명령: `pty_create`, `pty_write`, `pty_resize`, `pty_kill`
- **Frontend**: `Terminal.tsx` — `@xterm/xterm` + `@xterm/addon-fit`
- **이벤트**: `pty:output:{pty_id}` / `pty:exit:{pty_id}` (Rust → Tauri 이벤트)
- **중복 방지**: `openDirsRef` (`Set<string>`) — `await pty_create` 이전에 dir 추가; 실패 시 또는 탭 닫기 시에만 삭제
- **keepAlive**: `opacity:0 + pointerEvents:none` 사용 (절대 `display:none` 사용 금지 — FitAddon이 숨겨진 요소에서 0×0 반환)

---

## 브라우저 패널 — WebView2 임베딩 (#95, #249)

*2026-05-07 업데이트: Win32 SetParent → Tauri WebView2 자식 창으로 마이그레이션.*

브라우저 패널은 **keepAlive** 패널 (항상 마운트, 비활성 시 `opacity:0 + pointerEvents:none`).

**플랫폼별 임베딩 방식:**

| 플랫폼 | 방식 |
|--------|------|
| **Linux** | X11 `XReparentWindow` via x11rb (`platform/linux.rs` → `X11WindowManager`) |
| **Windows** | Tauri WebView2 자식 창 (`browser_webview.rs`) — `browser_wv_create/navigate/hide/show/resize` + 전체 브라우저 제어 IPC |
| **macOS** | 미구현 |

**Windows WebView2 IPC 명령** (`browser_webview.rs`):

| 명령 | 용도 |
|------|------|
| `browser_wv_create` | LogicalPosition + LogicalSize로 WebView2 자식 창 생성 |
| `browser_wv_navigate` | URL 이동 |
| `browser_wv_hide` | 오버레이 숨기기 (모달 `set()` 이전에 호출 — 1프레임 겹침 방지) |
| `browser_wv_show` | 오버레이 표시 |
| `browser_wv_resize` | viewport div 크기에 맞게 조정 |

> ⚠️ **`setPendingApproval` 순서**: `invoke("browser_wv_hide")`를 `set({ pendingApproval })` 이전에 호출해야 함 — 그렇지 않으면 Chrome 오버레이가 승인 모달 위에 1 React 렌더 프레임 동안 남음.

Chrome 탐색: Linux = `which` + Flatpak, Windows = `where.exe` + Program Files.

AI 도구: navigate, back, forward, reload, click, fill, scroll, press, snapshot, get_text, screenshot, eval + **`skill_tab_screenshot`** (tab-skills 경유 — GDI BitBlt로 네이티브 WebView2 콘텐츠 캡처).

---

## 패널 시스템 — Iframe 브리지 (#98, 2026-03-23)

설치형 패널 중 `index.html`이 있는 패널은 iframe으로 로드됨. Iframe 브리지를 통해 Shell 서비스에 `postMessage`로 접근.

### 파일

| 파일 | 역할 |
|------|------|
| `shell/src/lib/iframe-bridge.ts` | Shell 측 postMessage 서버 (`startIframeBridge`) |
| `shell/src/lib/naia-bridge-client.ts` | 패널 측 클라이언트 래퍼 (`NaiaBridgeClient` 클래스) |
| `shell/src/lib/behavior-log.ts` | IndexedDB 행동 로그 (`naia_behavior`, 30일 자동 purge) |

### 브리지 메시지

| 타입 | 처리 |
|------|------|
| `naia-bridge:logBehavior` | Shell IndexedDB (panelId 범위) |
| `naia-bridge:queryBehavior` | Shell IndexedDB 조회 (panelId 강제 — 다른 패널 조회 불가) |
| `naia-bridge:getSecret` | secure-store.ts, 키 `panel:{panelId}:{key}` |
| `naia-bridge:setSecret` | secure-store.ts, 키 `panel:{panelId}:{key}` |
| `naia-bridge:readFile` | Tauri `panel_read_file` (HOME 제한, 1 MB) |
| `naia-bridge:runShell` | Tauri `panel_run_shell` (허용 목록) |

### 보안 모델

- **Origin 검증**: `event.origin === 'http://asset.localhost'` 만 허용
- **`__unknown__` 차단**: panelId 식별 불가 시 모든 작업 거부
- **panelId 추출**: `iframe.src`에서 정규식 `/\/([^/]+)\/index\.html(?:[?#].*)?$/`
- **네임스페이싱**: getSecret/setSecret 키 `panel:{panelId}:{key}` — 패널 간 격리
- **응답 targetOrigin**: Shell이 iframe에 응답 시 `postMessage(data, ALLOWED_ORIGIN)` 사용 — `ALLOWED_ORIGIN = "http://asset.localhost"` (iframe origin)
- **`"*"` targetOrigin**: 패널→Shell 요청 시 `window.parent.postMessage(req, "*")` 사용. `window.parent.origin`이 cross-origin에서 SecurityError 발생 → `"*"` 사용. Shell이 수신 시 `event.origin` 검증.

### Tauri 커맨드 (panel.rs)

| 커맨드 | 보안 |
|--------|------|
| `panel_read_file` | `canonicalize()` + HOME 경계 + 1 MB 제한 |
| `panel_run_shell` | SHELL_CMD_MAP 허용 목록 (절대 `/usr/bin/` 경로) + 인수 메타문자/구분자/순회 필터 |
| `panel_remove_installed` | panelId 검증 + `canonicalize()` + HOME 경계 확인 후 `remove_dir_all` (심링크 공격 방어) |

### NaiaContextBridge 연동

- `panel-registry.ts`의 `NaiaContextBridge` 인터페이스 — #98에서 6개 메서드 추가
- `ActivePanelBridge` — 전체 구현; `NoopContextBridge` — 브리지 미지원 패널용 스텁
- `getBridgeForPanel(panelId)` 팩토리 (`active-bridge.ts`) — 캐시된 `ActivePanelBridge` 반환
- `App.tsx`: 모든 패널(keepAlive/non-keepAlive)에 per-panel 브리지 인스턴스 전달
