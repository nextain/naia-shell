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
| **UC10 멀티 채널(기본)** | discord/slack 에서 naia 응답 — **단일 active owner(동시 점유 없음)**. 동시성·충돌 중재 = UC10a | (채널 ingress) → 사고 → 표현(채널) | gateway·channels |
| **UC11 자기상태 인지** | "너 지금 상태 어때?"(system-status/진단) | **내수용**(시스템 상태) → 지각 → 표현 | InteroceptivePort·system-status·ExpressionPort |
| **UC12-min 최소 부팅 설정** | naia-adk workspace init(**외부 키 없이** 부팅 가능분) | (control-plane init) | control-plane·config |
| **UC12 전체 온보딩/설정** | wizard + 모델/provider + naia 계정/api key | (control-plane: 설정·신원·외부 auth) | control-plane(session)·config |
| **UC13 승인 게이트** | 위험 행위 전 사용자 승인 | 사고 → **승인**(규범) → 행위 | ApprovalPort·control-plane |
| **UC13a 실행 중 중단/취소/e-stop** (신규) | 돌아가는 browser/pty/system 작업을 끊음·회수 | (저지연) 중단·lease revoke·강등 | **SafetyPort**(≠Approval)·reactive path |
| **UC10a 다중 클라이언트 점유 충돌** (신규) | Discord·로컬 UI 동시 명령 → owner·lease·handoff·revoke | (control-plane 중재) | ClientSessionPort(lease/arbitration) |
| **UC12a 설정 검증** (UC11/14 **facet, 독립 UC 아님** — F1 흡수) | "키 저장됨"이 아니라 *provider/계정 연결 상태를 자기상태에서 관측* | 내수용 → 진단 | InteroceptivePort·system-status |
| **UC14 graceful degradation** (신규) ★ | **현 설정된 것의 degradation 감지·보고**(read-only) — F1=미설정·시스템 이상, *UC12 후 자동 확장*=외부 인증/키 깨짐(Discord). *대체(fallback)=후속 tranche*(행위라 밖) | 내수용(실패 감지)→지각→표현(정직 보고) | InteroceptivePort·ExpressionPort |

★ = naia 차별점(기억·경험·능동) — *기반 성숙 후* 별도 트랙(아래 순서 SoT).

> **우선순위 SoT = 아래 "Foundation tranche + vertical 순서"** (F0→F1→F2→F3 → V1·V2). UC3(기억)은 baseline 부재로 deferred. (인지흐름 관통 깊이는 *분류* 기준일 뿐, 착수 우선순위는 *기반 성숙도*가 결정.)

## Granular 시나리오 카탈로그 (전수 — 검증 여부 무관, 누락 금지)

> 원칙(루크 2026-06-08): **개발된 기능은 검증 여부와 무관하게 전부 시나리오로 enumerate.** 동작 여부(검증)는 *진행 중 Old-Baseline 측정* 또는 *루크 확인*으로 확정 — 내 추측으로 빼거나 deferred 안 함. "검증" 열 = **미측정**(측정/확인 예정)이 기본, 알려진 플래그만 표기(제외 아님).
> 13 UC = 인지흐름 분류 맵 / 아래 = 그 아래 실제 기능 단위(소스: 25 built-in skill + 6 패널 + provider/voice/채널). 각 행 = Old-Baseline 측정·이식·검증 단위.

