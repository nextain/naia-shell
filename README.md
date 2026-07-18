# naia-shell

**Naia Visual Agent의 비주얼 셸 코드베이스. 사용자가 보고 말을 거는 데스크톱 앱이며, naia-os 배포판의 핵심 사용자 표면이다.** Tauri/Rust 네이티브 셸이
대화 UI·음성·아바타를 그리고, 뒤에서 "뇌"(naia-agent)를 띄워 gRPC 로 대화한다. 이 레포의 앱 코어는 헥사고날 아키텍처로 재구축되어 있고, 배포판 계층은 Bazzite/titanoboa 기반으로 가져간다.

> **이름 정리**: 이 저장소가 `naia-shell`이고, 사용자가 직접 만나는 **비주얼 셸(앱)** 코드가 여기 있습니다. `naia-os`는 이제 이 셸을 부팅 가능한 형태로 묶는 Bazzite/titanoboa 기반 **배포판/ISO** 계층을 가리킵니다. 두 이름이 헷갈리지 않게, 코드는 `naia-shell`, 배포판은 `naia-os`로 나눠 씁니다. 제품 카테고리는 **Naia Visual Agent**입니다.

---

## naia-shell 이란?

naia-shell은 **Naia Visual Agent를 위한 데스크톱 셸(앱)**이다. 사용자가 실제로 실행하고
보는 화면이며, 내부적으로는:

- **뇌를 띄운다** — 기동 시 naia-agent 를 외부 프로세스로 spawn 하고 gRPC 로 연결.
- **메시지만 전달한다** — provider·모델·키·기억은 전부 agent 관할. 셸은 "무슨
  모델인지" 몰라도 된다. 사용자 입력을 보내고 스트리밍 응답을 그릴 뿐.
- **표현을 담당한다** — 텍스트·음성·아바타로 에이전트의 응답을 사람에게 표현.

```
사용자 ─입력→ naia-shell(비주얼 셸) ─(gRPC)→ naia-agent(뇌) ─→ provider / 기억 / 도구
            ◀─표현(텍스트·음성·아바타)── 스트림 ◀────────
```

---

## 무엇을 하나 (역량 · 상태)

| 역량 | 설명 | 상태 |
|------|------|:----:|
| **텍스트 대화** | 셸이 agent 를 spawn → gRPC `Chat` 스트림으로 대화. new core 경로 | ✅ |
| **provider/모델 설정** | 설정 UI → agent `SetWorkspace`/reload 로 앱 재시작 없이 모델 교체 | ✅ |
| **환경 사이드카** | 뇌와 분리된 독립 서비스(예: BGM `bgm-sidecar`). 뇌가 죽어도 생존 | ✅ |
| **선제 발화 profile** | “개인 라디오 시작해” 또는 “행사 소개 시작”으로 opt-in. 장기 activity stream을 기존 텍스트·TTS·BGM 표현에 연결 | ✅ 기술 slice / 제품 검증은 부분 |
| **음성 I/O · 아바타 · TTS** | 음성 입출력·아바타 표현 | 🔜 옛 경로 존재, 새 코어 이식은 UC2 후속 |
| **다중 모달 표현** | 하나의 표현 의도를 음성/아바타/로봇 몸체가 함께 소비 | 🔜 egress 분화 자리 예약 |

> ✅ = 새 코어에 구현+테스트(Playwright e2e 포함). 🔜 = 설계/옛 경로 존재, 이식 진행.
> 정확한 추적은 `docs/user-scenarios.md`(UC SoT)와 `docs/requirements.md` 참조.
> 실제 Tauri 검증은 profile 저장·복원, DJ 실제 YouTube BGM·첫 결과·stop, 전시 greeting·stop까지다.
> audible TTS·live 질문 끼어들기·모든 제어·장시간/현장 품질은 아직 native 검증으로 주장하지 않는다.

---

## 생태계에서의 위치

naia-shell은 Naia Visual Agent 스택의 **표현/셸 계층**이다.

```
┌───────────────┐   gRPC    ┌───────────────┐  recall/save  ┌────────────────┐
│  naia-shell   │ ────────▶ │  naia-agent   │ ────────────▶ │  naia-memory   │
│  (이 레포)     │ ◀──────── │   (뇌/처리)    │ ◀──────────── │  (인지 기억)    │
│ UI·음성·아바타  │  스트림    │ provider·도구   │               │ 장기기억·회상    │
└───────────────┘           └───────┬───────┘               └────────────────┘
                                    │ 설정·스킬 로딩
                                    ▼  naia-adk (워크스페이스 — provider/모델/스킬 SoT)
```

- **naia-shell** (이 레포의 현재 코드 역할) — 사용자 셸. agent 를 spawn 하고 gRPC 로 대화.
- **naia-os** — Bazzite/titanoboa 기반 커스텀 배포판/ISO. 비주얼 에이전트 스택을 부팅 가능한 작업장으로 묶는 배포 계층.
- **naia-agent** — provider 호출·도구 실행·대화 조립을 하는 뇌. → `../naia-agent`
- **naia-memory** — 장기기억. agent 가 recall/save 로 연동.
- **naia-adk** — 설정이 사는 워크스페이스. agent 가 기동 시 로딩.

