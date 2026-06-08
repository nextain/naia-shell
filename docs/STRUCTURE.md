# naia-os 이식 구조 (1단계 산출물 — 구조 뼈대) v5 (인지흐름 재그룹핑)

> 추적: L0 미션(naia-os 전체를 헥사고날 gRPC로 이식) / 진행 단계 **1**.
> 상태: **1단계 닫힘 (루크 승인 2026-06-08).** v5 인지흐름 재그룹핑(뇌/육체/OS) · v5 적대 리뷰 R1~R7(gemini PASS·codex PASS) · 완전성 크로스체크 C1~C9(gemini 8연속 NONE, codex step-2-소유 long-tail은 바운드). physical-AI 先占 보강 완료.
> **step-2 계약 backlog(C-라운드 deferred)**: goal-governance 구현 소유자 · 포트별 메서드 시그니처 계약 · ingress 상세 매핑 · execution-id/backlink 스키마 · SafetyPort↔reactive 런타임 경계 · dependency-cruiser/composition 강제. — 전부 step-2(시나리오·계약)에서 확정.
> 승인 전 슬라이스 이식 금지(=이제 step-2 후 해제).
> 범위 주의: 1단계 = *원칙 + 슬라이스 목록 + 레이어 규칙 + 경계 포트 + 이식 메커니즘*. **파일별 정밀 분류는 슬라이스 이식 시**(2~3단계).
> 작업장·이식 메커니즘 SoT = alpha-adk `.agents/progress/new-naia-transplant-workspace-2026-06-08.md`.

## v3 → v4 핵심 변경 — 변형이 아니라 이식

골격(레이어·슬라이스·경계 포트·계약)은 v3 유지. **바뀐 것은 두 가지뿐:**

- **담는 곳**: 깨진 기존 트리를 in-place 수정 ❌ → **template clean 베이스(이 프로젝트)에 이식** ✅. 게이트 0에서 green, 통과한 이식분만 받음(deny-by-default).
- **도달법**: 출처(frozen)에서 읽기 → `cleanse-scan` → 게이트 통과 → 이 프로젝트에 담기. (근거: template 존재목적 / 과거 false-success 교훈 / Caret-Cline 선례 — 작업장 SoT §1.)

## ★ 최상위 조직 원리: 뇌 ↔ 육체 (agent ↔ shell) — AI 중심, substrate-agnostic

> 슬라이스가 "기능 단위"처럼 보이지만, 실제 추상화 축은 *기능*이 아니라 **AI(뇌) 중심**이다. naia-os 가 장기적으로 **피지컬 로봇**까지 본다면, 데스크톱 앱 기능 단위로 굳는 순간 그 사상을 표현할 수 없다.

- **agent = 뇌(brain)**: 모든 *인지·결정·기억·스킬·LLM·표현 의도*. substrate(육체)를 모른다.
- **shell = 육체(body)**: 감각기(입력) + 효과기(표현/구동) **뿐, 인지 0**. 데스크톱 아바타든 로봇이든 *교체 가능한 말단*.
- **경계 = 신경계(semantic ports)**: 구심성(afferent: 감각→뇌) + 원심성(efferent: 뇌→효과기). transport-shaped·기능결합 금지.

**하드 불변조건 (gate 강제 대상)**: **shell 에서 인지/로직 "쿵짝" 금지.** shell 이 스스로 판단·가공하면 뇌/육체 분리가 깨져 body-swap(→로봇) 불가. shell 코드 = 캡처·렌더·라우팅(어댑터)만. → 그래서 voice/avatar/panel 의 *처리·결정*은 전부 뇌(agent)로, shell 은 감각·표현 말단만(↓ 입력·표현·환경 레이어). 슬라이스(llm·memory·skill···)는 **뇌의 모듈(faculties)** 이지 데스크톱 기능이 아니다.

### naia = OS, agent = 커널/데몬 (gRPC = 시스템 인터페이스, 다중 클라이언트)

agent 의 gRPC 가 *인터페이스*라면 agent 는 "shell 의 백엔드"가 아니다 — **여러 body·app·peripheral 이 붙는 다중 클라이언트 시스템 인터페이스**(OS 의 syscall/bus). 그래서 naia 는 *앱*이 아니라 **OS**다(이름 literal).
- **agent = 커널/데몬**: always-on 뇌(naia-os "AI is always on, daemon architecture").
- **gRPC = 시스템 인터페이스**: 1:1 shell↔agent 파이프 ❌ → **다중 클라이언트**(body N + 제3환경 app N + peripheral). 클라이언트 신원 + capability negotiation(이 body=아바타+음성 / 저 body=로봇 액추에이터) + 표현 이벤트 pub/sub.
- **body·app = 클라이언트**: desktop shell·robot(body), panel/browser(app) 가 동시 다중 접속.
- **함의**: `AppPort`/`protocol` = *shell 전용 파이프*가 아니라 **OS 레벨 다중 클라이언트 계약**으로 설계. (포트 EventPort/pub-sub 가 필수인 진짜 이유 = 다중 구독자.) **step 4(gRPC) = "두 repo 사이 wire" ❌ → OS 시스템 인터페이스 설계 ✅로 격상.**

### 감각·표현·환경 → 경험 (afferent 의 목적 = 경험→기억, 반응 아님)

shell 표면을 brain/body 로 분류하고, 그것이 뇌에서 **경험**이 되는 경로 (alpha 비전 "기억하고 경험하고 살아가").

