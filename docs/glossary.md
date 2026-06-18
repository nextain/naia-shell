# 워드사전 (glossary) — 2단계 산출물 (초안)

`[Phase 02]`

> 추적: 1단계 `STRUCTURE.md` v5 · 2단계 P01. **상태: 초안 — G1 대기.** 용어 통일 = 드리프트 방지.
> 신조어 금지(평이한 용어 + 학술/약자는 "한국어 (원문)" 1회) — 루트 terminology 정합.

## 최상위 (조직 원리)

| 용어 | 정의 |
|---|---|
| **뇌 (brain) = agent** | 모든 인지·결정·기억·스킬·LLM·표현 의도. substrate(육체)를 모름. |
| **육체 (body) = shell 의 일부** | 감각기(sensor)+효과기(effector) **뿐**, 인지 0. 데스크톱↔로봇 교체(swap). |
| **환경 (environment)** | body 밖 세계 — 공간(배경·BGM·3D)·앱 surface(브라우저·터미널·workspace)·시스템(host). shell 이 렌더/호스트하나 body 아님. **도구도 대부분 환경**(에이전트의 기관이 아니라 작업 대상 세계). |
| **사이드카 (sidecar)** | 환경의 실현 형태 — shell(substrate)이 소유하는 독립 서비스로, 뇌(agent)와 무관히 동작·생존. Rust in-process(터미널·파일) 또는 별도 프로세스(youtube·브라우저 CDP, 외부 런타임 필요 시). 코드·deps 는 셸 쪽, 뇌는 intent 만. SoT=`brain-body-environment.md`. |
| **신경계 = semantic ports** | 뇌↔육체↔환경 경계. 구심(afferent)·원심(efferent). transport-shaped 금지. |
| **naia = OS** | agent=커널/데몬, gRPC=다중 클라이언트 시스템 인터페이스(shell 백엔드 아님). body·app·peripheral 이 client. |
| **substrate-agnostic** | 뇌가 입력/표현/환경 substrate(2D·3D·로봇·물리)를 모름 → 의도/관측만 다룸. |

## 인지 흐름 (faculty)

| 용어 | 정의 |
|---|---|
| **감각 (sensation)** | 외수용 raw 신호(audio·vision·screen). `SensoryPort`. ≠ 정서. |
| **내수용 (interoception)** | 내부 생리/시스템 상태(배터리·부하·열). `InteroceptivePort`. affect 기반. |
| **고유수용 (proprioception)** | 자세·관절·균형. `ProprioceptivePort`. self/body model·frame. |
| **지각 (perception)** | 감각 해석(STT·화면이해·타인 감정 인식). |
| **경험 (experience)** | perception+자기행동+맥락+시간 융합 → episodic. **episode assembler**(memory 에 episodic append, working-mem/session 비소유). |
| **정서 (affect)** | naia *자신*의 느낌(core affect: valence/arousal). 횡단 서비스. ≠ 감각, ≠ 타인감정 인식(지각). |
| **주의 (attention)** | salience 게이트/필터(감각 폭주 우선순위). 횡단 서비스. |
| **작업기억 / 장기기억** | conversation(현 맥락) / memory(naia-memory, episodic·semantic). |
| **동기 (motivation)** | 욕구·항상성·가치 — always-on 자율성 근거(왜 지속 우선). 신설 예약. |
| **자기·신체 모델 (self/body-affordance)** | "이 몸이 뭘 할 수 있나"(body-swap 전제). 신설 예약. |
| **학습·적응 (learning)** | memory↔skill 사이 습관·선호·개인화 갱신. 신설 예약. |
| **메타인지 (metacognition)** | 드리프트 게이트(자기조절). control-plane. |

## 출력 3축 (efferent)

| 용어 | 정의 |
|---|---|
| **표현 (express)** | 의미를 *드러냄*(발화·감정·제스처 의도). `ExpressionPort`, embodiment-neutral. avatar=express. |
| **행위 (act)** | *body를 움직임*(이동·조작·파지). `ActionPort`. robot=act. |
| **환경 변경** | *body 밖 세계를 바꿈*(app/system/space). `EnvironmentPort`. |
| **reafference** | `commanded→acknowledged→observed→mismatch` — 의도/실행/실제 분리(agency·오류학습). |
| **efference copy** | 행동 의도 사본 → 결과 피드백을 experience 가 "내가 한 것"으로 묶음. |

## 포트 canon

| 용어 | 정의 |
|---|---|
| **AppPort** | `ChatPort`+`ToolPort` 조립 facade(대화·툴 interaction 전용). 다른 포트 재흡수 금지. |
| **ChatPort** | 대화 상호작용(텍스트+voice-realtime turn-taking). raw 오디오 아님. |
| **protocol** | transport-neutral wire DTO(직렬화는 transport adapter 만). |
| **ClientSessionPort** | (control-plane) client 신원·capability negotiation·subscription + body/env lease·arbitration owner. |
| **SafetyPort** | (control-plane) safety envelope·e-stop·lease revoke 정책/권한 발동. (즉시 실행=reactive path.) |

## 이식·거버넌스

| 용어 | 정의 |
|---|---|
| **이식(transplant) vs 변형** | frozen old → cleanse-scan → 게이트 통과분만 clean new 에 담기(deny-by-default). in-place 변형 ❌. |
| **커버리지 manifest** | 출처 인벤토리 전수 `accepted/deferred/rejected`(미분류 0 강제 = false-success 차단). |
| **두 VIEW** | 이식 단위=기능 슬라이스(출처 추적) ≠ 인지 렌즈(검증·갭탐지). |
| **provenance / execution-id** | 모든 event 에 actor/client id + 귀속 body·env; efferent correlation + reafferent backlink. |
| **goal governance** | goal 생성·덮어쓰기 권한 `request/propose/authorize/veto`(control-plane governance lane). |

> 미정·신설 항목의 정식 계약 = step-2 진행 중 채움. G1 에서 누락 용어·정의 충돌 검토.
