# Naia 프로젝트 규칙

> SoT: `.agents/context/agents-rules.json`의 한국어 미러

## 프로젝트 정체성

- **이름**: Naia
- **성격**: Bazzite 기반 개인 AI OS, 가상 아바타 탑재
- **철학**: OS 자체가 AI의 도구. 처음부터 만들지 않고 조립한다.
- **핵심**: USB 부팅 → Alpha 아바타가 맞이 → AI가 OS를 제어

## 설계 원칙

이 파일의 모든 규칙은 아래 네 가지 원칙에서 파생됩니다. AI 에이전트는 규칙을 기계적으로 따르는 것이 아니라, 규칙이 **왜** 존재하는지 이해해야 합니다.

### 네 가지 기둥

| 기둥 | 의미 |
|------|------|
| **단순(Simple)** | 불필요한 복잡성 배제. 코드가 스스로 설명. 최소한의 추상화. |
| **견고(Robust)** | 엣지 케이스 처리. 우아한 실패. 테스트는 이를 검증하는 진단 도구 — 통과시킬 점수판이 아님. |
| **디버깅 가능(Debuggable)** | BUILD 시점부터 충분한 디버그 로깅 (버그 발견 후 추가하는 것이 아님). 모든 실패를 첫 발생부터 진단 가능. |
| **확장 가능(Extensible)** | 기존 코드 수정 없이 새 프로바이더/기능 추가. 프로바이더 레지스트리 패턴. |

**추상화 규칙**: 추상화는 네 가지 원칙을 달성하기 위한 도구이지, 그 자체가 목표가 아닙니다.

