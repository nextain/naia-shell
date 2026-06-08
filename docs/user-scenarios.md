# 사용자 시나리오 (P01) + 테스트 커버리지 맵 — 2단계 산출물 (초안)

> 추적: 1단계 `STRUCTURE.md` v5 → 2단계 P01. **상태: 초안 — G1 휴먼 게이트(가장 강함) 대기.**
> 원칙: 시나리오는 *발명*이 아니라 old-naia-os **실제 기능**에서 도출(built-in skills 25·패널 6·멀티채널). 각 UC = 인지흐름 경로 + 관통 슬라이스/포트.
> 용어 = `glossary.md`.

## 분류축 — 인지흐름 관통 (감각→지각→경험→사고→표현/행위)

UC 를 인지흐름이 *어디까지 도는가*로 묶는다(기능 나열 ❌). vertical(5단계) 후보 = 흐름을 가장 많이 관통하는 UC.

| UC | 시나리오 (실제 기능) | 인지흐름 경로 | 관통 슬라이스/포트 |
|---|---|---|---|
| **UC1 텍스트 대화** | ChatPanel 에 입력→응답 | Chat(ingress) → 사고(llm) → 표현(speech-intent) | ChatPort·llm·ExpressionPort |
| **UC2 음성 대화** | wake→말하기→음성응답+아바타 | 감각(audio→STT) → 지각 → 사고 → 표현(음성+emote) | SensoryPort·voice(provider)·affect·ExpressionPort(avatar) |
| **UC3 기억하는 대화** ★ | "지난번 그거 기억해?" | 감각/Chat → 지각 → **장기기억 recall** → 사고 → 표현 | memory(naia-memory)·conversation·llm |
| **UC4 경험→능동 회상** ★ | 기념일·시간 앵커에 naia가 *먼저* 말 검 | (시간 trigger) → 장기기억 → 동기 → 표현 | temporal(cron)·memory·motivation·ExpressionPort |
| **UC5 도구 사용** | 날씨·시간·웹검색·github | Chat → 사고(의도) → 능력·도구(skill/mcp) → 표현 | ChatPort·skill·mcp/gateway·ExpressionPort |
| **UC6 환경 조작-브라우저** | "이거 찾아서 눌러줘" | Chat → 사고 → **환경 행위**(browser navigate/click) + 관측 | EnvironmentPort(app-surface)·skill |
| **UC7 환경 조작-시스템** | 파일 편집·명령 실행(workspace/terminal) | Chat → 사고 → **환경 행위**(host-system) + 관측(결과) | EnvironmentPort(host-system)·ActionPort? |
| **UC8 공간 분위기** | "음악 틀어줘"(BGM) | Chat → 사고 → 환경 변경(space) + 관측(BGM context) | EnvironmentPort(space)·youtube-bgm skill |
| **UC9 패널 앱** | 패널 설치→그 앱 스킬 사용 | Chat → 능력(panel install) → 환경(app-surface tool) | skill(panel)·EnvironmentPort.app-surface |
| **UC10 멀티 채널** | discord/slack 에서 naia 응답 | (외부 채널 ingress, 다중 client) → 사고 → 표현(채널) | ClientSessionPort·gateway·channels |
| **UC11 자기상태 인지** | "너 지금 상태 어때?"(system-status/진단) | **내수용**(시스템 상태) → 지각 → 표현 | InteroceptivePort·system-status·ExpressionPort |
| **UC12 온보딩/설정** | 첫 실행 wizard·키 설정 | (control-plane: 설정·신원) | control-plane(session)·config |
| **UC13 승인 게이트** | 위험 행위 전 사용자 승인 | 사고 → **승인**(규범) → 행위 | ApprovalPort·control-plane |

★ = naia 차별점(기억·경험·능동) = vertical 강력 후보.

## Test Coverage Map (P02 선행 스케치)

각 UC → 계약 테스트(port) + 통합 테스트(app use case) 매핑은 P02. 초안 우선순위:
- **UC2(음성)·UC3(기억)** = 인지흐름 최다 관통 → vertical 1순위 후보 (감각→지각→기억→사고→표현 1회전).
- UC1(텍스트) = 최소 관통, smoke baseline.
- UC11(자기상태) = InteroceptivePort 신설 검증.

## 기반 성숙도 (vertical 선정 1순위 기준 — 검증된 subsystem 위에 올려야)

첫 vertical 목적 = *이식 방법론이 인지흐름 1회전을 제대로 도는지* 검증. **검증 안 된 subsystem 위에 올리면 "이식 실패 vs subsystem 실패"가 섞여 vertical 이 무의미.** → 기반이 *이미 검증된* UC 를 골라 transplant 만 격리 검증.

> ⚠️ 아래 "검증" 열 = **old-naia-os *소스* 기능 검증 상태 = 이식 golden 기준선의 존재/신뢰도**. *이식 완료도 아님*(이식은 아직 0, step-1 막 닫힘). old가 known-good 이어야 이식 후 golden-trace/record-replay 로 "이식본 ≡ old 동작"을 격리 검증 가능. old에 없는 기능(memory)은 기준선 자체가 없어 vertical 불가.

