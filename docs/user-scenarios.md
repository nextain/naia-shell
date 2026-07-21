# 사용자 시나리오 (P01) + 테스트 커버리지 맵 — 2단계 산출물

`[Phase 03·04 (P01 시나리오 + P02 테스트맵)]`

> 추적: 1단계 `STRUCTURE.md` v5 → 2단계 P01. **상태: 완전성 수렴(13R, 3연속 NONE). foundation tranche 순서 = 아이디어 수준 잠정안(F0→…→V2, 실행 시 재검토). G1 게이트 아님.**
> 완전성 추이: 초안 46 → 누락 발견·추가 R1~R10(ADK부트스트랩·비용·업데이트·공지·비전캡처·@멘션·Issues·AppBar·botmadang·ref오디오·Lab동기화·deeplink·**default-skills 60+ 컬렉션**·메모리백업) → R11~R13 3연속 NONE. 앱 표면 ≈ S01~S71(+S52b) + 브라우저/워크스페이스/default-skills 그룹. 분포/OS(S68/69)=범위 밖.
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
| **UC9 앱** | 앱 설치→그 앱 스킬 사용 | Chat → 능력(panel install) → 환경(app-surface tool) | skill(panel)·EnvironmentPort.app-surface |
| **UC10 멀티 채널(기본)** | discord/slack 에서 naia 응답 — **단일 active owner(동시 점유 없음)**. 동시성·충돌 중재 = UC10a | (채널 ingress) → 사고 → 표현(채널) | gateway·channels |
| **UC11 자기상태 인지** | "너 지금 상태 어때?"(system-status/진단) | **내수용**(시스템 상태) → 지각 → 표현 | InteroceptivePort·system-status·ExpressionPort |
| **UC12-min 최소 부팅 설정** | naia-adk workspace init(**외부 키 없이** 부팅 가능분) | (control-plane init) | control-plane·config |
| **UC12 전체 온보딩/설정** | wizard + 모델/provider + naia 계정/api key | (control-plane: 설정·신원·외부 auth) | control-plane(session)·config |
| **UC13 승인 게이트** | 위험 행위 전 사용자 승인 | 사고 → **승인**(규범) → 행위 | ApprovalPort·control-plane |
| **UC13a 실행 중 중단/취소/e-stop** (신규) | 돌아가는 browser/pty/system 작업을 끊음·회수 | (저지연) 중단·lease revoke·강등 | **SafetyPort**(≠Approval)·reactive path |
| **UC10a 다중 클라이언트 점유 충돌** (신규) | Discord·로컬 UI 동시 명령 → owner·lease·handoff·revoke | (control-plane 중재) | ClientSessionPort(lease/arbitration) |
| **UC12a 설정 검증** (UC11/14 **facet, 독립 UC 아님** — F1 흡수) | "키 저장됨"이 아니라 *provider/계정 연결 상태를 자기상태에서 관측* | 내수용 → 진단 | InteroceptivePort·system-status |
| **UC14 graceful degradation** (신규) ★ | **현 설정된 것의 degradation 감지·보고**(read-only) — F1=미설정·시스템 이상, *UC12 후 자동 확장*=외부 인증/키 깨짐(Discord). *대체(fallback)=후속 tranche*(행위라 밖) | 내수용(실패 감지)→지각→표현(정직 보고) | InteroceptivePort·ExpressionPort |
| **UC17 자유·연속 발화 전달** | agent가 사용자 요청 또는 내부 trigger로 여러 발화를 이어 보내면 셸이 session stream을 구독해 기존 채팅·TTS·취소 경로로 표현 | 사고(agent activity) → gRPC stream → 표현(text/TTS/avatar) → 끼어들기 | Agent gRPC client·ExpressionPort·SafetyPort(cancel) |