| # | granular 시나리오 (소스) | UC 분류 | 슬라이스/포트 | 검증(측정/확인 예정) |
|---|---|---|---|---|
| S01 | 온보딩/welcome | UC12 | control-plane·config | 측정 |
| S02 | 설정 config / settings 패널 | UC12 | control-plane·config | 측정 |
| S03 | provider 설정(anthropic·openai·gemini·ollama·xai·zai·claude-code-cli·lab-proxy 각각) — **계정+비용 얽힘(복잡)** | UC12·UC1 | providers·control-plane | 측정(복잡) |
| S04 | naia 계정 / api key 설정 | UC12 | control-plane(entitlement·naia-token) | 측정 |
| S05 | sessions 관리 | UC12 | session(control-plane) | 측정 |
| S06 | agents 관리 | UC12 | control-plane·skill | 측정 |
| S07 | skill-manager(스킬 설치·관리) | UC12·skill | skill | 측정 |
| S08 | notify-config(알림 설정) | UC12 | control-plane | 측정 |
| S09 | system-status(자기 상태) | UC11 | InteroceptivePort | 측정 |
| S10 | diagnostics(진단) | UC11 | InteroceptivePort | 측정 |
| S11 | device(디바이스 상태/제어) | UC11·UC7 | 로컬 | 측정 |
| S12 | approvals(승인 게이트) | UC13 | ApprovalPort | 측정 |
| S13 | 텍스트 대화(ChatPanel) | UC1 | ChatPort·llm·ExpressionPort | 측정 |
| S14 | omni 음성(naia-omni realtime) | UC2 | voice provider·ws | 측정(키/서버) |
| S15 | gemini-live 음성 | UC2 | voice provider·ws | 측정 |
| S16 | openai-realtime 음성 | UC2 | voice provider·ws | 측정 |
| S17 | tts | UC2 | ExpressionPort(speech) | 측정 |
| S18 | **voicewake(이름 불러 활성화)** | UC2 | SensoryPort·wake | ✓루크확인: OpenClaw 잔재·미검증(개발검증 X) |
| S19 | avatar 표현(VRM, AvatarCanvas) | UC2 | ExpressionPort | 측정 |
| S20 | time | UC5 | skill(temporal) | 측정 |
| S21 | weather | UC5 | skill(외부) | 측정 |
| S22 | memo(로컬 노트) | UC5 | skill(로컬 fs) | 측정 |
| S23 | github(skill_github) | UC5 | skill·mcp(외부 auth) | 측정 |
| S24 | obsidian(skill_obsidian) | UC5 | skill(로컬/외부) | 측정 |
| S25 | mcp 연결 | UC5 | mcp | 측정 |
| S26 | agent-browser(브라우저 조작) | UC6 | EnvironmentPort.app-surface | 측정 |
| S27 | browser 패널 | UC6 | EnvironmentPort.app-surface | 측정 |
| S28 | panel 설치(panel) | UC9 | skill·EnvironmentPort.app-surface | 측정 |
| S29 | generic-installed 패널 | UC9 | EnvironmentPort.app-surface | 측정 |
| S30 | sample-note 패널 | UC9 | EnvironmentPort.app-surface | 측정 |
| S31 | youtube-bgm | UC8 | EnvironmentPort.space | 측정(YouTube 변동) |
| S32 | 배경화면/scene | UC8 | EnvironmentPort.space | 측정 |
| S33 | workspace(fs·editor·filetree) | UC7 | EnvironmentPort.host-system | 측정 |
| S34 | terminal(pty) | UC7 | EnvironmentPort.host-system | 측정 |
| S35 | channels(채널 일반) | UC10 | gateway·channels | 측정 |
| S36 | naia-discord | UC10 | gateway·channels | ✓루크확인: 안 됨(앱 인증 만료 추정) |
| S37 | notify-discord | UC10 | channels | 측정(인증) |
| S38 | notify-google-chat | UC10 | channels | 측정(인증) |
| S39 | notify-slack | UC10 | channels | 측정(인증) |
| S41 | 기억 recall/주입(`<recalled_memories>`) | UC3 | memory·scrubber | ✓루크확인: store/recall 미배선(scrubber만) — 검증 필요·naia-memory 트랙 |
| S42 | 능동 회상(기념일/시간 앵커) | UC4 | memory·cron·motivation | ⚠️ **미배선(memory+cron) — 트랙 후** |
| S43 | **cron 작업 생성/실행** | (temporal) | cron·CronPort | ✓루크확인: 미배선(만들기로 함)·gateway 의존 |
| S44 | graceful degradation(설정 degradation 감지·보고) | UC14 | InteroceptivePort·ExpressionPort | 신설(F1) |
| S45 | 실행 중 중단/e-stop | UC13a | SafetyPort | 신설 |
| S46 | 다중 클라이언트 점유 충돌 | UC10a | ClientSessionPort | 신설 |
| S47 | **페르소나/personality**(config.persona·OnboardingWizard·system-prompt buildSystemPrompt) | UC12·표현 | control-plane·ExpressionPort | 측정 |
| S48 | **naia-adk 로컬 스킬 로딩·확장**(workspace_discover_skills·SKILL.md·gateway agent 실행) — *배선 시 로컬에서 가져와 확장* | skill | skill·EnvironmentPort | ⚠️ **배선 의존 — 확인** |
| S49 | STT 모델 관리(download/delete/list stt models) | UC2(음성 입력) | SensoryPort·adapter | 측정 |
| S50 | 오디오 출력 장치(list_audio_output_devices) | UC2 | 효과기(audio) | 측정 |
| S51 | gateway 운영(health·restart·reset·sync) | (control-plane) | control-plane·gateway | 측정 |
| S52 | memory facts CRUD(get_all/delete — tauri) | UC3 | memory(facts 표면) | ⚠️ facts 표면 존재 / recall 주입 미배선(S41) |
| S52b | 메모리 **백업/복원**(암호화 export/import, Settings 메모리 탭 Backup UI) | UC3 | memory | ⚠️ **UI disabled/ComingSoon**(완전성R7) |
| S53 | audit log(get_audit_log·stats) | (control-plane) | 메타인지·감사 | 측정 |
| S54 | OAuth/로그인·api key 검증(oauth_state·open_login·validate_api_key·write_agent_key) | UC12 | control-plane auth | 측정 |
| S55 | gateway 스킬: **web_search · x(트위터) · discord**(gateway-tier, gateway LLM agent 실행) | UC5·UC10 | gateway·tool-tiers | 측정 |
| S56 | (external 광고 tool: github·obsidian·notion·slack·spotify·trello·canvas·code_review 등 — gateway/mcp 경유) | UC5 | gateway·mcp | ⚠️ **실재 vs 광고-only 구분 = 측정** |
| S57 | **ADK 부트스트랩**(AdkSetupScreen: 기존 ADK 로드/clone·init/재생성/로그인 — inspect_adk_dir·clone_naia_adk·init_naia_settings·delete_naia_adk) | UC12 | control-plane·config | 측정 (완전성R1) |
| S58 | **비용 대시보드 + Naia Lab 잔액·충전**(CostDashboard `/v1/profile/balance`·billing 링크, ChatPanel 비용 배지) | UC12 | control-plane(billing/cost) | 측정 (완전성R1, 루크 "비용 관련") |
| S59 | **앱 업데이트 알림·설치**(UpdateBanner: checkForUpdate·install·다운로드) | (control-plane) | control-plane(updater) | 측정 (완전성R1) |
| S60 | **원격 공지 배너**(AnnouncementBanner: fetchUnreadAnnouncements·read/dismiss/details) | (control-plane/notify) | control-plane·gateway | 측정 (완전성R1) |
| S61 | **화면/패널 비전 캡처**(skill_tab_screenshot·capture.rs — 패널 viewport→PNG) = naia 시각 | UC11/UC6 | **SensoryPort(vision)** | 측정 (완전성R2) |
| S62 | 채팅 **@ 멘션** 파일/폴더 선택기(AtMentionPopover, workspace fuzzy 검색→삽입) | UC1 | ChatPort·workspace | 측정 (완전성R2) |
| S63 | 워크스페이스 **GitHub Issues 패널**(IssuesPanel, `gh issue list`) | UC5/UC7 | workspace group·skill(github) | 측정 (완전성R2) |
| S64 | **ModeBar 브라우저 바로가기 관리**(URL shortcut 추가/삭제/재정렬/아이콘) | UC6 | browser group·UI | 측정 (완전성R2) |
| S65 | **botmadang 커뮤니티 연동**(botmadang.org: register·post_article·comment) — 기본 스킬·skill.json 매니페스트 | UC10/UC5 | skill·channels | ⚠️ **codex 실재 확인(잔재 아님)** vs 루크 "제외" → **keep(카탈로그) / reject(이식 제외) 결정 필요** |
| S66 | **참조 오디오 / voice clone**(RefAudioSection: 미리듣기·녹음/업로드·preset·삭제, `/v1/ref-audio`, mid-session 반영) = naia 음색 | UC2 | voice·ExpressionPort(timbre) | 측정 (완전성R4) |
| S67 | **Naia Lab 설정 동기화**(lab-sync: pull/push + 충돌 선택 다이얼로그, 로컬변경 자동 push) — 계정/비용과 별개 | UC12 | control-plane(settings sync) | 측정 (완전성R5) |
| S70 | 채팅 **절대경로 파일 deeplink**(chat-file-deeplink 버튼 → workspace 패널 openFile + 전환) | UC1/UC7 | ChatPort·workspace | 측정 (완전성R9) |
| **S71 번들 default-skills 컬렉션 (~60+, OpenClaw 출처)** = command-group (preload + SkillsTab 노출 + tool-bridge) | UC5 | skill·gateway | 측정 (완전성R10, **개별 스킬 per-skill 검증**) |

