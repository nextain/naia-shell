# Naia Gateway 설정 동기화

## 개요

Shell(Tauri 앱) 사용자 설정을 Naia Gateway 부트스트랩 파일에 동기화하는 아키텍처입니다.
이를 통해 Discord DM, TTS 등 Gateway 기능이 Shell과 동일한 페르소나/인증 정보를 사용합니다.

## 동기화 시점

| 트리거 | 파일 | 함수 |
|--------|------|------|
| Settings 저장 | `SettingsTab.tsx` | `handleSave()` |
| Onboarding 완료 | `OnboardingWizard.tsx` | `handleComplete()` |
| Lab 인증 콜백 | `SettingsTab.tsx` | `lab_auth_complete` listener |
| 앱 시작 | `ChatPanel.tsx` | session load useEffect |
| 세션 요약 후 | `ChatPanel.tsx` | `summarizePreviousSession()` |
| 자동 fact 추출 후 | `ChatPanel.tsx` | 10 메시지마다 / visibilitychange |
| 역방향 동기화 후 | `memory-sync.ts` | `syncFromGatewayMemory()` |

## 동기화 항목

### 1. `gateway.json` — Provider/Model
Shell provider를 Naia Gateway provider 이름으로 매핑합니다.

| Shell Provider | Gateway Provider |
|---------------|-------------------|
| gemini | google |
| anthropic | anthropic |
| xai | xai |
| openai | openai |
| nextain | nextain |
| claude-code-cli | anthropic |
| ollama | ollama |

### 2. `auth-profiles.json` — API 키
- Lab 프록시(nextain) 및 키 불필요 provider는 건너뜀

### 3. `SOUL.md` — 시스템 프롬프트 (완성본)
`buildSystemPrompt()`의 결과를 그대로 저장합니다:
- 페르소나 원문 (이름 치환 적용됨)
- Emotion tag 지시문
- 사용자 이름 컨텍스트
- **사용자에 대해 알려진 사실 (Shell facts DB)**
- 언어/로케일 지시문

> **핵심**: `syncToGateway()`는 self-contained — 항상 내부에서 config + facts를 로드합니다.
> 호출자가 `_systemPrompt`를 전달해도 무시됩니다. 모든 동기화 경로에서 facts가 일관되게 포함됩니다.

### 4. `IDENTITY.md` / `USER.md`
- 에이전트 이름, 사용자 이름

## 메모리 동기화

### Dual-Origin 아키텍처

| 구분 | Shell | Naia Gateway |
|------|-------|----------|
| 역할 | "사용자가 누구인지" (facts) | "무슨 일이 있었는지" (세션 기록) |
| 저장소 | `memory.db` (SQLite, facts 테이블) | `workspace/memory/*.md` + `memory/main.sqlite` |

### Shell → Gateway (facts → SOUL.md)

facts DB의 내용을 SOUL.md에 주입하여 Discord DM 등 Gateway-only 경로에서도 사용자 정보 접근 가능.

### 대화 중 자동 추출

별도의 "새 대화" 클릭 없이, 대화 중 자동으로 facts 추출:
- **10 메시지마다**: `usage` 청크 핸들러에서 트리거
- **앱 백그라운드 시**: `visibilitychange` 이벤트, 미추출 3개 이상일 때
- `extractFacts()`만 사용 (경량, 요약 없음)

### Gateway → Shell (역방향 동기화)

Gateway의 `session-memory` hook이 저장한 `~/.naia/workspace/memory/*.md` 파일을 읽어 facts 추출:
- `read_gateway_memory_files(since_ms)` Rust 커맨드로 파일 읽기
- LLM으로 facts 추출 → `upsertFact()` → `syncToGateway()`
- 앱 시작 5초 후 + 30분 주기 실행

### session-memory hook

Gateway 내부 hook으로 대화 종료 시 `workspace/memory/*.md`에 자동 기록.
`config/defaults/gateway-bootstrap.json`에서 활성화됨.

## 핵심 파일

- `shell/src/lib/gateway-sync.ts` — `syncToGateway()` (self-contained)
- `shell/src/lib/memory-sync.ts` — 역방향 동기화 (Gateway → Shell)
- `shell/src/lib/memory-processor.ts` — `extractFacts()`, `summarizeSession()`
- `shell/src/lib/persona.ts` — `buildSystemPrompt()`
- `shell/src/lib/db.ts` — `getAllFacts()`, `upsertFact()`
- `shell/src/components/ChatPanel.tsx` — 자동 추출 트리거
- `shell/src-tauri/src/lib.rs` — `sync_gateway_config`, `read_gateway_memory_files`

## 채팅 라우팅 모드

채팅 메시지를 Gateway 경유로 보낼 수 있습니다.

| 설정 | 값 | 동작 |
|------|---|------|
| `AppConfig.chatRouting` | `"auto"` (기본) | Gateway 연결 시 Gateway 경유, 아니면 직접 LLM |
| | `"gateway"` | 항상 Gateway 경유 |
| | `"direct"` | 항상 직접 LLM (기존 동작) |

Agent 측 필드: `ChatRequest.routeViaGateway` (boolean)

관련 파일:
- `agent/src/gateway/gateway-chat.ts`
- `shell/src/lib/config.ts`

## 제약사항

- **Naia Gateway 소스 수정 가능** (naia-agent는 자체 코드)
- 동기화는 best-effort — 에러 시 로그만 남기고 UI 차단하지 않음
- SOUL.md에는 emotion tag 포함 **완성된** 시스템 프롬프트가 저장됨
