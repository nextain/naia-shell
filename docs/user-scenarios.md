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

## Vertical (5단계) 후보 — G1 에서 선정

- **후보 A: UC3 기억하는 대화** — "감각/입력 → 지각 → 장기기억 recall → 사고 → 표현" 인지 1회전. naia 핵심 차별(기억). 물리 행위 없어 desktop 으로 완결.
- **후보 B: UC2 음성 대화** — 감각(audio)→표현(음성+아바타) 전 substrate 축. 발표 데모 임팩트.
- **후보 C: UC4 능동 회상** — 가장 naia다운 "경험하고 사는" 실증이나 temporal·motivation 신설 의존 큼.

→ **G1 에서 루크가 vertical 1개 확정** + 시나리오 정확성·누락 검토.

## 열린 질문 (G1 결정)
1. vertical 1순위 = UC3(기억) vs UC2(음성) vs UC4(능동)?
2. UC7(시스템 행위)을 EnvironmentPort(host-system)로 둘지 ActionPort 경계인지 (express≠act≠environment 3축 적용).
3. step-2 계약 backlog(goal-governance 소유자 등) 중 vertical 에 필요한 것 우선 계약화 순서.