> **canon(C5 P1)**: **body = 감각기(sensor)+효과기(effector) 뿐.** **environment = body 밖 세계**(app·system·space) — shell 이 *렌더/호스트*하지만 body 아님. (로봇: body=로봇 센서/액추에이터, environment=물리 세계.)

| shell 이 제공하는 표면 | 분류 | 뇌(agent)에서 |
|---|---|---|
| 마이크 / 화면캡처(시각, capture.rs) / ref녹음 | **입력(감각·afferent → SensoryPort)** | 지각(STT·화면이해·화자/감정) → **경험(episodic)** |
| 직접 대화 텍스트 입력 | **대화(ChatPort, 감각 아님)** | conversation interaction (turn) |
| 아바타(VRM)·gesture·gaze / 음성출력·prosody | **표현(efferent)** | 표현 의도 *emit*(ExpressionPort) |
| **공간/주변**(배경·BGM·3D) + **앱 surface**(browser·note) + **시스템**(파일·프로세스/터미널·설정·디바이스) | **환경(제3)** | **양방향**: 관측(공간·앱·시스템 상태)→경험 + 행위(공간/앱/시스템 툴) |

```
감각(raw) → 지각(멀티모달 해석) → 경험(지각+자기행동+맥락+시간 융합, episodic) → 기억(naia-memory)·삶
```

- 입력 = chat 트리거 ❌ → **감각**(듣고·보고·읽음). 환경 = 도구 ❌ → naia 가 *사는 세계*(관측+행위 양방향, 패널 화면 = 시야). 표현 = 명령실행 ❌ → *존재의 발현*(같은 의도가 3D/로봇으로).
- **누락 faculty (이식 시 first-class)**: 반응형 turn(input→LLM→output)과 별개의 **지각/경험 모듈** — 감각 융합 → episodic → naia-memory. 현재 conversation(작업맥락)+memory(저장)만 있고 경험 통합 부재. 화면캡처도 tool 일 뿐 *지속적 시각 경험* 아님.
- → 뇌 모듈에 **perception/experience** 슬라이스 후보 추가(2단계 시나리오에서 구체화). 이것이 naia 를 "응답 앱"이 아니라 "경험하고 사는 존재"로 만드는 축.

## ★ 설계 가치: 인간 인지 흐름 정렬 (cognitive-flow alignment) — VTuber → physical AI

> **성공 기준 = "작동한다" ❌ → "각 모듈이 *인간 인지의 흐름*에 정렬되어 body-swap(→ physical AI)이 가능한 추상화" ✅.**
> 임의 기능 단위로 자르면 지금은 버튜버 앱처럼 보이고 거기서 끝난다. 인지 흐름에 맞춰 추상화하면 같은 뇌가 결국 피지컬 AI 로 이어진다. **"그것(인지정렬) 없이 그냥 구현하고 멈춤" = 실패 모드(명시 금지).**

인지 흐름 ↔ 뇌 모듈(슬라이스) 매핑 — 슬라이스는 *이 흐름의 단계*여야 한다:

```
감각 → 지각 → 주의 → 작업기억 ⇄ 장기기억 → 정서 → 추론/의사결정 → 의도/계획 → 표현/행위
                                                  └──────── 메타인지(자기조절) 가 전체를 가로지름 ────────┘
```
| 인지 faculty | 현 모듈(슬라이스) | 상태 |
|---|---|---|
| 감각·지각·경험 | (perception/experience=episode assembler) | **갭 — 신설 후보** (지금 conversation+memory 뿐) |
| 주의 | (attention) | **횡단 서비스** + **salience 게이트/필터**(감각 폭주 시 우선순위 — 로봇 인지 핵심) |
| 동기·욕구 | (motivation/drive·homeostasis·value) | **갭 — 신설**(always-on 자율성 근거; tasks=무엇을, 동기=왜 지속 우선) |
| 자기·신체 모델 | (self/body-affordance) | **갭 — 신설**(body-swap 전제: "이 몸이 뭘 할 수 있나") |
| 학습·적응 | (learning/policy-update) | **갭 — 신설**(memory=저장·skill=현재능력 사이 습관·선호·개인화 갱신) |
| 공간 | (world/body frame: pose·coordinate) | **갭 — 이름만이라도 先占**(panel·3D·robot 공간언어 통일) |
| 사회인지 | (other-agent model) | 갭 — 선택(화자/클라이언트 의도·권한·관계) |
| 작업기억 | conversation | 있음 |
| 장기기억(episodic·semantic) | memory(naia-memory) | 있음 |
| 정서 | (affect appraisal) | **횡단 서비스**(독립 상태, prosody 메타 아님) |
| 추론/언어 | llm/providers | 있음 |
| 절차기억(학습된 능력) | skill | 있음 |
| 의도/계획 | tasks | 있음 |
| 도구사용(확장인지) | mcp·gateway | 있음 |
| 시간·예기 | temporal(상위개념) — cron=스케줄링 구현 | 있음(명칭 명료화) |
| 발화/표현 운동 | tts/voice·ExpressionPort | 있음(표현레이어) |
| 자기조절/규범 | approval + (메타인지=드리프트 게이트) | 부분 |