> **브라우저(S26/27) = command-group(~50)**: embed lifecycle·webview·navigate/click/fill/get_text/snapshot/screenshot/eval/press/scroll/forward-back/resize/show-hide/login/permission. **워크스페이스(S33) = command-group(~25)**: adk-server discover·skills discover·sessions·git·progress·file read/write·watch·classify·set-root·project-index. (이식 시 sub-capability 별 분해.)
> **S71 default-skills 전 목록 (~60+, OpenClaw 출처 — 누락 0, per-skill 검증)**: 1password·blogwatcher·blucli·bluebubbles·camsnap·clawhub·coding-agent·eightctl·food-order(json-only)·gemini·gh-issues·gifgrep·gog·goplaces·healthcheck·himalaya·mcporter·nano-banana-pro·nano-pdf·openai-image-gen·openai-whisper·openai-whisper-api·openhue·oracle·ordercli·sag·session-logs·sherpa-onnx-tts·skill-creator·songsee·sonoscli·summarize·tmux·video-frames·wacli·xurl. **darwin-only**: apple-notes·apple-reminders·bear-notes·imsg·model-usage·peekaboo·things-mac. (이식 단위 = default-skills preload/loader + 번들; 동작은 per-skill Old-Baseline 측정.)
> **분포/OS 레벨 (P01 앱 시나리오 범위 *밖* — 별도 배포 트랙, 완전성 기록용, 완전성R8)**: S68 Naia OS ISO 설치(라이브 USB→HD) · S69 persistent USB writer/update/status(naia-usb). = recipes/installer/os 패키징 레이어, 헥사고날 이식 슬라이스(agent+core+shell 앱) 밖. (앱 표면 자체는 R8=NONE.)
> 누락 0 목표. **검증 열 = 측정/루크 확인으로만**(추측 ✅ 금지). 우선 확인: S18(잔재✓)·S36(깨짐✓)·S41/43(미배선✓)·S42·S48·S52·S56.

