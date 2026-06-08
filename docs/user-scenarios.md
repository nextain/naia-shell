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
| **UC7a 시스템 관측(read-only)** | 파일/프로세스 *상태 조회*(변경 X) | Chat → 사고 → 환경 관측 | EnvironmentPort(host-system) observe |
| **UC7 시스템 조작(mutating)** | 파일 편집·명령 실행 + **결과 관측**(reafference) | Chat → 사고 → 환경 행위 → observed→mismatch | EnvironmentPort(host-system) + reafference |
| **UC8 공간 분위기** | "음악 틀어줘"(BGM) | Chat → 사고 → 환경 변경(space) + 관측(BGM context) | EnvironmentPort(space)·youtube-bgm skill |
| **UC9 패널 앱** | 패널 설치→그 앱 스킬 사용 | Chat → 능력(panel install) → 환경(app-surface tool) | skill(panel)·EnvironmentPort.app-surface |
| **UC10 멀티 채널** | discord/slack 에서 naia 응답 | (외부 채널 ingress, 다중 client) → 사고 → 표현(채널) | ClientSessionPort·gateway·channels |
| **UC11 자기상태 인지** | "너 지금 상태 어때?"(system-status/진단) | **내수용**(시스템 상태) → 지각 → 표현 | InteroceptivePort·system-status·ExpressionPort |
| **UC12 온보딩/설정** | 첫 실행 wizard·키 설정 | (control-plane: 설정·신원) | control-plane(session)·config |
| **UC13 승인 게이트** | 위험 행위 전 사용자 승인 | 사고 → **승인**(규범) → 행위 | ApprovalPort·control-plane |
| **UC13a 실행 중 중단/취소/e-stop** (신규) | 돌아가는 browser/pty/system 작업을 끊음·회수 | (저지연) 중단·lease revoke·강등 | **SafetyPort**(≠Approval)·reactive path |
| **UC10a 다중 클라이언트 점유 충돌** (신규) | Discord·로컬 UI 동시 명령 → owner·lease·handoff·revoke | (control-plane 중재) | ClientSessionPort(lease/arbitration) |
| **UC12a 설정 검증** (신규) | "키 저장됨"이 아니라 *provider/계정 연결 상태를 자기상태에서 관측* | 내수용 → 진단 | InteroceptivePort·system-status |
| **UC14 graceful degradation** (신규) ★ | 외부 인증/키 깨짐(Discord 등)을 **감지·보고·대체** | 내수용(실패 감지) → 지각 → 표현(정직 보고) | InteroceptivePort·ExpressionPort |

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

## Foundation tranche + vertical 순서 (R1 codex·gemini 반영)

**원칙: 외부 인증/키에 안 흔들리는 *로컬·read-only·introspective* 부터, 얇게 쪼개 결함 격리.** (V0를 "클러스터"로 묶으면 실패 시 interoception/host-adapter/setup/auth 중 어디인지 분해 불가 → 번들 금지.)

**Foundation tranche (얇은 순차 단계, read-only→mutating):**
- **F0 (전제조건, vertical 아님): UC12-min 로컬 최소 설정** — naia-adk workspace 최소(외부 키 없이 부팅 가능분). control-plane init. *인지흐름 아님 = vertical 분류 제외.*
- **F1: UC11 + UC14 자기상태 진단(read-only, afferent-only)** — naia 가 자기 상태(설정·연결·시스템·**뭐가 깨짐**) 관측·보고. `InteroceptivePort`. **= 진단 렌즈**. ★ 깨진 외부인증(Discord 등)을 *정직하게 감지·보고*하는 능력을 **golden-trace 첫 성과물**로(깨진 상태를 무시 말고 진단으로 활용).
- **F2: UC7a 시스템 관측(read-only)** — host-system 상태 조회(변경 X). 가장 안전한 첫 환경 이식.
- **F3: UC7 시스템 조작(mutating)** — Action→Environment→**observed→mismatch**(reafference) 완결. = 얇지만 완전한 cognitive 1회전(첫 efferent+reafferent 실증).

**그 다음 (외부 의존, F1 자기상태로 연결 검증 후):**
- **V1: UC1 텍스트 대화** — provider 키 유효 확인 후 Chat→사고→표현.
- **V2: UC2 음성 대화** — voice substrate 축 확장(다슬라이스, 데모).
- **OS-core (P01 필수, 시점 G1):** UC10a 다중 클라이언트 lease/handoff/revoke · UC13a stop/e-stop/revoke. — 부가 아니라 OS성 핵심.
- **보류: UC3/UC4 기억·능동** — old 미배선 → naia-memory 통합 트랙 후.

→ **G1 에서 루크가 F0~F3 순서 + OS-core(UC10a/13a) 포함 확정.** "가장 안전한 vertical"이 아니라 *얇게 쪼갠 foundation tranche*.

## golden 기준선 — 1회 smoke ≠ golden (R1 codex)

외부 인증/모델/YouTube/Discord 는 drift source. baseline 에 함께 **freeze**: `입력 trace` + `출력 trace` + `설정/버전/키 상태` + `실패 분류(인증 실패 vs 제품 버그)`. 안 그러면 "old 가 오늘 운 좋게 됨"을 canonical 로 오인. (UC14 가 인증실패 분류를 담당.)

**Old-Baseline 측정 = P02 전제조건 단계(R2 gemini)**: vertical/foundation 후보 기능을 *old-naia-os 에서 실제 구동* → 위 4종 스냅샷 생성. 이 측정 없이 P02 테스트 매핑 금지. ("작동 안 함"이 정상 baseline 일 수 있음 — 측정으로 확정.)
**F1 InteroceptivePort 최소 스펙(R2 gemini)**: old 에 통합된 형태가 아님(신설) → F1 에서 **read-only 최소 인터페이스부터** 정의(이식 첫 난관 최소화).

> **이식 coverage 함의**: 1단계 슬라이스의 `memory` = old 소스엔 scrubber·prompt convention(`<recalled_memories>`)만 → `accepted`(scrubber) + `deferred`(실제 store/recall = naia-memory 통합 대기). 커버리지 manifest 에 명시.

## 열린 질문 (G1 결정)
1. Foundation tranche 순서 F0(설정-min)→F1(자기상태 read-only)→F2(시스템 관측)→F3(시스템 조작) 확정?
2. OS-core(UC10a 다중클라이언트 lease·UC13a stop/e-stop)를 P01 에 지금 넣을지, 시점은?
3. ~~UC7 포트 축~~ = **해소(R1)**: host-system = `EnvironmentPort`(body 밖 세계), `ActionPort`=body movement. UC7 = EnvironmentPort.
4. step-2 계약 backlog(goal-governance 소유자 등) 중 foundation tranche 에 필요한 것 우선 계약화 순서.
5. notify/memo(non-memory) 계열 독립 UC 필요 여부 — old 실측 확인 후.