→ 2단계(시나리오)에서 이 매핑으로 슬라이스 타당성 검증: 각 슬라이스가 *인지 단계*에 대응하는가, 아니면 기능 편의로 자른 것인가. 갭(지각/경험·정서·주의)은 신설 검토.

## ★ 재그룹핑 — 인지흐름 정렬 개발 구조 (v5, 기능단위 → faculty)

> 기존 12 평면 슬라이스(기능 편의)를 **인지 흐름 파이프라인**으로 재조직. 개발 단위 = faculty 그룹. (출처 인벤토리 = 아래 슬라이스 표 그대로, 단 *조직 원리*가 기능 → 인지.)

```
 ┌─ shell substrate ─ 인지 0 ─ body(감각기+효과기) + 환경 렌더/호스트(world) ─┐
 │  [body]감각기(sensors)  [body]효과기(effectors)   [world]환경(거주공간 2D/3D) │
 │  마이크·화면·키보드    아바타VRM·스피커          배경·BGM·앱·시스템(fs·proc) │
 └──────┬───────────────────────▲───────────────────────┬───────────────┘
   afferent(구심)          efferent(원심)          bidirectional(관측+행위)
  ┌──────▼─── 신경계 = gRPC OS 시스템 인터페이스 (다중 클라이언트) ───▲──┬┘
  │  SensoryPort           ExpressionPort        EnvironmentPort/PanelPort │
  │  protocol(transport-neutral) · AppPort(semantic facade)               │
  └──────┬────────────────────────────────────────────────────▲──────────┘
 ┌───────▼──── 뇌(agent/core) ── 인지 코어(faculty) ─────────────┴────────┐
 │ A. 지각·경험: perception(감각융합) → experience(episode assembler)         │  ← 신설
 │ B. 기억: working(conversation) ⇄ long-term(memory/naia-memory)            │
 │ D. 사고·결정: reasoning/language(llm/providers) · intention(tasks)         │
 │ E. 능력·도구: skill(절차) · mcp·gateway(tool) · cron(예기)                  │
 │ F. 출력(efferent) 대칭: **express**(speech/emote→ExpressionPort) + **act**(이동·조작→ActionPort) │
 │   ┄ 횡단 서비스(슬라이스 아님): attention(주의) · affect(정서 appraisal) ┄  │
 │   ⊕ 예약 lane(C1/C2 신설, 2단계 배치): 동기·욕구 · 자기/신체모델 · 학습·적응 · world/body frame · 사회인지 │
 ├──────────── 제어면(control-plane / runtime) — 인지 faculty 아님 ──────────┤
 │ 세션·신원(다중클라이언트) · transport/OS 인터페이스 · approval(규범) · 메타인지(드리프트) │
 │ **authority/arbitration**(누가 지금 몸/환경 점유·중재, 동시명령 충돌) · **safety**(e-stop·lease revoke·강등) │
 └─────────────────────────────────────────────────────────────────────────┘
```

**R1(codex·gemini) 반영 — 철학이 구조를 앞서지 않게:**
- **두 분류축 분리(codex HIGH)**: 인지 코어(A·B·D·E·F) ≠ **제어면**(세션·전송·규범·메타인지). 같은 목록에 안 섞음 — 안 그러면 구현 때 "인지 vs 시스템"으로 재분열.
- **횡단 = 슬라이스 아님(MED)**: attention·affect(정서)는 세로 슬라이스 ❌ → 여러 faculty 가 참조하는 **stateful 서비스/정책**(순환의존 방지). 정서는 ExpressionPort 메타데이터가 아니라 독립 appraisal 상태(core affect: valence/arousal).
- **개념 구분(정밀) — 감각 ≠ 정서, 타인감정 ≠ 자기정서**:
  - `감각(sensation)`(외수용: 시청각)·`지각` = **afferent**(SensoryPort→perception), affect 아님.
  - `affect(정서)` = **naia 자신의 느낌 상태**(appraisal). 감각의 *해석 결과*이며, 내수용(interoception)을 감각 성분으로 가질 수 있으나 외수용 감각 자체는 아님.
  - ⚠️ **타인 감정 *인식*(화자 prosody→감정) = 지각(perception)** ≠ **naia 자신 affect(appraisal 서비스)**. 둘을 분리(안 그러면 affect 가 perception 과 뒤엉킴).
- **experience 소유 정의(codex·gemini HIGH)**: experience = **episode assembler** — perception 읽어 episodic write-model 로 memory 에 기록. working-memory/session 을 *소유하지 않음*(쓰레기통 계층 방지). 미정 = 2단계 계약화.
- **ExpressionPort = embodiment-neutral(codex HIGH)**: 뇌는 `speak/attend/acknowledge/emphasize/emote(valence)` 같은 **의도**만 emit. `avatar state·gesture` 같은 body-specific 토큰 금지 → body 어댑터가 VRM/robot 으로 매핑. (이게 진짜 substrate-agnostic; 아니면 "아바타 일반화"에 불과.)
- **실시간 음성(MED)**: provider 확장만으로 안 닫힘 — afferent/efferent **timing**을 함께 다루는 *interaction substrate*(A↔F 횡단). 모델(provider) ↔ turn-taking(interaction) 분리.
- **★ 두 VIEW — 인지 렌즈 ≠ 이식 단위(codex HIGH/MED)**:
  - *이식 단위* = **기능 슬라이스**(출처 추적·커버리지 manifest·계약 테스트) = v4 그대로. deny-by-default 이식은 이걸로(난도·실패율 통제).
  - *인지 렌즈* = faculty 흐름 = **검증·갭탐지용 조직 관점**(이식 단위를 대체하지 않음).
  - vertical(5단계) = 인지흐름 1회전을 *기능 슬라이스 이식의 조합*으로 뚫음. 인지=*왜/어디로*, 기능슬라이스=*무엇을 어떻게 옮기나*.