### 왜 전수인가 — fault isolation (루크 2026-06-09)

혼자 개발 → **다 작동한다는 보장 없음.** 목표는 "전부 검증"이 아니라 **구조적 이식으로 고장을 가두는 것**: 각 기능이 자기 slice/port 경계에 들어가면, 깨진 기능(Discord·cron·memory recall…)이 *그 슬라이스에 격리*되어 다른 영역으로 안 번진다. 전수 enumerate = 각 기능에 구조적 슬롯을 줘 *고장 전파 차단* + UC11 자기상태가 *어디가 깨졌는지 표면화*. (검증은 그 위에서 점진.)

## Test Coverage Map (P02 선행 스케치)

각 UC → 계약 테스트(port) + 통합 테스트(app use case) 매핑은 P02. 순서는 ↓ foundation tranche 를 따름(별도 우선순위 두지 않음). P02 착수 전 = Old-Baseline 측정 필수.

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
- **F1: UC11 + UC14 자기상태 진단(read-only, afferent-only)** — naia 가 자기 상태 관측·보고. `InteroceptivePort`. **= 진단 렌즈**. **범위(R5)**: F0-min 이 남긴 *persisted config + 시스템 상태 + 무엇이 설정/미설정*까지(대체·행위 없음). UC14 = **현 설정된 것의 degradation 보고**(F1=미설정·시스템 이상; 외부 provider/계정 auth 깨짐은 그 auth 가 설정된 *UC12 이후 자동 확장* — F1 시점엔 판정 기준 부재라 다루지 않음). golden-trace 첫 성과물 = "설정/미설정·시스템 상태를 정직 보고".
- **F2: UC7a 시스템 관측(read-only)** — host-system 상태 조회(변경 X). 가장 안전한 첫 환경 이식.
- **F3: UC7 시스템 조작(mutating)** — Action→Environment→**observed→mismatch**(reafference) 완결. = 얇지만 완전한 cognitive 1회전(첫 efferent+reafferent 실증).

