# naia-os

**배포형 AI OS — 사용자가 보고 말을 거는 데스크톱 셸.** Tauri/Rust 네이티브 셸이
대화 UI·음성·아바타를 그리고, 뒤에서 "뇌"(naia-agent)를 띄워 gRPC 로 대화한다.
Bazzite 기반, 헥사고날 아키텍처로 깨끗하게 재구축(clean rebuild)된 코어.

---

## naia-os 란?

naia-os 는 **AI 에이전트를 위한 데스크톱 셸(앱)**이다. 사용자가 실제로 실행하고
보는 화면이며, 내부적으로는:

- **뇌를 띄운다** — 기동 시 naia-agent 를 외부 프로세스로 spawn 하고 gRPC 로 연결.
- **메시지만 전달한다** — provider·모델·키·기억은 전부 agent 관할. 셸은 "무슨
  모델인지" 몰라도 된다. 사용자 입력을 보내고 스트리밍 응답을 그릴 뿐.
- **표현을 담당한다** — 텍스트·음성·아바타로 에이전트의 응답을 사람에게 표현.

```
사용자 ─입력→ naia-os(셸) ─(gRPC)→ naia-agent(뇌) ─→ provider / 기억 / 도구
            ◀─표현(텍스트·음성·아바타)── 스트림 ◀────────
```

---

## 무엇을 하나 (역량 · 상태)

| 역량 | 설명 | 상태 |
|------|------|:----:|
| **텍스트 대화** | 셸이 agent 를 spawn → gRPC `Chat` 스트림으로 대화. new core 경로 | ✅ |
| **provider/모델 설정** | 설정 UI → agent `SetWorkspace`/reload 로 앱 재시작 없이 모델 교체 | ✅ |
| **환경 사이드카** | 뇌와 분리된 독립 서비스(예: BGM `bgm-sidecar`). 뇌가 죽어도 생존 | ✅ |
| **음성 I/O · 아바타 · TTS** | 음성 입출력·아바타 표현 | 🔜 옛 경로 존재, 새 코어 이식은 UC2 후속 |
| **다중 모달 표현** | 하나의 표현 의도를 음성/아바타/로봇 몸체가 함께 소비 | 🔜 egress 분화 자리 예약 |

> ✅ = 새 코어에 구현+테스트(Playwright e2e 포함). 🔜 = 설계/옛 경로 존재, 이식 진행.
> 정확한 추적은 `docs/user-scenarios.md`(UC SoT)와 `docs/requirements.md` 참조.

---

## 생태계에서의 위치

naia-os 는 4개 레포가 맞물린 naia 생태계의 **표현/셸 계층**이다.

```
┌───────────────┐   gRPC    ┌───────────────┐  recall/save  ┌────────────────┐
│   naia-os     │ ────────▶ │  naia-agent   │ ────────────▶ │  naia-memory   │
│  (이 레포)     │ ◀──────── │   (뇌/처리)    │ ◀──────────── │  (인지 기억)    │
│ UI·음성·아바타  │  스트림    │ provider·도구   │               │ 장기기억·회상    │
└───────────────┘           └───────┬───────┘               └────────────────┘
                                    │ 설정·스킬 로딩
                                    ▼  naia-adk (워크스페이스 — provider/모델/스킬 SoT)
```

- **naia-os** (이 레포) — 사용자 셸. agent 를 spawn 하고 gRPC 로 대화.
- **naia-agent** — provider 호출·도구 실행·대화 조립을 하는 뇌. → `../new-naia-agent`
- **naia-memory** — 장기기억. agent 가 recall/save 로 연동.
- **naia-adk** — 설정이 사는 워크스페이스. agent 가 기동 시 로딩.

**결합 방식 = 인터페이스, 런타임 의존 아님.** os↔agent 는 gRPC wire 계약
(`AgentOutbound`/`AgentMessage` 폐쇄 union)으로만 맞물린다. transport 는 포트라
stdio↔gRPC 교체가 도메인을 건드리지 않는다.

---

## 뇌 · 몸 · 환경 모델 (naia 의 핵심 개념)

naia-os 가 다른 데스크톱 앱과 다른 점은 이 3층 분리다 (SoT: `docs/brain-body-environment.md`):

| 층 | 무엇 | 어디 |
|----|------|------|
| **뇌(brain)** | 인지·의도 — 무엇을 말하고 어떤 도구를 쓸지 | naia-agent (별도 프로세스) |
| **몸(body)** | 감각·표현 기관 — 아바타·음성 I/O | 셸 네이티브 |
| **환경(environment)** | 에이전트가 작업하는 세계 — 브라우저·터미널·workspace·BGM | 셸 소유 독립 사이드카 |