## 핵심 원칙: 디렉터리 ≠ 레이어

출처 agent의 각 디렉터리는 **여러 레이어로 분화**된다. 슬라이스 = *관심사*, 레이어 분류는 이식할 때 파일 단위로.
```
gateway/   → types(ports) · tool-tiers(domain) · client(adapter) · tool-bridge(app)
providers/ → types·registry·factory(ports) · cost(domain) · 구현체(adapters)
index.ts   → transport(driving adapter) · chat-orch·tool-exec·approval·panel(app) · config(helpers)
```

## core / agent / shell 관계

- **경계 = shell ↔ agent *transport* ↔ core(use case).** "shell↔core 경계"라 부르지 않는다.
- **core(=이 프로젝트 src) 는 stdio JSON 을 직접 먹지 않는다** — `AppPort` 추상화 뒤에. ***transport-shaped(writeLine/parseRequest) 금지***. 그래야 4단계 gRPC 가 *adapter 교체만으로* 됨(core 상호작용 모델 불변).
- **AppPort = god-port 아님 (R1·R4 codex HIGH 수정)**: AppPort facade = **`ChatPort`(텍스트+voice-realtime turn-taking) + `ToolPort` 두 개의 조립 진입점일 뿐**. ⚠️ **재흡수 금지 canon**: `SensoryPort`·`ExpressionPort`(I/O), `EnvironmentPort/PanelPort`(환경), `ApprovalPort`·`ClientSessionPort`(control-plane)는 **AppPort 밑이 아니라 독립 canon 포트** — AppPort 가 이들을 빨아들이면 god-facade 복귀. 각 서브포트 독립 계약(2단계 책임선 강고정).
- **이식판에서 "agent" 의 지위 변경**: v3 에선 agent 가 in-place 로 비워지며 transport host 로 잔존했다. 이식판에선 **출처 agent = frozen 읽기 전용**이고, transport/composition host 역할은 이 프로젝트의 `app` + driving adapter 가 처음부터 담당한다(좀비 thin re-export 불필요).
- **shell**: 외관 유지(75K, 리팩터 안 함). 이식 후반에 **verbatim 편입**(레이어 분해 대상 아님). 편입 형태 = `packages/shell`(R1 수렴).
- 범위: 출처 agent ~38K(218 ts) 대상, shell 외관 유지.

### 입력·표현·환경 레이어 — shell = 어댑터, core = substrate-agnostic (루크 결정 2026-06-08)

**원칙: agent/core 는 *무엇이 입력/렌더 substrate 인지 모른다*** (데스크톱 shell · 미래의 로봇 · headless 무관). shell 은 core 로직을 갖지 않는 **어댑터 묶음** = 3 레이어. 이것이 헥사고날의 최종 보상.

1. **입력 레이어 (input)** — driving adapter: 마이크·카메라·키보드 캡처 → 입력 포트(raw 감각=`SensoryPort` / 직접 대화 텍스트=`ChatPort`). 처리는 agent.
2. **표현 레이어 (expression)** — driven adapter: **아바타(VRM 3D)·음성 출력·시각 표현**을 렌더. agent 가 `ExpressionPort` 로 **embodiment-neutral 의도**(`speak/attend/acknowledge/emphasize/emote(valence)`)만 *emit* → body 어댑터가 제 매체(VRM 표정·gesture / 로봇 액추에이터)로 매핑. ⚠️ 뇌는 `avatar state·gesture` 같은 body-specific 토큰 금지(그래야 진짜 substrate-agnostic). **3D shell ↔ 로봇 ↔ headless swap.**
   - ⚠️ 현 gap: 표현 신호가 아직 formal 포트가 아니라 voice transcript prosody 태그(`[sigh]`/`[laughing]`, shell/lib/voice/emotion-tags)로 *암묵* 처리 → 이식 시 **`ExpressionPort` 로 승격**(agent emit, 어댑터 render)해야 로봇 substrate 가 구독 가능.
3. **제3의 환경 (third environment) = naia 가 거주·운용하는 세계** — 세 종류:
   - **공간/주변**: 배경·BGM·3D scene (사는 공간의 분위기)
   - **앱 surface**: browser·note·workspace 등 (surface 위 앱)
   - **시스템(호스트)**: 파일시스템·프로세스/터미널(pty)·설정·디바이스·네트워크 — naia 가 *운용하는 머신*(코드 실측: workspace.rs·pty.rs·memo/notify-config fs). naia=OS 의 운용 대상.
   **차원/substrate 무관(body-swap 과 동형)**: 2D 패널·배경(now) → **3D 환경 UX** → 로봇=물리 공간+온보드 시스템. `EnvironmentPort` 는 차원·호스트 무관 관측+행위(2D 패널 가정 하드코딩 금지). 각 환경은 tools/skills 를 agent 에 등록 → agent 가 LLM 에 노출 + 호출 라우팅(`PanelPort`: `panel_tool_call` ↔ `PanelToolResult`). **agent 가 매개자** — 환경이 LLM 에 직접 붙지 않음(코드 실측: `panelSkillsByPanel`·`pendingPanelToolCalls`).

