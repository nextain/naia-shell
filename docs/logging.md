# 로깅 규약 (Logging Convention) — naia-os (shell + Rust)

루크 지시(2026-06-12)로 확립한 프로젝트 로깅 원칙. 신규 코드와 **이식(transplant)하는 코드 모두**에 적용.

## 원칙 1 — 진입·분기 로깅 (debug 모드 전용)

신규/이식 코드는 다음 지점에서 **반드시 로그**를 남긴다. **디버그 모드에서만 출력**(릴리즈에선 생략/no-op 가능):

- **객체/컴포넌트·함수 진입** (constructor, 주요 핸들러·effect·command 진입)
- **로직 분기 및 분기 진입** (라우팅, if/switch 각 경로 진입 등)

각 로그에 **반드시 포함**: ① 시간(timestamp) ② 클래스/컴포넌트명 ③ 파라미터들(값; 단 **비밀/키는 이름만**).

naia-os 메커니즘 (이미 존재 — 새로 만들지 않음):
- **frontend**: `Logger.debug(component, message, data)` (src/lib/logger.ts) — 이미 `[ts][LEVEL][component] msg {data}` 구조 + `frontend_log` IPC 로 Rust 브리지. timestamp·component·data(파라미터) 충족. 진입·분기는 `Logger.debug` 사용(디버그 레벨이라 릴리즈 레벨 상향 시 자동 생략).
- **Rust**: `log_verbose(msg)` (src-tauri/src/lib.rs) — 디버그 게이트(`CAFE_DEBUG_E2E`/verbose). 진입·분기 메시지에 함수명+파라미터 포함.
- `console.*` 직접 금지(logger.ts 가 대체).

## 원칙 2 — logs-first 디버깅 (1순위, HARD RULE)

**문제를 잡을 때·디버깅·원인규명 시 반드시 로그부터 확인하는 것이 1순위.** 추측·이론·도구 제작보다 로그가 먼저다.
- "왜 느리지/실패하지?" → 추측 금지. 관련 로그를 열어 타임스탬프/라인으로 근거를 댄다.
- 크기·동작·원인을 단정하기 전 `du`/`ls`/로그로 실측한 수치를 댄다.
- (계기: provider-provenance e2e-tauri 90초 행을 로그 안 보고 몇 시간 추측한 실패.)

## 로그 표면 (디버깅 시 먼저 볼 곳 — naia 로그 디렉터리 `.naia/logs/`)

| 증상 | 먼저 볼 로그 |
|------|-------------|
| 셸 UI / IPC / Rust command | `naia.log` (frontend Logger 브리지 + Rust `log_verbose`) |
| 헤드리스/E2E Rust 상세 | tmp 의 `naia-debug.log` (`CAFE_DEBUG_E2E=1` 시) |
| agent 처리·대화 | `agent-stderr.log` |
| LLM 호출 | `llm-debug.log` / 게이트웨이 `gateway.log` |

## 코드 규약 (forward-only — 기존 이식분 일괄 리팩터 안 함)

1. 신규/이식·만지는 파일에만 원칙 1 적용. 기존 코드 일괄 교체 X(이식 부담 회피).
2. `console.*` 대신 `Logger`. 비밀 값 로그 금지(이름만).
3. 진입·분기 로그는 `Logger.debug`(디버그 레벨) — 릴리즈에서 레벨 상향 시 자동 비출력.

cf 루트 메모리 `feedback_observe_before_build_logs_first`, agent 측은 new-naia-agent `docs/logging.md`.