**그 다음 (외부 의존, F1 자기상태로 연결 검증 후):**
- **V1: UC1 텍스트 대화** — provider 키 유효 확인 후 Chat→사고→표현.
- **V2: UC2 음성 대화** — voice substrate 축 확장(다슬라이스, 데모).
- **OS-core (P01 시나리오에 포함 확정, 구현 = F-tranche 안정화 후 DEFER):** UC10a 다중 클라이언트 lease/handoff/revoke · UC13a stop/e-stop/revoke. — 부가 아니라 OS성 핵심이라 *시나리오는 지금 박되* 착수는 F3 이후.
- **보류: UC3/UC4 기억·능동** — old 미배선 → naia-memory 통합 트랙 후.

→ "가장 안전한 vertical"이 아니라 *얇게 쪼갠 foundation tranche*. G1 = 이 순서 승인.

### 전체 UC 배치 (단일 착수 SoT — 모든 UC 명시, R3 codex)

| 단계 | UC | 비고 |
|---|---|---|
| **F0** | UC12-min | 외부키 없는 최소 부팅 |
| **F1** | UC11 · UC14 *(UC12a = UC11/14 facet, 흡수 — 독립 카운트 아님)* | read-only 진단·실패감지 |
| **F2** | UC7a | host-system read-only 관측 |
| **F3** | **UC13 승인 게이트 → UC7**(F3 내부 순서: 승인 경로 먼저, 그 위에 mutating) | 첫 efferent+reafference |
| **V1** | UC1 (+ UC12 전체 = provider/계정/키 설정 완료, V1 직전) | provider 검증 후 |
| **V2** | UC2 | voice |
| **도구·환경 tranche**(V 이후, *기능별 Old-Baseline 게이트*) | UC5 도구 · UC6 브라우저 · UC8 BGM · UC9 패널 · UC10 멀티채널(기본) | 외부 의존 개별 실측 후 |
| **OS-core**(F3 후) | UC10a 다중클라이언트 lease · UC13a stop/e-stop | 구현 DEFER |
| **deferred**(naia-memory 트랙) | UC3 기억 · UC4 능동 | old 미배선 |

미배치 UC = 0(전수 배치). 착수 순서 해석 단일.

## golden 기준선 — 1회 smoke ≠ golden (R1 codex)

외부 인증/모델/YouTube/Discord 는 drift source. baseline 에 함께 **freeze**: `입력 trace` + `출력 trace` + `설정/버전/키 상태` + `실패 분류(인증 실패 vs 제품 버그)`. 안 그러면 "old 가 오늘 운 좋게 됨"을 canonical 로 오인. (UC14 가 인증실패 분류를 담당.)

**Old-Baseline 측정 = P02 전제조건 단계(R2 gemini)**: vertical/foundation 후보 기능을 *old-naia-os 에서 실제 구동* → 위 4종 스냅샷 생성. 이 측정 없이 P02 테스트 매핑 금지. ("작동 안 함"이 정상 baseline 일 수 있음 — 측정으로 확정.)
**F1 InteroceptivePort 최소 스펙(R2 gemini)**: old 에 통합된 형태가 아님(신설) → F1 에서 **read-only 최소 인터페이스부터** 정의(이식 첫 난관 최소화).

> **이식 coverage 함의**: 1단계 슬라이스의 `memory` = old 소스엔 scrubber·prompt convention(`<recalled_memories>`)만 → `accepted`(scrubber) + `deferred`(실제 store/recall = naia-memory 통합 대기). 커버리지 manifest 에 명시.

## 열린 질문 (G1 결정 — 진짜 결정 사항만)
1. Foundation tranche 순서 F0(설정-min)→F1(자기상태 read-only)→F2(시스템 관측)→F3(시스템 조작) 승인?

## 해소·DEFER (재논 금지)
- ~~UC7 포트 축~~ = 해소(R1): UC7 = `EnvironmentPort`(host-system). `ActionPort`=body movement(별개).
- OS-core(UC10a·UC13a) = P01 시나리오 **포함 확정**, 구현 DEFER(F3 후).
- step-2 계약 backlog(goal-governance 소유자·포트 시그니처 등) = DEFER(step-2 계약 단계).
- notify/memo(non-memory) 독립 UC 여부 = **Old-Baseline 측정 시 확인**(DEFER).