레이어별 귀속:
- **voice**: 입력(마이크)=입력레이어 · 출력(합성음)=표현레이어 · **모델 처리=agent provider**(omni/gemini-live/openai-realtime = LLM 동격 ws, providers registry 통일). 현재 shell/lib/voice 16파일에 갇힘 → 처리부 agent 이전. (voice-server py 브리지 = rejected.)
- **avatar**: 표현레이어(`shell/panels/avatar` VRM render adapter) ← `ExpressionPort`. 3D→로봇 swap.
- **panel/browser/background**: 제3환경, `PanelPort` 로 agent 매개.
- **설정 계층**: agent **기본설정**(ProviderConfig 등) + shell **확장설정**(디바이스·아바타·패널).

## 헥사고날 레이어 (canon = `src/main/`, R2 codex MED 확정)

> 소스 루트 canon = **`src/main/{domain,ports,adapters,app,composition}`**, 테스트 = `src/test/`. (template `src/main`,`src/test` 규약 준수 = churn 최소. `packages/core` 조기분할 X.) 아래 디렉터리는 전부 `src/main/` 하위.
> **인지/제어면 물리 분리(C1 gemini 권장)**: 인지 코어(domain/app/ports) ↔ control-plane(session·transport·approval·safety·메타인지)을 디렉터리로도 구분(예: app 하위 `cognitive/` vs `control/`) — 인지 로직과 운영 로직 혼입 방지. (구체 = 2단계.)
```
domain/    순수 값객체·규칙 (import 0)
ports/     인터페이스(계약) — domain만
adapters/  포트 구현 — ports+domain   (driving adapter = transport: protocol/stdio 포함)
app/       use case orchestration — ports만 (※ shell 경계 자체가 아님; god-layer 금지)
```
의존성 규칙(dependency-cruiser) — **모든 정적 의존은 ports/domain 으로 수렴(R3 codex MED: transport→app 충돌 제거)**: `adapters→ports→domain` · **`app→ports`**(app 은 driving 포트 `AppPort` 를 *구현* + driven 포트를 *사용*; adapters 직접 import 금지) · **`driving(transport)→ports(AppPort·protocol)`**(transport 는 app 에 정적 의존 X — app 의 AppPort 구현체는 composition root 가 주입) · orphan 0.
- **포트 방향은 관심사에 맞게 (R1 codex MED 수정)**: 이벤트 스트림이 *실제로 있는* 포트만 bidirectional(`invoke` + `subscribe/onEvent`, EventPort). 순수 요청/응답 포트는 `invoke`-only. 무차별 양방향 강제 = hollow event channel + transport 모양 역침투 → 금지.

## 슬라이스 — 뇌 모듈 12 (agent core) + 뇌↔육체 경계 슬라이스

**기능 슬라이스(= 이식 단위 / 출처 인벤토리, old-naia-os/agent)** — 인지 tier 는 ↑재그룹핑이 부여(`session`·`approval`·`transport/app-shell` = **control-plane**, 인지 코어 아님; voice = providers 확장). 이 표는 *무엇을 옮기나*(출처 추적), 인지 코어 여부는 재그룹핑 뷰가 SoT:

| 슬라이스 | 출처 | 주 레이어(분화) | 포트 |
|---|---|---|---|
| llm | providers/* | ports(types·factory) + domain(cost) + adapters(구현) | LlmPort |
| voice (provider) | **shell/lib/voice→agent** (naia-omni·gemini-live·openai-realtime·vllm-omni) | providers 확장/분기(ws adapter) — 처리는 전부 agent | LlmPort 계열 |
| tts | tts/* | adapters | TtsPort |
| memory | memory-scrubber(domain, ✅존재) — **store/recall bridge 미배선**(old-naia-os baseline 단순화로 끊김) | adapters + domain | MemoryPort (scrubber=accepted / store·recall=**deferred**=naia-memory 통합 트랙) |
| skill | skills/built-in/*, loader | adapters(loader) + app(빌트인=gateway proxy 응용) | SkillPort |
| gateway | gateway/* | ports(types)+domain(tool-tiers)+adapters(client)+app(tool-bridge) | GatewayPort |
| mcp | mcp/* | adapters | McpPort |
| cron(temporal) | cron/*(scheduler·store·테스트 존재) — ⚠️ index.ts 미배선·gateway 의존(동작 검증은 Old-Baseline 측정) | adapters + domain | CronPort |
| tasks | tasks/*(JobTracker) | domain(수명주기) + app | — |
| conversation | conversation/*(token-budget·context-limits) | domain | — |
| session | local-sessions(fs+path-resolver) | adapters(저장) + SessionPort | SessionPort |
| approval | index.ts 승인흐름, approval-bridge | app(+ApprovalPort) | ApprovalPort |
| transport/app-shell | index.ts(1384), protocol-bridge | driving adapter(transport) + app(chat-orch·tool-exec) + AppPort facade 조립 | **AppPort(semantic)** |

**뇌↔육체 경계 슬라이스 (처리·결정=agent / 말단=shell body)**:

| 슬라이스 | 뇌(agent) 측 | 육체(shell) 측 | 포트 |
|---|---|---|---|
| panel (제3환경) | panel.ts(install)·`panelSkillsByPanel`·tool 라우팅(`pending…ToolCalls`)·protocol panel 타입 | panels/ UI·browser/pty(rust) 렌더 | **EnvironmentPort.app-surface**(구 PanelPort: panel_tool_call↔result) |
| avatar (표현) | embodiment-neutral 의도 *emit*(speak/emote(valence)/attend…); affect 서비스가 valence 제공 | panels/avatar VRM(AvatarCanvas/VrmPreview)가 의도→표정·gesture 매핑 | **ExpressionPort** (3D↔robot swap) |
| **body action (행위, 예약 C8)** | action use case(C3 소유)가 비표현 행위 의도 emit | (현 desktop=없음) → robot=액추에이터 어댑터 | **ActionPort** (표현중심 편향 방지 placeholder) |

**이식 제외 (rejected)**: `voice-server/`(py minicpm-o 브리지) = 죽음 확정(증거 = 미해결 Q3). 커버리지 manifest `rejected`. · 음성 *인터페이스*(마이크 캡처·재생·ref녹음)·아바타 렌더·패널 UI = shell body 잔류(core 슬라이스 아님).

## 경계 계약 (boundary contract — 1단계에 못 박음, 미정 아님)

> ⚠️ R1 리뷰 수정(codex·gemini 수렴, HIGH): 계약 소유권이 transport(adapter)에 있으면 의존성 역전(DIP)이 깨지고 계약 SoT가 둘이 된다. 아래로 교정.

- **두 계약을 레이어로 분리, 단일 의존 방향**:
  - `ports/protocol` = **transport-neutral semantic 경계 payload**(shell↔agent 가 주고받는 *의미* 구조). **ports 레이어 소유**(adapter 아님). ⚠️ **불변조건(R2 codex MED)**: protocol DTO 에 wire-framing(JSON 라인·길이 prefix·gRPC 메시지 등) 누출 금지 — 직렬화/프레이밍은 *transport adapter 만* 안다. 그래야 stdio→gRPC = adapter 교체만으로 끝남.
  - `AppPort` = **내부 semantic 유스케이스 포트**(아래). ports 레이어 소유.
  - **매핑 규칙**: transport(driving adapter)가 `protocol` DTO ↔ `AppPort` 호출을 **번역**한다. 의존 = `transport(adapter) → ports(protocol, AppPort)`. core/app 은 wire DTO 를 절대 모른다.
- `protocol-bridge.ts` / `approval-bridge.ts` = 각 슬라이스의 driving/경계 **adapter**(계약 소유 아님, 위 ports 계약을 구현/번역).
- 효과: wire 포맷(stdio→gRPC) 교체 = transport adapter 만 교체, ports·core 불변. 계약 SoT 충돌 제거.

### 포트 canon — 전 경계를 한 표에 (R2 codex HIGH: prose→canon 승격)

> 1단계 = 포트의 **이름·방향·소유 tier** 를 canon 으로 못 박음(SoT 단일화, AppPort 우산 재흡수 방지). **전체 메서드 계약(시그니처)은 2단계**(시나리오 기반) — step-1 에서 full 계약까지 요구 = 범위 초과(gemini·codex 공통: 2단계 계약화).

| 포트 | 방향 | 소유 tier | 역할 | 계약 깊이 |
|---|---|---|---|---|
| `protocol` | — | ports | transport-neutral wire DTO | 1단계(불변조건) |
| `AppPort` facade → `ChatPort`·`ToolPort` (이 둘만) | bi | ports | **conversation·tool interaction 전용**(범용 이벤트 허브 아님). canon 명: 서브포트 = `ChatPort`/`ToolPort`, `AppPort`=조립 facade | 1단계 골격 |
| `ApprovalPort` | bi | **control-plane** | 승인/규범 게이트 (AppPort 밑 아님) | 1단계 골격 |
| `SensoryPort` | afferent(in) | ports | **외수용 raw 감각**(audio·vision·screen·관측 텍스트) → perception. *대화 텍스트 아님* | 2단계 |
| `InteroceptivePort`(신설, C1) | afferent(in) | ports | **내수용**(내부 생리/시스템: 배터리·부하·열·자기 처리상태) → affect 기반 | 2단계 |
| `ProprioceptivePort`(신설, C2 정정) | afferent(in) | ports | **고유수용/자세감각**(pose·관절·균형) → self/body model·world frame. *내수용과 별개* | 2단계 |
| `ExpressionPort` | efferent(out) | ports | embodiment-neutral **표현** 의도(speak/emote-valence/attend) | 2단계 |
| `ActionPort`(신설, C1; canon 명 1개 — C4: EmbodimentPort 별칭 폐기) | efferent(out) | ports | **비표현 행위**(이동·조작·파지) — *express ≠ act* 대칭축. avatar=express, robot=act 같은 자리 | 2단계 |
| `EnvironmentPort`(상위) — capability family: **`space` / `app-surface` / `host-system`** | bi | ports | **환경 관측(상태)** + 행위. ⚠️ **`PanelPort` = `app-surface` sub-capability (1급 포트 아님, C6 lock)** — 문서 내 "PanelPort" 표기는 전부 이 sub-port | 1단계 골격 |
| `ClientSessionPort`(multi-client) | control bi (not domain-facing) | **control-plane** | client 신원·capability negotiation·subscription lifecycle + **body/env lease 취득·양도·충돌 중재 owner**(C5: arbitration 정식 소유, 산발 방지) | 2~4단계 |
| `SafetyPort`(신설, C1) | control | **control-plane** | safety envelope·e-stop·lease revoke·강등 모드 (approval 로 안 닫히는 물리 행동 중지) | 2~4단계 |

**출력 3축 고정(C2 P3)**: `ExpressionPort`=의미를 *드러냄* / `ActionPort`=*body를 움직임* / `EnvironmentPort`=*body 밖 세계를 바꿈*. (panel/tool/robot 경계 단순화.)

**관측 ingress 소유(C4 HIGH)**: `SensoryPort`=**raw 외수용 신호**(오디오 파형·카메라/화면=*이미지(vision)*). `EnvironmentPort`=**구조화된 환경 상태**(panel/browser/system 의 *자기보고* — BGM context·파일목록·프로세스 상태 등)의 관측+행위. → 화면 픽셀=Sensory(시각), 앱/시스템 보고 상태=Environment. (PanelPort 관측 half = EnvironmentPort observe.)

**provenance 불변식(C4 MED)**: 모든 afferent/efferent/episode/tool event 에 **actor/client id + 귀속 body·env** 전파. + **execution correlation id(C8)**: efferent 3축 공통, `commanded→acknowledged→observed→mismatch` 를 다중클라이언트·중단·재시도에서 1:1 상관. **reafferent backlink(C9)**: Sensory/Environment 관측 이벤트도 "어느 execution 을 관측한 것인지" id 를 실어 mismatch 계산이 포트별 ad-hoc 로 새지 않게. multi-client arbitration·사회인지·episodic attribution("누가 했나/누구에게")의 공통 근거 — 없으면 후반 재분기.

**efferent 계약 원칙(C1 필수 — physical-AI 先占)**: **출력 3축 전부(Express/Action/Environment, C6 대칭)**가 **async + interruption + reafference** 계약. 환경 변경(app-surface/host-system/world)도 같은 실행 수명주기·관측 귀결을 가져야 agency·episode attribution·mismatch 학습이 비대칭으로 비지 않음. 아바타=즉시 렌더지만 로봇 액추에이터=지연·중도중단. **결과 4단계(C2 P2 reafference)**: `commanded → acknowledged → observed(실제 감각 재유입) → mismatch`. 의도만 emit하고 *관측된 결과* 비교가 없으면 "의도한 것/실행된 것/실제 일어난 것"이 안 갈려 agency·오류학습·자기교정 약화. 동기 가정 하드코딩 금지. **상태머신 소유(C3 P1)**: app 의 action use case 가 소유, `observed/mismatch` → experience(episode)가 "내가 한 것"으로 묶음(중복 소유 금지).

**goal governance(C2 P1 — 1줄 先占)**: goal/intention 의 생성·덮어쓰기 **권한 분리** = `request / propose / authorize / veto`. 내적 동기·사용자 명령·외부 app 요청·safety override 가 전부 tasks 로 몰려 우선순위 충돌하는 것 방지. **소유(C9): control-plane 의 별도 governance lane**(approval=개별 행위 승인과 구분). **충돌 precedence(C3 P1)**: `safety > reactive hold/e-stop > authority lease > authorized goals`. **소유 분리(C9)**: 정책·권한 발동 = `SafetyPort` / 즉시 실행·유지 루프 = reactive path(중복 금지).

**reactive 저지연 경로 예약(C2 P2 — 先占)**: 흐름이 전부 deliberative(reasoning/tasks 경유)면 physical AI 에서 늦음 → safety/action 아래 **reactive loop 예약**(충돌회피·자세안정·e-stop 정지유지)은 인지 우회 저지연 경로.

- **session 단일 소속(R2 codex PARTIAL)**: 세션·신원 = **control-plane**(OS), *인지 faculty 아님*. 기능 슬라이스 `session`(local-sessions)은 그 control-plane 의 저장 adapter — 인지 코어에 중복 배치 금지.
- **experience 쓰기 불변식(R2 PARTIAL)**: experience(episode assembler)는 `MemoryPort` 에 **episodic record append 만**(write-model 소유). conversation/session 에 쓰지 않음. 전체 write 계약 = 2단계.
- **interaction substrate 배치(R2 MED)**: 실시간 turn-taking timing = **app 레이어** 소유, `ChatPort`(AppPort facade)로 노출. provider(모델)와 분리 — provider=무엇을, interaction=언제(타이밍).
- **ingress 소유 경계(R5 codex HIGH) — Chat vs Sensory 중복 제거**: `SensoryPort` = **raw 감각 신호**(오디오 파형·화면·관측 텍스트) → perception(STT·prosody·화자). `ChatPort`(AppPort facade) = **대화 상호작용**(의미 턴 + turn-taking 조율), raw 오디오를 먹지 않음. → 음성 발화: *오디오*는 Sensory(청각)로 들어와 perception, *대화 턴 구조/타이밍*만 Chat. 텍스트: 사용자 *직접 입력* = Chat / 화면·환경 *관측* 텍스트 = Sensory. (구체 ingress 매핑 = 2단계 시나리오.)

## 이식 메커니즘 (deny-by-default, 슬라이스 단위)

각 슬라이스마다:
1. **출처(frozen)에서 읽기** — old 트리 수정 0.
2. **소스 인벤토리 작성 (R1 codex HIGH 수정 — false-success 방지 핵심)**: 출처 슬라이스의 export·심볼·동작을 열거 → 각 항목 `accepted | deferred | rejected(+사유)` 로 분류한 **커버리지 manifest**. 게이트는 "들어온 것의 정합"뿐 아니라 **"인벤토리 100% 처분됨(미분류 0)"**을 강제 → 일부만 옮기고 green 나는 것 차단.
3. `scripts/cleanse-scan.mjs` 로 군더더기·죽은코드 식별.
4. 헥사고날 레이어로 분해 → 이 프로젝트에 **이식**.
5. `scripts/conform/manifest.json` 에 계약↔코드 region 등록(빈 manifest=inert 에서 채워감).
6. 계약 테스트(port) + 통합 테스트(app) 작성·통과.
7. **conform 게이트 + 커버리지 manifest(미분류 0) 통과해야** commit(3회 연속 드리프트면 차단).
8. 이식하며 얻은 **일반화 패턴만** template 로 환류. **"Template Reusable Unit" 판정 (R1 gemini MED 수정)**: naia-os 전용 식별자·도메인 결합이 없는지 검증 통과분만 환류(template 오염 방지).

**추가 안전장치 (C1 완전성 — gemini 필수·codex 권장):**
- **계약 테스트 先행 게이트(필수)**: port 계약 테스트 미작성 시 게이트 fail = commit 차단. "이식 성공 후 테스트 후행" 금지(헥사고날 유지).
- **golden-trace / record-replay 게이트(권장)**: 커버리지 manifest 는 *누락*은 잡아도 *"옮겼는데 행동이 달라짐"*은 못 잡음 → 대표 시나리오 트레이스 기록·재생으로 행동 등가 검증.
- **semantic permission matrix(권장)**: 포트 capability 존재만이 아니라 "어떤 faculty/app 이 어떤 환경/행위 포트를 호출 가능"한지 **deny-by-default** 고정(privilege creep 방지).

## 테스트 구분 (완료조건)
- **계약 테스트** = port 인터페이스(모든 어댑터 만족) / **통합 테스트** = app 오케스트레이션.
- 슬라이스 이관 완료조건 = 출처 테스트 → (해당) 계약/통합 테스트 전환 + 통과.

## composition root (R1 gemini HIGH 수정 — 단일 root 강제)
- 와이어링은 **`src/main/composition/` 1곳에만**. src/ 전역 분산 금지(헥사고날 '단일 구성' 이점 상실).
- 각 슬라이스는 와이어링 로직을 노출하지 않고 **Factory/Registry 포트만** 노출 → composition root 가 그것들을 주입.
- 의존: driving adapter 진입 → app use case 호출 → ports 통해 adapters 주입.

## 미해결 → R1 리뷰 결과 (codex·gemini)

- **Q2 shell 편입 = 해소(수렴)**: `pnpm workspace + packages/shell` verbatim. (양 AI 동의: "외관 유지" + 통합 빌드 + 4단계 프로세스 분리 선제.)
- **Q4 standalone naia-agent = 해소(수렴)**: 4단계까지 동결, agent 는 이 프로젝트 `src/` 내부 슬라이스로 유지(Port/Adapter 분리 연습장). repo 경계는 1단계 밖.
- **Q1 소스 루트 배치 = 확정(R2)**: **`src/main/{domain,ports,adapters,app,composition}` + `src/test/`** (template 규약 준수, codex 권고). `packages/core` 조기분할 X. → 단일 composition root 물리 경로 = `src/main/composition/`.
- **Q3 = 해소(grounding 으로 가짜 이분법 분해, 루크 결정 2026-06-08)**:
  - **voice-server (py minicpm-o) = 죽음 확정 → `rejected`(미이식)**. 증거: 라이브 참조 0(테스트 fixture 문자열·문서뿐), `:8765` 참조 0, 빌드/기동 스크립트 0, 마지막 손댐 2026-03-30 #177(음성 아닌 base 이미지 부수). 현 라이브 음성 = 외부 vLLM/gateway realtime.
  - **voice 처리 = agent provider 확장/분기**: omni/gemini-live/openai-realtime = 일반 LLM 동격(ws). 마이크 의존이라 *인터페이스*는 shell(UI)이나 *내부 처리는 전부 agent 가 관리* = agent providers 의 확장/분기(LlmPort 계열). shell→agent 이전.
  - **원격 naia gateway service = 외부 capability**(`GatewayPort` + client adapter, 원래 외부). **naia-os/gateway 채널어댑터(Discord·GoogleChat) = 라이브러리**. 우리 서비스 **프로세스 토폴로지 = 4단계**.

## 슬라이스 리뷰 메모 (R1 MED, 이식 시 유의)
- `tasks`·`conversation` 은 현재 포트 없음(domain/app 내부) — persistence/scheduler/telemetry 와 닿는 순간 포트 신설(경계 지연 시 app 응집도 붕괴).
- `skill` = "builtin=gateway proxy 응용"이라 skill 정책 ↔ gateway 호출 책임선이 흐려질 수 있음 → 이식 시 `SkillPort`/`GatewayPort` 경계 명확화.

## 다음 (2단계)
구조 승인 후 → 사용자 시나리오 분류 리스트 + glossary(G1, 가장 강한 휴먼 게이트). 시나리오가 위 슬라이스를 어떻게 관통하는지로 첫 vertical(5단계) 선정.