핵심: **도구·BGM 은 "몸"이 아니라 "환경"**이며 뇌에서 분리된 독립 서비스다(뇌가
죽어도 환경은 생존, 뇌는 intent 만 보낸다). 이 분리 덕에 뇌를 안드로이드/임베디드로
갈아껴도 몸·환경·도메인은 불변이다.

---

## 아키텍처 한눈에

- **셸** = Tauri(Rust) + 프론트엔드(`packages/shell`). 네이티브 창·IPC·표현.
- **코어** = 헥사고날 TypeScript(`src/main`: domain/app/ports/adapters). agent 와 같은 사상.
- **사이드카** = 환경 독립 서비스(`packages/bgm-sidecar`).
- 전체 사상(직교 2축·인지 계층·새 UC 레시피)의 **온보딩 SoT** = [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## 빠른 시작

```bash
pnpm install                       # 의존성 설치
pnpm test                          # 코어 단위·계약 테스트 (vitest)

# 데스크톱 셸 실행 (Tauri)
cd packages/shell
pnpm run tauri:dev                 # 개발 모드 실행 (agent 자동 spawn)

# 검증 (P04 — GUI/Rust 도 헤드리스로)
pnpm test                          # vitest (순수 로직)
pnpm test:e2e                      # Playwright e2e (실 UI, Tauri IPC mock)
xvfb-run pnpm test:e2e:tauri       # 실 Tauri 바이너리 풀스택 (wdio+tauri-driver)
```

> **사전 요건**: Rust(rustup) · WebView2(Windows)/webkit2gtk(Linux) · C++ 빌드 도구.
> OS별 셋업은 [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md) 참조.

---

## 개발 프로세스 (기여자용)

**계약 우선 + V모델** — 코드 한 줄 전에 시나리오·요구사항·테스트가 먼저.

| 게이트 | 산출물 |
|--------|--------|
| P01 사용자 시나리오 | `docs/user-scenarios.md` UC |
| P02 테스트 시나리오 | Test Coverage Map 매핑 |
| P03 요구사항 | `docs/requirements.md` FR/NFR |
| P04 통합 테스트 | vitest + Playwright e2e (UI/Rust 변경은 실 검증 포함) |
| P05 완료 | 요구사항 상태 → Done |

새 UC 추가 레시피(슬롯 채우기, 추론 금지)는 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §6.
모든 AI 도구의 진입점·규칙은 **[`AGENTS.md`](AGENTS.md)** — 처음이라면 이 README 다음에 읽으세요.
빠른 첫 기여 가이드는 [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md)(15분 fast-path 포함).

---

## 프로젝트 구조

```
naia-os/
├── AGENTS.md / CLAUDE.md / GEMINI.md / OPENCODE.md / CODEX.md   # AI 진입점(헌장) — AGENTS.md 가 SoT, 나머지는 자동 mirror
├── .agents/        # AI 컨텍스트(규칙·상태·훅) — 사람이 편집
│   └── context/    #   agents-rules.json(규칙 SoT) · process-status.json(진행)
├── .users/         # .agents/ 의 사람용 마크다운 mirror
├── src/
│   ├── main/       # 코어 — domain / app / ports / adapters
│   └── test/       # 코어 테스트
├── packages/
│   ├── shell/      # Tauri 데스크톱 셸 (UI·아바타·음성 I/O·e2e)
│   └── bgm-sidecar/# 환경 사이드카 (BGM)
├── scripts/        # enforce-root-structure.sh(구조강제) · sync-harness-mirrors.sh 등
└── docs/           # ARCHITECTURE · brain-body-environment · user-scenarios · requirements · glossary · progress
```

구조 규칙: 새 루트 파일/폴더는 `agents-rules.json`(F12/F13)에 먼저 등록해야 한다.
미등록 시 `scripts/enforce-root-structure.sh --fix` 가 **삭제**한다.

---

## 라이선스

Apache License 2.0 — [`LICENSE`](LICENSE) 참조.
기여 가이드·행동강령·보안정책은 [`.github/`](.github/) 참조.

## 링크

- **naia-agent** (뇌) — `../new-naia-agent`
- **naia-memory** (장기기억) — [github.com/nextain/naia-memory](https://github.com/nextain/naia-memory)
- **naia-adk** (워크스페이스) — [github.com/nextain/naia-adk](https://github.com/nextain/naia-adk)
- **Nextain** — [nextain.io](https://nextain.io)
