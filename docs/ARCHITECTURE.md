# new-naia 아키텍처 — 사상 + UC 추가 레시피 (온보딩 SoT)

> **목적**: 새 개발자/AI 가 **흔들림 없이 동일 구조·사상으로** 개발/확장하기 위한 단일 진입 문서.
> 사상은 코드·CI 게이트로 강제된다(말로 끝나지 않음). 위반은 PR 에서 자동 RED(아래 §5).

---

## 1. 큰 그림 — os → agent → adk (수평/lateral)

```
new-naia-os (Tauri/Rust 셸 = UI/표현)
   │  ① 셸이 agent 를 외부 프로세스로 spawn → "GRPC_LISTENING <addr>" 핸드셰이크
   │  ② gRPC (tonic 클라 ↔ @grpc/grpc-js 서버). transport = 포트(stdio/grpc 교체 가능)
   ▼
new-naia-agent (Node = 뇌/처리)
   │  ③ SetWorkspace(adkPath) → agent 가 naia-adk settings 에서 provider/model 로딩
   │  ④ Chat(server-stream): 메시지만 던지면 agent 가 recall→provider→save→스트림
   ▼
naia-adk (settings 저장소 = SoT). 키는 OS 키체인(평문 금지)
```

**불변식**: 대화 1회 = 셸은 **메시지만** 던진다. provider/키/모델 선택·기억은 전부 agent 가 naia-adk 기준으로 처리. 셸은 provider 를 모른다(관할이 agent 로 이식됨).

## 2. 직교 2축 (orthogonality)

- **수직 = UC (사용자 시나리오)**: UC1 텍스트대화, UC2 음성, UC3 기억, … UC14. `docs/user-scenarios.md` SoT.
- **수평 = wire/포트 경계**: os ⟷ agent = `AgentOutbound`/`AgentMessage` 폐쇄 union(H-agent 계약). agent 내부 = 헥사고날(domain/app/ports/adapters).
- 한 UC = **두 repo 의 두 반쪽**(os UC1 ⟂ agent UC1)이 같은 wire 계약으로 만나는 **세로 슬라이스**.
- 코드 변경은 한 축에만 국소화돼야 한다(transport 교체 ⇒ 도메인 불변; UC 추가 ⇒ 다른 UC 불변).

## 3. 인지 계층 (뇌 중심 — 안드로이드까지)

> **상위 레이어 모델 = 뇌·몸·환경** (SoT: `docs/brain-body-environment.md`).
> **뇌(agent)** = 인지/의도 · **몸(셸 네이티브)** = 에이전트의 감각·표현 기관(아바타·음성 I/O) ·
> **환경(셸 소유 독립 서비스/사이드카)** = 에이전트가 작업하는 세계(브라우저·터미널·workspace·**BGM**).
> **도구·BGM 은 몸이 아니라 환경**이며, 뇌에서 분리된 독립 서비스(뇌 죽어도 생존, 뇌는 intent 만)다.
> 환경 런타임을 agent 트리에 두면 substrate-agnostic 위반(아래 §3 본문은 그중 *뇌* 내부 계층).

agent 는 기능(채팅·도구·기억)이 아니라 **계층**으로 구조화한다:
- **입력층(ingress)** — `ports/uc1.ts AgentIngressPort` (transport-neutral 수신).
- **처리** — `app/chat-turn-handler.ts` (recall→컨텍스트 주입→provider→save).
- **출력층(egress)** — `AgentEgressPort` (text/usage/finish emit).
- **표현층** — *아직 분화 전*(현재 단일 텍스트 모달이라 출력≈표현). 다중 모달(음성/아바타/로봇 몸체)이 하나의 표현 의도를 소비하게 될 때 egress 에서 분화한다(UC2 착수 시). → **표현 egress 포트 자리 예약**.

입력/출력이 transport-neutral 포트라, 안드로이드 임베디드로 갈아껴도 도메인·처리는 불변이다.

## 4. 헥사고날 레이어 (agent)

| 레이어 | 책임 | 예 |
|---|---|---|
| `domain/` | 순수 로직, I/O 0 | chat.ts(계약 union), memory.ts, provider-route.ts |
| `app/` | use-case 오케스트레이션 | chat-turn-handler.ts |
| `ports/` | 경계 인터페이스 | uc1.ts(Ingress/Egress/Provider/…), memory.ts |
| `adapters/` | 포트 구현(I/O 소유) | grpc/, naia-memory.ts, naia-settings-store.ts, providers |
| `composition/` | 와이어링 | index.ts |