**결합 방식 = 인터페이스, 런타임 의존 아님.** shell↔agent 는 gRPC wire 계약
(`AgentOutbound`/`AgentMessage` 폐쇄 union)으로만 맞물린다. transport 는 포트라
stdio↔gRPC 교체가 도메인을 건드리지 않는다.

---

## 뇌 · 몸 · 환경 모델 (naia 의 핵심 개념)

naia-shell이 다른 데스크톱 앱과 다른 점은 이 3층 분리다 (SoT: `docs/brain-body-environment.md`):

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
- **코어** = 헥사고날 TypeScript(`src/main`: domain/app/ports/adapters/composition). agent 와 같은 사상.
- **사이드카** = 환경 독립 서비스(`packages/bgm-sidecar`).
- 전체 사상(직교 2축·인지 계층·새 UC 레시피)의 **온보딩 SoT** = [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## 빠른 시작

> ⚠️ naia-shell은 실행·빌드 시 형제 폴더의 **naia-agent(뇌)** 를 자동으로 빌드해 spawn 한다.
> 따라서 두 저장소를 **같은 부모 폴더 아래 나란히(형제 디렉토리)** 내려받아야 한다.
> agent 만 없으면 `tauri:dev`·`tauri build`(빌드) 가 바로 실패한다.

```bash
# 1) 두 저장소를 형제로 clone (디렉토리 이름을 바꾸지 말 것 — 경로가 고정돼 있다)
git clone https://github.com/nextain/naia-shell.git
git clone https://github.com/nextain/naia-agent.git
#  부모폴더/
#  ├── naia-shell/       ← 아래 명령은 여기서 실행
#  └── naia-agent/      ← tauri:dev / tauri build 가 자동으로 빌드·spawn

cd naia-shell
pnpm install                       # 의존성 설치 (루트)

# 2) 코어 단위·계약 테스트 (루트)
pnpm test                          # vitest run (src/test — 순수 로직·UC 계약)

# 3) 데스크톱 셸 실행 (Tauri) — agent 를 자동 빌드·spawn 한다
pnpm -C packages/shell run tauri:dev

# 4) 배포본(인스톨러) 빌드
pnpm -C packages/shell run tauri:build:windows:local   # Windows → NSIS + MSI (target/release/bundle/)
pnpm -C packages/shell run tauri build                  # Linux   → deb / rpm / appimage (기본 conf)

# 5) 검증 (P04 — GUI/Rust 도 헤드리스로). test:e2e / test:e2e:tauri 는 packages/shell 에만 존재:
cd packages/shell
pnpm test                          # vitest (셸 단위)
pnpm test:e2e                      # Playwright e2e (실 UI, Tauri IPC mock)
xvfb-run pnpm test:e2e:tauri       # 실 Tauri 바이너리 풀스택 (wdio+tauri-driver, Linux)
```

> **사전 요건**: Node 22+ · pnpm · Rust(rustup) · WebView2(Windows)/webkit2gtk(Linux) · C++ 빌드 도구.
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
naia-shell/
├── AGENTS.md / CLAUDE.md / GEMINI.md / OPENCODE.md / CODEX.md   # AI 진입점(헌장) — AGENTS.md 가 SoT, 나머지는 자동 mirror
├── .agents/        # AI 컨텍스트(규칙·상태·훅) — 사람이 편집
│   └── context/    #   agents-rules.json(규칙 SoT) · process-status.json(진행)
├── .users/         # .agents/ 의 사람용 마크다운 mirror
├── src/
│   ├── main/       # 코어 — domain / app / ports / adapters / composition
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

- **소스 코드**: Apache License 2.0 — [`LICENSE`](LICENSE).
- **AI 컨텍스트**(`.agents/`·`.users/`·`AGENTS.md`): CC-BY-SA 4.0 — [`CONTEXT-LICENSE`](CONTEXT-LICENSE).

**왜 듀얼 라이선스인가?** 소스 코드는 Apache 2.0 으로 자유롭게 수정·상용 가능하지만, AI 컨텍스트 파일(프로젝트 철학·기여 구조·AI 에이전트 협업 원칙)은 CC-BY-SA 4.0 입니다. 포크 시 컨텍스트 변경분도 **동일 라이선스로 공유(ShareAlike)**하고 원작자(Nextain)를 명시해야 합니다 — 업스트림 생태계(오픈소스 기여 구조 + AI 협업 원칙)가 모든 포크에 전파되도록 보호하기 위함입니다. 상세 = [`CONTEXT-LICENSE`](CONTEXT-LICENSE).

기여 가이드·행동강령·보안정책은 [`.github/`](.github/) 참조.

## 링크

- **naia-agent** (뇌) — `../naia-agent`
- **naia-memory** (장기기억) — [github.com/nextain/naia-memory](https://github.com/nextain/naia-memory)
- **naia-adk** (워크스페이스) — [github.com/nextain/naia-adk](https://github.com/nextain/naia-adk)
- **Nextain** — [nextain.io](https://nextain.io)
