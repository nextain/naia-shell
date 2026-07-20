# 조립 매트릭스 (assembly matrix) — 이식·보충·수직·수평 전수 추적 SoT (2026-06-10, v2)

> **목적 = drift/드롭 방지 anchor.** v1이 "자리만" 적고 미분류 0을 거짓 주장(codex HIGH) → v2는 **UC1~14 + S01~71 전수 분류**(미분류 0 *기계 강제* via `scripts/check-assembly-coverage.mjs`). AI 판단 못 믿음 → 결정론 체크가 앵커([[project_drift_detection_anchor_thesis]]).
> 진실=사용자 시나리오(UC); 옛 동작은 *맞던 곳만* 참조.

## 축 (직교 — 둘 다)
- **수직=UC** / **수평=포트 canon 전체(시스템 인터페이스, 다중 클라이언트)**.
- **이식**(옛것 맞게 돎)/**보충**(없거나 깨짐)/**rejected**(이식 제외).
- **권위**: `old-auth`(옛 *관측 행동* 기준, 구조는 인지 포트 재표현) / `scenario-auth`(UC 기준, 옛것과 달라도 됨).
- **인지 포트 매핑 + fit**: clean / **mismatch**(1급 표면화) / 미평가.

## 현재 활성 슬라이스
- **활성 = UC1** (텍스트 대화). 활성 슬라이스의 fit=미평가 backlog 는 check 가 *가시화*(영구 은닉 금지, GLM 3차 C-1). 진전 없이 무한 pending 금지 — 활성은 항상 명시.

## fit 게이트 (이빨 — codex HIGH 정정)
- `미평가`는 **상태 ∈ {pending, 계약} 에서만 허용.** 상태를 `코드`/`검증`으로 올리려면 fit ∈ {clean, mismatch-resolved} **필수**. 즉 **미평가인 채 슬라이스 done 금지.**
- `mismatch` 발견 = 행에 **해결경로 명시**(=(a) UC 인지흐름 재매핑 / (b) 수평 갭 재검토) + 미해결 시 그 슬라이스 commit 차단.
- **기계 강제**: `scripts/check-assembly-coverage.mjs` = ① user-scenarios의 모든 UC/S가 이 표에 있나(미분류 0) ② 상태≥코드인데 fit=미평가인 행 0. 위반=비0 exit.

---

## 수평 트랙 — 포트 canon 전체 (다중 클라이언트·다중 UC 공통, AppPort 재흡수 금지)
| # | 포트/배선 | 역할 | old | 이식/보충 | 권위 | 상태(slice) |
|---|---|---|---|---|---|---|
| H-proto | `protocol` | transport-neutral 의미 DTO(직렬화 누출 금지) | △산재 | 보충 | scenario | 부분(F0)·일반화 필요 |
| H-tx | transport 어댑터 | stdio(now)→gRPC(목표), 어댑터 교체 | O(stdio) | 이식+보충 | old(stdio)/scen(gRPC) | pending |
| H-client | `ClientSessionPort` | 다중 클라이언트 신원·lease·arbitration | △ | 보충 | scenario | pending(UC10a) |
| H-safety | `SafetyPort` | e-stop·lease revoke·강등(reactive) | △ | 보충 | scenario | pending(UC13a) |
| H-app | `AppPort`(=ChatPort+ToolPort *조립 facade*, 재흡수 아님) | facade | △ | 보충 | scenario | pending |
| H-chat | `ChatPort` | 대화 ingress(독립) | O transport동작·**추상화 없음**(shell↔Tauri 직결) | 이식(흐름)+보충(추상화) | old-auth(흐름) | pending(UC1) |
| H-tool | `ToolPort` | 툴 interaction(독립) | △직접호출 | 보충 | scenario | pending(UC5) |
| H-sensory | `SensoryPort` | 감각(audio/vision/screen) | O(부분) | 이식+보충 | mixed | pending(UC2/61) |
| H-intero | `InteroceptivePort` | 내수용(시스템 상태) | O | 이식 | old | **F1 계약+코드** |
| H-express | `ExpressionPort` | 표현(speak/emote, embodiment-neutral) | △(UI직결) | 보충 | scenario | pending(UC1/2) |
| H-env | `EnvironmentPort`(observe/act/space/app-surface/host) | 환경 관측·행위 | O | 이식 | old | **F2(observe)+F3(mutate) 계약+코드**; app-surface/space pending |
| H-approval | `ApprovalPort` | 승인 게이트+결속 | O(부분) | 이식+보충 | mixed | **F1 계약+코드** |
| H-proprio | `ProprioceptivePort` | 고유수용(자세·관절·self/body model) | △ | 보충 | scenario | pending(2단계·로봇) |
| H-action | `ActionPort` | 행위(body 이동·조작·파지) | △ | 보충 | scenario | pending(2단계·로봇) |
| H-cron | `CronPort` | temporal 작업 스케줄 | △(미빌드) | 보충 | scenario | pending(2단계) |
| **H-agent** | **agent(brain)↔os 연결** | stdio JSON-line(send_to_agent_command↔agent_response) | **기본 chat=O 동작(이식)**; 깊은 통합(memory/context)=보충 | 이식(chat I/O)+보충(deep) | old-auth(chat)/scenario(deep) | chat 동작·**ChatPort 추상화 없음** |

> ⚠️ v1처럼 "protocol→AppPort 단일경로"로 좁히지 않음. AppPort=Chat/Tool 하나일 뿐, 나머지 포트는 독립(canon: Sensory·Interoceptive·**Proprioceptive**·Chat·Express·Environment·**Action**·Approval·ClientSession·Safety·Cron). 다중 클라이언트=H-client. (GLM 3차: Proprioceptive·Action·Cron 누락 정정.)

---

## 수직 UC 트랙 — UC1~15 전수 (분류; UC1 상세)

| UC | 이식/보충 | 주 인지포트 | 권위 | slice/상태 |
|---|---|---|---|---|
| **UC1** 텍스트대화 | **이식**(채팅 동작)+보충(ChatPort 추상화) | Chat→agent→Express | old-auth(흐름) | ↓ 상세 |
| UC2 음성대화 | 이식+보충 | Sensory→…→Express(avatar) | mixed(외부키) | pending(후속 tranche) |
| UC3 기억대화 | **보충** | Chat+memory | scenario | pending(naia-memory 트랙) |
| UC4 능동회상 | **보충** | memory+temporal | scenario | pending |
| UC5 도구사용 | 이식 | ToolPort+Environment | old | pending |
| UC6 환경조작-브라우저 | 이식 | EnvironmentPort(app-surface) | old | pending |
| UC7a 시스템관측 | 이식 | EnvironmentPort observe | old | **F2 계약+코드** |
| UC7 시스템조작 | 이식+보충 | EnvironmentPort act+reafference | mixed | **F3 계약+코드** |
| UC8 공간분위기 | 이식 | EnvironmentPort(space) | old | pending |
| UC9 패널앱 | 이식 | EnvironmentPort(app-surface) | old | pending |
| UC10 멀티채널 | 이식+보충 | (채널 ingress) | mixed | pending(S36 깨짐) |
| UC10a 다중클라이언트 | **보충** | ClientSessionPort | scenario | pending(H-client) |
| UC11 자기상태 | 이식 | InteroceptivePort→Express | old | **F1 계약+코드** |
| UC12-min 최소부팅 | 이식 | control-plane | old | **F0 계약+코드** |
| UC12 온보딩/설정 | 이식 | control-plane(session/auth) | old | 부분(F0)·외부auth pending |
| UC12a 설정검증 | 보충 | InteroceptivePort | scenario | **F1 흡수** |
| UC13 승인게이트 | 이식+보충 | ApprovalPort | mixed | **F1 계약+코드** |
| UC13a 중단/e-stop | **보충** | SafetyPort | scenario | pending(H-safety) |
| UC14 degradation | **보충** | InteroceptivePort→Express | scenario | **F1(정직 degradation 신설)** |
| UC17 자유·연속 발화 전달 | 이식+보충 | Agent gRPC→ExpressionPort·SafetyPort | naia-agent #82 contract | **기술 slice 구현, native acceptance partial** |

### UC1 상세 — 텍스트 대화 (Chat→사고→표현)
| # | 조각(S) | old | 이식/보충 | 인지 포트 | fit | 권위 | 상태 |
|---|---|---|---|---|---|---|---|
| U1.1 | S13 채팅 입력 UI | O(shell) | 이식 | ChatPort(ingress) | 미평가 | old-auth | pending |
| U1.2 | LLM 사고/추론 | **O 동작**(shell→stdio→agent→provider.chat 스트리밍) | 이식(흐름)+보충(ChatPort 추상화) | agent(brain) via H-chat/H-app | 미평가 | old-auth(흐름 동작) | pending |
| U1.3a | 응답 *텍스트 표시* UI | O(shell) | 이식 | (shell 렌더) ← Express 출력 소비 | 미평가 | old-auth | pending |
| U1.3b | 응답 *speech-intent* | △ | **보충** | ExpressionPort(embodiment-neutral) | 미평가 | scenario-auth | pending |
| U1.4 | S62 @멘션 파일선택 | O(shell) | 이식 | ChatPort + EnvironmentPort observe | 미평가 | old-auth | pending |
| U1.5 | S70 파일 deeplink (UC1/UC7 공유) | O(shell) | 이식 | ChatPort + EnvironmentPort **app-surface 행위**(패널 open/전환) | 미평가 | old-auth | pending |
| U1.6a | S03 provider 설정 UI (UC12 공유) | O | 이식 | control-plane/config | 미평가 | old-auth | pending(F0 인접, 미측정) |
| U1.6b | S03 provider→agent 연결/검증 | O 동작(creds_update·chat_request provider) | 이식 | control-plane→agent | 미평가 | old-auth | pending |


> **UC1 grounding (2026-06-10, Explore 실코드):** 옛 앱 채팅 *동작함* — `ChatPanel→chat-service.sendChatMessage→invoke("send_to_agent_command")→stdio→agent index.ts handleChatRequest→provider.chat() 스트리밍→"agent_response" event→handleChunk`. transport=**stdio JSON-line**(gRPC 0). DTO=`protocol.ts` ChatRequest/AgentResponseChunk(이식 가능). **ChatPort/AppPort 추상화 없음**(shell↔transport 직결)=보충. 루크 "agent 미연결"=memory/깊은통합(UC3+)이지 *기본 chat 아님*. → **UC1 수평 = 동작하는 흐름을 ChatPort/protocol(transport-neutral)로 *재표현*(이식) + gRPC=어댑터 교체**. scenario-auth 아님(old 동작 기준).

**UC1 착수**: 수평 H-proto·H-tx·H-app·**H-agent** 먼저(agent 연결 *제대로*) → U1.1→U1.2→U1.3a/b 재표현 엮기 → mismatch=표면화(우김 금지) → U1.4~U1.6.

---

## S 전수 분류 (S01~71 — per-S 테이블, 행단위 미분류 0; 기계 검증 대상)
> GLM 3차: 불릿 그룹핑은 S별 이식/보충·multi-UC를 흐림 → per-S 행으로 전환. 각 행에 이식/보충/rej·UC(들)·포트·권위 필수.

| S | 기능 | UC(들) | 이식/보충/rej | 주 포트 | 권위 | 상태 |
|---|---|---|---|---|---|---|
| S01 | 온보딩/welcome | UC12 | 이식 | control-plane | old-auth | pending |
| S02 | 설정/settings 패널 | UC12 | 이식 | control-plane | old-auth | pending |
| S03 | provider 설정 | UC12·UC1 | 이식 | control-plane (연결=H-agent 보충) | old-auth | pending(복잡·미측정) |
| S04 | naia 계정/api key | UC12 | 이식 | control-plane | old-auth | pending |
| S05 | sessions 관리 | UC12 | 이식 | ClientSessionPort/control | old-auth | pending |
| S06 | agents 관리 | UC12 | 이식 | control-plane·skill | old-auth | pending |
| S07 | skill-manager | UC12·skill | 이식 | ToolPort·EnvironmentPort(exec) | old-auth | pending(F3 인접) |
| S08 | notify-config | UC12 | 이식 | control-plane | old-auth | pending |
| S09 | system-status | UC11 | 이식 | InteroceptivePort | old-auth | F1 계약+코드 |
| S10 | diagnostics | UC11 | 이식 | InteroceptivePort | old-auth | F1 계약+코드 |
| S11 | device 상태/제어 | UC11·UC7 | 이식 | InteroceptivePort·EnvironmentPort | old-auth | F1(부분) |
| S12 | approvals 승인 | UC13 | 이식+보충 | ApprovalPort | mixed | F1 계약+코드 |
| S13 | 텍스트 대화 | UC1 | 이식+보충 | ChatPort(UI 이식)·llm/agent·ExpressionPort(보충) | old-auth(UI)/scenario(agent·Express) | pending |
| S14 | omni 음성 | UC2 | 이식+보충 | SensoryPort·voice | mixed | pending(외부키) |
| S15 | gemini-live 음성 | UC2 | 이식 | SensoryPort·voice | mixed | pending(외부키) |
| S16 | openai-realtime 음성 | UC2 | 이식 | SensoryPort·voice | mixed | pending(외부키) |
| S17 | tts | UC2 | 이식 | ExpressionPort(speech) | old-auth | pending |
| S18 | voicewake | UC2 | 이식 | SensoryPort·wake | old-auth(잔재·미검증) | pending |
| S19 | avatar 표현 | UC2 | 이식 | ExpressionPort(avatar) | old-auth | pending |
| S20 | time | UC5 | 이식 | ToolPort | old-auth | pending |
| S21 | weather | UC5 | 이식 | ToolPort | old-auth | pending |
| S22 | memo | UC5 | 이식 | ToolPort | old-auth | pending |
| S23 | github skill | UC5 | 이식 | ToolPort | old-auth | pending |
| S24 | obsidian skill | UC5 | 이식 | ToolPort | old-auth | pending |
| S25 | mcp 연결 | UC5 | 이식 | ToolPort | old-auth | pending |
| S26 | agent-browser | UC6 | 이식 | EnvironmentPort(app-surface) | old-auth | pending |
| S27 | browser 패널 | UC6 | 이식 | EnvironmentPort(app-surface) | old-auth | pending |
| S28 | panel 설치 | UC9 | 이식 | EnvironmentPort(app-surface) | old-auth | pending |
| S29 | generic-installed 패널 | UC9 | 이식 | EnvironmentPort(app-surface) | old-auth | pending |
| S30 | sample-note 패널 | UC9 | rejected | — | — | rejected(제거됨) |
| S31 | youtube-bgm | UC8 | 이식 | EnvironmentPort(space) | old-auth | pending |
| S32 | 배경화면/scene | UC8 | 이식 | EnvironmentPort(space) | old-auth | pending |
| S33 | workspace(fs·editor·filetree) | UC7 | 이식 | EnvironmentPort(observe+act) | old-auth | F2(observe)+F3(act) |
| S34 | terminal(pty) | UC7 | 이식 | EnvironmentPort(observe+act) | old-auth | F2+F3(부분) |
| S35 | channels 일반 | UC10 | 이식+보충 | (채널 ingress) | mixed | pending |
| S36 | naia-discord | UC10 | 보충 | (채널) | scenario-auth | pending(깨짐) |
| S37 | notify-discord | UC10 | 이식 | (notify) | old-auth | pending |
| S38 | notify-google-chat | UC10 | 이식 | (notify) | old-auth | pending |
| S39 | notify-slack | UC10 | 이식 | (notify) | old-auth | pending |
| S41 | 기억 recall/주입 | UC3 | 이식+보충 | memory·scrubber(scrubber 이식, recall 보충) | mixed | pending(recall 미배선) |
| S42 | 능동 회상 | UC4 | 보충 | memory·CronPort | scenario-auth | pending(미배선) |
| S43 | cron 작업 | temporal·UC4 | 보충 | CronPort | scenario-auth | pending(미빌드; scaffold 발견 시 이식+보충 재평가) |
| S44 | graceful degradation | UC14 | 보충 | InteroceptivePort·ExpressionPort | scenario-auth | F1(신설) |
| S45 | 실행 중 중단/e-stop | UC13a | 보충 | SafetyPort | scenario-auth | pending |
| S46 | 다중 클라이언트 충돌 | UC10a | 보충 | ClientSessionPort | scenario-auth | pending |
| S47 | 페르소나/personality | UC12·표현 | 이식 | control-plane·ExpressionPort | old-auth | pending |
| S48 | 로컬 스킬 로딩·확장 | UC5·skill | 이식+보충 | ToolPort·EnvironmentPort(loader 이식, 확장배선 보충) | mixed | pending(배선의존) |
| S49 | STT 모델 관리 | UC2 | 이식 | SensoryPort·adapter | old-auth | pending |
| S50 | 오디오 출력 장치 | UC2 | 이식 | (효과기 audio) | old-auth | pending |
| S51 | gateway 운영 | control-plane | 이식 | control-plane | old-auth | pending |
| S52 | memory facts CRUD | UC3 | 이식 | memory(facts) | old-auth | pending |
| S52b | 메모리 백업/복원 | UC3 | 이식 | memory | old-auth | pending |
| S53 | audit log | control-plane | 이식 | control-plane | old-auth | pending |
| S54 | OAuth/로그인·key 검증 | UC12 | 이식+보충 | control-plane(auth) | mixed | pending(외부auth) |
| S55 | gateway 스킬(web_search·x·discord) | UC5·UC10 | 이식 | ToolPort(gateway) | old-auth | pending |
| S56 | external 광고 tool | UC5 | 이식 | ToolPort(gateway/mcp) | old-auth | pending |
| S57 | ADK 부트스트랩 | UC12 | 이식 | control-plane | old-auth | F0 계약+코드 |
| S58 | 비용 대시보드·잔액 | UC12 | 이식 | control-plane | old-auth | pending |
| S59 | 앱 업데이트 알림/설치 | control-plane | 이식 | control-plane | old-auth | pending |
| S60 | 원격 공지 배너 | control-plane | 이식 | control-plane | old-auth | pending |
| S61 | 화면/패널 비전 캡처 | UC11·UC6 | 이식 | SensoryPort(vision) | old-auth | pending |
| S62 | 채팅 @멘션 파일선택 | UC1 | 이식 | ChatPort·EnvironmentPort(observe) | old-auth | pending |
| S63 | GitHub Issues 패널 | UC5·UC7 | 이식 | ToolPort·EnvironmentPort | old-auth | pending |
| S64 | ModeBar 브라우저 바로가기 | UC6 | 이식 | EnvironmentPort(app-surface) | old-auth | pending |
| S65 | botmadang 연동 | UC10·UC5 | rejected | — | — | rejected(루크 결정) |
| S66 | 참조 오디오/voice clone | UC2 | 이식 | voice·ExpressionPort(timbre) | old-auth | pending |
| S67 | Naia Lab 설정 동기화 | UC12 | 이식 | control-plane | old-auth | pending |
| S70 | 채팅 파일 deeplink | UC1·UC7 | 이식 | ChatPort·EnvironmentPort(app-surface 행위) | old-auth | pending |
| S71 | 번들 default-skills(~60+, OpenClaw) | UC5·skill | 이식 | ToolPort/SkillPort·gateway | old-auth | pending(per-skill 검증) |

> (S40·S68·S69 = user-scenarios 인벤토리에 없음/배포 out-of-scope.)

## 갱신/체크 규칙
조각 작업 시 해당 행 상태·fit 갱신, mismatch=즉시 기록+해결경로. **commit 전 `node scripts/check-assembly-coverage.mjs` 통과 필수**(미분류 0 + 상태≥코드 행 fit≠미평가). 다음 UC는 같은 수평 위에 수직만 추가.

## 검증 한계 (바운드 — 4계보 교차 후 정직 기록)
codex·gemini·GLM 4라운드로 *내용 결함*(미분류0 거짓·수평 좁힘·canon포트 누락·per-S 오분류·S71 누락·H-app 재결합)은 정정됨. 남은 결함 = **체크 스크립트가 prose markdown 을 regex 로 검사**하는 한 내재적:
- staleness 가 숫자 출력뿐(기준시각·증가차단 없음 → 무한 pending 가능) — backlog 가시화로 *은닉*은 막았으나 *강제*는 못 함.
- per-S 행 검증이 컬럼 수·중복·테이블 소속까지는 못 봄(regex 한계).
**근본 해결(권장, 미실행)**: 매트릭스를 **structured-data(YAML/JSON) + schema 검증**으로 — 그러면 regex 우회·format 누락 class 가 한 번에 닫힘. 지금은 prose+regex 로 *우발적 드롭은 잡고*(미분류0·per-S 분류·fit게이트·활성선언) 무한 하드닝은 바운드. AI "한 축만" 방지의 1차 안전망으로 충분, 2차(structured)는 이식 진행하며.