> ⚠️ **실측 경고(루크 2026-06-08)**: 아래 "기준선" 열은 **아직 실제로 돌려보지 않은 추정**. "예전엔 됐다" ≠ "지금 된다". 외부 인증/키 의존 기능은 토큰 만료로 *지금 깨진* 경우가 많음(예: **Discord = 앱 인증 풀린 듯**). **vertical 선정 전 = 후보 기능을 old-naia-os에서 *실제 기동·작동 확인*(golden 기준선 확립)이 필수 선행.**

| UC | 기반 subsystem | 의존성 | 기준선 상태(실측 전 추정) |
|---|---|---|---|
| UC1 텍스트 | llm provider | 외부 키(LLM API/gateway) | 키 유효 시 작동 추정 — **실측 필요** |
| UC2 음성 | voice cascade(omni/VoxCPM2)·아바타 | gateway realtime·키·GPU | 라이브 데모 이력 있으나 **현 작동 실측 필요**(키/서버 의존) |
| UC3 기억 | naia-memory | — | ⛔ **old에 미배선**(scrubber만) — 기준선 자체 없음 → deferred |
| UC4 능동회상 | naia-memory+동기(신설)+temporal | — | ⛔ 미배선+신설 → deferred |
| UC5 도구 | weather·time·github·web | 일부 외부 키 | 혼재 — 개별 실측 |
| UC6 브라우저 | agent-browser | 로컬(webview) | 로컬 의존 낮음 — 실측 필요 |
| UC7 시스템 | workspace·pty·memo | 로컬(fs/proc) | 로컬 — 비교적 견고 추정, 실측 |
| UC8 BGM | youtube-bgm | 외부(YouTube/InnerTube) | YouTube 변동 취약 — 실측 |
| UC9 패널 | panel install | 로컬 | 실측 |
| UC10 멀티채널 | discord·slack·google-chat | **외부 앱 인증** | ⚠️ **Discord 깨진 듯(앱 인증 만료?)** — 인증 의존 전반 의심 |
| UC11 자기상태 | system-status+InteroceptivePort(신설) | 로컬 | 부분(신설 포함) |

## Vertical 순서 — 로컬·introspective foundation 먼저 (루크 2026-06-08)

**원칙: 외부 인증/키에 안 흔들리는 *로컬·자기관찰* 부터.** 외부키 의존(provider·voice·채널)은 지금 깨진 게 많아(Discord 인증 등) golden 기준선이 불안정 → 후순위. 로컬은 견고 + 진단의 렌즈.

- **★ V0 (foundation = 로컬·auth-독립·introspective 클러스터, 권고 1순위)**:
  - **UC11 자기상태(interoception)** — naia 가 *자기 상태*(설정된 provider·연결·시스템·뭐가 깨짐)를 본다. `InteroceptivePort`. **= 진단 렌즈**(다른 모든 것의 "지금 되나"를 여기서 확인). 로컬, 가장 견고.
  - **UC7 시스템(host-system)** — 로컬 fs·pty(workspace/terminal). 외부 의존 0, host-system 환경축 실증.
  - **UC12 substrate 바인딩 설정**:
    - **workspace 설정** = **naia-adk 설정**(워크스페이스/런타임 환경, AdkSetupScreen·WslSetup) + **naia 계정 / api key 설정**(naia 게이트웨이 계정·entitlement·`naia-token` + provider api key). control-plane. ※ workspace = 설정의 집이자 host-system 표면(UC7과 동일 단위).
    - **모델 설정** — *어떤 provider/model*(anthropic/openai/gemini/ollama/local/gateway — `agent/providers`) = 뇌↔reasoning substrate.
    - (+ 환경: 배경화면/공간 `EnvironmentPort` space · body: 아바타 VRM — substrate 외관축)
    - config = "뇌는 substrate 모름"을 묶음. 계정/키/provider 는 외부 의존 → **UC11 자기상태로 연결을 관찰·검증**.
  - → 로컬 3종이 첫 transplant 실증이자 기준선 인프라. 완료 시 외부키 기능들의 기준선도 *진단 가능*해짐.
- **V1: UC1 텍스트 대화** — provider 연결 검증(키 유효) 후, 얇은 cognitive-flow 1회전(Chat→사고→표현).
- **V2: UC2 음성 대화** — voice substrate 축 확장. 데모 임팩트(다슬라이스).
- **보류: UC3/UC4 기억·능동** — old 미배선 → naia-memory 통합 트랙 후.

→ **G1 에서 루크가 V0 클러스터(UC11+UC7+UC12) 범위·순서 확정.** 로컬·introspective 가 흔들리지 않는 첫 실증.

> **이식 coverage 함의**: 1단계 슬라이스의 `memory` = old 소스엔 scrubber·prompt convention(`<recalled_memories>`)만 → `accepted`(scrubber) + `deferred`(실제 store/recall = naia-memory 통합 대기). 커버리지 manifest 에 명시.

## 열린 질문 (G1 결정)
1. vertical 1순위 = UC3(기억) vs UC2(음성) vs UC4(능동)?
2. UC7(시스템 행위)을 EnvironmentPort(host-system)로 둘지 ActionPort 경계인지 (express≠act≠environment 3축 적용).
3. step-2 계약 backlog(goal-governance 소유자 등) 중 vertical 에 필요한 것 우선 계약화 순서.