도메인은 어댑터를 모른다. 새 외부 의존은 **어댑터**로, 경계는 **포트**로.

## 5. 흔들림 방지 = 자동 강제 (드리프트 검출)

사상은 다음 게이트로 **강제**된다. 위반 시 자동 RED:

| 게이트 | 무엇 | 어디 |
|---|---|---|
| **file-anchor** | `src/main/*` 파일이 `module-manifest.json` 에 {layer,uc,contract} 등록됐나 | PreToolUse 훅 + `check-file-anchors.mjs`(CI) |
| **assembly-coverage** | 모든 S/UC 가 user-scenarios 에 전수분류(미분류 0) | `check-assembly-coverage.mjs`(CI) |
| **compile-integrity** | core+shell+agent tsc 무결 | `check-compile-integrity.mjs`(CI) |
| **logging** | Logger/DiagnosticLog 강제, console.* 금지 | `check-logging.mjs`(CI) |
| **wire probe** | os outbound ⊆ agent accept / agent output ⊆ os classify | `scripts/builds/uc1-*-probe.mjs`(CI) |
| **vitest** | UC 계약·통합 테스트 | CI `code-gates` job |
| **self-trust** | 구조/헌장/SDLC 메타 | CI `verify` job |

> CI(`.github/workflows/self-trust-gates.yml`)가 fork/웹 PR 까지 강제하는 최종 방어선. 로컬 hook/pre-commit 은 1차 마찰(우회 가능).
> **follow-up(B-WIRE)**: proto SoT(`new-naia-agent/.../naia_agent.proto`)를 os 가 하드코드 형제경로로 소비 — cross-repo proto 해시 일치 강제는 공유 패키지/서브모듈 결정 후. 현재는 probe 가 union 정합을 잡음.

## 6. 새 UC 추가 레시피 (R3 — 따라하면 동일 구조)

새 UC(예: UC-X)를 추가할 때 **이 순서**를 따른다. 추론 금지, 슬롯 채우기:

1. **시나리오(P01)** — `docs/user-scenarios.md` 에 UC-X 항목 + Test Coverage Map 행 추가. (assembly-coverage 가 미분류면 RED)
2. **요구사항(P03)** — `docs/requirements.md` 에 FR/NFR.
3. **수평 계약** — os↔agent wire 가 바뀌면 `AgentOutbound`/`AgentMessage` union(양 repo `domain/chat.ts`) + proto(`naia_agent.proto`) 에 추가. probe 가 양방향 정합 검증.
4. **포트** — 새 경계는 `ports/` 에 인터페이스. 기존 포트로 되면 재사용.
5. **도메인** — 순수 로직은 `domain/`. I/O 금지.
6. **어댑터** — 외부 의존(provider/skill/store)은 `adapters/` 에 포트 구현.
7. **와이어링** — `composition/index.ts` 에서 주입.
8. **file-anchor** — 새 `src/main/*` 파일은 `module-manifest.json` 에 {layer,uc:["UC-X"],contract} 등록. (안 하면 PreToolUse/CI RED)
9. **테스트(P04)** — UC-X 계약 테스트(`src/test/uc-x*.contract.test.ts`) + 필요 시 통합. 실 UI/Rust 변경은 Playwright/e2e-tauri 포함.
10. **검증** — `pnpm test` + 위 게이트 전부 green. 그 다음 커밋.

> 셸(UI) 측: `packages/shell/src/components/` + `chat-service.ts`(새 코어 경유는 `isNewCore()` 게이트). voice/tts/route 는 아직 옛 경로(UC2 후속).

## 7. 정본 문서
- `docs/brain-body-environment.md`(뇌·몸·환경 레이어 표준 — 환경=독립 사이드카) · `docs/user-scenarios.md`(UC SoT) · `docs/requirements.md`(FR/NFR) · `docs/project-structure.md`(구조) · `docs/logging.md` · `docs/progress/structure-soundness-review-2026-06-13.md`(현 위치+로드맵).
- 사상 갱신은 이 문서 + (헌장) AGENTS.md 동시.