UC15 제품 수용 확장(#84):

- DJ 사용자는 설정에서 profile·간격·날씨 위치/동의와 전시 knowledgeScope를 관리한다. 잘못된 timezone,
  부분/범위 밖 좌표, 빈 전시 scope는 시작하지 않으며 동의 철회 뒤 좌표를 보내지 않는다(PA-DJ-04).
- `DJ 좋아요/싫어요/취향 삭제:`는 다음 런타임까지 명시 취향으로 남고, `DJ 상태:`는 같은 세션 6시간만
  추천에 쓰인다. 일반 대화나 청취 시간으로 취향·기분을 추론하지 않는다(PA-DJ-01/02).
- 선제 DJ 텍스트는 지원 TTS 경로별로 실제 재생을 시작한다. 8개 멘트가 반복되지 않고, 5개 제어와 ordinary
  chat 끼어들기는 현재 음성을 먼저 끊고 이전 generation의 늦은 출력을 버린다(PA-DJ-03/05).
- 8시간 상당 운용에도 BGM/controller 하나와 bounded lease를 유지하고 stop 경계 뒤 추가 호출이 없다(PA-DJ-06).
- 전시는 유효 KB scope로만 시작한다. 질문이 소개를 중단하고 source 답변 뒤 미소개 항목으로 복귀하며,
  quiet/restart/stop을 지킨다. memory/transcript/raw-content log는 남기지 않는다(PA-EX-01/02).

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
| S05 | sessions 관리 — **대화 transcript 영속/로드**(S05a write·S05b read, ↓note) | UC12·UC1 | session(control-plane)·ConversationLogPort·EnvironmentPort(storage) | ⚠️ **현 게이트웨이 directToolCall = new-core 死 → 재구현**(2026-06-18 transcript 트랙) |
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
| S30 | sample-note 패널 | UC9 | EnvironmentPort.app-surface | ⚠️ App.tsx 에서 제거/미배선(완전성R12) — rejected 후보 |
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
| S64 | **AppBar 브라우저 바로가기 관리**(URL shortcut 추가/삭제/재정렬/아이콘) | UC6 | browser group·UI | 측정 (완전성R2) |
| S65 | **botmadang 커뮤니티 연동**(botmadang.org: register·post_article·comment) — 기본 스킬·skill.json 매니페스트 | UC10/UC5 | skill·channels | **rejected(루크 결정 2026-06-09: 이식 제외)** — voice-server류, 카탈로그엔 rejected로 명시 |
| S66 | **참조 오디오 / voice clone**(RefAudioSection: 미리듣기·녹음/업로드·preset·삭제, `/v1/ref-audio`, mid-session 반영) = naia 음색 | UC2 | voice·ExpressionPort(timbre) | 측정 (완전성R4) |
| S67 | **Naia Lab 설정 동기화**(lab-sync: pull/push + 충돌 선택 다이얼로그, 로컬변경 자동 push) — 계정/비용과 별개 | UC12 | control-plane(settings sync) | 측정 (완전성R5) |
| S70 | 채팅 **절대경로 파일 deeplink**(chat-file-deeplink 버튼 → workspace 패널 openFile + 전환) | UC1/UC7 | ChatPort·workspace | 측정 (완전성R9) |
| **S71 번들 default-skills 컬렉션 (~60+, OpenClaw 출처)** = command-group (preload + SkillsTab 노출 + tool-bridge) | UC5 | skill·gateway | 측정 (완전성R10, **개별 스킬 per-skill 검증**) |

> **브라우저(S26/27) = command-group(~50)**: embed lifecycle·webview·navigate/click/fill/get_text/snapshot/screenshot/eval/press/scroll/forward-back/resize/show-hide/login/permission. **워크스페이스(S33) = command-group(~25)**: adk-server discover·skills discover·sessions·git·progress·file read/write·watch·classify·set-root·project-index. (이식 시 sub-capability 별 분해.)
> **S71 default-skills 전 목록 (~60+, OpenClaw 출처 — 누락 0, per-skill 검증)**: 1password·blogwatcher·blucli·bluebubbles·camsnap·clawhub·coding-agent·eightctl·food-order(json-only)·gemini·gh-issues·gifgrep·gog·goplaces·healthcheck·himalaya·mcporter·nano-banana-pro·nano-pdf·openai-image-gen·openai-whisper·openai-whisper-api·openhue·oracle·ordercli·sag·session-logs·sherpa-onnx-tts·skill-creator·songsee·sonoscli·summarize·tmux·video-frames·wacli·xurl. **darwin-only**: apple-notes·apple-reminders·bear-notes·imsg·model-usage·peekaboo·things-mac. (이식 단위 = default-skills preload/loader + 번들; 동작은 per-skill Old-Baseline 측정.)
> **분포/OS 레벨 (P01 앱 시나리오 범위 *밖* — 별도 배포 트랙, 완전성 기록용, 완전성R8)**: S68 Naia OS ISO 설치(라이브 USB→HD) · S69 persistent USB writer/update/status(naia-usb). = recipes/installer/os 패키징 레이어, 헥사고날 이식 슬라이스(agent+core+shell 앱) 밖. (앱 표면 자체는 R8=NONE.)
> 누락 0 목표. **검증 열 = 측정/루크 확인으로만**(추측 ✅ 금지). 우선 확인: S18(잔재✓)·S36(깨짐✓)·S41/43(미배선✓)·S42·S48·S52·S56.

> **S05 대화 transcript 영속/로드 (2026-06-18 transcript 트랙, V1-선행)**: 현 S05 = 죽은 게이트웨이 directToolCall(new-core fail-fast)에 의존 → verbatim 대화록 영속/로드 재구현.
> - **S05a WRITE(전두엽=agent)**: agent 가 각 turn 을 `{adkPath}/conversations/{sessionId}.jsonl` append(`ConversationLogPort`). 인지흐름 = 사고→표현 후 *경험 외재화/기록*. sessionId 배선(proto+domain+codec). (Phase2: 음성 turn = agent 경유 동일 기록.)
> - **S05b READ(shell, agent 독립 E1)**: HistoryTab 이 Rust IPC 로 conversations 직접 list/read/delete(**write 없음**). 죽은 directToolCall 대체.
> - **S05c 관계(비구현)**: transcript = UC3/S41 memory recall 원재료 + 멀티모달 잠재기억 substrate(`audioRef` 예약).
> - **검증(P02)**: agent write 계약(`conversation-log.contract.test.ts`: jsonl append·sessionId 격리·no-throw·CRLF) / shell read 계약(`conversation-store.test.ts`: 경계 가드·agent-down 빈목록) / 통합(`conversation-persistence.integration.test.ts`: 대화→재시작→복원 golden) + Playwright e2e(HistoryTab 복원)·e2e-tauri(Rust IPC adkPath 경계).

> **S72 워크스페이스 전환 설정 복원 (2026-06-24, 셸 feature)**: 워크스페이스(ADK path) 전환 시 그 워크스페이스의 정체성 설정(페르소나·이름·말투·locale·VRM·배경·BGM)이 복원돼야 한다. 현 버그 = 전환 핸들러(SettingsTab/WorkspaceCenterPanel)가 ADK 포인터(localStorage `naia-adk-path`)만 바꾸고 기존 localStorage `naia-config` 를 유지 → 페르소나/VRM 안 바뀜. 초기 설정(AdkSetupScreen)은 `readNaiaConfig` 로 복원하나 전환 경로만 누락(비대칭).
> - **S72a 복원(전환 핸들러)**: `setAdkPath` 후 config.json(persona/이름/말투/locale via `readNaiaConfig`) + ui-config.json(VRM/배경/BGM via `readNaiaUiConfig`) → localStorage `naia-config` 로 병합 복원 → reload. AdkSetupScreen 과 동형(비대칭 해소).
> - **S72b 저장 분리**: UI 정체성(vrmModel·backgroundImage·backgroundVideo·bgmTrack·customVrms·customBgs)을 워크스페이스별 `{adkPath}/naia-settings/ui-config.json` 에 저장. agent config.json 은 `stripForAgent` 유지(env 오염 방지) — UI키는 ui-config.json 으로만. persona/이름/말투/locale 은 기존 config.json(agent 도 소비).
> - **검증(P02)**: adk-store 계약(`writeNaiaUiConfig`/`readNaiaUiConfig` 분리·경계) + 복원 병합 계약(`applyWorkspaceConfigToLocal`: config.json+ui-config.json → naia-config) + e2e(워크스페이스 A→B 전환 시 VRM·persona 변경).

> **UC-CONFIG-SOT localStorage 는 adkPath 뿐, 설정 SoT = naia-settings/ (2026-07-15, 루크 원칙)**: 앱이 켜질 때 사용자가 보는 설정(페르소나·이름·말투·locale·모델·VRM·배경)은 **`naia-settings/config.json`·`ui-config.json` 이 유일한 진실(SoT)**이어야 한다. localStorage 는 오직 `naia-adk-path`(어느 ADK 를 볼지 = 부트스트랩 포인터)만 **권위**로 갖고, `naia-config` 는 파일에서 하이드레이트되는 **순수 렌더 캐시**(107곳 동기 `loadConfig()` 리더용, 권위 없음)일 뿐이다.
> - **현 버그(재현 100%)**: `naia-settings/config.json` 을 바꿔도 재기동마다 **스테일 localStorage 값이 이겨** 파일을 덮는다. 원인 = 부팅 병합 `App.tsx:367` 만 유일하게 `merged = { ...local, ...fileConfig, ...uiConfig }` 로 **local 을 base** 로 쓴다(워크스페이스 전환 `adk-store.ts:413` 은 이미 파일만 base = 정답). ① `readNaiaConfig()` 가 null/부분 config 면 `fileConfig.persona` 부재 → 스테일 `local.persona` 가 스프레드에서 살아남음. ② `App.tsx:457` `syncConfigToFile()` 이 하이드레이션 전 스테일 localStorage 를 800ms 디바운스로 **config.json 에 되씀**(persona 는 strip 대상 아님) → 영구화.
> - **S-CONFIG-SOT-1 부팅 병합 = 파일 우선**: 부팅 병합에서 `...local` 제거 → `merged = { ...(fileConfig ?? {}), ...(uiConfig ?? {}) }`. 부트스트랩 키(`workspaceRoot`/adkPath·`onboardingComplete`)만 명시 보존. `if(!fileConfig && !uiConfig) return`(read 실패 시 캐시 wipe 방지). `applyWorkspaceConfigToLocal`(전환)과 **동형**(부팅↔전환 비대칭 해소).
> - **S-CONFIG-SOT-2 되쓰기 순서(레이스 차단)**: `syncConfigToFile()` 은 파일→localStorage 하이드레이션 **완료 후에만** 실행(hydrated 플래그 게이트). 하이드레이션 전 스테일 되쓰기 금지. stale-URL 대비 sync 는 하이드레이트 **후** 재실행으로 충족. **AdkSetup 화면 분기에서도 게이트 선개방 금지**(FR-CONFIG-SOT.5, 2026-07-16 실측 클로버). 실 UI 검증 = `e2e/config-sot-boot.spec.ts`(하이드레이션·무클로버·읽기지연 경쟁 3계약).
> - **S-CONFIG-SOT-3 무회귀**: `writeNaiaConfig`·`stripForAgent`·키체인 **무변경**. 107곳 동기 `loadConfig()` 리더 **무변경**(캐시는 유지, 권위만 박탈).
> - **S-CONFIG-SOT-4 UI 설정 SoT 완성 (2026-07-15 회귀 대응)**: 부팅 병합이 파일 우선(`...local` 제거)이 되면, **파일에 SoT 가 없는 키는 매 부팅 기본값으로 리셋된다.** 실제 회귀: 로컬 보이스 호스트(`vllmTtsHost`)가 저장 안 됨 — `UI_ONLY_CONFIG_KEYS`(config.json 에서 strip)이면서 `UI_IDENTITY_KEYS`(ui-config.json 저장 대상, 9개뿐)에 없어 **어느 파일에도 SoT 가 없었다**(localStorage 가 유일 저장소였는데 S-CONFIG-SOT-1 이 그걸 무력화). 따라서 **config.json 에서 빼는 UI 키 = ui-config.json 에 넣는 키**가 정확히 일치해야 한다. `extractUiConfig` 가 `UI_IDENTITY_KEYS`(9개) 대신 `UI_ONLY_CONFIG_KEYS`(전체: theme·panelPosition·vllmTtsHost·ttsProvider·liveProvider·bgmVolume 등)를 뽑도록 확장 → 모든 UI 설정이 ui-config.json 에 저장/로딩. read(`readNaiaUiConfig`)·병합(`mergeBootConfig`/`applyWorkspaceConfigToLocal` 의 `{...file, ...ui}`)은 이미 통짜라 대칭 자동 완성.
> - **검증(P02)**: 부팅 병합 계약(스테일 localStorage persona 를 config.json 이 덮는가) + 되쓰기 게이트 계약(하이드레이션 전 `writeNaiaConfig` 호출 없음) + e2e-tauri(config.json=나이아 / localStorage=알파 → 부팅 → 나이아 유지, config.json 미오염).

### 왜 전수인가 — fault isolation (루크 2026-06-09)

혼자 개발 → **다 작동한다는 보장 없음.** 목표는 "전부 검증"이 아니라 **구조적 이식으로 고장을 가두는 것**: 각 기능이 자기 slice/port 경계에 들어가면, 깨진 기능(Discord·cron·memory recall…)이 *그 슬라이스에 격리*되어 다른 영역으로 안 번진다. 전수 enumerate = 각 기능에 구조적 슬롯을 줘 *고장 전파 차단* + UC11 자기상태가 *어디가 깨졌는지 표면화*. (검증은 그 위에서 점진.)

## 셸 feature 시나리오 (V-tranche 외 · 사용자 우선순위 — 2026-06)

foundation UC 카탈로그와 직교하는 셸 feature(S72 선례). 각 시나리오는 **계약(단위) + 통합(셸 vitest)** 으로 검증, 라이브 네트워크/하드웨어 왕복은 검증 천장(실 앱·GPU) 명시.

| 시나리오 | 사용자 경험 | 인지/레이어 | 검증(P02) |
|---|---|---|---|
| **S-TTS** (#363) | omni 아닌 모델로 음성 대화 시 **소리가 난다**(edge/google/nextain/openai/elevenlabs). 기본 edge 가 무음이면 browser 폴백 | 표현(speech) — 셸이 합성(agent 우회) | `synthesize.test.ts`·`edge-tts.test.ts`·셸 vitest. ⚠️ 라이브 합성=실 앱(naiaKey) |
| **S-CAP** (#365) | 모델을 고르면 그 모델 **능력에 맞춰 설정이 전개**(omni→STT/TTS 슬롯 숨김, 텍스트→노출). gateway 가 능력 선언 | 제어면(설정) — capability manifest 도출 | `test_models.py`·`capability-fetch.test.ts`·`slots.test.ts`. ⚠️ 라이브 /v1/models=게이트웨이 배포 |
| **S-VRAM** (#2) | 내 GPU VRAM 을 감지해 **로컬에서 돌릴 수 있는 tier**(아바타·음성)를 보여주고 선택. opt-in 시 외부 슬롯 대신 로컬 | 제어면(설정) — VRAM→capability 브리지 | `vram-tiers.test.ts`. ⚠️ 실 VRAM 감지=실 GPU, 로컬 serving=windows-manager 로더(DEFER) |
| **S-SLOT** (#gate-slots, 신규 — 2026-06-28) | 설정이 **naia 계정 게이트 → 6 클라우드 슬롯(LLM main·LLM sub·embedding·STT·TTS·video avatar) 각각 독립 설정** 순서로 전개. naia 계정 시 Gemini 기본값 자동 적용. 구 engine/ai/models/memory 분산을 통합해 "설정 헷갈림" 해소. **Naia는 provider가 아닌 접근 유형(게이트)**. local 런타임(cascade)은 별도 "naia-omni local setting" 영역(wm 연동, **DEFER**). legacy 고정 VRAM tier는 R2-3으로 폐기 → capability 토글+VRAM 예산(설계 P1.4) | 제어면(설정) — 게이트+슬롯 모델 | `settings-slots.contract.test.ts`(신규)·`settings-tab.test.ts`·`onboarding-fresh.spec.ts` + Playwright E2E(게이트→클라우드 슬롯 흐름). ⚠️ 로컬 설정 영역(1.2b)·통합 VRAM(1.4)=wm 언블록 후 |
| **S-EMBKO** (한글 오프라인 임베딩, FR-SLOT.6 — 2026-07-15) | 한국어 사용자가 기억(memory) 임베딩을 **CPU 오프라인**으로 돌릴 때, 영어 전용(all-MiniLM/all-mpnet) 대신 **다국어(한국어) 모델을 선택**할 수 있다 — offline 모델 선택지에 `multilingual-e5-large`(1024d) 추가. 백엔드 naia-memory `OfflineEmbeddingProvider` 가 이미 지원(e5 query/passage 프리픽스·`device=cpu` 존중) → **셸이 노출만**(백엔드 무변경, 경계 준수). 기본값 무변경(선택지로만) | 제어면(설정) — 임베딩 슬롯 한글 모델 노출 | `settings-slots.contract.test.ts`(offline 모델 union·roundtrip). ⚠️ 실 다운로드/한글 회상=수동 프리페치 검증(부스 전, 2026-07-16) |
| **S-VREC** (#2 후속, FR-VRAM.4 — 2026-06-30) | GPU 프로파일(VRAM)을 정하면 **그 예산 안에서 각 슬롯에 로컬 추천이 보인다** — 두뇌 탭 GPU 프로파일 아래 추천 요약, 음성/아바타/메인 셀렉터의 추천 옵션 배지, 프로파일 슬롯 개요 배지, 온보딩에도 추천 표시. **외부 슬롯은 숨기지 않고 추천만**(선택·확인은 사용자) | 제어면(설정) — VRAM 예산→슬롯 추천 | `tier-slots.test.ts`(6/6). ⚠️ 실제 로컬 기동=Round 2(wm 로더, DEFER) |
| **S-VOICE** (FR-VOICE — 2026-06-30) | naia-local-voice(로컬 GPU 음성)를 고르면 **로컬 음성 호스트로 합성**(LLM 호스트 오용 수정). 로컬 엔진 미실행/미연결 시 **무료 음성으로 조용히 위장하지 않고** "로컬 음성 미가용"을 1회 명확히 알리고 무음. 음성 picker 채움 | 표현(speech) — 로컬 음성 정직화 | `synthesize.test.ts`(naia-local-voice host 라우팅 3건). ⚠️ 실제 합성 동작=로컬 cascade 기동(Round 2, DEFER) |
| **S-VOICE-AVATAR** (FR-VOICE.5 — 2026-07-15) | 두뇌=로컬 LLM(ollama DNA) · 음성=**원격 omni**(`vllmTtsHost`→`/v1/audio/speech`, 음색 서버 해석) · 아바타=**로컬 Ditto TRT(8g avatar-only)** 인 부스 토폴로지에서, 나이아가 말하면 **셸이 합성한 WAV 가 즉시 재생되면서(AudioQueue) 같은 오디오가 muted 로 Ditto `/stream` 에 흘러 입이 맞춰 움직인다**. avatar-only 파사드는 자체 TTS 가 없으므로 `/stream_text`(텍스트) 폴백은 무음 = 오답. 음성 서버 미가용이면 S-VOICE 정직 원칙(1회 알림+무음, 랜덤/위장 음색 금지) | 표현(speech+avatar) — 원격 음성·로컬 립싱크 합성점 | `synthesize.test.ts`: 신 표면 계약(POST `/v1/audio/speech`·Bearer·voice=naia-default·WAV 패스스루) 5건 + `streamsAvatarPcm` 게이트(naia-local-voice=true·edge/browser=false) 3건 [계약]. 실 립싱크=부스 리허설(수동, 2026-07-16) |
| **S-VRAM-AUTO / S-VOICE-AUTO / S-VOICE-PRESET / S-ECHO** (FR-VRAM.5·VOICE.6·VOICE.7·ECHO.1 — 2026-07-15) | 사용자가 GPU 프로파일에서 **"16GB: 로컬 LLM + 음성"** 하나를 고르면 두뇌(ollama/DNA-4B)·음성(naia-local-voice→로컬 :8910 façade)·아바타(VRM 복원)가 **자동 설정**된다. 원격 GPU(Tailscale) 음성 호스트를 쓰던 사용자는 프로파일을 만져도 그 호스트가 보존된다(로컬 잔재만 교정). 프리셋 음색을 고르면 그 파일명이 façade 팔레트 id 로 전달돼 실제로 음색이 바뀐다(남성 선택 시 남성). 음성 대화 중 나이아 자기 목소리가 마이크로 되들어와도 (1)재생 중 마이크 정지 (2)직전 발화 유사도 스킵으로 사용자 입력에 섞이지 않으며, **"좋아/네" 같은 짧은 정상 답변은 삼켜지지 않는다** | 제어면(프로파일 자동설정) + 표현(음색·에코) | `vram-tiers.test.ts`·`SettingsTab.test.tsx`·`slots-manifest.contract.test.ts`·`synthesize.test.ts`·`echo-text-filter.test.ts`·e2e `settings-slots.spec.ts`(16G 자동설정). 실 음색/에코=부스 리허설(수동 2026-07-16). ⚠️ 부팅 SoT 시크릿/세션키 보존 회귀=후속 |
| **S-BGM-SKILL** (UC8/FR-BGM.1 — 2026-07-16, 시연 크리티컬) | 사용자가 나이아에게 **"잔잔한 음악 틀어줘"** 라고 하면 나이아가 `skill_youtube_bgm` 도구로 BGM 위젯을 제어한다 — 검색(사이드카 :18791) 첫 결과 재생·정지·일시정지·재개·다음/이전(즐겨찾기)·볼륨. 구 monolith 의 내장 BGM 스킬이 new-core 이식에서 누락돼(위젯·사이드카·에이전트 UC8 어댑터는 있으나 **도구 등록 배선 0**) 나이아가 BGM 존재 자체를 몰랐던 갭 해소. 배선 = **패널(환경) 도구 경로**(E1 — agent 무변경): 부팅 등록 → `panel_tool_call` → 셸 실행 → 위젯이 이미 듣는 `bgm_youtube_*` 이벤트 | 환경(ambiance) — 위젯 도구화, 뇌 무변경 | `bgm-skill.test.ts`(액션 라우팅·검색→첫결과·볼륨 clamp·인자검증·이벤트 payload 형상) [단위] + **`e2e/bgm-skill.spec.ts`(실 UI 배선 회귀 가드: (A) 부팅 panel_skills 에 skill_youtube_bgm 등록 (B) 채팅 턴 panel_tool_call → BgmPlayer 실제 재생 `.bgm-icon--playing`)** — 단위테스트로 못 잡는 *배선 누락*(이번 회귀 유형)을 실 UI 로 고정. 실 음악 재생=부스 리허설(수동, 2026-07-16) |
| **S-CASCADE** (FR-CASCADE — Round 2, 2026-06-30) | 설정에서 **"로컬 음성 엔진 시작"** 을 누르면 naia-os가 로컬 cascade(VoxCPM2 등)를 **로컬에서 직접 기동**(원격 아님) — windows-manager loader를 사이드카로 띄워 VRAM 예산 내 서비스를 spawn·감독, 준비되면 사용 가능. "중지"로 내림. 8GB는 음성 단독(6.9G)까지. | 제어면/표현 — 로컬 cascade lifecycle 임베딩 | windows-manager `test_launcher.py`(9) · naia-os cargo check · `cascade-toggle` UI. ⚠️ 실기동 RTF/모델·venv 설치=R2.3(DEFER) |
| **S-8G** (8G 재티어링, 2026-07-08) | 8GB GPU 사용자가 프로파일에서 **로컬 집중 3모드 택1**(로컬 LLM만 / 비디오 아바타만 / 둘 다) — 동시 구동 불가라 배타 선택, **음성은 8G에선 항상 클라우드**. VRAM 부족 시 로컬 LLM이 클라우드로 강등되며 그 사실을 **정직히 알림**(무료 위장 금지). 아바타는 로컬 avatar 제공(또는 로그인) 없으면 선택 불가 | 제어면(설정) — 8G 배타 capability 해소 + VRAM 프리플라이트 | `vram-tiers.test.ts`·wm `test_manifest.py`(focus 배타·비8G 무시·voice→avatar)·`capability-settings.spec.ts`(FR-5 focus 3옵션·FR-6 립싱크·FR-7 아바타 게이트). ⚠️ 실 아바타 렌더 RTF=실 GPU(사용자 실기) |
| **S-CASCADE-T3** (원격 cascade, 2026-07-15) | 로그인 사용자가 아바타 설정에서 **NVA를 선택하고 Host URL**을 입력해 검증된 원격 cascade에 연결한다. 명시한 Host가 로컬 파사드보다 우선한다. `health → query 없는 /idle 전체 MP4 Blob 재생`과 `/stream` 첫 재생 프레임까지 검증하며 원격 `/load_nva`에 Windows 경로를 보내지 않는다. | 제어면(설정) + 표시계면(NVA idle/발화) | `config.test.ts`·`capability-settings.spec.ts`·`nva-remote-idle.live.spec.ts`의 opt-in 실 원격 테스트 |
| **S-VN** (#ui-reorg, 신규 — 2026-06-29) | 홈(기본) 화면에서 naia와 **몰입형 VN 대화** — 전체화면 VRM 아바타 + 하단 넓은 대화박스(탭 없는 집중형). 좁게 떠 있던 채팅 패널 제거("대화 집중 안 됨" 해소) | 표현(셸 UI) — 단일 ChatPanel을 CSS로 재배치(variant=vn), 무리마운트 | `119-pty-terminal.spec.ts` T6(VN variant 노출). ⚠️ 미감=실 앱 |
| **S-WS4** (#ui-reorg) | 워크스페이스 진입 시 **4단 관제탑**: 대화창(좌 레일)·워크트리·문서뷰어(상)+터미널(하)·서브에이전트 리스트. 레일 접기·상하 비율 자유 리사이즈·터미널 탭/그리드 | 표현(셸 UI) — App.tsx `data-ui-mode` 파생 + WorkspaceCenterPanel center 상하분할 | T7(레일 variant)·T8(레일 접기 시 ChatPanel 무리마운트)·T9(문서뷰어/터미널 분할) + 91 18/18(무회귀) |
| **S-DOC** (#ui-reorg) | 대량 작업문서를 **탭으로 유지·전환**(문서 탭바)해 "터미널에서 문서 찾기 어려움" 해소. 서브에이전트 클릭 시 그 에이전트 최근문서가 탭으로 surface. Ctrl+P QuickOpen 유지 | 표현(셸 UI) — `openDocs` 상태 + DocTabBar | T10(세션 클릭→문서 탭 surface) + 91 S3/S6(에디터 무회귀) |
| **S-ASK** (#ui-reorg) | 터미널 출력의 파일경로 **클릭=문서뷰어에서 열기 / Alt+클릭=대화창에 AI 질의**. 문서 탭에도 AI 질의(✦) 버튼 | 표현(셸 UI) — Terminal link provider Alt 분기 + 기존 `naia:ask-ai` 재사용 | `Terminal.tsx` activate Alt 분기. ⚠️ xterm 링크 클릭=실 앱 |
| **S-INSTALL** (#377, FR-INSTALL — 2026-07-17) | 사용자가 **설치 파일을 받아 자기 OS(Windows/Linux/macOS)에 설치하고 첫 실행**한다 — Windows 는 NSIS(사용자 권한, 관리자 불요, **WSL 불요**) + MSI(관리자 설치 — WiX 표준), Linux 는 deb/rpm/AppImage, macOS 는 app/dmg(**arm64(Apple Silicon) 전용** · 미서명 — 우클릭 열기). Node 런타임이 3 OS 모두 동봉되어 **Node 미설치 머신에서도 에이전트가 뜬다**. 개발자는 clean checkout 에서 **명령 1개**로 자기 OS 의 설치 파일을 재현 빌드한다(수동 파일 배치 0). 플랫폼 차이(타깃·동봉 리소스·설치자 설정·기대 산출물)는 **매트릭스 데이터 1곳**이 정의하고, 스크립트는 OS 별 분리 없이 1개 | 배포(설치·첫 부팅) — 매트릭스→생성 conf, OS 분기=데이터 | `scripts/__tests__/platform-matrix.test.ts`(매트릭스 스키마 + conf 생성 golden, 3 OS) [단위] · `check-build-contract.mjs` PASS [계약] · **Windows 실측: 실 NSIS 무인 설치(/S) → 설치본 기동 — 핸드셰이크 AND `[Naia] node = ` 포함 줄이 최소 2줄 AND 전부 `$INSTDIR` 하위**(2조건, FR-INSTALL.4 — 빌드 머신엔 시스템 node 가 있어 기동만으론 번들 분기가 증명 안 됨. 개수 단언은 공허참 차단)(e2e-tauri `TAURI_BINARY` 설치 경로 지정) · **Linux: CI ubuntu job 이 deb 설치 → xvfb 기동 스모크 — 마커 `[Naia] agent-core gRPC @` **AND** node 줄 최소 2줄 **AND** 그 경로가 전부 설치본 resource_dir 하위**(R5: "PATH 에서 node 제거" 는 폐기 — 폴백이 PATH 무관하게 nvm 디렉토리를 직접 스캔하므로 번들 node 를 증명하지 못함. mutation probe 로 red 도 확인) — **Windows·Linux 양쪽 모두 판정 범위 = 마지막 `=== Session started ===` 포함 줄 이후**(`naia.log` 는 누적 파일) · macOS 실빌드 = CI(`build-installers.yml`) · **산출물 검증 스크립트 `scripts/verify-artifacts.mjs` 실행(빌드 머신 + CI 3 OS) + 부정(negative) 케이스 단위 테스트**(FR-INSTALL.6). ⚠️ mac = **arm64 전용**(CI `macos-latest` = arm64 러너, Intel 산출물 미제공 — 후속) + 실기기 설치 실측 미보유(정직 표기: 이번 완료선 = arm64 CI 빌드 성공) |

> 격리 라벨: S-VRAM 의 로컬 serving/auto-download = `unimplemented`(loader device RTF gate, private tier manifest). S-TTS/S-CAP 라이브 왕복 = 측정 천장(실 앱), 코드 결함 격리 아님.

> **UC-AV 비디오 아바타 + 음성 cascade (8G 재티어링 + T1/T3 소싱 — 2026-07-08~09 SoT)**: 사용자가 로컬 GPU 로 비디오 아바타·음성·LLM 을 VRAM 예산 안에서 취사선택하고, cascade 를 로컬 네이티브(T1) 또는 원격 URL(T3)로 소싱한다. **"항상 cascade *계약*(파사드 :8910)이지 프로세스가 아니다."** SoT = alpha-adk `.agents/progress/naia-video-avatar-voice-architecture-sot-2026-07-08.md`. (S-8G·S-CASCADE-T3 행의 UC-레벨 상술.)
> - **UC-AV.1 8G 로컬 집중 3모드**: 8GB 사용자가 프로파일에서 로컬 집중 택1(로컬 LLM만 / 비디오 아바타만 / 둘 다) — 동시 구동 불가라 배타. 음성(VoxCPM2)은 8G 에선 **항상 클라우드**. 기본=llm(프라이버시). 수용기준: focus 셀렉터 3옵션 노출·resolveLocalCapabilities 배타 해소(llm→[llm]·avatar→[avatar]·both→[llm,avatar])·tts 로컬 제거. 검증(P02): `vram-tiers.test.ts`(resolveLocalCapabilities·normalizeLocal8gFocus)·wm `test_manifest.py`(focus 배타·voice→avatar 마이그레이션·비8G 무시·**tts_ 전체 스트립**)·`capability-settings.spec.ts` FR-5.
> - **UC-AV.2 VRAM 프리플라이트 강등(정직)**: free VRAM 부족 시 로컬 LLM→클라우드 강등 + 명확 경고(무료/로컬 위장 금지). ★실측: 8G both(llm 4.0 + avatar 2.6 = 6.6) > 프로덕션 budget(8 − margin 1.5 = 6.5) → **LLM 강등(아바타만 로컬)**. 수용기준: `llmFallbackToCloud=true` 시 `local-llm-vram-fallback` 배지. 검증: `vram-tiers.test.ts`(fit 폴백 + margin 1.5 fidelity)·`capability-settings.spec.ts`(fallback 배지).
> - **UC-AV.3 아바타 cascade capability 게이트**: 비디오 아바타는 로컬 avatar 제공(또는 naia 로그인) 없으면 선택 불가 + 안내(`avatar-cascade-required`). 검증: `capability-settings.spec.ts` FR-7(게이트·로그아웃 교차).
> - **UC-AV.4 립싱크 노트**: 비디오 아바타 선택 + TTS off → "립싱크엔 TTS 필요" 경고(`nva-lipsync-note`). 8G avatar 모드=음성 클라우드라 TTS 필수 안내. 검증: `capability-settings.spec.ts` FR-6.
> - **UC-AV.5 T1 로컬 네이티브 cascade auto-spawn**: wm `loader launch` → 파사드 :8910 + VRAM 예산 내 서비스(Ditto TRT :8902 / VoxCPM2 :8901) spawn·감독, stdout `CASCADE_READY {json}` 핸드셰이크, 자식 사망 시 teardown. **★실증 2026-07-09 (이 RTX 4060 8GB)**: 3서비스 완전 spawn·`CASCADE_READY`·full 모드 — Ditto TRT SDK ready 7.7s(tensorrt-native)·VoxCPM2 int8 CUDA bfloat16 로드·파사드 `avatar_enabled+tts_enabled`. naia-shell 앱 자체 launch 도 파사드 기동 확인. 검증: wm `test_launcher.py`·`test_service_plan.py`·loader plan/launch 실행·naia-shell Rust `start_cascade`. ⚠️ **얼굴 프레임 렌더 = NVA 캐릭터 번들 로드(/load_nva=추출 dir) 후**(P4 통합, 앱이 캐릭터 config 로 처리) — measurement-gated(F1), 사용자 실기.
> - **UC-AV.6 T3 원격 cascade URL**: 로그인 사용자가 아바타 설정에서 NVA 선택 후 `cascadeRuntimeUrl`을 입력한다. URL은 http/https만 허용하고 정규화한다. 명시한 NVA Host가 로컬 파사드보다 우선하며 원격 장애 시 로컬 Ditto를 암묵 기동하지 않는다. 원격 뷰어는 `GET /health` 후 query 없는 `GET /idle` 전체 응답을 Blob URL로 반복 재생하며, `/load_nva.dir`이 서버 로컬 경로라는 계약 때문에 원격 서버에는 이를 호출하지 않는다.
> - **UC-AV.8 원격 NVA 결합 발화**: 명시한 원격 NVA Host가 있으면 응답 텍스트를 `/stream_text`로 보내고 서버가 mux한 VoxCPM2 음성+아바타 영상을 그대로 재생한다. 이 경로에서는 Shell의 별도 음성 호스트를 호출하거나 음성을 중복 재생하지 않는다. 배경 투명은 원격 cascade의 VP9 알파 출력이 활성일 때만 제공한다.
> - **UC-AV.7 voiceprint 불변(NFR)**: naia 가 VoxCPM2 를 쓸 때 **음성지문(ref) 필수**(무지문 합성 금지). 8G 는 로컬 음성 없음(클라우드)이라 무지문 옵션 불요. 검증: naia-omni-cascade `tts_voxcpm2.py`(require_voiceprint=True)·`test_integration_smoke.py`(guard)·`cascade-contract-governance.md` §5.5. ★실측: 파사드 `/ref/voices`=음성지문 10개(ref_ko_485 기본 등) 노출.

## S-RADIO-DJ — 개인 라디오 DJ·행사 소개 (Shell 기본 스킬, #362 계획)

| 시나리오 ID | 사용자 흐름 / 완료 조건 | 책임·검증 |
|---|---|---|
| **S-RADIO-DJ-1** | 사용자가 DJ 모드에서 곡을 요청하면 Shell은 `requested → loading → playing`의 실제 관측값, 곡 정보·길이·진행 위치를 반환한다. 곡 A 다음 곡 B로 바꾼 뒤 늦게 도착한 A 오류는 B의 상태나 소개를 바꾸지 않는다. | Shell 관측 사실: FR-RADIO-DJ.1~2. 로컬 fixture E2E: A→B→late A error. |
| **S-RADIO-DJ-2** | YouTube가 재생 불가·임베드 제한·로딩 시간초과이면 DJ는 재생 성공처럼 말하지 않는다. 자동재생 opt-in일 때만 대체곡을 한 번 시도하고, 그 외에는 한 번의 짧은 안내 또는 침묵으로 끝낸다. | Shell 오류 분류 + agent의 근거 있는 멘트: FR-RADIO-DJ.2·5. |
| **S-RADIO-DJ-3** | 연속 발화·DJ·행사 소개에서 agent가 다음 발화 전 Shell 관측값을 확인한다. 곡이 충분히 진행되지 않았거나 쿨다운 중이거나 사용자가 말하는 중이면 새 멘트와 TTS를 만들지 않는다. `speakPermit` 발급 뒤 사용자 발화/채팅이 시작하거나 재생 sequence가 바뀌면 permit을 폐기하고 DJ TTS는 0회여야 한다. | agent 소유 스케줄러, Shell의 단일 사용 permit·원자적 TTS 직전 재검증: FR-RADIO-DJ.3~4. |
| **S-RADIO-DJ-4** | 동의한 사용자에게만 유효한 IANA 시간대와 신선한 날씨 결과를 DJ/행사 맥락에 맞게 짧게 쓴다. 동의를 철회하면 원 좌표와 날씨 캐시가 폐기되고 이후 멘트에 날씨가 나오지 않는다. 잘못된 시간대는 정규화/시간 언급 비활성으로 관측 가능하게 처리하며, DST 경계도 일관되게 계산한다. | 최소 노출·TTL·정밀도·폐기·유효/무효 IANA·DST 검증: FR-RADIO-DJ.6~7. |
| **S-RADIO-DJ-5** | DJ가 곡 제목·아티스트·길이를 언급할 때는 현재 `playbackId`의 관측된 `playing` 결과에 근거한다. 명령 접수 성공만으로는 소개하지 않는다. 5초가 지난 `playing` 스냅샷이 `ended/error`로 바뀌면 재관측 뒤 소개·TTS를 하지 않는다. | 도구 결과→activity provenance·freshness 계약: FR-RADIO-DJ.1·5. |
| **S-RADIO-DJ-6** | CI는 외부 YouTube 의존 없이 로컬 iframe event fixture로 ready/playing/error/ended와 도구 결과·발화 조건을 검증한다. 실제 YouTube 검증은 부스/릴리스 전 선택적 smoke로 분리한다. | 결정론적 Tauri E2E + 선택적 smoke: FR-RADIO-DJ.7. |
## Test Coverage Map (P02)

각 시나리오의 **검증 3단(verification stack)** — 어느 하나로 "됐다" 판정 금지(R1 codex·gemini 보강):
1. **Old-Baseline 측정**(이식 *전*, old): 입력/출력 trace + **상태 전이**(세션·캐시·fs·프로세스·권한 = hidden state, trace만으론 부족) + 설정/버전/키 상태 + **오류 분류축**(아래). **환경 정규화**(외부 의존 stub/mock → 루크 env 부작용을 코드 로직으로 오인 방지). **flaky**=1회 측정 금지, 반복+안정도 표기. **record-replay 한계**(외부시간·랜덤·네트워크·ws/streaming 재현 불안정) 명시.
2. **계약 테스트(contract, port)**: 시그니처·불변식 **+ 오류 의미론·timeout·cancel·retry·partial·ordering·idempotency**(adapter 공통이라 필수). 0토큰 결정론(conform-gate).
3. **통합 테스트(integration)**: 인지흐름 관통(감각→…→표현) + golden 행동 등가 **+ Negative/부정 path**(거부될 요청·승인실패·권한부족·미지원 환경·timeout·침묵) **+ downstream contamination**(상태보고 실패가 planning/route/skill 선택 오판 일으키나).

**검증 ≠ 이식 성공만**: contract+integration GREEN 이어도 baseline 행동과 다르면 FAIL(drift-gate). happy-path만 GREEN = 가짜성공(Negative 필수).
- **drift-gate 차등 필터(R2)**: trivial 상태차(timestamp·PID·랜덤·경로) 정규화 제외, *의미 있는* 상태/출력 차만 FAIL.
- **측정 간 상태 격리(R2 codex)**: 반복 측정·이식본 비교 전 workspace write·pty·cache·session **리셋/롤백**(잔존 상태를 로직 회귀로 오판 방지). 환경 정규화 = 측정 스크립트가 외부 키/엔드포인트 stub 강제(루크 env 부작용 분리).

### 오류 분류축 (R1) — 모든 측정/실패에 라벨
**2개 직교 축(R4)**:
- **오류-유형 축**: `auth · infra · timeout · flaky · old-bug · new-regression`.
- **민감-도메인 축(직교)**: `security · policy · approval · safety`(해당 시 라벨).
→ "깨짐"을 baseline 에 뭉뚱그리지 않음. **거버넌스(결정론 집행)**: `new-regression` = 무조건 FAIL. **(민감-도메인) ∩ (old-bug)** = 자동 FAIL + tranche exit 차단(승계·격리만으로 통과 금지). 그 외 `old-bug` = 승계 가능(별도 결정).

### ⚠️ 측정 불가/깨짐 ≠ baseline (R1 수렴 — 핵심 교정)
미배선(memory·cron)·깨짐(Discord)·disabled(memory backup)는 **golden baseline 아님** → **별도 "기능 격리/면제 목록"** 으로. **격리 상태 라벨(비-bug, 오류-유형 축과 별개)**: `unwired · unimplemented · disabled-by-design · unsupported-env` + 사유. ⚠️ **적용 자격(R7)**: 격리는 *old-baseline 에서도 본래 부재/비지원이 확인된 경우에만* 허용 — old 에서 **작동하던 것의 상실**은 격리 불가 = `new-regression` FAIL(재라벨 우회 차단). baseline 에 넣으면 *구현 실패*와 *원래 없음*이 섞여 **regression 은닉 장치**가 됨(codex). 격리 목록 항목은 slice 격리 + UC11 자기상태 보고 대상. **거버넌스(R2): high-importance 격리 항목은 해당 tranche exit 를 차단**(중요도만 적고 진행 금지 — 루크 명시 면제만 통과).

### baseline 갱신·coverage 규칙 (R1)
- **old-bug 승계 vs new 교정**: old 버그 *승계(동일 재현)* 기본, 교정은 별도 결정. ⚠️ **단 민감-도메인(security/policy/approval/safety) old-bug = 승계 금지**(명시 승인 필요) — deny-by-default 우선(R2 codex, R5 safety 포함).
- **coverage = 중요도 기준**(루크 측정가능성 skew 방지): 측정 불가여도 중요 시나리오는 격리 목록에 *중요도* 명시(후순위 자동화 방지).

### deny-by-default 선잠금 (R1 codex — F3 전)
`ApprovalPort` 최소 계약(승인 부재·거부·만료·중복·승인후 컨텍스트변경)을 **F3 진입 전**(F1 계약 수준)에 먼저 잠금 — 안 그러면 F1~F2 통합이 과권한/우회 전제로 굴러감.

### per-skill 샘플링 (R1 — coverage illusion 방지)
default-skills 60+ "각 1회 측정"=존재확인≠동작보장(공통 runtime/auth/env/schema drift 공유). → **capability class 대표 샘플 + 변이점별 예외 샘플**(통계 추론). **샘플 manifest 고정(R3)**: class별 ≥1 대표 + 알려진 변이축(auth·env·schema·runtime)별 예외 1 = 고정 목록(리뷰어/tranche 무관 동일, coverage drift 방지).

### Foundation tranche 테스트 매핑 (F0~F3 구체) — *provisional(실측 전 추정), Old-Baseline 측정 후 final*

| 단계 | 시나리오 | Old-Baseline 측정 | 계약 테스트 | 통합 테스트(인지흐름) |
|---|---|---|---|---|
| **F0** | UC12-min workspace init(최소 부팅, 외부키X) | naia-adk 부팅·workspace init trace | config/control-plane port | 부팅→workspace 준비 / **negative**: 손상·부분 설정→정직 보고(차단/비차단은 손상 유형별 계약 — fail-closed 차단도 정상일 수 있음) |
| **F1** | S09/S10/S11 자기상태 · S44 degradation · S52 facts · **+ApprovalPort 최소계약 선잠금** | system-status·diagnostics·device 상태 trace **+ 승인 플로우(부재·거부·만료·중복·승인후변경) 상태전이 trace** | `InteroceptivePort`(read-only 최소) **+ `ApprovalPort` 최소계약** | 내수용→지각→정직 보고 / **negative(exit-block)**: 승인부재·거부 시 행위 차단·degradation 오보 금지 / **downstream contamination**: 상태/승인 실패가 planning·route·skill 선택 오판으로 전염되지 않음 |
| **F2** | S07a workspace 관측(read-only) | workspace_* read 류 trace | `EnvironmentPort`(host-system) observe | 사고→환경 관측 / **negative(exit-block)**: 권한 밖 경로 거부·미지원 환경 정직 보고 |
| **F3** | S07 workspace 조작 + S12 승인 | workspace write·pty trace + 승인 흐름 + **거부/권한부족/timeout trace** | `EnvironmentPort` mutate + `ApprovalPort` | 승인→환경 행위→**observed→mismatch** / **negative(exit-block)**: 승인거부·권한부족→행위 차단; timeout→부분반영·rollback불가 시 *결과 미확정 정직 보고*(rollback 항상 가능 가정 금지) |

### 나머지 시나리오 매핑 (템플릿 — 각 tranche 착수 시 구체화)

| 묶음 | 시나리오 | 검증 핵심 |
|---|---|---|
| V1 텍스트 | S13 | provider 키 검증(Old-Baseline) → ChatPort 계약 → 대화 1회전 통합 |
| V2 음성 | S14~S19·S49·S50·S66 | voice ws/키/GPU Old-Baseline → voice provider·ExpressionPort 계약 → 감각→음성+아바타 통합 |
| 도구 | S20~S25·S55·S56·S71(per-skill) | skill/mcp/gateway Old-Baseline → SkillPort 계약 → 도구 호출 통합. **default-skills 60+ = capability-class 대표+변이점 샘플**(per-skill 전수 아님) |
| 환경-앱 | S26~S30·S62~S64·S70 | 브라우저/워크스페이스 group Old-Baseline → EnvironmentPort.app-surface 계약 |
| 환경-공간 | S31·S32 | BGM/배경 Old-Baseline → EnvironmentPort.space |
| 채널 | S35~S39·S60 | 외부 인증 Old-Baseline(깨짐 분류) → channels/ClientSessionPort |
| 설정·control | S01~S08·S47·S51·S53·S54·S57~S59·S67 | control-plane Old-Baseline → 각 port |
| 설정 SoT | S72 · **UC-CONFIG-SOT** | **부팅 병합 계약**: `mergeBootConfig({local,file,ui})` 순수함수 = 파일 절대 우선(스테일 localStorage persona 를 config.json 이 덮는가) → `lib/__tests__/config-boot-merge.test.ts` [계약] / **되쓰기 게이트**: 하이드레이션 전 `syncConfigToFile` 호출 없음 → 동 파일 [계약] / **e2e-tauri**(⚠️ 미작성 — 2026-07-15 리뷰 적발, 실 파일 부재): config.json=나이아 · localStorage=알파 → 부팅 → 나이아 유지·config.json 미오염 시나리오는 단위 계약(`config-boot-merge.test.ts`)으로만 검증됨, e2e-tauri 통합 스펙은 **후속 작성 대상**(P04 미충족 명시) |
| OS-core(DEFER) | S45·S46 | SafetyPort·ClientSessionPort 계약(F3 후) |
| 보류 | S41·S42·S52b | naia-memory 트랙(미배선 = **격리/면제 목록**, golden baseline 아님) |

> P02 착수 = **F0~F3 Old-Baseline 측정부터**. F0~F3 은 로컬·외부키X·read-only/승인 범위라 **루크 게이트 없이 측정 가능**(R6). 루크 게이트(실구동·키·env)는 *외부 의존* 측정(V1/V2·채널·voice)에만. 측정 결과로 계약·통합 테스트 구체화.

## 기반 성숙도 (vertical 선정 1순위 기준 — 검증된 subsystem 위에 올려야)

첫 vertical 목적 = *이식 방법론이 인지흐름 1회전을 제대로 도는지* 검증. **검증 안 된 subsystem 위에 올리면 "이식 실패 vs subsystem 실패"가 섞여 vertical 이 무의미.** → 기반이 *이미 검증된* UC 를 골라 transplant 만 격리 검증.

> ⚠️ 아래 "검증" 열 = **old-naia-os *소스* 기능 검증 상태 = 이식 golden 기준선의 존재/신뢰도**. *이식 완료도 아님*(이식은 아직 0, step-1 막 닫힘). old가 known-good 이어야 이식 후 golden-trace/record-replay 로 "이식본 ≡ old 동작"을 격리 검증 가능. old에 없는 기능(memory)은 기준선 자체가 없어 vertical 불가.

> ⚠️ **실측 경고(루크 2026-06-08)**: 아래 "기준선" 열은 **아직 실제로 돌려보지 않은 추정**. "예전엔 됐다" ≠ "지금 된다". 외부 인증/키 의존 기능은 토큰 만료로 *지금 깨진* 경우가 많음(예: **Discord = 앱 인증 풀린 듯**). **vertical 선정 전 = 후보 기능을 old-naia-os에서 *실제 기동·작동 확인*(golden 기준선 확립)이 필수 선행.**

| UC | 기반 subsystem | 의존성 | 기준선 상태(실측 전 추정) |
|---|---|---|---|
| UC1 텍스트 | llm provider | 외부 키(LLM API/gateway) | 키 유효 시 작동 추정 — **실측 필요** |
| UC2 음성 | voice cascade(omni)·아바타 | gateway realtime·키·GPU | 라이브 데모 이력 있으나 **현 작동 실측 필요**(키/서버 의존) |
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

## 결정/잠정
- Foundation tranche 순서 F0→…→V2 = **아이디어 수준 잠정**(루크: 우선 적어둔 것, 실행 시 재검토 — 못 박은 결정 아님). G1 = 게이트로 두지 않음.
- botmadang(S65) = **rejected**(이식 제외, 명확 결정).

## 셸 feature 시나리오 — 지식 근거→원문 + 그래프 (K2·K3, kb-compiler 통합 — 2026-06-30)

도구·환경 tranche(UC5 도구·UC6 브라우저·UC7 워크스페이스)의 셸측 슬라이스. 사용자가 워크스페이스 지식을 물으면, 에이전트가 `skill_knowledge_ask`/`search`(naia-agent **UC-KNOWLEDGE**, kb-compiler backend — 별 레포 live)로 **근거 있는 답변**을 내고, 셸이 그 tool-result(JSON)를 **답변 + 출처 칩**으로 렌더한다(K2). 출처 칩 클릭 시 **근거→원문**: URL=브라우저 패널(UC6), 워크스페이스 파일=파일뷰어(UC7)로 원문이 열린다. 근거 없으면 **기권**(칩 없음). 또한 `skill_knowledge_graph` 결과는 셸이 **2D/3D 캔버스 그래프**(엔티티·관계·군집색·degree 크기, 2D↔3D 토글)로 시각화한다(K3).

- **인지흐름**: (사고)지식 질의 → (표현)근거 답변+출처·지식 그래프 → (행위)칩 클릭→원문 패널 전환. 백엔드 배선·계약 = naia-agent(별 레포), 셸 렌더·dispatch·뷰어 = 본 feature(기존 브라우저/워크스페이스 패널 api 재사용·그래프 의존성 0 캔버스, 신규 사이드카 0).
- **검증(P02)**: requirements.md **FR-KB-OS.1~4** 매핑 — `knowledge-result.test.ts`(파싱·분류·그래프 파싱 단위)·`knowledge-tool-result.test.tsx`(RTL 렌더+칩 dispatch)·`e2e/chat-tools.spec.ts` "지식 도구(K2)"·"지식 그래프(K3)"(Playwright 실 UI: 답변+칩+칩클릭→브라우저 패널 / 그래프 캔버스 렌더+2D/3D 토글). tsc0.
- 통합 설계 SoT = alpha-adk `.agents/progress/naia-kb-compiler-agent-os-integration-2026-06-29.md`. 전용 그래프 패널(on-demand fetch) = post-MVP. 설정 지식 탭(관리 compile/소스) = 아래 UC-KB-MANAGE.

## UC-KB-MANAGE — 지식 소스 관리 설정 탭 (K4, kb-compiler 통합 — 2026-06-30)

사용자가 설정>지식 탭에서 **자기 워크스페이스의 지식 소스(자료 폴더)를 직접 관리**한다. "준비 중" 자리를 실제 관리면이 대체한다: ①여러 자료 폴더를 추가/제거(폴더 선택 다이얼로그)하고, ②현재 **지식 스코프(프로젝트)** 와 **컴파일 상태**(카드·엔티티·관계 수, 또는 "미컴파일")를 보고, ③"지금 컴파일"로 등록 폴더 → 구조화 지식(kb.json)을 빌드한다. 빌드된 지식은 채팅에서 근거 답변(UC-KNOWLEDGE)으로 소비된다.

- **소유 경계(핵심)**: 이 설정(소스·스코프)은 **사람이 셸 UI 로만** 바꾼다 → `naia-settings/knowledge.json`(셸 전용 write). **AI 에이전트는 읽기만** 하고 설정을 못 바꾼다(config-write 도구 부재 = 신뢰경계 자가확장 차단). 사람=설정, 엔진=컴파일 산출(kb.json) 분리.
- **인지흐름/역할**: (관리)셸 UI 폴더 등록·스코프 → (지능)에이전트가 `CompileKnowledge`(naia-agent, 별 레포)로 폴더 → kb-compiler `compile()` → `knowledge/<scope>/kb.json` 저장 → (소비)채팅 근거 답변. 셸 = 관리 UI·상태 표시·트리거(직접 `invoke`, AI 미경유). 컴파일/답변 지능 = 에이전트.
- **검증(P02)**: requirements.md **FR-KB-OS.5~9** 매핑 — `knowledge-config.test.ts`(config CRUD·dedup·kb 통계 파싱 단위)·`KnowledgeSettingsTab.test.tsx`(RTL 폴더 add/remove·스코프·상태 렌더)·`e2e/settings-knowledge.spec.ts`(Playwright 실 UI: 설정 지식 탭 폴더 추가/제거/상태 표시). 컴파일 트리거(FR-KB-OS.8)는 에이전트 `CompileKnowledge` 배선에 의존(미배선 시 정직 표기).
- 통합 설계 SoT = alpha-adk `.agents/progress/naia-kb-compiler-agent-os-integration-2026-06-29.md`(K4).

## 해소·DEFER (재논 금지)
- ~~UC7 포트 축~~ = 해소(R1): UC7 = `EnvironmentPort`(host-system). `ActionPort`=body movement(별개).
- OS-core(UC10a·UC13a) = P01 시나리오 **포함 확정**, 구현 DEFER(F3 후).
- step-2 계약 backlog(goal-governance 소유자·포트 시그니처 등) = DEFER(step-2 계약 단계).
- notify/memo(non-memory) 독립 UC 여부 = **Old-Baseline 측정 시 확인**(DEFER).

## UC17 — 자유·연속 발화 session stream (#82 cross-repo)

naia-agent가 사용자 요청의 기존 `Chat` stream에서 연속 발화를 보내거나, idle/cron 같은 외부 정책으로
사용자 입력 없이 자유 발화를 시작한다. 셸은 agent 연결 뒤 현재 대화 session의
`SubscribeSpeechActivities` 장기 stream을 정확히 하나 구독하고, 받은 `AgentEvent.request_id`를 기존
`agent_response` JSON으로 변환해 기존 텍스트·TTS·아바타 표현 경로에 그대로 넣는다.

- 요청 기반 연속 발화는 기존 `Chat` stream을 그대로 소비해 셸 상태 기계를 추가하지 않는다.
- 자유 발화 event도 기존 `agent_response`와 동일한 폐쇄 union이라 별도 UI 이벤트 형식을 만들지 않는다.
- session 구독 해제·agent 재시작은 보이지 않는 활동을 계속하지 않도록 server의 cancelled 정지로 이어진다.
- 사용자가 받은 requestId+activityId로 self-init activity cancel을 보내면 provider/발화 사이 대기가
  함께 취소된다. requestGeneration은 requested Chat에만 사용한다. activityId 관측 전과 session 전체
  명시 정지는 `StopSpeechActivity`가 담당한다.
- unsolicited activity는 ordinary Chat의 currentRequestId 필터와 별도로 수용한다. 사용자 입력은
  TTS를 먼저 중단하고 `YieldSpeechActivity`가 반환한 resumeToken/profileGeneration을 Chat에 실어
  즉시 보내며 queue 뒤에 가두지 않는다. quiet/stop은 terminal Stop을 쓴다. 이전 activityId 또는
  profileGeneration의 늦은 text/audio는 재생하지 않는다.
- 중복 session 구독은 만들지 않고, dispatcher 종료 시 모든 구독 task를 종료한다. 반복·시간·기억 상태는
  agent 소유이며 셸은 복제하지 않는다.

P02 검증:

- Rust 단위/계약: `agent_grpc.rs`의 activity event 변환, subscribe/stop 요청, 같은 session 중복 구독 방지.
- 실 백엔드/계약: `agent_grpc.rs`가 agent spawn → session subscribe → self-init
  text/usage/finish → 기존 `agent_response`, requestId cancel/stop, disconnect 정리를 검증.
- 프론트 계약: ChatArea에서 unsolicited activity 표시/TTS, `interruptTts → yield/stop → Chat` 순서,
  stale audio/text 폐기를 검증한다.
- 실제 Tauri `71-proactive-speech-profiles.spec.ts`: profile 저장·복원, 개인 DJ의 실제 YouTube BGM·첫
  결과 text·stop, 전시 greeting·stop만 검증한다. 이 테스트는 TTS를 꺼 두므로 audible TTS, DJ 멘트2,
  전시 질문 barge-in→답변→resume, 모든 control, stale audio 폐기를 native로 증명하지 않는다.

Test Coverage Map:

- UC17 / FR-CONT-SHELL.1~7 → Rust `agent_grpc` contract+live tests,
  `packages/shell/e2e-tauri` 시작/표현 일부 full-stack, 기존 `src/main/adapters/tauri/uc1`·ChatArea cancel 회귀.
- FR-CONT-SHELL.8 / PA-DJ-04 UC test → `packages/shell/e2e-tauri/specs/71-proactive-speech-profiles.spec.ts`
  `persists validated proactive settings after cache-clear native reload`; FE tests →
  `packages/shell/src/lib/__tests__/proactive-speech-settings.test.ts` `normalizes proactive settings fail-closed`와
  `packages/shell/src/components/__tests__/SettingsTab.proactive-speech.test.tsx`
  `edits and persists proactive speech settings`.
- FR-CONT-SHELL.9 / PA-DJ-05·PA-EX-01 UC tests →
  `packages/shell/e2e/121-proactive-speech-product-acceptance.spec.ts`
  `speaks proactive text through browser TTS`, `plays synthesized proactive audio`,
  `interrupts before every DJ control and drops stale output`,
  `ordinary chat interrupts before yielding the active exhibition`;
  native `packages/shell/e2e-tauri/specs/71-proactive-speech-profiles.spec.ts`
  `starts and persists personal radio DJ through the real Tauri IPC path`,
  `persists validated proactive settings after cache-clear native reload`,
  `starts exhibition introduction without waiting for ordinary chat`.

## UC-WIRE-V1 — 이미지·Discord·RAG·처리 공개 공통 채팅 경계 (#384 / naia-agent #89)

셸 사용자는 기존 텍스트 대화를 그대로 사용하면서 필요할 때 안전한 이미지 참조,
Discord 채널 결속, 지식 범위, provider session, 처리 profile을 함께 보낸다.
셸은 원시 이미지 bytes, Discord token, provider thread id, endpoint 또는 지식
원문을 wire에 넣지 않는다.

- 구조화 입력은 public `chat-service`와 new-core/Tauri 경로가 같은 필드 이름과
  선택성 규칙을 보존한다.
- 구조화 출력은 grounding 출처, image artifact, provider-session lifecycle,
  처리 위치 공개를 본문과 분리해 소비한다.
- 오류는 안정 code로 분기하고 사용자 표시 문구는 셸 i18n에서 결정한다.
- Rust는 `NAIA_AGENT_PROTO_DIR`로 지정한 paired Agent proto가 없거나 enum이
  unknown/UNSPECIFIED이면 추정하지 않고 실패한다.
- 계약 동결 전에는 Discord/RAG lane이 이 형상을 소비했다고 주장하지 않는다.

P02 검증:

- T-WIRE-01~05, 08~16, 18~23: core
  `src/test/uc-wire-v1*.test.ts`, `uc1-*` 회귀 테스트.
- T-WIRE-06, 17: paired proto Rust `agent_grpc::transcode_tests::wire_v1_*`,
  `cargo check`, Shell TypeScript build.
- T-WIRE-15: `packages/shell/src/lib/__tests__/wire-errors.test.ts`와
  `chat-service.test.ts`의 안정 code/i18n/public callback 검증.

## S-STEAM — Windows Steam 배포 준비 (#314)

- **사용자 목표**: Steam에서 Naia를 설치하고 `naia-shell.exe`를 직접 실행한다.
- **배포 계약**: Windows 설치 완료 트리에서 NSIS 전용 `uninstall.exe`를 제외한 포터블 디포를 만들고,
  번들 Node·agent·BGM sidecar를 포함한다.
- **독립 실행 증명**: CI는 디포 복사 후 NSIS 기본 설치 위치를 제거한 상태에서 실제 셸을 기동해
  agent handshake와 번들 Node 사용을 확인한다.
- **무결성**: 업로드 디포에는 모든 파일의 상대 경로와 SHA256을 담은 `steam-files.sha256`이 포함된다.
- **범위 경계**: Steamworks App ID·depot ID·계정 비밀·스토어 심사 제출은 저장소 밖 운영 단계이며 #314에서 추적한다.

## UC-DISCORD — Discord 채널 에이전트 (신규 요구, 2026-07-20)

### UC-DISCORD-1: 개인 봇 연결과 채널 활동 허용

사용자는 나이아에게 Discord 연결 방법을 물어본다. 나이아는 사용자가 Discord에서 봇을 만들고 자신의 서버에 초대해야 함을 설명한 뒤 연결 설정으로 안내한다. 사용자는 보안 입력을 통해 봇을 연결하고, 나이아가 접근 가능한 채널 중 활동을 허용할 채널을 선택한다. 이후 나이아는 허용 채널에서만 다른 참여자와 대화한다.

- 성공: 연결 상태와 허용 채널이 보이고, 봇은 허용 채널에서만 동작한다.
- 실패: 토큰 오류, 봇 미초대, 권한 부족, 채널 삭제는 원인을 보여 주며 다른 채널에는 영향을 주지 않는다.
- 안전: 토큰은 채팅·일반 설정·로그·agent 요청에 나타나지 않는다.

### UC-DISCORD-2: 여러 채널을 지구본 대화함에서 읽기

사용자의 봇이 여러 Discord 채널에 초대돼 있다. 사용자가 지구본 버튼을 누르면 최근 활동한 허용 채널의 대화가 먼저 열린다. 사용자는 목록으로 돌아가 다른 채널을 고르고, 그 채널의 대화와 읽지 않은 상태를 본다.

- 좁은 화면: 목록과 대화를 동시에 강제로 넣지 않고, 목록 → 대화 → 뒤로 가기 흐름으로 전환한다.
- 넓은 화면: 목록과 선택된 대화를 함께 보여 줄 수 있다.
- 비어 있음: 허용 채널이 없으면 연결·권한 설정을 안내한다.

### UC-DISCORD-3: 실시간 공동 대화

가족 채널처럼 여러 사람이 있는 허용 Discord 채널에 새 메시지가 올라온다. 나이아는 지속 연결로 메시지를 받고, 해당 채널의 참여 규칙에 따라 같은 채널에 응답한다. 두 채널에서 동시에 대화해도 각 채널의 맥락과 응답은 서로 섞이지 않는다.

- 성공: 새 메시지는 한 번만 처리되며 응답은 같은 채널에 표시된다.
- 복구: 네트워크 단절 뒤 재연결해도 이미 처리한 메시지에 다시 응답하지 않는다.
- 비활성: 허용되지 않았거나 일시 중지한 채널은 읽거나 응답하지 않는다.

### Test Coverage Map

| Scenario | Unit / contract | UI / integration | Real Discord E2E |
|---|---|---|---|
| UC-DISCORD-1 | credential boundary, allow-list, participation policy | Settings connection flow | bot invite, permissions, allowed-channel activation |
| UC-DISCORD-2 | recency and selected-channel persistence | narrow/wide channel inbox navigation | multi-channel history visibility |
| UC-DISCORD-3 | Gateway event deduplication, per-channel context, reconnect | live status and unread rendering | two-channel message/reply/reconnect flow |
