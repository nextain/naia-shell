# 조립 매트릭스 (assembly matrix) — 이식·보충·수직·수평 전수 추적 SoT (2026-06-10, v2)

> **목적 = drift/드롭 방지 anchor.** v1이 "자리만" 적고 미분류 0을 거짓 주장(codex HIGH) → v2는 **UC1~14 + S01~71 전수 분류**(미분류 0 *기계 강제* via `scripts/check-assembly-coverage.mjs`). AI 판단 못 믿음 → 결정론 체크가 앵커([[project_drift_detection_anchor_thesis]]).
> 진실=사용자 시나리오(UC); 옛 동작은 *맞던 곳만* 참조.

## 축 (직교 — 둘 다)
- **수직=UC** / **수평=포트 canon 전체(시스템 인터페이스, 다중 클라이언트)**.
- **이식**(옛것 맞게 돎)/**보충**(없거나 깨짐)/**rejected**(이식 제외).
- **권위**: `old-auth`(옛 *관측 행동* 기준, 구조는 인지 포트 재표현) / `scenario-auth`(UC 기준, 옛것과 달라도 됨).
- **인지 포트 매핑 + fit**: clean / **mismatch**(1급 표면화) / 미평가.

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
| H-app | `AppPort`(=Chat+Tool facade) | 대화·툴 interaction **만** | △직접호출 | 보충 | scenario | pending(UC1) |
| H-sensory | `SensoryPort` | 감각(audio/vision/screen) | O(부분) | 이식+보충 | mixed | pending(UC2/61) |
| H-intero | `InteroceptivePort` | 내수용(시스템 상태) | O | 이식 | old | **F1 계약+코드** |
| H-express | `ExpressionPort` | 표현(speak/emote, embodiment-neutral) | △(UI직결) | 보충 | scenario | pending(UC1/2) |
| H-env | `EnvironmentPort`(observe/act/space/app-surface/host) | 환경 관측·행위 | O | 이식 | old | **F2(observe)+F3(mutate) 계약+코드**; app-surface/space pending |
| H-approval | `ApprovalPort` | 승인 게이트+결속 | O(부분) | 이식+보충 | mixed | **F1 계약+코드** |
| **H-agent** | **agent(brain)↔os 연결** | 위 포트들이 agent로 닿는 seam | **△ 제대로 연결된 적 없음** | **보충** | **scenario** | **pending(핵심 리스크)** |

> ⚠️ v1처럼 "protocol→AppPort 단일경로"로 좁히지 않음. AppPort=Chat/Tool 하나일 뿐, 나머지 포트는 독립(canon). 다중 클라이언트=H-client.

---

## 수직 UC 트랙 — UC1~14 전수 (분류; UC1 상세)

| UC | 이식/보충 | 주 인지포트 | 권위 | slice/상태 |
|---|---|---|---|---|
| **UC1** 텍스트대화 | 이식+보충 | Chat→agent→Express | mixed | ↓ 상세 |
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

### UC1 상세 — 텍스트 대화 (Chat→사고→표현)
| # | 조각(S) | old | 이식/보충 | 인지 포트 | fit | 권위 | 상태 |
|---|---|---|---|---|---|---|---|
| U1.1 | S13 채팅 입력 UI | O(shell) | 이식 | ChatPort(ingress) | 미평가 | old-auth | pending |
| U1.2 | LLM 사고/추론 | △ agent 미연결 | **보충** | agent(brain) via H-app/H-agent | 미평가 | scenario-auth | pending(H-agent 의존) |
| U1.3a | 응답 *텍스트 표시* UI | O(shell) | 이식 | (shell 렌더) ← Express 출력 소비 | 미평가 | old-auth | pending |
| U1.3b | 응답 *speech-intent* | △ | **보충** | ExpressionPort(embodiment-neutral) | 미평가 | scenario-auth | pending |
| U1.4 | S62 @멘션 파일선택 | O(shell) | 이식 | ChatPort + EnvironmentPort observe | 미평가 | old-auth | pending |
| U1.5 | S70 파일 deeplink (UC1/UC7 공유) | O(shell) | 이식 | ChatPort + EnvironmentPort **app-surface 행위**(패널 open/전환) | 미평가 | old-auth | pending |
| U1.6a | S03 provider 설정 UI (UC12 공유) | O | 이식 | control-plane/config | 미평가 | old-auth | pending(F0 인접, 미측정) |
| U1.6b | S03 provider→agent 연결/검증 | △ | **보충** | H-agent | 미평가 | scenario-auth | pending |

**UC1 착수**: 수평 H-proto·H-tx·H-app·**H-agent** 먼저(agent 연결 *제대로*) → U1.1→U1.2→U1.3a/b 재표현 엮기 → mismatch=표면화(우김 금지) → U1.4~U1.6.

---

## S 전수 분류 (S01~71 — 미분류 0; 기계 체크 대상)
> 형식 `S## 이식/보충/rej · 권위 · 주포트`. F0~F3 커버분=상태표시.
- **control-plane/config (F0 인접, 이식·old)**: S01 온보딩 · S02 설정 · S04 naia계정/key · S05 sessions · S06 agents · S08 notify-config · S47 페르소나 · S54 OAuth/key검증 · S57 ADK부트스트랩(**F0**) · S58 비용대시 · S59 앱업데이트 · S60 공지배너 · S67 lab-sync · S51 gateway운영 · S53 audit
- **InteroceptivePort (F1, 이식·old)**: S09 system-status · S10 diagnostics · S11 device · S44 degradation(**보충/scenario** 신설)
- **ApprovalPort (F1, 이식+보충)**: S12 approvals
- **EnvironmentPort observe (F2, 이식·old)**: S33 workspace(read) · S34 terminal(read) · S63 GitHub Issues 패널
- **EnvironmentPort act (F3, 이식·old)**: S33 workspace(write) · S34 terminal(write) · S07 skill-manager(exec)
- **ChatPort (UC1, 이식·old)**: S13 텍스트대화 · S62 @멘션 · S70 deeplink(UC7 공유)
- **SensoryPort/voice (UC2, 이식+보충·mixed, 외부키)**: S14 omni · S15 gemini-live · S16 openai-realtime · S17 tts · S18 voicewake(**잔재·미검증**) · S19 avatar · S49 STT모델 · S50 오디오장치 · S61 화면캡처(vision) · S66 ref-audio
- **ToolPort/skills (UC5, 이식·old; 일부 보충)**: S20 time · S21 weather · S22 memo · S23 github · S24 obsidian · S25 mcp · S55 gateway스킬(web_search/x/discord) · S56 external광고tool · S48 로컬스킬로딩(**보충**·배선의존) · S64 ModeBar바로가기
- **EnvironmentPort app-surface (UC6/9, 이식·old)**: S26 agent-browser · S27 browser패널 · S28 panel설치 · S29 generic패널 · S30 sample-note(**제거됨**)
- **EnvironmentPort space (UC8, 이식·old)**: S31 youtube-bgm · S32 배경/scene
- **채널 (UC10, 이식+보충)**: S35 channels · S36 naia-discord(**보충/scenario — 깨짐**) · S37 notify-discord · S38 notify-google-chat · S39 notify-slack
- **memory (UC3/4, 보충·scenario)**: S41 recall주입(**미배선**) · S42 능동회상(**미배선**) · S52 facts CRUD · S52b 백업/복원
- **temporal (보충·scenario)**: S43 cron(**미빌드**)
- **SafetyPort (UC13a, 보충·scenario)**: S45 중단/e-stop
- **ClientSessionPort (UC10a, 보충·scenario)**: S46 다중클라이언트 충돌
- **rejected (이식 제외)**: S65 botmadang(루크 결정)
- (S68/69 배포 = out-of-scope, distribution tranche)

---

## 갱신/체크 규칙
조각 작업 시 해당 행 상태·fit 갱신, mismatch=즉시 기록+해결경로. **commit 전 `node scripts/check-assembly-coverage.mjs` 통과 필수**(미분류 0 + 상태≥코드 행 fit≠미평가). 다음 UC는 같은 수평 위에 수직만 추가.