**예시**: LLM/STT/TTS 프로바이더 레지스트리 (#51, #60), Gateway 인터페이스 추상화 (#64).

### AI 행동 함정

네 가지 원칙을 위반하는 알려진 AI 경향:

| 함정 | 설명 | 대응 |
|------|------|------|
| **낙관적 코드** | AI가 모든 호출이 성공하고 모든 입력이 유효하다고 가정한 happy-path 코드만 작성. | BUILD 중에 의식적으로 에러 경로를 구현. 실패 발견 후가 아님. |
| **목표 고착** | AI가 가장 측정 가능한 목표(테스트 통과, 빌드 성공)에 수렴하고 실제 목적을 잃음. | 행동 전에 질문: 이 테스트/로그/리뷰의 **목적**은 무엇인가? 지표가 아닌 목적에 따라 행동. |
| **성공 편향 보고** | AI가 불확실한 상태를 "완료" 또는 "동작함"으로 보고. 예: E2E를 실행하지 않았는데 작업 완료로 표시. | 검증되지 않으면 완료가 아님. 솔직하게 보고: "E2E는 X로 인해 차단됨, 구현 완료했지만 미검증." |
| **전후 불일치** | 순차적 생성으로 같은 파일 내에서 앞쪽 코드/주석이 뒤쪽 코드와 모순. | 반복 리뷰로 포착. 작성 후 전체 파일을 다시 읽고 내부 일관성 확인. |
| **컴팩션 식별자 손실** | 컨텍스트가 압축될 때 AI가 기억으로 식별자를 재구성 — 이슈 번호 오류, UUID 잘림, 파일 경로 추측. | 파일/툴에서 발견된 모든 불투명 식별자를 그대로 보존: 이슈 번호, UUID, 파일 경로, API 키, 호스트명, URL, 포트 번호. 불확실하면 기억에서 재구성하지 말고 소스 파일을 직접 읽을 것. |
| **공개 레포 개인정보 유출** | AI가 테스트 데이터, 예시, 문서에 실제 사용자 이름, 주소, 가족, 회사명을 사용하여 public 레포에 커밋. | **이 레포는 public 오픈소스**. 커밋되는 모든 파일에 실제 개인정보(관리자 이름, 주소, 가족, 회사명) 절대 금지. 항상 가상 인물(예: 김하늘) 사용. 실제 데이터가 필요하면 private 레포(docs-business 등)에만. |

---

## 아키텍처 4계층

| 계층 | 기술 | 역할 |
|------|------|------|
| Shell | Tauri 2 + Three.js | Avatar UI, 사용자 상호작용 |
| Agent | Node.js | LLM 연결, 도구, 서브에이전트 |
| Gateway | WebSocket 데몬 | 채널, Skills, 메모리 |
| OS | Bazzite (Fedora Atomic) | 불변 OS, BlueBuild |

### 통신 프로토콜

```
Shell ←stdio JSON lines→ Agent Core
Shell ←WebSocket→ Gateway ←stdio→ Agent Core
Gateway ←채널 SDK→ Discord, Telegram 등
```

### 소스 디렉토리

```
naia-os/
├── shell/      # Tauri 데스크탑 앱 (Avatar + UI)
├── agent/      # AI 에이전트 코어
├── gateway/    # 항상 실행되는 데몬
└── os/         # BlueBuild 레시피 + systemd
```

---

## 코딩 컨벤션

### 언어 & 런타임
- **TypeScript**: Shell 프론트엔드, Agent, Gateway
- **Rust**: Tauri 백엔드
- **패키지 매니저**: pnpm (모노레포 워크스페이스)
- **런타임**: Node.js 22+

### 포맷터: Biome
- 들여쓰기: 탭
- 따옴표: 쌍따옴표
- 세미콜론: 항상
- 트레일링 콤마: 항상
- 줄 너비: 100

### 네이밍 규칙

| 대상 | 스타일 | 예시 |
|------|--------|------|
| 파일/디렉토리 | kebab-case | `agent-core.ts` |
| 클래스 | PascalCase | `AvatarRenderer` |
| 함수 | camelCase | `sendMessage()` |
| 상수 | UPPER_SNAKE_CASE | `MAX_RETRIES` |
| 타입/인터페이스 | PascalCase | `AgentConfig` (I- 접두사 없음) |
| Rust 파일 | snake_case | `stdio_bridge.rs` |

### import 순서
1. Node.js 내장 모듈
2. 외부 패키지
3. 내부 모듈
4. 상대 경로

### 주석
- 코드 주석: 영어
- 문서: 한국어
- 자명한 로직에는 주석 달지 않음

### 에러 핸들링
- 시스템 경계에서만 검증 (사용자 입력, 외부 API, LLM 응답)
- Rust: `Result<T, Error>` 패턴
- TypeScript: 경계에서 try-catch

---

## 테스트

### 철학
**Integration-first TDD.** 실제 사용 시나리오를 먼저 테스트.

### TDD 순서
```
❌ 잘못: 헬퍼 함수 유닛 테스트 → 구현 → 나중에 통합
✅ 올바름: 통합/E2E 테스트 작성(RED) → 최소 구현(GREEN) → 리팩터(REFACTOR)
```

### 테스트 코드 리뷰 규칙
테스트 코드는 결과를 맹신하기 전에 반드시 반복 리뷰해야 합니다. 잘못된 테스트 로직은 실제 버그를 숨깁니다.
- 테스트 작성 → 테스트 코드 리뷰 (assertion 정확? 대상 정확? 엣지 케이스?) → 수정 → 재리뷰 → 연속 2회 클린 패스 → 실행
- 통과 후: "이 테스트가 진짜 의도한 동작을 검증하는가?" 재확인
- 이유: 잘못된 테스트 로직으로 테스트가 통과하면 실제 버그에 접근조차 못함

### 테스트 태도 (Test Attitude)

테스트는 구현을 완전하고 올바르게 만들기 위한 것이지, 통과시키기 위한 것이 아닙니다. 테스트 코드 자체도 틀릴 수 있고 유지보수되지 않을 수 있습니다. 테스트가 항상 옳은 것이 아닙니다. 실패하는 테스트는 "조사하라"는 신호이지, "구현을 테스트에 맞추라"는 신호가 아닙니다.

테스트 코드가 틀린 것이 발견되면, **왜 구현이 그렇게 되어 있는지, 왜 테스트가 틀리고 있는지를 알아내는 것**이 목적입니다. 테스트를 통과시키는 것이 목적이 아닙니다.

**실패 시 대응:**
1. 전체 테스트 출력을 읽음 (에러 메시지, 스택 트레이스, 실제 vs 기대값)
2. **구현 코드를 읽어서** 해당 기능이 왜 그렇게 작성되었는지 의도를 파악
3. **테스트 코드를 읽어서** 어떤 동작을 검증하려 했는지 파악
4. 비즈니스 로직을 먼저 이해한 후 진단: 실패 원인이 앱 코드인가 테스트 코드인가?
5. 앱 코드 → 앱 코드 수정, 테스트 재실행
6. 테스트 코드 → 테스트 코드 수정, 테스트 재실행
7. 진단 결과를 진행 파일에 기록 (`test_findings`)

**안티패턴:**
- 실패하는 테스트를 통과시키려고 assertion을 느슨하게 변경 (예: `===`를 `includes`로, 검사 제거)
- 버그 있는 실제 출력에 맞추려고 기대값을 수정
- 조사 없이 실패하는 테스트를 삭제하거나 스킵
- 테스트가 실제로 무엇을 검증했는지 읽지 않고 "테스트 통과"라고 보고
- **[치명적] 코드 맥락을 파악하지 않고 구현을 테스트에 맞춰 수정** — 테스트가 틀렸을 수 있습니다. 예: 테스트 이름이 "strips X"라고 해서 stripping이 올바른 동작이라는 보장이 없습니다. 구현이 의도적으로 다르게 (예: 제거 대신 이모지 교체) 작동할 수 있고, 그게 맞는 것일 수 있습니다. 구현을 먼저 읽고 왜 그렇게 작성됐는지 이해한 후 어느 쪽을 고칠지 결정하세요.

**이유:** 목표 고착으로 AI가 "통과"를 목표로 취급하게 됨. 실제 목표는 시스템 상태 이해. 잘못된 assertion으로 통과하는 테스트는 올바른 assertion으로 실패하는 테스트보다 나쁩니다. 구현을 틀린 테스트에 맞춰 수정하면 동작하는 기능이 조용히 삭제됩니다.

### 테스트 프레임워크

| 종류 | 프레임워크 |
|------|-----------|
| 유닛/통합 | Vitest |
| E2E (Shell) | @tauri-apps/cli (tauri-driver) + WebDriver |
| E2E (OS) | QEMU VM boot (libvirt in CI) |
| 모킹 | msw (Mock Service Worker) |
| Rust | cargo test |

### 테스트 파일 위치

```
<module>/__tests__/*.test.ts      # 유닛
tests/integration/*.test.ts       # 통합
tests/e2e/*.spec.ts               # E2E
<crate>/src/*.rs                  # Rust (#[cfg(test)])
```

### E2E 시나리오

**Shell:**
- 앱 실행 → 아바타 렌더링 → idle 애니메이션
- 메시지 입력 → LLM 응답 → 립싱크
- 파일 편집 요청 → 권한 승인 → 파일 수정
- 앱 크래시 → 자동 재시작 → 세션 복구

**Agent:**
- stdin 메시지 → LLM 호출 → stdout 스트리밍 응답
- 도구 호출 → 권한 확인 → 실행 → 결과
- 서브에이전트 생성 → 병렬 실행 → 결과 병합

**OS:**
- ISO 부팅 → 로그인 → Naia Shell 자동 시작
- 첫 부팅 → 온보딩 위자드 → API 키 설정 → 첫 대화

### 테스트 명령어

```bash
pnpm test:unit         # 유닛 테스트
pnpm test:integration  # 통합 테스트
pnpm test:e2e          # E2E 테스트
pnpm test              # 전체
pnpm test:coverage     # 커버리지 포함
```

### 커버리지 목표
- Agent Core: 80%+
- Shell 컴포넌트: 70%+
- Gateway: 80%+
- E2E: 모든 핵심 사용자 플로우

---

## 로깅

### TypeScript (Shell frontend, Agent)

**금지**: `console.log`, `console.warn`, `console.error`

```typescript
import { Logger } from "./logger"; // shell/src/lib/logger.ts

Logger.debug("[AgentCore] Processing message", { id });
Logger.info("[AgentCore] LLM response received", { model, tokens });
Logger.warn("[Gateway] Channel reconnecting", { channel: "discord" });
Logger.error("[Shell] Avatar render failed", error);
```

| 레벨 | 용도 |
|------|------|
| debug | 개발 디버깅 (프로덕션에서 strip) |
| info | 중요한 작업 완료, 상태 변경 |
| warn | 잠재적 문제, 성능 저하 |
| error | 실제 오류, 예외 |

### Rust (Tauri backend — `shell/src-tauri/src/lib.rs`)

**금지**: raw `eprintln!`, `println!`

| 함수 | stderr | 파일 | 용도 |
|------|--------|------|------|
| `log_both` | 항상 | 항상 | 세션 시작/종료, 에러, 인증 이벤트, 중요 상태 변경 |
| `log_verbose` | debug 빌드만 | 항상 | 경로 탐색, PID, 환경변수, 진행 상황, 윈도우 상태 |
| `log_to_file` | 안 찍힘 | 항상 | 고빈도 내부 이벤트 |

```rust
// ✅ 올바른 사용
log_both("[Naia] Gateway healthy after 25s");                    // 릴리즈에서도 보임
log_verbose(&format!("[Naia] Found agent at: {}", path));        // 릴리즈에서 파일만
log_verbose(&format!("[Naia] Gateway env: {}=***", key));        // 값은 마스킹

// ❌ 금지
eprintln!("[Naia] some debug info");  // raw eprintln 금지
```

**보안**: API 키, 토큰, 비밀번호는 절대 로그에 노출 불가. 환경변수 값은 `***`로 마스킹.

**로그 파일 위치**: `~/.naia/logs/` (naia.log, gateway.log, node-host.log)

### 디버그 로깅

**시점**: 디버그 로깅은 BUILD 시점의 활동이지, 디버그 시점의 활동이 아닙니다. 구현 중에 로깅을 추가하고, 문제 발견 후에 추가하지 않습니다. 문제 발생 후에야 로깅을 추가하면, 첫 번째 발생은 항상 진단 불가능합니다. BUILD 시점 로깅은 모든 실패를 첫 발생부터 진단 가능하게 합니다.

**BUILD 시점 체크리스트:**
- 모든 새 비동기 작업: 시작, 성공, 실패를 컨텍스트와 함께 로깅
- 모든 새 상태 전환: 변경 전후 값 로깅
- 모든 새 외부 호출 (API, IPC, 파일 I/O): 요청과 응답 요약 로깅
- 모든 새 에러 처리 경로: 전체 컨텍스트와 함께 에러 로깅

**안티패턴**: 버그가 보고되거나 테스트 실패 후에야 `Logger.debug()` 호출을 추가하는 것.

**원칙:**
- 모든 비동기 대기/폴링은 무엇을 기다리는지와 현재 상태를 로깅
- UI 블로킹 상태 (모달, 다이얼로그, 로딩 스피너)를 trace에 캡처
- 상태 전환 시 변경 전/후 값을 모두 로깅
- 타임아웃 에러는 전체 컨텍스트 포함: 기대값, 실제값, 경과 시간

### 감사 로그 (Audit Log)
- **목적**: AI의 모든 행동을 기록 (보안 + 투명성)
- **저장**: `~/.naia/audit.db` (SQLite)
- **필드**: timestamp, tier, action, target, result
- **보존**: 90일 기본

---

## 보안

### 권한 계층 (Permission Tiers)

| Tier | 정책 | 예시 |
|------|------|------|
| **0: 자유** | 확인 불필요 | 파일 읽기, 정보 조회, 대화, 검색 |
| **1: 알림** | 사후 보고 | 파일 생성/수정(~/내), 비파괴 명령, 앱 실행 |
| **2: 승인** | 사전 확인 필요 | 파일 삭제, 패키지 설치/제거, 시스템 설정, git push |
| **3: 금지** | 절대 불가 | 시스템 파일 수정, 타 사용자 데이터, 보안 설정 변경, 인증정보 외부 전송 |

### 샌드박스
- **기본 범위**: 사용자 홈 디렉토리만
- **위험 명령**: Podman 일회용 컨테이너에서 실행
- **네트워크 격리**: 민감 작업은 네트워크 차단 컨테이너

### OS 기본 보안
- **불변 OS**: rpm-ostree, 시스템 파괴 불가, 롤백 가능
- **SELinux**: 프로세스별 접근 제어
- **Flatpak**: 앱 샌드박싱
- **Podman**: 루트리스 컨테이너

### 인증 정보
- **저장**: `~/.naia/credentials/` (암호화)
- **규칙**: Agent는 키를 사용할 수 있지만 값을 볼 수 없음
- **금지**: API 키, 토큰, 비밀번호는 로그/감사에 절대 노출 불가

### 원격 접근
- **기본**: localhost만 (127.0.0.1)
- **허용**: Tailscale VPN 또는 SSH 터널
- **외부 채널**: Discord/Telegram은 Tier 0-1 권한만

---

## 개발 프로세스

### 브랜치 전략

```
main ← 항상 배포 가능 (BlueBuild가 main에서 빌드)
  └── dev ← 통합 브랜치
        └── issue-{N}-{desc} ← 기능 브랜치 (짧은 수명, PR to dev)
```

**작업 공간 격리:**

| 모드 | 사용 시점 | 명령어 |
|------|----------|--------|
| **워크트리** (기본값) | 동시 작업 — 같은 프로젝트에서 여러 이슈를 병렬 진행 | `git worktree add ../{project}-issue-{N}-{desc} issue-{N}-{desc} dev` |
| **브랜치만** | 단독 작업 — 해당 레포에서 이슈 하나만 진행 | `git checkout -b issue-{N}-{desc} dev` |

**장기 브랜치 관리 정책:**

- 기능 브랜치는 main에서 **2주 이상 분기 금지** — 반드시 리베이스 또는 main 머지 필요.
- 교훈: `issue-4-windows-support` 수개월 방치 → 69커밋 누적 → 13파일 충돌 → 세션 전체를 충돌 해결에 소비.
- 방치된 브랜치 머지 전: 전체 범위 분석 → 토픽별 분류 → 패턴 우열 비교 후 일괄 해결. 파일 단위 순차 해결 금지.
- 예방: 주간 리베이스, 2주 이상 중단 시 현재 main에서 새 브랜치 생성.

### 커밋 컨벤션

```
<type>(<scope>): <description> (#<issue>)

types: feat, fix, refactor, test, docs, chore, ci
scopes: shell, agent, gateway, os, context

⚠️ 이슈 번호 참조는 필수입니다.
  - 첫 줄 끝에 (#N) 추가 (N = GitHub Issue 번호)
  - 이슈를 완료하는 마지막 커밋에는 본문에 "Closes #N" 추가
  - 예외: merge 커밋, 초기 레포지토리 셋업

예시:
feat(shell): add VRM avatar idle animation (#36)
fix(agent): handle LLM timeout gracefully (#26)
ci(os): add BlueBuild GitHub Action (#12)
```

### 선택적 트레일러 (Optional Trailers)

커밋 본문에 **맥락이 명확하지 않아 재조사에 상당한 시간이 걸릴 때만** 추가. 모든 커밋에 필수가 아님.

**트리거**: 진행 파일에 `rejected_alternatives[]` 또는 `constraints_discovered[]`가 있으면 → 커밋 시점에 트레일러로 증류.

| 트레일러 | 형식 | 목적 |
|---------|------|------|
| `Rejected:` | `<접근법> \| <이유>` | 검토했으나 거절된 접근법 |
| `Constraint:` | `<제약>` | 결정을 형성한 기술적/아키텍처 제약 |
| `Directive:` | `<경고>` | 이 코드를 다음에 건드릴 AI 세션에 대한 경고 |
| `Assisted-by:` | `<도구>` | 사용된 AI 도구 (투명성을 위해 권장) |

```
feat(shell): fix audio recording in WebKitGTK (#79)

Rejected: AudioContext({sampleRate:16000}) | WebKitGTK freezes audio to zeros
Constraint: WebKitGTK AudioContext — default sampleRate only, SW downsampling required
Directive: Do not hardcode sampleRate in AudioContext for this platform
Assisted-by: Claude Sonnet 4.6
```

### PR 프로세스
1. 동시 작업: `git worktree add ../{project}-issue-{N}-{desc} issue-{N}-{desc} dev` (워크트리 + 브랜치 from dev)
   단독 작업: `git checkout -b issue-{N}-{desc} dev` (단순 브랜치 from dev)
2. 테스트 먼저 작성 (TDD)
3. 최소 코드 구현
4. 모든 테스트 통과 확인
5. dev로 PR (설명 포함)
6. Squash merge
7. 주기적으로 dev → main 머지 (릴리스)

### CI 파이프라인

| 트리거 | 실행 |
|--------|------|
| push | lint, typecheck, unit tests, build |
| PR | 위 + 통합 테스트 |
| main merge | 위 + E2E + BlueBuild 이미지 + ISO 생성 |

### 버전 관리

단일 진실 공급원(SoT): `shell/src-tauri/Cargo.toml`

| 파일 | 역할 |
|------|------|
| `shell/src-tauri/Cargo.toml` | **SoT** — 이 파일을 먼저 변경 |
| `shell/package.json` | Cargo.toml과 반드시 일치 — 빌드 스크립트가 강제 |
| `shell/src-tauri/tauri.conf.json` | **version 필드 없음** — Tauri가 Cargo.toml에서 자동으로 읽음 |

**규칙**: `tauri.conf.json`에 version을 절대 설정하지 말 것. 버전 업 시 `Cargo.toml` + `package.json`만 수정. 빌드 스크립트(`scripts/build-windows.ps1`)는 두 파일이 다르면 실패함.

### 릴리즈 프로세스

6단계 워크플로우 — 반드시 순서대로 진행. AI는 단계를 건너뛸 수 없음.

| 단계 | 내용 |
|------|------|
| 1. 개발 | 기능 구현 및 테스트 |
| 2. 검수용 설치 파일 전달 | 로컬 `tauri build` 후 설치 파일 경로 안내 — CI 태그 푸시 **금지** |
| 3. 유저 검수완료 | 사용자가 직접 설치/검증 후 OK 확인 |
| 4. 릴리즈 노트 작성 | CHANGELOG.md 또는 GitHub Release 드래프트에 작성 |
| 5. 릴리즈 유저 허가 | 사용자가 명시적으로 승인: `echo approved > .agents/release-approved` |
| 6. 릴리즈 진행 | 태그 푸시 + GitHub Release (CI가 아티팩트 빌드) |

**AI 제약사항:**
- 2단계 "검수용 파일 전달": 로컬 빌드만. 절대 태그 푸시 또는 CI 트리거 금지.
- 1~5단계 완료 전 태그 푸시 또는 `gh release create` 금지.
- `release-guard.js` hook이 기계적으로 강제 차단 — 승인 플래그 없으면 태그 푸시 차단됨.
- `.agents/release-approved`는 **사용자만** 생성. 1회 사용 후 자동 삭제.

### 코드 리뷰

AI 리뷰 권장, 보안 관련은 사람 리뷰 필수.

**수정 원칙:** 리뷰에서 발견된 항목은 버그든 코드 품질 개선이든 반드시 수정해야 합니다. "버그가 아니니까" 미룰 수 없습니다. 발견할 가치가 있었다면 수정할 가치도 있습니다.

**코드 품질:**
- [ ] 새 행동에 대한 테스트 추가/업데이트?
- [ ] 중복 코드 없는가? (같은 로직이 2곳 이상)
- [ ] 미사용 import/함수/파일 없는가? (knip clean)
- [ ] 이전 구현의 좀비 코드 없는가?
- [ ] 구조화된 로거 사용? (console.log 없음)
- [ ] 새 코드 경로에 충분한 디버그 로깅이 있는가? (비동기 작업, 상태 전환, 외부 호출, 에러 경로)

**보안:**
- [ ] 새 도구의 권한 Tier 올바른지?
- [ ] 감사 로그에 새 AI 행동이 기록되는지?
- [ ] 하드코딩된 인증 정보 없는지?
- [ ] 위험 작업이 Podman 샌드박스를 사용하는지?
- [ ] 외부 네트워크 접근이 정당한지?
- [ ] LLM 프롬프트 변경이 안전한지?

**아키텍처:**
- [ ] 올바른 모듈에 코드가 있는가? (shell/agent/gateway/os)
- [ ] stdio 프로토콜 변경이 하위 호환인가?
- [ ] 불필요한 새 파일이 없는가? (기존 파일 확장으로 가능했는지)
- [ ] 6개월 후에도 이해할 수 있는 코드인가?

---

## 컨텍스트 관리

### Dual-directory 아키텍처
```
.agents/   → AI용 (영어, JSON/YAML, 토큰 최적화)
.users/    → 사람용 (한국어, Markdown, 상세)
```

### 규칙
- **SoT**: `.agents/context/agents-rules.json`이 유일한 규칙 소스
- **미러링**: `.agents/` 변경 시 `.users/`도 반영 (역도 마찬가지)
- **온디맨드 로딩**: 워크플로우는 필요할 때만 읽기
- **항상 읽기**: `agents-rules.json`
- **필요시 읽기**: `workflows/*`, `skills/*`

### Cascade (전파) 규칙
- 컨텍스트 변경 → `.users/` 미러 업데이트
- 모듈 추가 → parent 인덱스 업데이트
- 규칙 변경 → 모든 의존 컨텍스트에 전파
- **순서**: self → parent → siblings → children → mirror

### Harness Engineering (하네스 엔지니어링)

Claude Code 훅을 통한 프로젝트 규칙의 기계적 시행.
텍스트 규칙은 잊혀짐; 기계적 시행은 잊혀지지 않음.

**훅** (`.claude/hooks/`):

| 훅 | 트리거 | 목적 |
|----|--------|------|
| `sync-entry-points.js` | 엔트리포인트 편집 시 | CLAUDE.md ↔ AGENTS.md ↔ GEMINI.md 자동 동기화 |
| `cascade-check.js` | 컨텍스트 파일 편집 시 | 삼중 미러링 업데이트 알림 |
| `commit-guard.js` | `git commit` 실행 시 | sync_verify 이전 커밋 경고; gate_approvals + phase 순서 검증; upstream_issue_ref 설정 시 upstream contribution advisory |
| `process-guard.js` | Stop (응답 종료 시) | 실제 Read/Grep/Glob 없는 리뷰 완료 선언 차단 |

**진행 파일** (`.agents/progress/*.json`):
- 세션 핸드오프용 JSON — 컨텍스트 압축과 세션 경계를 넘어 상태 보존
- Gitignored (세션 로컬 전용, 커밋 안 됨)
- 스키마: issue, title, project, current_phase, gate_approvals, decisions, surprises, blockers, review_evidence

**테스트**: `bash .agents/tests/harness/run-all.sh` (77개 테스트)

상세: `.agents/context/harness.yaml`

---

## AI 워크플로우

### 세션 시작 프로토콜 (필수)

> **컨텍스트 압축은 모든 인메모리 상태를 삭제한다. GitHub Issue가 유일한 영구 정보 출처다.**

모든 새 세션 또는 컨텍스트 압축 후 — 작업 시작 전 반드시:

1. `gh issue list --state open` — 활성 이슈 확인
2. `gh issue view <N>` — 각 활성 이슈의 **전체 본문 + 모든 댓글** 읽기
3. `cat .agents/progress/<N>-*.json` — progress 파일이 있으면 읽기
4. **그 다음에만** 작업 재개 또는 시작

**절대** AI 메모리만으로 작업을 시작하거나 재개하지 않는다. 이슈에 없으면 없는 것이다.

### 이슈에 반드시 기록해야 할 것

- 디자인 참조: 모든 UI 변경에 대한 파일 경로 또는 이미지 설명
- 단계별 구현 계획
- 내린 결정과 그 이유
- 검토 후 기각한 대안
- 14단계 사이클에서 현재 위치
- 블로커

### 표준 사전 점검

- **응답 언어**: 한국어
- **작업 전 필수**: `agents-rules.json` + `issue-driven-development.yaml` 읽기
- **작업 유형 확인**: shell / agent / gateway / os 중 어디?
- **TDD 필수**: 통합 테스트 우선
- **보안 확인**: 새 도구/명령의 Tier 확인

### 작업 로그
- **위치**: `work-logs/` (gitignored, 프로젝트 내부)
- **형식**: `YYYYMMDD-{번호}-{주제}.md`
- **규칙**: `{username}/` 하위 디렉토리
- **언어**: 기여자 선호 언어
