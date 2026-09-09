# 사용자 시나리오 (P01) + 테스트 커버리지 맵 — 2단계 산출물

> **현재 Windows 로컬 표현 시나리오:** GPU 감지는 온보딩에서 로컬 음성 사용 가능성만 안내하며 프로파일을 자동 활성화하지 않는다. 사용자는 이후 음성 설정에서 로컬 음성과 레퍼런스 음성을 선택한다. 사전 생성 NVA 외모는 GPU 프로파일과 독립적으로 선택한다. 과거 8GB 서버 렌더링 NVA 기록은 [`windows-8gb-nva.md`](windows-8gb-nva.md)에 보존한다.

`[Phase 03·04 (P01 시나리오 + P02 테스트맵)]`

> 추적: 1단계 `STRUCTURE.md` v5 → 2단계 P01. **상태: 완전성 수렴(13R, 3연속 NONE). foundation tranche 순서 = 아이디어 수준 잠정안(F0→…→V2, 실행 시 재검토). G1 게이트 아님.**
> 완전성 추이: 초안 46 → 누락 발견·추가 R1~R10(ADK부트스트랩·비용·업데이트·공지·비전캡처·@멘션·Issues·AppBar·botmadang·ref오디오·Lab동기화·deeplink·**default-skills 60+ 컬렉션**·메모리백업) → R11~R13 3연속 NONE. 앱 표면 ≈ S01~S71(+S52b) + 브라우저/워크스페이스/default-skills 그룹. 분포/OS(S68/69)=범위 밖.
> 원칙: 시나리오는 *발명*이 아니라 old-naia-os **실제 기능**에서 도출(built-in skills 25·앱 6개·멀티채널). 각 UC = 인지흐름 경로 + 관통 슬라이스/포트.
> 용어 = `glossary.md`.

## 분류축 — 인지흐름 관통 (감각→지각→경험→사고→표현/행위)

UC 를 인지흐름이 *어디까지 도는가*로 묶는다(기능 나열 ❌). vertical(5단계) 후보 = 흐름을 가장 많이 관통하는 UC.

| UC | 시나리오 (실제 기능) | 인지흐름 경로 | 관통 슬라이스/포트 |
|---|---|---|---|
| **UC1 텍스트 대화** | ChatApp 에 입력→응답 | Chat(ingress) → 사고(llm) → 표현(speech-intent) | ChatPort·llm·ExpressionPort |
| **UC2 음성 대화** | wake→말하기→음성응답+아바타 | 감각(audio→STT) → 지각 → 사고 → 표현(음성+emote) | SensoryPort·voice(provider)·affect·ExpressionPort(avatar) |
| **UC3 기억하는 대화** ★ | "지난번 그거 기억해?" | 감각/Chat → 지각 → **장기기억 recall** → 사고 → 표현 | memory(naia-memory)·conversation·llm |
| **UC4 경험→능동 회상** ★ | 기념일·시간 앵커에 naia가 *먼저* 말 검 | (시간 trigger) → 장기기억 → 동기 → 표현 | temporal(cron)·memory·motivation·ExpressionPort |
| **UC5 도구 사용** | 날씨·시간·웹검색·github | Chat → 사고(의도) → 능력·도구(skill/mcp) → 표현 | ChatPort·skill·mcp/gateway·ExpressionPort |
| **UC6 환경 조작-브라우저** | "이거 찾아서 눌러줘" | Chat → 사고 → **환경 행위**(browser navigate/click) + 관측 | EnvironmentPort(app-surface)·skill |
| **UC7a 시스템 관측(read-only)** | 파일/프로세스 *상태 조회*(변경 X) | Chat → 사고 → 환경 관측 | EnvironmentPort(host-system) observe |
| **UC7 시스템 조작(mutating)** | 파일 편집·명령 실행 + **결과 관측**(reafference) | Chat → 사고 → 환경 행위 → observed→mismatch | EnvironmentPort(host-system) + reafference |
| **UC8 공간 분위기** | "음악 틀어줘"(BGM) | Chat → 사고 → 환경 변경(space) + 관측(BGM context) | EnvironmentPort(space)·youtube-bgm skill |
| **UC9 앱** | 앱 설치→그 앱 스킬 사용 | Chat → 능력(app install) → 환경(app-surface tool) | skill(app)·EnvironmentPort.app-surface |
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
> 13 UC = 인지흐름 분류 맵 / 아래 = 그 아래 실제 기능 단위(소스: 25 built-in skill + 앱 6개 + provider/voice/채널). 각 행 = Old-Baseline 측정·이식·검증 단위.

| # | granular 시나리오 (소스) | UC 분류 | 슬라이스/포트 | 검증(측정/확인 예정) |
|---|---|---|---|---|
| S01 | 온보딩/welcome | UC12 | control-plane·config | 측정 |
| S02 | 설정 config / settings 앱 | UC12 | control-plane·config | 측정 |
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
| S13 | 텍스트 대화(ChatApp) | UC1 | ChatPort·llm·ExpressionPort | 측정 |
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
| S27 | browser 앱 | UC6 | EnvironmentPort.app-surface | 측정 |
| S28 | app 설치(app) | UC9 | skill·EnvironmentPort.app-surface | 측정 |
| S29 | generic-installed 앱 | UC9 | EnvironmentPort.app-surface | 측정 |
| S30 | sample-note 앱 | UC9 | EnvironmentPort.app-surface | ❌ 제품에서 내림 — `App.tsx` 의 등록 import 가 주석 처리돼 앱바에 뜨지 않는다. 그 UI 를 재던 90번 앱 시스템 스펙도 2026-09-06 에 지웠다(#567 "능력이 죽으면 삭제"). 메모 앱이 들어오면 이 줄과 스펙을 함께 되살린다 |
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
| S58 | **비용 대시보드 + Naia Lab 잔액·충전**(CostDashboard `/v1/profile/balance`·billing 링크, ChatApp 비용 배지) | UC12 | control-plane(billing/cost) | 측정 (완전성R1, 루크 "비용 관련") |
| S59 | **앱 업데이트 알림·설치**(UpdateBanner: checkForUpdate·install·다운로드) | (control-plane) | control-plane(updater) | 측정 (완전성R1) |
| S60 | **원격 공지 배너**(AnnouncementBanner: fetchUnreadAnnouncements·read/dismiss/details) | (control-plane/notify) | control-plane·gateway | 측정 (완전성R1) |
| S61 | **화면·앱 비전 캡처**(skill_tab_screenshot·capture.rs — 앱 viewport→PNG) = naia 시각 | UC11/UC6 | **SensoryPort(vision)** | 측정 (완전성R2) |
| S62 | 채팅 **@ 멘션** 파일/폴더 선택기(AtMentionPopover, workspace fuzzy 검색→삽입) | UC1 | ChatPort·workspace | 측정 (완전성R2) |
| S63 | 워크스페이스 **GitHub Issues 앱**(IssuesArea, `gh issue list`) | UC5/UC7 | workspace group·skill(github) | 측정 (완전성R2) |
| S64 | **AppBar 브라우저 바로가기 관리**(URL shortcut 추가/삭제/재정렬/아이콘) | UC6 | browser group·UI | 측정 (완전성R2) |
| S65 | **botmadang 커뮤니티 연동**(botmadang.org: register·post_article·comment) — 기본 스킬·skill.json 매니페스트 | UC10/UC5 | skill·channels | **rejected(루크 결정 2026-06-09: 이식 제외)** — voice-server류, 카탈로그엔 rejected로 명시 |
| S66 | **참조 오디오 / voice clone**(RefAudioSection: 미리듣기·녹음/업로드·preset·삭제, `/v1/ref-audio`, mid-session 반영) = naia 음색 | UC2 | voice·ExpressionPort(timbre) | 측정 (완전성R4) |
| S67 | **Naia Lab 설정 동기화**(lab-sync: pull/push + 충돌 선택 다이얼로그, 로컬변경 자동 push) — 계정/비용과 별개 | UC12 | control-plane(settings sync) | 측정 (완전성R5) |
| S70 | 채팅 **절대경로 파일 deeplink**(chat-file-deeplink 버튼 → workspace 앱 openFile + 전환) | UC1/UC7 | ChatPort·workspace | 측정 (완전성R9) |
| **S71 번들 default-skills 컬렉션 (~60+, OpenClaw 출처)** = command-group (preload + SkillsTab 노출 + tool-bridge) | UC5 | skill·gateway | 측정 (완전성R10, **개별 스킬 per-skill 검증**) |

> **브라우저(S26/27) = command-group(~50)**: embed lifecycle·webview·navigate/click/fill/get_text/snapshot/screenshot/eval/press/scroll/forward-back/resize/show-hide/login/permission. **워크스페이스(S33) = command-group(~25)**: adk-server discover·skills discover·sessions·git·progress·file read/write·watch·classify·set-root·project-index. (이식 시 sub-capability 별 분해.)
> **S71 default-skills 전 목록 (~60+, OpenClaw 출처 — 누락 0, per-skill 검증)**: 1password·blogwatcher·blucli·bluebubbles·camsnap·clawhub·coding-agent·eightctl·food-order(json-only)·gemini·gh-issues·gifgrep·gog·goplaces·healthcheck·himalaya·mcporter·nano-banana-pro·nano-pdf·openai-image-gen·openai-whisper·openai-whisper-api·openhue·oracle·ordercli·sag·session-logs·sherpa-onnx-tts·skill-creator·songsee·sonoscli·summarize·tmux·video-frames·wacli·xurl. **darwin-only**: apple-notes·apple-reminders·bear-notes·imsg·model-usage·peekaboo·things-mac. (이식 단위 = default-skills preload/loader + 번들; 동작은 per-skill Old-Baseline 측정.)
> **분포/OS 레벨 (P01 앱 시나리오 범위 *밖* — 별도 배포 트랙, 완전성 기록용, 완전성R8)**: S68 Naia OS ISO 설치(라이브 USB→HD) · S69 persistent USB writer/update/status(naia-usb). = recipes/installer/os 패키징 레이어, 헥사고날 이식 슬라이스(agent+core+shell 앱) 밖. (앱 표면 자체는 R8=NONE.)
> 누락 0 목표. **검증 열 = 측정/루크 확인으로만**(추측 ✅ 금지). 우선 확인: S18(잔재✓)·S36(깨짐✓)·S41/43(미배선✓)·S42·S48·S52·S56.

> **S05 대화 transcript 영속/로드 (2026-06-18 transcript 트랙, V1-선행)**: 현 S05 = 죽은 게이트웨이 directToolCall(new-core fail-fast)에 의존 → verbatim 대화록 영속/로드 재구현.
> - **S05a WRITE(전두엽=agent)**: agent 가 각 turn 을 `{adkPath}/conversations/{sessionId}.jsonl` append(`ConversationLogPort`). 인지흐름 = 사고→표현 후 *경험 외재화/기록*. sessionId 배선(proto+domain+codec). (Phase2: 음성 turn = agent 경유 동일 기록.)
> - **S05b READ(shell, agent 독립 E1)**: HistoryTab 이 Rust IPC 로 conversations 직접 list/read/delete(**write 없음**). 죽은 directToolCall 대체.
> - **S05c 관계(비구현)**: transcript = UC3/S41 memory recall 원재료 + 멀티모달 잠재기억 substrate(`audioRef` 예약).
> - **검증(P02)**: agent write 계약(짝 naia-agent 저장소의 `conversation-log.contract.test.ts`: jsonl append·sessionId 격리·no-throw·CRLF — 이 저장소에는 없다) / shell read 계약(`conversation-store.test.ts`: 경계 가드·agent-down 빈목록) / 통합(`conversation-persistence.integration.test.ts`: 대화→재시작→복원 golden) + Playwright e2e(HistoryTab 복원)·e2e-tauri(Rust IPC adkPath 경계).

> **S72 워크스페이스 전환 설정 복원 (2026-06-24, 셸 feature)**: 워크스페이스(ADK path) 전환 시 그 워크스페이스의 정체성 설정(페르소나·이름·말투·locale·VRM·배경·BGM)이 복원돼야 한다. 현 버그 = 전환 핸들러(SettingsTab/WorkspaceCenterArea)가 ADK 포인터(localStorage `naia-adk-path`)만 바꾸고 기존 localStorage `naia-config` 를 유지 → 페르소나/VRM 안 바뀜. 초기 설정(AdkSetupScreen)은 `readNaiaConfig` 로 복원하나 전환 경로만 누락(비대칭).
> - **S72a 복원(전환 핸들러)**: `setAdkPath` 후 config.json(persona/이름/말투/locale via `readNaiaConfig`) + ui-config.json(VRM/배경/BGM via `readNaiaUiConfig`) → localStorage `naia-config` 로 병합 복원 → reload. AdkSetupScreen 과 동형(비대칭 해소).
> - **S72b 저장 분리**: UI 정체성(vrmModel·backgroundImage·backgroundVideo·bgmTrack·customVrms·customBgs)을 워크스페이스별 `{adkPath}/naia-settings/ui-config.json` 에 저장. agent config.json 은 `stripForAgent` 유지(env 오염 방지) — UI키는 ui-config.json 으로만. persona/이름/말투/locale 은 기존 config.json(agent 도 소비).
> - **검증(P02)**: adk-store 계약(`writeNaiaUiConfig`/`readNaiaUiConfig` 분리·경계) + 복원 병합 계약(`applyWorkspaceConfigToLocal`: config.json+ui-config.json → naia-config) + e2e(워크스페이스 A→B 전환 시 VRM·persona 변경).

> **UC-CONFIG-SOT localStorage 는 adkPath 뿐, 설정 SoT = naia-settings/ (2026-07-15, 루크 원칙)**: 앱이 켜질 때 사용자가 보는 설정(페르소나·이름·말투·locale·모델·VRM·배경)은 **`naia-settings/config.json`·`ui-config.json` 이 유일한 진실(SoT)**이어야 한다. localStorage 는 오직 `naia-adk-path`(어느 ADK 를 볼지 = 부트스트랩 포인터)만 **권위**로 갖고, `naia-config` 는 파일에서 하이드레이트되는 **순수 렌더 캐시**(107곳 동기 `loadConfig()` 리더용, 권위 없음)일 뿐이다.
> - **현 버그(재현 100%)**: `naia-settings/config.json` 을 바꿔도 재기동마다 **스테일 localStorage 값이 이겨** 파일을 덮는다. 원인 = 부팅 병합 `App.tsx:367` 만 유일하게 `merged = { ...local, ...fileConfig, ...uiConfig }` 로 **local 을 base** 로 쓴다(워크스페이스 전환 `adk-store.ts:413` 은 이미 파일만 base = 정답). ① `readNaiaConfig()` 가 null/부분 config 면 `fileConfig.persona` 부재 → 스테일 `local.persona` 가 스프레드에서 살아남음. ② `App.tsx:457` `syncConfigToFile()` 이 하이드레이션 전 스테일 localStorage 를 800ms 디바운스로 **config.json 에 되씀**(persona 는 strip 대상 아님) → 영구화.
> - **S-CONFIG-SOT-1 부팅 병합 = 파일 우선**: 부팅 병합에서 `...local` 제거 → `merged = { ...(fileConfig ?? {}), ...(uiConfig ?? {}) }`. 부트스트랩 키(`workspaceRoot`/adkPath·`onboardingComplete`)만 명시 보존. `if(!fileConfig && !uiConfig) return`(read 실패 시 캐시 wipe 방지). `applyWorkspaceConfigToLocal`(전환)과 **동형**(부팅↔전환 비대칭 해소).
> - **S-CONFIG-SOT-2 되쓰기 순서(레이스 차단)**: `syncConfigToFile()` 은 파일→localStorage 하이드레이션 **완료 후에만** 실행(hydrated 플래그 게이트). 하이드레이션 전 스테일 되쓰기 금지. stale-URL 대비 sync 는 하이드레이트 **후** 재실행으로 충족. **AdkSetup 화면 분기에서도 게이트 선개방 금지**(FR-CONFIG-SOT.5, 2026-07-16 실측 클로버). 실 UI 검증 = `e2e/config-sot-boot.spec.ts`(하이드레이션·무클로버·읽기지연 경쟁 3계약).
> - **S-CONFIG-SOT-3 무회귀**: `stripForAgent`·키체인 **무변경**. 107곳 동기 `loadConfig()` 리더 **무변경**(캐시는 유지, 권위만 박탈).
> - **S-CONFIG-SOT-4 UI 설정 SoT 완성 (2026-07-15 회귀 대응)**: 부팅 병합이 파일 우선(`...local` 제거)이 되면, **파일에 SoT 가 없는 키는 매 부팅 기본값으로 리셋된다.** 실제 회귀: 로컬 보이스 호스트(`vllmTtsHost`)가 저장 안 됨 — `UI_ONLY_CONFIG_KEYS`(config.json 에서 strip)이면서 `UI_IDENTITY_KEYS`(ui-config.json 저장 대상, 9개뿐)에 없어 **어느 파일에도 SoT 가 없었다**(localStorage 가 유일 저장소였는데 S-CONFIG-SOT-1 이 그걸 무력화). 따라서 **config.json 에서 빼는 UI 키 = ui-config.json 에 넣는 키**가 정확히 일치해야 한다. `extractUiConfig` 가 `UI_IDENTITY_KEYS`(9개) 대신 `UI_ONLY_CONFIG_KEYS`(전체: theme·appPosition·vllmTtsHost·ttsProvider·liveProvider·bgmVolume 등)를 뽑도록 확장 → 모든 UI 설정이 ui-config.json 에 저장/로딩. read(`readNaiaUiConfig`)·병합(`mergeBootConfig`/`applyWorkspaceConfigToLocal` 의 `{...file, ...ui}`)은 이미 통짜라 대칭 자동 완성.
> - **S-CONFIG-SOT-5 중단 안전 저장 (2026-07-31 재부팅 조사)**: Shell이 `config.json`을 저장하는 도중 프로세스 종료·재부팅·동시 저장이 발생해도 독자는 이전 JSON 또는 새 JSON 중 하나만 읽어야 한다. 저장 전 JSON 객체를 검증하고, 같은 디렉터리의 임시 파일에 UTF-8 전체를 기록·동기화한 뒤 원자적으로 교체한다. 잘못된 JSON이나 기록 실패는 기존 파일을 보존한다.
> - **검증(P02)**: 부팅 병합 계약(스테일 localStorage persona 를 config.json 이 덮는가) + 되쓰기 게이트 계약(하이드레이션 전 `writeNaiaConfig` 호출 없음) + Rust 원자 저장 계약(UTF-8 한국어 왕복·기존 파일 교체·잘못된 JSON 입력 시 기존 파일 보존) + e2e-tauri(config.json=나이아 / localStorage=알파 → 부팅 → 나이아 유지, config.json 미오염).

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
| **S-VOICE-MIGRATION** (#419, FR-VOICE.13 — 2026-08-13) | 과거 버전의 로컬 GPU 프로파일 설정(`localGpuTier`)이 남은 채 업그레이드하면 안전 마이그레이션이 로컬 음성 권한을 끄는데, 사용자는 **왜 꺼졌는지 설정 Voice 카드에서 사유를 보고** 같은 자리의 복구 버튼 한 번으로 로컬 음성을 다시 켠다. 사유 없는 침묵 비활성은 없다 — "고장"과 "정당한 꺼짐"이 화면에서 구분된다. | 제어면(설정 Voice 카드) — 마이그레이션 정직화 | `config.test.ts`(마이그레이션→notice 기록·재활성→notice 해제) + `SettingsTab.test.tsx`(notice 표시+복구 버튼) + `e2e/settings-slots.spec.ts`(폐기 필드 시드→사유 실 UI 노출) |
| **S-VOICE-READY** (#418, FR-VOICE.14~15 — 2026-08-13) | 로컬 음성이 선택된 상태에서 사용자는 "포트가 열렸다"가 아니라 **음성 엔진의 준비 신호(façade `/health` 의 TTS ready)** 를 기준으로 상태를 본다: 엔진 미실행이면 Voice Reference 영역이 침묵 대기·일반 네트워크 오류 대신 "엔진 실행 필요"를 명시하고 그 자리에서 시작할 수 있으며, 엔진이 떠 있지만 TTS 미가용이면 준비 중임을 안내한다. e2e/하니스 시드는 제품 config 스키마의 시드 빌더(`config-seed.ts`)에서 생성되어 폐기 필드가 하니스로 재유입되지 않는다(2026-08-11 voice-6g 하니스 사고 재발 방지). | 표현(설정 Voice Reference) + e2e 하니스 | `local-runtime.test.ts`(health 파싱·미도달 null) + `RefAudioSection.test.tsx`(엔진 미실행 명시 상태+시작 액션) + `config-seed.test.ts`(폐기 키 런타임 거부·마이그레이션 폐기 목록 일치) + Tauri 94 실측 `/health` |
| **S-SHELL-ISO** (#425, FR-SHELL-ISO.1 — 2026-08-13) | 개발자는 운영 설치본(Naia)을 켜 둔 채 개발 인스턴스(**Naia Dev**)를 동시에 실행한다. 두 앱은 설정·로그인·로컬 데이터를 서로 침범하지 않으며(별도 identifier + `~/.naia-dev`), 단일 GPU 음성 런타임(VoxCPM2 :8910)은 **공유**한다 — 나중에 뜬 인스턴스가 건강한 엔진을 죽이고 재스폰하는 대신 입양해 그대로 쓴다(상대 인스턴스의 발화 절단·GPU 이중 적재 방지). 뇌(naia-agent)는 인스턴스별 자식 프로세스로 비공유. | 개발 워크플로 + Windows lifecycle + 공유 GPU 표현 | Rust 단위 2건(홈 오버라이드·입양 계약) + `local-runtime.test.ts` 입양 페이로드 핀 + 실기 동시 실행 스모크(운영 발화 중 dev 기동 → 발화 무절단, 수동 1회) |
| **S-VOICE-AVATAR** (FR-VOICE.5 — #397 갱신) | Windows 8GB 프로파일은 LLM을 외부(Naia 계정·원격 Ollama·외부 API)에 유지한다. 로컬 표현은 VoxCPM2 W8A16 + TensorRT LocDiT 음성을 재생하고 **같은 WAV를 Ditto TensorRT-native `/stream`에 직렬 전달**해 립싱크한다. 음성 서버 미가용이면 NVA idle을 유지하고 1회 알림+무음 원칙을 따른다. | 표현(speech+avatar) — 외부 두뇌와 GPU 표현의 half-duplex 결합점 | `synthesize.test.ts` · `cascade-renderer.test.ts` · 실제 :8910→:8901/:8902 façade probe · Tauri 94 NVA 출력/발화 |
| **UC-WIN-NVA-8G** (#397·#413, FR-CASCADE.9~14 — 2026-08-02) | Windows의 **지원되는 NVIDIA GPU, VRAM 8GB 이상** PC에서 Naia 계정의 외부 LLM(원격 Ollama 또는 외부 API)을 그대로 사용하면서 로컬 음성과 NVA 비디오 아바타를 실행한다. 프로파일 UI는 CUDA·INT8·TensorRT·VoxCPM2·Ditto 같은 구현명을 노출하지 않는다. 프로파일은 LLM provider/model/host를 바꾸거나 로컬 Ollama·NPU를 설치/기동하지 않는다. 보안 저장소의 Naia 로그인은 재시작 뒤 NVA 렌더와 회원 manifest에 복원되며, 일반 설정 동기화가 이를 로그아웃으로 덮지 않는다. 8GB 미만 또는 VRAM 미확인 상태에서는 NVA 선택·자동기동·재시작 복원을 모두 막고 VRM으로 안전하게 복귀한다. 초기화가 느리거나 실패해도 NVA Player는 idle 화면을 먼저 표시한다. 실시간 속도는 지원 조건이 아니다. | 제어면(온보딩·프로파일·두뇌·아바타) + 표현(NVA Player) + Windows lifecycle | secure-store App 회귀 · `adk-store.test.ts` manifest 재덮기 회귀 · `VideoAvatarCanvas.test.tsx` · `vram-tiers.test.ts` · `nva-gate.test.ts` · `SettingsTab.test.tsx` · 실제 `tauri:dev` manifest/8910 health/NVA 캡처 |
| **UC-WIN-VOICE-6G** (#406, FR-CASCADE.20~22 — 2026-08-01) | 등록 후 Naia에 로그인한 사용자는 Windows NVIDIA RTX VRAM 6GB 이상 PC에서 기존 Naia 계정 LLM·원격 Ollama·외부 API 설정을 유지하면서 로컬 VoxCPM2 W8A16 + TensorRT LocDiT 음성을 사용한다. Shell은 3D VRM을 유지하며 Ditto/NVA/로컬 LLM/Ollama/NPU/STT를 시작하지 않는다. 로그아웃 또는 VRAM 미달이면 profile/manifest/IPC가 모두 fail-closed다. 첫 기동이 느려도 기능 대상이지만 실시간 속도와 실제 6GB cold boot는 측정 전 보장하지 않는다. 실제 화면 검증 자산은 `naia-settings/vrm-files/01-OL_Woman.vrm`이며 SHA-256으로 동일성을 고정한다. | 설정 프로파일 + 외부 대화 + 로컬 TTS + VRM + Windows lifecycle | `vram-tiers` · `tier-slots` · `config` · `slots-manifest` · Settings Playwright · Rust account/VRAM/install tests · manager profile/manifest/launch tests · labs CPU-quantization tests · 실제 Tauri Shell voice/VRM probe |
| **UC-SHELL-RECOVERY** (#406, FR-RUNTIME.1/FR-VOICE.10/FR-SETTINGS.1 — 2026-08-01) | 통합테스트 뒤 일반 `pnpm run tauri:dev`를 실행해도 Shell은 실제 ADK와 Naia 계정의 외부 LLM을 로드해 대답한다. 로컬 음성 목록은 파일명 대신 사람이 읽을 수 있는 이름을 보이며, 준비되지 않은 Connections 설정에는 들어갈 수 없다. | 일반 개발 실행 + 외부 LLM + 로컬 음성 설정 | 환경 scrub·E2E sentinel·path-cache 격리 단위, Settings/RefAudio FE, 실제 Tauri `SetWorkspace loaded=true`와 채팅 응답 |
| **UC-WIN-VOICE-CONTINUOUS** (FR-VOICE.11~12 — 2026-08-01) | 여러 문장 답변에서 첫 문장만 들리고 나머지가 `429 busy`로 사라지지 않는다. 첫 문장을 생성한 뒤 다음 문장을 한 개씩 준비하며, 생성이 재생보다 느릴 때는 한 문장을 더 버퍼링해 문장 사이의 무음을 줄인다. 사용자가 음성으로 끼어들어 앞 발화를 끊었을 때도 서버에 남은 이전 GPU 작업이 끝날 때까지 새 첫 문장을 제한적으로 재시도해 무음 응답으로 버리지 않는다. | Windows 6GB VoxCPM2 + Shell VRM 연속 발화 | ChatArea/AudioQueue 단위 + synthesize busy retry/abort + 실제 façade 연속·겹침 로그에서 최종 200 |
| **UC-WIN-VOICE-WARMUP** (#519, FR-VOICE.19 — 2026-08-31) | 로컬 음성 엔진이 기동/재설치 직후라 합성이 실시간보다 느린 동안(RTF>1), 사용자는 "쉬었다 째지는" 언더런 발화 대신 기존 "음성 모델 준비 중…" 표시를 본다. 폴백 음성으로 바꾸지 않는다(루크 결정 2026-08-31). 재생은 ① 엔진이 실시간 속도를 회복하거나(RTF<1) ② 답변 전 문장이 WAV로 완성된 뒤(complete-then-play, 갭 0) 시작한다. 임의 시간 캡으로 굶주린 큐를 강제 재생하지 않는다. | Windows 로컬 음성 워밍업 + 재생 게이트 | `local-voice-scheduler.test.ts` warming hold 3해제조건 + `sentence-pipeline.test.ts` 전 문장 RTF 측정·preparing 이벤트 |
| **UC-WIN-NVA-LATENCY** ([alpha-adk #14](https://github.com/nextain/alpha-adk/issues/14), REQ-051, FR-CASCADE.15~19 — 2026-07-31) | 같은 외부 LLM 대화 경로에서 사용자는 요청이 겹쳐도 숨은 GPU 대기열 때문에 앞선 발화까지 느려지지 않는다. 사용자가 발화를 중단하면 Shell의 미디어 요청과 Ditto 작업이 종료되고 NVA idle로 돌아간다. 성능 판정은 같은 텍스트·음성지문·NVA·warm 상태에서 요청→첫 오디오, 첫 미디어 바이트, 첫 Shell 발화 프레임, 전체 완료, A/V 종료차, 취소 회수 시간을 전후 비교한다. 완성 A/V 응답 캐시는 사용하지 않는다. | Shell MSE/취소 + cascade 스트림 수명 + Ditto TRT 역압력 + manager 실행 환경 | P02: labs `test_render_admission.py`(첫 요청·동시 429·해제), manager `test_service_plan.py`(렌더 크기), Shell `cascade-renderer` 단위/FE(AbortSignal·MSE 조기 재생), cascade adapter 취소 테스트, Tauri 94 실제 NVA 계측 |
| **UC-WIN-NVA-TTS-SYNC** (FR-VOICE.8~9 — 2026-08-01) | TTS를 켠 사용자가 메시지를 보내면 Shell은 `생각 중 → 음성 처리 중 → 렌더 중`을 현재 언어로 보여 준다. 답 텍스트는 음성 상태와 무관하게 도착하는 대로 화면에 나타난다(2026-09-07 #571 로 개정 — 그전에는 재생 시작까지 가렸고, 음성이 느린 기계에서 그 가림이 본문을 무기한 붙잡았다). Ditto video가 `playing`에 들어가면 음소거가 풀리고 진행 표시가 사라지며, ESC·새 발화·합성 실패에서도 이전 답변이나 상태가 늦게 되살아나지 않는다. 느린 처리 중에도 화면이 멈춘 것처럼 보이지 않아야 한다. | ChatArea 즉시 렌더 + AudioQueue/Cascade playback callback + 14-locale i18n + GPU single-flight | `ChatArea.test.tsx` 느린 합성 중 본문·비용 배지 노출/CJK/실패/ESC · `i18n-output-stage.test.ts` · Tauri 94 실제 4060 |
| **UC-VRM-EXPRESSION** ([#361](https://github.com/nextain/naia-shell/issues/361)·[#422](https://github.com/nextain/naia-shell/issues/422), FR-AVATAR.1) | Naia 전용 VRM 1.0을 선택한 사용자가 TTS 응답을 들으면 텍스처 전환형 `aa/ih/ou/ee/oh` 입모양이 한 번에 하나씩 모두 나타나고, 발화 종료·중단 시 입이 즉시 닫힌다. 생각 신호에는 외주 모델의 custom `think` 표정을 사용한다. 이 경로는 실제 음소 동기화가 아닌 발화 상태 기반 5모음 시뮬레이션이며, 전신 동작은 별도 VRMA 클립이 제공된 경우에만 가능하다. | UC2/S19 ExpressionPort(VRM) | `mouth.test.ts` 5모음·binary/continuous·VRM 0.0·정지, `expression.test.ts` think 우선·fallback, 외주 VRM 메타데이터 실측 |
| **UC-VRM-ACTIVE-EXPRESSION** ([#423](https://github.com/nextain/naia-shell/issues/423), FR-AVATAR.2) | 사용자가 질문하면 Naia가 대기 중 custom `think` 표정을 보이고, 응답의 명시적 감정 표정과 실제 음성 발화 5모음 입모양을 함께 사용한다. 감정은 마지막 음성이 끝날 때까지 유지되고 취소·중단·오류 시 neutral로 안전하게 돌아온다. 외주 파일의 blink·lookAt·hair springBone과 외부 idle VRMA는 계속 동작하되, 파일에 없는 전신 감정 모션은 실행하지 않는다. | UC2/S19 ExpressionPort(VRM) + audio playback lifecycle | `ChatArea.test.tsx` request/emotion/TTS/interrupt, `pipeline-voice.spec.ts`, `mouth.test.ts`, `expression.test.ts`, `AvatarCanvas.tsx` load-time sync |
| **UC-WIN-NVA-8G evidence correction** | #397 supersedes the CPU/NPU Ollama brain clauses in S-VOICE-AVATAR and S-8G: the LLM remains external and only VoxCPM2 W8A16 + TensorRT LocDiT and TensorRT-native Ditto run locally. | Same surfaces as UC-WIN-NVA-8G. | Implemented automation: `VideoAvatarCanvas.test.tsx` (idle/start failure/retry/<8GB no-start), `capability-settings.spec.ts`, `settings-slots.spec.ts`, Rust `cascade_vram_requires_detected_nvidia_8gb_or_more`, windows-manager profile/manifest tests, and Tauri 94 real 4060 output path. Model-wide VoxCPM2 TensorRT and model-wide RTX compatibility gates remain follow-up work. |
| **S-BGM-SKILL** (UC8/FR-BGM.1 — 2026-07-16, 시연 크리티컬) | 사용자가 나이아에게 **"잔잔한 음악 틀어줘"** 라고 하면 나이아가 `skill_youtube_bgm` 도구로 BGM 위젯을 제어한다 — 검색(사이드카 :18791) 첫 결과 재생·정지·일시정지·재개·다음/이전(즐겨찾기)·볼륨. 구 monolith 의 내장 BGM 스킬이 new-core 이식에서 누락돼(위젯·사이드카·에이전트 UC8 어댑터는 있으나 **도구 등록 배선 0**) 나이아가 BGM 존재 자체를 몰랐던 갭 해소. 배선 = **앱(환경) 도구 경로**(E1 — agent 무변경): 부팅 등록 → `app_tool_call` → 셸 실행 → 위젯이 이미 듣는 `bgm_youtube_*` 이벤트 | 환경(ambiance) — 위젯 도구화, 뇌 무변경 | `bgm-skill.test.ts`(액션 라우팅·검색→첫결과·볼륨 clamp·인자검증·이벤트 payload 형상) [단위] + **`e2e/bgm-skill.spec.ts`(실 UI 배선 회귀 가드: (A) 부팅 app_skills 에 skill_youtube_bgm 등록 (B) 채팅 턴 app_tool_call → BgmPlayer 실제 재생 `.bgm-icon--playing`)** — 단위테스트로 못 잡는 *배선 누락*(이번 회귀 유형)을 실 UI 로 고정. 실 음악 재생=부스 리허설(수동, 2026-07-16) |
| **S-CASCADE-HISTORICAL** (Round 2, 2026-06-30) | 과거 8GB 음성 단독/fp16 가정 기록. **현재 Windows 8GB 실행 계약이 아니다.** 현재는 `windows_trt_8g`가 VoxCPM2 W8A16 + TensorRT LocDiT와 Ditto를 함께 계획한다. | 이력 | 현재 시나리오는 UC-WIN-NVA-8G 참조 |
| **S-8G-HISTORICAL** (2026-07-08) | 과거 로컬 LLM/아바타/both 3모드와 8GB 음성 클라우드 전용 가정. **Windows `windows_trt_8g`에는 적용하지 않는다.** | 이력 | 현재 시나리오는 UC-WIN-NVA-8G 참조 |
| **S-CASCADE-T3** (BYO 원격 cascade, 2026-07-15) | 로그인 사용자가 직접 운영하거나 별도로 제공받은 Host URL을 입력한다. 이는 향후 Nextain cloud cascade와 별개이며 현재 cloud endpoint·entitlement·자동 폴백을 뜻하지 않는다. 명시한 Host가 로컬 façade보다 우선한다. | 제어면(설정) + 표시계면(NVA idle/발화) | `config.test.ts`·`capability-settings.spec.ts`·`nva-remote-idle.live.spec.ts` |
| **S-VN** (#ui-reorg, 신규 — 2026-06-29) | 홈(기본) 화면에서 naia와 **몰입형 VN 대화** — 전체화면 VRM 아바타 + 하단 넓은 대화박스(탭 없는 집중형). 좁게 떠 있던 채팅 앱 제거("대화 집중 안 됨" 해소) | 표현(셸 UI) — 단일 ChatApp을 CSS로 재배치(variant=vn), 무리마운트 | `119-pty-terminal.spec.ts` T6(VN variant 노출). ⚠️ 미감=실 앱 |
| **S-WS4** (#ui-reorg) | 워크스페이스 진입 시 **4단 관제탑**: 대화창(좌 레일)·워크트리·문서뷰어(상)+터미널(하)·서브에이전트 리스트. 레일 접기·상하 비율 자유 리사이즈·터미널 탭/그리드 | 표현(셸 UI) — App.tsx `data-ui-mode` 파생 + WorkspaceCenterArea center 상하분할 | T7(레일 variant)·T8(레일 접기 시 ChatApp 무리마운트)·T9(문서뷰어/터미널 분할) + 91 18/18(무회귀) |
| **S-DOC** (#ui-reorg) | 대량 작업문서를 **탭으로 유지·전환**(문서 탭바)해 "터미널에서 문서 찾기 어려움" 해소. 서브에이전트 클릭 시 그 에이전트 최근문서가 탭으로 surface. Ctrl+P QuickOpen 유지 | 표현(셸 UI) — `openDocs` 상태 + DocTabBar | T10(세션 클릭→문서 탭 surface) + 91 S3/S6(에디터 무회귀) |
| **S-ASK** (#ui-reorg) | 터미널 출력의 파일경로 **클릭=문서뷰어에서 열기 / Alt+클릭=대화창에 AI 질의**. 문서 탭에도 AI 질의(✦) 버튼 | 표현(셸 UI) — Terminal link provider Alt 분기 + 기존 `naia:ask-ai` 재사용 | `Terminal.tsx` activate Alt 분기. ⚠️ xterm 링크 클릭=실 앱 |
| **S-INSTALL** (#377, FR-INSTALL — 2026-07-17) | 사용자가 **설치 파일을 받아 자기 OS(Windows/Linux/macOS)에 설치하고 첫 실행**한다 — Windows 는 NSIS(사용자 권한, 관리자 불요, **WSL 불요**) + MSI(관리자 설치 — WiX 표준), Linux 는 deb/rpm/AppImage, macOS 는 app/dmg(**arm64(Apple Silicon) 전용** · 미서명 — 우클릭 열기). Node 런타임이 3 OS 모두 동봉되어 **Node 미설치 머신에서도 에이전트가 뜬다**. 개발자는 clean checkout 에서 **명령 1개**로 자기 OS 의 설치 파일을 재현 빌드한다(수동 파일 배치 0). 플랫폼 차이(타깃·동봉 리소스·설치자 설정·기대 산출물)는 **매트릭스 데이터 1곳**이 정의하고, 스크립트는 OS 별 분리 없이 1개 | 배포(설치·첫 부팅) — 매트릭스→생성 conf, OS 분기=데이터 | `scripts/__tests__/platform-matrix.test.ts`(매트릭스 스키마 + conf 생성 golden, 3 OS) [단위] · `check-build-contract.mjs` PASS [계약] · **Windows 실측: 실 NSIS 무인 설치(/S) → 설치본 기동 — 핸드셰이크 AND `[Naia] node = ` 포함 줄이 최소 2줄 AND 전부 `$INSTDIR` 하위**(2조건, FR-INSTALL.4 — 빌드 머신엔 시스템 node 가 있어 기동만으론 번들 분기가 증명 안 됨. 개수 단언은 공허참 차단)(e2e-tauri `TAURI_BINARY` 설치 경로 지정) · **Linux: CI ubuntu job 이 deb 설치 → xvfb 기동 스모크 — 마커 `[Naia] agent-core gRPC @` **AND** node 줄 최소 2줄 **AND** 그 경로가 전부 설치본 resource_dir 하위**(R5: "PATH 에서 node 제거" 는 폐기 — 폴백이 PATH 무관하게 nvm 디렉토리를 직접 스캔하므로 번들 node 를 증명하지 못함. mutation probe 로 red 도 확인) — **Windows·Linux 양쪽 모두 판정 범위 = 마지막 `=== Session started ===` 포함 줄 이후**(`naia.log` 는 누적 파일) · macOS 실빌드 = CI(`build-installers.yml`) · **산출물 검증 스크립트 `scripts/verify-artifacts.mjs` 실행(빌드 머신 + CI 3 OS) + 부정(negative) 케이스 단위 테스트**(FR-INSTALL.6). ⚠️ mac = **arm64 전용**(CI `macos-latest` = arm64 러너, Intel 산출물 미제공 — 후속) + 실기기 설치 실측 미보유(정직 표기: 이번 완료선 = arm64 CI 빌드 성공) |
| **UC-CLI-OPEN** ([#484](https://github.com/nextain/naia-shell/issues/484), FR-CLI.1~3) | 설치 사용자가 새 터미널에서 `naia`를 실행하면 Naia Shell이 열리거나 기존 창이 포커스된다. `naia <file>`은 상대 경로를 호출 터미널 기준으로 해석해, 셸이 꺼져 있든 실행 중이든 같은 워크스페이스 에디터에 해당 파일을 연다. 존재하지 않는 경로와 디렉터리는 열지 않는다. | 설치 alias/PATH 스모크 · Rust 인자/경로 계약 테스트 · 실행 중/콜드 스타트 네이티브 인수 테스트 |

| **S-MAC-UNIVERSAL** (#505, FR-INSTALL.7 — 2026-08-27) | macOS 사용자는 Intel 또는 Apple Silicon Mac에서 동일한 Universal `Naia.app`을 실행한다. 릴리스 운영자는 동일 커밋을 `macos-15-intel`과 `macos-15`에서 각각 빌드하고, 공통 경로의 Mach-O(셸·Node·네이티브 Node 모듈)를 재귀 병합한다. `darwin-x64`/`darwin-arm64`처럼 런타임 선택용 경로에 든 네이티브 payload는 두 slice를 함께 보존하되, 경로와 slice가 다르거나 그 밖의 한쪽 파일 누락·일반 파일 불일치·thin Mach-O가 있으면 Universal 산출물을 만들지 않는다. 기존 단일 아키텍처 app/dmg는 유지한다. | 배포 — 두 독립 빌드 → 재귀 `lipo` → 전체 Mach-O 검증 | `assemble-macos-universal.test.ts`(파일 집합·분류·thin 바이너리 부정 계약), Intel 실기기 설치본 스모크(agent/BGM/번들 Node), CI arm64+x64 빌드 및 Universal 전체 Mach-O 검사. Apple Silicon 실기기 실행은 별도 출시 증거로 남긴다. |

> S-INSTALL의 arm64-only 표기는 #377 완료 당시의 역사적 기준이다. #505 이후 macOS 릴리스 경로는 S-MAC-UNIVERSAL/FR-INSTALL.7을 따른다.

> **S-INSTALL #411·#412 보강(2026-08-02):** paired Agent와 로컬 의존 프로젝트의 pnpm 버전이
> 서로 달라도 스테이징은 각 `package.json#packageManager` 선언을 Corepack으로 실행한다.
> 설치·빌드·deploy는 비대화식 `CI=true`로 수행해 TTY 확인 대기나
> `ERR_PNPM_BAD_PM_VERSION` 없이 clean installer와 `tauri:dev`를 재현한다. 설치 스테이징과
> dev 시작은 하나의 package-manager resolver를 공유한다. 검증은 `package-manager.test.ts`,
> `platform-matrix.test.ts`와 실제 Windows NSIS/MSI 빌드·release/dev 시작 스모크다.

> 격리 라벨: S-VRAM 의 로컬 serving/auto-download = `unimplemented`(loader device RTF gate, private tier manifest). S-TTS/S-CAP 라이브 왕복 = 측정 천장(실 앱), 코드 결함 격리 아님.

> **UC-AV 과거 연구 기록 (2026-07-08~09):** 아래 8GB 3모드·음성 클라우드 전제는 Windows `windows_trt_8g`에 적용하지 않는다. T3 원격 URL 계약 등 독립 기능의 이력은 유지한다. 현재 Windows 시나리오는 UC-WIN-NVA-8G와 [`windows-8gb-nva.md`](windows-8gb-nva.md)를 따른다.
> - **UC-AV.1 8G 로컬 집중 3모드**: 8GB 사용자가 프로파일에서 로컬 집중 택1(로컬 LLM만 / 비디오 아바타만 / 둘 다) — 동시 구동 불가라 배타. 음성(VoxCPM2)은 8G 에선 **항상 클라우드**. 기본=llm(프라이버시). 수용기준: focus 셀렉터 3옵션 노출·resolveLocalCapabilities 배타 해소(llm→[llm]·avatar→[avatar]·both→[llm,avatar])·tts 로컬 제거. 검증(P02): `vram-tiers.test.ts`(resolveLocalCapabilities·normalizeLocal8gFocus)·wm `test_manifest.py`(focus 배타·voice→avatar 마이그레이션·비8G 무시·**tts_ 전체 스트립**)·`capability-settings.spec.ts` FR-5.
> - **UC-AV.2 VRAM 프리플라이트 강등(정직)**: free VRAM 부족 시 로컬 LLM→클라우드 강등 + 명확 경고(무료/로컬 위장 금지). ★실측: 8G both(llm 4.0 + avatar 2.6 = 6.6) > 프로덕션 budget(8 − margin 1.5 = 6.5) → **LLM 강등(아바타만 로컬)**. 수용기준: `llmFallbackToCloud=true` 시 `local-llm-vram-fallback` 배지. 검증: `vram-tiers.test.ts`(fit 폴백 + margin 1.5 fidelity)·`capability-settings.spec.ts`(fallback 배지).
> - **UC-AV.3 아바타 cascade capability 게이트**: 비디오 아바타는 로컬 avatar 제공(또는 naia 로그인) 없으면 선택 불가 + 안내(`avatar-cascade-required`). 검증: `capability-settings.spec.ts` FR-7(게이트·로그아웃 교차).
> - **UC-AV.4 립싱크 노트**: 비디오 아바타 선택 + TTS off → "립싱크엔 TTS 필요" 경고(`nva-lipsync-note`). 8G avatar 모드=음성 클라우드라 TTS 필수 안내. 검증: `capability-settings.spec.ts` FR-6.
> - **UC-AV.5 T1 로컬 네이티브 cascade auto-spawn**: wm `loader launch` → 파사드 :8910 + VRAM 예산 내 서비스(Ditto TRT :8902 / VoxCPM2 :8901) spawn·감독, stdout `CASCADE_READY {json}` 핸드셰이크, 자식 사망 시 teardown. **★실증 2026-07-09 (이 RTX 4060 8GB)**: 3서비스 완전 spawn·`CASCADE_READY`·full 모드 — Ditto TRT SDK ready 7.7s(tensorrt-native)·VoxCPM2 int8 CUDA bfloat16 로드·파사드 `avatar_enabled+tts_enabled`. naia-shell 앱 자체 launch 도 파사드 기동 확인. 검증: wm `test_launcher.py`·`test_service_plan.py`·loader plan/launch 실행·naia-shell Rust `start_cascade`. ⚠️ **얼굴 프레임 렌더 = NVA 캐릭터 번들 로드(/load_nva=추출 dir) 후**(P4 통합, 앱이 캐릭터 config 로 처리) — measurement-gated(F1), 사용자 실기.
> - **UC-AV.6 T3 원격 cascade URL**: 로그인 사용자가 아바타 설정에서 NVA 선택 후 `cascadeRuntimeUrl`을 입력한다. URL은 http/https만 허용하고 정규화한다. 명시한 NVA Host가 로컬 파사드보다 우선하며 원격 장애 시 로컬 Ditto를 암묵 기동하지 않는다. 원격 뷰어는 `GET /health` 후 query 없는 `GET /idle` 전체 응답을 Blob URL로 반복 재생하며, `/load_nva.dir`이 서버 로컬 경로라는 계약 때문에 원격 서버에는 이를 호출하지 않는다.
> - **UC-AV.8 원격 NVA 결합 발화**: 명시한 원격 NVA Host가 있으면 응답 텍스트를 `/stream_text`로 보내고 서버가 mux한 VoxCPM2 음성+아바타 영상을 그대로 재생한다. 이 경로에서는 Shell의 별도 음성 호스트를 호출하거나 음성을 중복 재생하지 않는다. 배경 투명은 원격 cascade의 VP9 알파 출력이 활성일 때만 제공한다.
> - **UC-AV.7 voiceprint 불변(NFR)**: Naia가 VoxCPM2를 사용할 때 **음성지문(ref)은 필수**이며 무지문 합성을 허용하지 않는다. 이 원칙은 Windows 8GB 로컬 VoxCPM2 W8A16 + TensorRT LocDiT에도 적용된다. 검증: voiceprint guard와 façade `/ref/voices` 팔레트.

## S-RADIO-DJ — 개인 라디오 DJ·행사 소개 (Shell 기본 스킬, #362·#405)

| 시나리오 ID | 사용자 흐름 / 완료 조건 | 책임·검증 |
|---|---|---|
| **S-RADIO-DJ-1** | 사용자가 DJ 모드에서 곡을 요청하면 Shell은 `requested → loading → playing`의 실제 관측값, 곡 정보·길이·진행 위치를 반환한다. 곡 A 다음 곡 B로 바꾼 뒤 늦게 도착한 A 오류는 B의 상태나 소개를 바꾸지 않는다. | Shell 관측 사실: FR-RADIO-DJ.1~2. 로컬 fixture E2E: A→B→late A error. |
| **S-RADIO-DJ-2** | YouTube가 재생 불가·임베드 제한·로딩 시간초과이면 DJ는 재생 성공처럼 말하지 않는다. 자동재생 opt-in일 때만 대체곡을 한 번 시도하고, 그 외에는 한 번의 짧은 안내 또는 침묵으로 끝낸다. | Shell 오류 분류 + agent의 근거 있는 멘트: FR-RADIO-DJ.2·5. |
| **S-RADIO-DJ-3** | 연속 발화·DJ·행사 소개에서 agent가 다음 발화 전 Shell 관측값을 확인한다. 곡이 충분히 진행되지 않았거나 쿨다운 중이거나 사용자가 말하는 중이면 새 멘트와 TTS를 만들지 않는다. `speakPermit` 발급 뒤 사용자 발화/채팅이 시작하거나 재생 sequence가 바뀌면 permit을 폐기하고 DJ TTS는 0회여야 한다. | agent 소유 스케줄러, Shell의 단일 사용 permit·원자적 TTS 직전 재검증: FR-RADIO-DJ.3~4. |
| **S-RADIO-DJ-4** | 동의한 사용자에게만 유효한 IANA 시간대와 신선한 날씨 결과를 DJ/행사 맥락에 맞게 짧게 쓴다. 동의를 철회하면 원 좌표와 날씨 캐시가 폐기되고 이후 멘트에 날씨가 나오지 않는다. 잘못된 시간대는 정규화/시간 언급 비활성으로 관측 가능하게 처리하며, DST 경계도 일관되게 계산한다. | 최소 노출·TTL·정밀도·폐기·유효/무효 IANA·DST 검증: FR-RADIO-DJ.6~7. |
| **S-RADIO-DJ-5** | DJ가 곡 제목·아티스트·길이를 언급할 때는 현재 `playbackId`의 관측된 `playing` 결과에 근거한다. 명령 접수 성공만으로는 소개하지 않는다. 5초가 지난 `playing` 스냅샷이 `ended/error`로 바뀌면 재관측 뒤 소개·TTS를 하지 않는다. | 도구 결과→activity provenance·freshness 계약: FR-RADIO-DJ.1·5. |
| **S-RADIO-DJ-6** | CI는 외부 YouTube 의존 없이 로컬 iframe event fixture로 ready/playing/error/ended와 도구 결과·발화 조건을 검증한다. 실제 YouTube 검증은 부스/릴리스 전 선택적 smoke로 분리한다. | 결정론적 Tauri E2E + 선택적 smoke: FR-RADIO-DJ.7. |
| **S-RADIO-DJ-7** | 외부 LLM과 Windows 로컬 TRT를 함께 쓰는 개인 라디오에서 곡 A의 `playing`을 확인한 뒤 자동 DJ 문장을 만든다. 문장은 음성 준비 전에는 채팅에 노출하지 않고, VoxCPM2가 만든 같은 오디오를 Ditto에 보내 영상 재생이 시작될 때 표시한다. activity가 곡 B를 요청하면 현재 곡과 대기열을 교체하고 B의 `playing`을 확인한 뒤 한 번만 다시 말한다. 렌더 중 사용자가 Enter로 끼어들면 250ms 안에 현재 렌더를 취소하되 BGM은 유지한다. | 실제 Tauri + TRT NVA 통합: `94-avatar-4060-facade.spec.ts`; Shell #405, agent #103. 일반 채팅의 BGM 요청은 기존 대기열 의미를 유지한다. |

| **S-RADIO-DJ-8** | 사용자가 설정의 스킬 탭을 열면 `Youtube Radio DJ`가 시스템 스킬 다음이자 `memo` 바로 앞에 다른 기본 스킬과 같은 2열 카드로 보인다. 접힌 상태에는 짧은 설명만 표시되고, 카드를 누르면 대기시간·멘트 간격·시간대·BGM 자동재생 상세 설정이 펼쳐진다. 처음 열어도 숫자 입력이 비어 있지 않으며 자동 발화는 사용자가 켜기 전까지 시작하지 않는다. | FR-RADIO-DJ.9. Settings RTL + `settings-slots.spec.ts` Playwright. |
| **S-RADIO-DJ-9** | 사용자가 어느 언어로든 “계속 음악을 골라 소개해 줘”처럼 유사한 뜻을 말하면 LLM이 `radio_dj` 모드를 선택해 음악 재생과 능동 발화를 함께 켠다. 단순히 한 곡이나 BGM을 요청하면 `player`로 실행되어 능동 발화 설정을 바꾸지 않는다. | FR-RADIO-DJ.10. 키워드 매칭 없이 스킬 schema와 구조화 `mode` 호출 검증. |
| **S-RADIO-DJ-10** | 곡이 끝나기 전에 최근곡·싫어요·실패 후보를 제외해 비슷한 다음 곡을 미리 찾고, 실제 종료 뒤 짧은 멘트와 함께 전환한다. 새 곡은 실제 `playing` 뒤에만 소개한다. | FR-RADIO-DJ.11·14·16. 결정론적 종료/검색 fixture + 실제 YouTube 실기. |
| **S-RADIO-DJ-11** | 재생 중 일반 대화는 음악·대기열을 보존하고, “다른 곡”은 현재 자동 흐름을 취소해 새 곡으로 즉시 교체하며, “라디오 그만”은 검색·TTS·타이머까지 멈춘다. | FR-RADIO-DJ.12. 대화/종료/TTS 경합 Playwright + 네이티브 끼어들기. |
| **S-RADIO-DJ-12** | 사용자가 명시한 좋아요·싫어요만 장기 취향으로 기억하고 조회·수정·삭제할 수 있다. 단순 청취와 한 번의 건너뛰기로 영구 취향을 추론하지 않는다. | FR-RADIO-DJ.13. 메모리 쓰기·재호출·삭제 영수증 및 계정 격리. |
| **S-RADIO-DJ-13** | 최근에 튼 같은 곡과 동일 음원의 다른 영상을 피하고, 장르·분위기는 비슷하지만 새로운 곡을 추천한다. 명시적으로 같은 곡을 요청하면 반복 금지를 우회할 수 있다. | FR-RADIO-DJ.14. videoId+정규화 곡 키 최근 이력, 아티스트 편중, 8시간 피로도 검증. |
| **S-RADIO-DJ-14** | “이 곡 즐겨찾기에 등록해줘/빼줘/내 즐겨찾기 틀어줘”를 실행하고 재시작 뒤에도 유지한다. 즐겨찾기 한 바퀴 전에는 같은 곡을 반복하지 않는다. | FR-RADIO-DJ.15. 음성·텍스트 도구 계약 + 저장·복원 + 빈 목록·실패 항목. |
| **S-RADIO-DJ-15** | YouTube가 “재생할 수 없는 곡입니다”, 삭제·지역·연령 제한 또는 iframe 오류를 반환하면 성공으로 소개하지 않고 해당 후보를 제외한 다른 곡을 제한된 횟수로 찾는다. | FR-RADIO-DJ.16. 오류 fixture + 실제 YouTube 실패 후보 smoke. |
| **S-RADIO-DJ-16** | 이미지 입력이 가능한 모델이면 음악 화면만 캡처해 실제 보이는 영상·앨범 아트·오류 화면을 짧게 언급한다. 채팅·설정·알림 등 개인 UI는 캡처하지 않으며 이미지 입력이 불가능하면 보았다고 말하지 않는다. | FR-RADIO-DJ.17. 음악 표면 전용 캡처 + model capability gate + 멀티모달 도구 결과 계약. |

전체 실기 절차와 증거 형식은 [`radio-dj-practical-test-scenarios.md`](radio-dj-practical-test-scenarios.md)를 따른다.

메모리·반복 회피·즐겨찾기·오류 복구·이미지 모델 화면 관찰을 한 흐름으로 묶은 단계별 계약은 [`radio-dj-integrated-use-cases.md`](radio-dj-integrated-use-cases.md)를 따른다.

## UC-CODEX-ROLES — Codex를 main으로 쓰고 역할별 모델을 분리한다

사용자는 설정에서 Codex를 main provider로 선택한다. API key 입력 없이 로컬 Codex 로그인으로 대화하며,
sub와 memory 역할은 처음에는 main 설정을 상속한다. 사용자가 역할별 설정을 선택하면 각 역할에서 지원하는
provider/model을 독립적으로 지정하고, 다시 시작해도 그 선택을 복원한다. Codex처럼 main 전용 provider는
sub 또는 memory의 직접 선택지에 표시하지 않고, main 상속으로만 사용한다. 재시작 뒤에도 역할 설정이 보존되고,
Shell은 빌드 때 고정된 정확한 Agent 런타임만 실행한다.

검증은 `SettingsTab`, `adk-store`, `chat-service`, `uc-wire-v1-paired-proto` 계약과 실제 Codex smoke를 함께 사용한다.

## UC-GROK-SUBSCRIPTION — SuperGrok 구독 CLI를 main으로 쓴다

사용자는 설정 두뇌에서 Grok를 선택한다. API key 칸은 없고, `Grok 연결 확인`으로 로컬 Grok Build CLI 설치·로그인만 본다. 기존 xAI API-key provider는 그대로 남아 종량 경로로 쓸 수 있다. 채팅 준비는 키 없이 통과한다.

- 성공: Grok 선택 후 모델 `grok-4.6`이 기본이고, 준비 확인이 `준비됨`을 표시하며 계정/출력을 보여 주지 않는다.
- 실패: 미설치·미로그인·확인 실패를 구분해 표시하고 기존 설정은 바꾸지 않는다.
- 재시도: 같은 화면에서 다시 확인할 수 있다.
- 채팅: API 키 없이 `chat_request.provider=grok`가 Agent로 가고 응답이 렌더된다.
- 경계: `~/.grok/auth.json`을 읽거나 복사하지 않는다. 게이트웨이 카탈로그의 `grok:` prefix는 API(`xai`)로 남는다.

검증: Playwright 실 UI `packages/shell/e2e/grok-readiness.spec.ts`. 로그인된 실제 Shell은 `e2e-tauri/specs/96-grok-readiness.spec.ts`.

## UC-JEONJU-COURSE-READINESS — 강의용 Codex 준비 상태를 확인한다

전주대 실습 참여자는 설정의 **두뇌**에서 Codex를 선택하고 `Codex 연결 확인`을 누른다. Shell은 현재 PC에서 Codex CLI가 설치되어 있고 로그인되어 있는지만 확인해 `준비됨`, `설치 필요`, `로그인 필요`, 또는 `확인 실패`를 표시한다. 인증 토큰, 계정 식별자, 명령 출력 원문은 화면·설정·로그에 표시하거나 저장하지 않는다.

참여자는 이어서 일반 설정에서 수업 워크스페이스를 선택한다. Codex 준비 확인은 파일을 읽거나 바꾸지 않으며, 수업 저장소 밖의 경로를 허용하지 않는다. 이 단계가 통과한 뒤에만 Discord에서 첫 제작 요청을 시작한다.

- 성공: Codex 선택 상태에서 준비됨이 보이고, 선택한 워크스페이스가 현재 Shell의 작업 루트와 일치한다.
- 실패: 설치되지 않았거나 로그인되지 않았으면 원인을 구분해 표시하고, 이전 provider·모델·워크스페이스 설정은 바꾸지 않는다.
- 재시도: 사용자가 설치 또는 로그인을 마친 뒤 같은 화면에서 다시 확인할 수 있다.
- 경계: 이 확인은 Codex에게 파일 작성·Git commit·push·배포를 맡기지 않는다. Git과 GitHub Pages는 수강생이 별도 단계에서 직접 수행한다.

이 UC의 상태 분류과 토큰 비노출은 Rust·Settings 단위 테스트로, 실제 로그인된 Codex CLI와 Brain 화면의 준비 상태 표시는 `e2e-tauri/specs/96-codex-readiness.spec.ts` 네이티브 Tauri E2E로 검증한다.

## UC-CODEX-WORKER-LIFECYCLE — 격리된 Codex 코딩 작업자를 관리한다

사용자는 워크스페이스의 **Coding Workers** 앱에서 provider `codex`, 작업할 worktree, 작업 설명을 명시해 코딩 작업자를 요청한다. Shell은 준비되지 않은 adapter를 성공으로 표시하지 않으며, API가 연결되기 전에는 “작업자 서비스에 연결할 수 없음”을 표시하고 목록 상태를 만들지 않는다.

작업자가 생성된 뒤에는 각 항목의 worktree·작업 설명·마지막 갱신 시각·`queued`/`running`/`cancelling`/`cancelled`/`completed`/`failed` 상태를 독립적으로 본다. 실행 중인 작업자가 같은 worktree를 이미 점유하면 두 번째 요청은 충돌 이유를 표시하고 전송하지 않는다. 동시에 실행할 작업자는 서로 다른 격리 worktree를 사용한다.

사용자는 대상 작업자에만 취소를 요청할 수 있다. Shell은 adapter가 확인한 상태만 렌더하며, PTY 종료를 취소 성공으로 바꾸지 않는다. 재개는 checkpoint 식별자가 있는 `cancelled` 또는 `failed` 항목에만 노출한다. checkpoint가 없으면 재개 버튼을 제공하지 않고, 단순 터미널 재시작을 재개로 표현하지 않는다.

- 성공: adapter가 반환한 작업자만 목록에 추가·갱신되고, 두 작업자는 서로 다른 worktree에서 병렬로 관찰된다.
- 실패: API 미연결·요청 실패·동일 worktree 충돌은 안전한 오류만 표시하며 새 상태·비밀값·원본 adapter 오류는 화면이나 로그에 남기지 않는다.
- 경계: 로그인 토큰·계정 식별자·Codex CLI 출력은 worker request·UI·로그에 포함하지 않는다. 실제 gRPC schema가 확정되기 전 Shell은 작업자 실행을 흉내 내지 않는다.

### 시각·사용성 수용 기준

사용자는 작업자 앱을 열었을 때 제어 루트, 실행 대상, 현재 수업 대상의 저장 상태, 다음 행동을 한 화면에서 구분한다. 선택할 수 없는 provider를 선택 상자처럼 보이지 않게 하며, 상태는 원시 enum이나 원문 시간만으로 전달하지 않는다. 앱은 1,100px 이하의 Shell 분할 폭에서도 입력·수업 경계·실행 버튼이 한 열의 의도된 순서로 유지된다.

- 빈 목록: 작업자가 없다는 사실과 첫 작업을 시작할 수 있는 입력 흐름을 표시한다.
- 진행 중: 저장·시작·취소·재개 요청 중에는 해당 행동을 중복 전송하지 않고 진행 상태를 표시한다.
- 오류: 안전한 원인과 재시도 전에 확인할 행동을 해당 요청 맥락에서 표시한다. 주기적 연결 오류가 사용자의 저장·시작 결과를 덮어쓰지 않는다.
- 수업 대상: 저장된 대상은 `다음 Agent 시작 시 적용`임을 명시하고, 저장되지 않았거나 아직 적용되지 않은 상태를 구분한다.

## UC-JEONJU-COURSE-WORKER

For the Jeonju course, the user explicitly selects a Git root and enables course mode. The default remains an Agent-created isolated worktree. Course mode is the only route that can run in the selected workspace.

- **ADK control root and execution target:** Shell shows the currently selected Naia ADK root as the control root. Skills, settings, and job state remain there. The user separately enters an execution-target Git root: normally `naia-adk/projects/<project>`, or the ADK root itself only for an explicit ADK-maintenance task. Codex is started with that target as its working directory; it does not receive a blanket write scope for every project under the ADK root.
- **Course containment:** a direct course target must be the control root itself or a descendant Git root. A sibling checkout or an unrelated absolute path fails closed before the worker is created. This keeps the default ADK workspace useful while allowing an independently versioned project below `projects/` to be the actual write target.
- Shell and Agent both fail closed unless the selected folder is the exact clean Git root with a remote.
- The allowed file list is fixed by Shell IPC to `index.html` and `hero.svg`. WebView input, Discord messages, LLM text, and task text cannot supply or change that list.
- **Proposal then apply:** the selected provider is a read-only proposal producer, not the filesystem authority. It returns only a versioned complete-file JSON proposal. Naia parses that fixed schema, applies the accepted subset of `index.html` and `hero.svg`, then runs the existing Git and content verification. This contract is shared by Codex, a model authenticated through the user's Naia account, and any later compatible provider.
- The worker card shows the returned verification summary. A failed check preserves student changes for manual review; Shell never resets or cleans the student workspace.
- **Visible course interaction:** Shell keeps the course start action disabled until the saved Discord course target is the same Git root currently entered by the instructor. The selected-workspace card is the student-facing Naia report: it states whether the proposal is queued, running, cancelling, completed with verification, completed without verification, failed, or cancelled. A verified completion tells the student to inspect the two files, check the page in a browser, and then make the Git commit; its `수업 파일 열기` action opens `index.html` directly in the Shell editor. Failed or cancelled work explicitly says that success was not claimed and that remaining files are preserved for review.
- If readiness fails, no worker is created and the UI gives a safe instruction to review the selected folder rather than exposing raw Git or Agent output.

### UC-JEONJU-DISCORD-COURSE-TARGET

Before starting the Agent, the instructor opens **Coding Workers**, enables Jeonju course mode, and explicitly saves the Discord course target. Shell writes the target only to the active ADK control root at `naia-settings/jeonju-discord-course.json`.

- The persisted document is versioned (`version: 1`) and contains the canonical selected Git root plus the exact fixed file list `index.html`, `hero.svg`.
- Rust accepts only a clean Git root with `origin` that is the control root or its descendant. A sibling checkout, arbitrary absolute path, dirty repository, missing remote, malformed document, or altered file list fails closed.
- The form exposes the fixed file boundary as status only. Discord messages, chat task text, and model output never supply a workspace path or allowed-file list.
- Agent startup consumes this trusted target document. The saved target is distinct from an ordinary Coding Worker request, so normal workers continue to use isolated worktrees.

Success means the visible confirmation identifies the saved target and fixed boundary without exposing a token or raw Git output. A failed save keeps the prior target unchanged and gives only the folder-readiness guidance.

## UC-NAIA-AZURE-MODELS — Naia 계정으로 Azure 모델을 일반 대화에 사용한다

Naia 계정으로 로그인한 사용자는 설정의 Naia 모델 목록에서 `grok-4.3`,
`deepseek-v4-pro`, `gpt-5.6-sol`, `gpt-5.6-luna`를 선택하고 저장할 수 있다.

선택 가능한 모든 Naia 채팅 모델은 동일한 Shell 스킬 목록을 전달받아 호출할 수 있다. 도구 호출이 검증되지 않았거나 운영 catalog에서 사용할 수 없는 모델은 선택 가능한 모델로 취급하지 않는다.
`claude-opus-5`는 Azure quota가 열리기 전까지 준비중으로 보이며 적용되지 않는다.
재시작 후 선택이 복원되며 일반 채팅은
기존 Shell→Agent provider pipeline과 같은 Naia 키를 통해 선택한 정확한 모델로 전달된다.
Gateway가 제공한 Azure provenance와 tool 지원 여부는 정직하게 반영하고, gateway가
일시적으로 응답하지 않으면 정적 fallback을 사용하되 다른 모델/provider로 바꾸지 않는다.
Gateway의 가격은 이미 10%가 반영된 고객가이므로 Shell은 다시 가산하지 않는다.

이번 UC는 Coding Workers·Pi 작업 시작/취소/재개를 포함하지 않는다. 상세 계약은
`docs/progress/99.dev-comm/naia-account-model-connection-2026-07-30.md`이다.

## Test Coverage Map (P02)

**UC-JEONJU-COURSE-WORKER** 의 화면은 지금 없다. 코딩 작업자 패널이 2026-09-05 에 없어졌고(#554, Herdr 창의 agents 탭과 IDE 뷰어가 그 자리를 대신한다), 그 패널을 그려서 재던 단위 테스트와 실기 수용 스펙을 함께 지웠다 — 97-course-worker-guidance 는 2026-09-05 에(6eeb1433), coding-workers 단위 테스트와 91-jeonju-course-worker 스펙은 같은 날 그 뒤에 지웠다. 남은 것은 화면이 아닌 계약이다: `apps/workspace/__tests__/coding-workers-tauri.test.ts` 가 작업자 어댑터의 Tauri 경계를, `src-tauri/src/lib.rs` 가 생성·취소·재개의 네이티브 계약을 재다. 화면을 되살릴지는 #554 에서 정한다. The proposal worker may inherit a read-only parent sandbox, because it no longer writes the course repository: Naia performs the constrained apply and post-apply verification.

**UC-JEONJU-DISCORD-COURSE-TARGET** maps to `apps/workspace/__tests__/jeonju-course-target.test.ts` for the fixed schema parser and no caller-supplied allowed files. 저장 단추를 누르는 화면은 코딩 작업자 패널과 함께 없어졌으므로, 지금 재는 것은 그 단추가 아니라 문서 자체의 계약이다. `src-tauri/src/lib.rs` contracts cover canonical containment and exact schema rejection. Its native Tauri coverage extends the Jeonju course acceptance fixture so the saved target exists before Agent startup.

작업자 입력 양식은 2026-09-05 까지 제어 루트와 실행 대상을 따로 보여 주었고, 수업 모드를 고르면 대상 라벨과 안내 문구가 바뀌었다. 그 양식이 없어졌으므로 이것을 재던 단위 테스트도, 수업 저장소를 만들던 실기 스펙도 남아 있지 않다. 수업 대상을 다시 사람이 고를 수 있게 할 것인지는 #554 에서 정한다.

**시각 검토 게이트:** 기능 UI 변경은 구현 전 상태 매트릭스(기본·빈 목록·진행·성공·오류·좁은 폭)를 P02에 기록한다. P04에서는 해당 상태를 컴포넌트/Playwright와 실제 Tauri Shell에서 확인하고, 스크린샷 또는 동등한 DOM·레이아웃 증거를 남긴다. 기능 계약 테스트만 통과한 경우에는 P05 완료로 선언하지 않는다.

| UC | 단위/계약 | UI 통합 |
|---|---|---|
| UC-CODEX-WORKER-LIFECYCLE | `apps/workspace/__tests__/coding-workers-tauri.test.ts`: 작업자 어댑터가 Tauri 명령으로 생성·취소·재개를 보내는 경계. 화면 쪽 단위 테스트는 코딩 작업자 패널과 함께 2026-09-05 에 지웠다(#554) | `e2e/coding-workers.spec.ts` (후속): Tauri adapter fixture로 두 isolated worktree와 cancel/reconciliation을 검증한다. 실제 Agent schema 수신 전에는 fixture가 성공 실행을 가장하지 않는다. |
| UC-CODEX-WORKER-LIFECYCLE 시각 수용 | 재는 자리가 없다 — provider 표현·빈 목록·상태 배지를 보여 주던 화면이 2026-09-05 에 없어졌다(#554). 다시 만들면 그때 상태 매트릭스를 다시 적는다 | `e2e/coding-workers.spec.ts`: Shell 분할 폭(1,100px 이하)에서 입력·수업 경계·주요 행동의 순서와 접근 가능한 상태 표현을 검증. |
| UC-CODEX-ROLES | `src/lib/llm/__tests__/roles.test.ts`, `src/components/__tests__/SettingsTab.test.tsx`: main 상속, 역할별 provider/model 저장, main 전용 provider 차단 | `e2e-tauri/specs/95-llm-role-settings.spec.ts`: 실제 Shell 설정 화면에서 역할 설정 저장과 재시작 복원 |
| UC-NAIA-AZURE-MODELS | `packages/shell/src/components/__tests__/SettingsTab.test.tsx`: Naia 모델 목록이 가격 가중 순서로 서고, 쓸 수 없는 모델은 숨으며, Azure provenance 와 도구 지원 여부가 gateway 응답대로 반영되는지 / `packages/shell/src/lib/__tests__/config.test.ts`: 선택이 재시작 뒤 복원되는지 | 실제 대화가 그 모델로 가는지는 사람이 받는다 — 자동으로 재는 자리는 아직 없다 |

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

### 기능 격리/면제 목록 — 게이트웨이 시대 도구 (#567, 2026-09-06)

위 규칙(R1/R7)에 따라 라벨한다. 이 항목들은 **대화로 도구를 시켜** 확인하던
e2e 스펙이었고, 그 도구 이름은 지금 에이전트의 도구 집합에 없다. 판정 기준은
"이름이 있느냐" 가 아니라 **"그 능력이 지금 어느 경로로 사는가"** 다 — 살아 있으면
그 경로로 다시 겨누고, 죽었으면 스펙을 지운다(판례: 코딩 작업자 화면 폐기 = 삭제,
workspace-area 41개 = Herdr 브리지로 재조준).

⚠️ **R7 경계**: 이 도구들은 게이트웨이 시대에 작동했다. 규칙은 "작동하던 것의
상실은 격리 불가" 라고 못박는다. 게이트웨이 제거는 `FR-SHELL-ISO.1` 이 적은
**의도된 설계 변경**(`spawn_gateway` = 제거된 스텁)이므로 `disabled-by-design` 으로
둔다. 그 판단은 오너의 것이고, 아래 삭제는 그 판단 위에 선다.

| 지운 스펙 | 부르던 도구 | 사유 부류 | 격리 라벨 | 중요도 |
|---|---|---|---|---|
| 05-skill-system | `skill_system_status` | 게이트웨이 표면 소멸 — 자기 상태는 `Diagnostics` RPC + DiagnosticsTab 이 맡고 `31`·`60` 이 덮는다 | `disabled-by-design` | 중 |
| 21-cron-recurring | `skill_cron` | 오너 확인된 cron 기능 트랙 존재(아웃룩형 캘린더 포함) — 그 트랙이 도구를 정하면 그때 다시 쓴다 | `unwired` | 중 |
| 29-cron-gateway | `skill_cron gateway_*` | 게이트웨이 표면 소멸 | `disabled-by-design` | 하 |
| 45-cron-gateway-full | `skill_cron gateway_*` | 게이트웨이 표면 소멸 | `disabled-by-design` | 하 |
| 41-agents-crud | `skill_agents` | 게이트웨이 표면 소멸 — 능력은 AgentsTab | `disabled-by-design` | 중 |
| 43-device-management | `skill_device` | 게이트웨이 표면 소멸 — **덮는 스펙 없음**(34 는 얕은 화면 스모크) | `disabled-by-design` | **상 — 의도된 커버리지 상실** |
| 47-tts-full | `skill_tts` | 게이트웨이 표면 소멸 — `24`·`73`·`76`·`80`·`81` 이 화면 경로를 덮는다 | `disabled-by-design` | 하 |
| 49-approvals-full | `skill_approvals` | 게이트웨이 표면 소멸 — 승인은 ApprovalPort + 권한 모달 | `disabled-by-design` | 중 |
| 30-exec-approvals | `skill_approvals get_rules` · `skill_time` | 같은 가족(49 를 덮는다던 스펙 자신이 같은 도구를 부른다) | `disabled-by-design` | 중 |
| 51-skills-advanced | `skill_skill_manager` | 게이트웨이 표면 소멸 — 능력은 SkillsTab, `14`·`28`·`59` 가 덮는다 | `disabled-by-design` | 하 |
| 39-web-tools 의 `web_search` 단정 | `web_search` | 게이트웨이 표면 소멸(S55 = gateway-tier) | `disabled-by-design` | 하 |

> **43 = 의도된 커버리지 상실.** 디바이스 조작(`node_describe` · token rotate/revoke ·
> rename · pair request/verify/approve) 여덟 단정을 지우면서 대체를 두지 않았다.
> `34-device-pairing` 은 설정 탭으로 가서 섹션과 빈 상태를 보는 얕은 스모크라 같은
> 깊이가 아니다. 재확보는 별도 이슈로 연다.

**재조준한 것**(스펙은 남는다):

| 스펙 | 예전 도구 | 지금 겨누는 경로 |
|---|---|---|
| 42-sessions-crud | `skill_sessions`(셸이 "new-core 미지원 — chat 도구루프로만" 이라 막음) | `ConversationLogPort` → `<ADK>/conversations/<sessionId>.jsonl` append-only 기록 |
| 39-web-tools | `browser` | 셸 앱 스킬 `skill_browser_navigate` |

**전제를 세워 다시 겨눈 것 둘** (#567 후속):

`17-skill-notify`(`skill_notify_slack`/`_discord`)와 `37-execute-command`
(`execute_command`)는 "미배선 어댑터" 로 분류됐으나, e2e 가 실제로 도는 짝
체크아웃에서 그 어댑터들은 **프로덕션 진입점이 import 한다**. 도달하지 못한 이유는
배선 부재가 아니라 **합성 전제**였다 — `shell_exec` 는 `NAIA_SHELL_TOOL=1`,
`notify` 는 webhook 주소가 있을 때만 도구 목록에 오른다. 진짜 미배선은 naia-agent 의
cron-skills 뿐이다(프로덕션 import 0, naia-agent#128).

그래서 지우지 않고 전제를 하네스가 세우도록 했다. 목록의 정본은
`packages/shell/e2e-tauri/harness-provided-env.mjs` 이고 러너의 선별도 같은 곳을
읽으므로, 러너·설정·문서가 한 목록을 본다.

| 스펙 | 예전 도구 | 지금 겨누는 것 | 하네스가 세우는 전제 |
|---|---|---|---|
| 37-execute-command | `execute_command` | `shell_exec` 로 `echo` 실행 후 출력 확인 | `NAIA_SHELL_TOOL=1` |
| 17-skill-notify | `skill_notify_slack`/`_discord` · `allowedTools` 배열 | `notify` 로 보낸 알림이 **받는 쪽 스텁**에 도착하는가, 그리고 요청한 채널로 갔는가 | 로컬 webhook 스텁(무작위 포트) + `NAIA_NOTIFY_*_WEBHOOK` + `NAIA_E2E_NOTIFY_LOG` |

`allowedTools` 단정은 지웠다. 그 배열은 에이전트가 읽지 않으므로 이름이 거기 있든
없든 도구가 붙는지와 무관하고, 알림이 실제로 나갔는지도 말하지 못한다.

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
| UC9 앱 | app install | 로컬 | 실측 |
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
| **도구·환경 tranche**(V 이후, *기능별 Old-Baseline 게이트*) | UC5 도구 · UC6 브라우저 · UC8 BGM · UC9 앱 · UC10 멀티채널(기본) | 외부 의존 개별 실측 후 |
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

도구·환경 tranche(UC5 도구·UC6 브라우저·UC7 워크스페이스)의 셸측 슬라이스. 사용자가 워크스페이스 지식을 물으면, 에이전트가 `skill_knowledge_ask`/`search`(naia-agent **UC-KNOWLEDGE**, kb-compiler backend — 별 레포 live)로 **근거 있는 답변**을 내고, 셸이 그 tool-result(JSON)를 **답변 + 출처 칩**으로 렌더한다(K2). 출처 칩 클릭 시 **근거→원문**: URL=브라우저 앱(UC6), 워크스페이스 파일=파일뷰어(UC7)로 원문이 열린다. 근거 없으면 **기권**(칩 없음). 또한 `skill_knowledge_graph` 결과는 셸이 **2D/3D 캔버스 그래프**(엔티티·관계·군집색·degree 크기, 2D↔3D 토글)로 시각화한다(K3).

- **인지흐름**: (사고)지식 질의 → (표현)근거 답변+출처·지식 그래프 → (행위)칩 클릭→원문 앱 전환. 백엔드 배선·계약 = naia-agent(별 레포), 셸 렌더·dispatch·뷰어 = 본 feature(기존 브라우저/워크스페이스 앱 api 재사용·그래프 의존성 0 캔버스, 신규 사이드카 0).
- **검증(P02)**: requirements.md **FR-KB-OS.1~4** 매핑 — `knowledge-result.test.ts`(파싱·분류·그래프 파싱 단위)·`knowledge-tool-result.test.tsx`(RTL 렌더+칩 dispatch)·`e2e/chat-tools.spec.ts` "지식 도구(K2)"·"지식 그래프(K3)"(Playwright 실 UI: 답변+칩+칩클릭→브라우저 앱 / 그래프 캔버스 렌더+2D/3D 토글). tsc0.
- 통합 설계 SoT = alpha-adk `.agents/progress/naia-kb-compiler-agent-os-integration-2026-06-29.md`. 전용 그래프 앱(on-demand fetch) = post-MVP. 설정 지식 탭(관리 compile/소스) = 아래 UC-KB-MANAGE.

## UC-KB-MANAGE — 지식 소스 관리 설정 탭 (K4, kb-compiler 통합 — 2026-06-30)

사용자가 설정>지식 탭에서 **자기 워크스페이스의 지식 소스(자료 폴더)를 직접 관리**한다. "준비 중" 자리를 실제 관리면이 대체한다: ①여러 자료 폴더를 추가/제거(폴더 선택 다이얼로그)하고, ②현재 **지식 스코프(프로젝트)** 와 **컴파일 상태**(카드·엔티티·관계 수, 또는 "미컴파일")를 보고, ③"지금 컴파일"로 등록 폴더 → 구조화 지식(kb.json)을 빌드한다. 빌드된 지식은 채팅에서 근거 답변(UC-KNOWLEDGE)으로 소비된다.

- **소유 경계(핵심)**: 이 설정(소스·스코프)은 **사람이 셸 UI 로만** 바꾼다 → `naia-settings/knowledge.json`(셸 전용 write). **AI 에이전트는 읽기만** 하고 설정을 못 바꾼다(config-write 도구 부재 = 신뢰경계 자가확장 차단). 사람=설정, 엔진=컴파일 산출(kb.json) 분리.
- **인지흐름/역할**: (관리)셸 UI 폴더 등록·스코프 → (지능)에이전트가 `CompileKnowledge`(naia-agent, 별 레포)로 폴더 → kb-compiler `compile()` → `naia-settings/knowledge/<scope>/kb.json` 저장 → (소비)채팅 근거 답변. 셸 = 관리 UI·상태 표시·트리거(직접 `invoke`, AI 미경유)이며 저장 위치를 주입하지 않는다. 컴파일/답변 지능과 저장 경계 = 에이전트.
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
- S-RADIO-DJ-7 / Shell #405 →
  `packages/shell/e2e-tauri/specs/94-avatar-4060-facade.spec.ts`
  `runs radio A-to-B switching, TRT speech/lipsync, and render-time barge-in through real Tauri`.
  이 검증은 실제 `/v1/audio/speech`와 `/stream`, A→B `playing`, 재생 시작 전 문장 숨김,
  Enter→render 취소 250ms 기준, BGM 지속을 한 흐름에서 확인한다. 수백 회 장시간 soak와
  stop/quiet/change-vibe/next 전체 조합은 #405의 후속 안정성 범위로 남긴다.

## UC-PROACTIVE-COST-CONTROL — AI/TTS 옆에서 능동 발화를 통제한다

Naia가 개인 라디오 DJ나 전시 소개를 제안하거나 시작하려 할 때, 사용자는 아바타 영역의
AI·TTS 제어 바에서 **능동 발화** 상태를 항상 확인하고 즉시 바꿀 수 있다. 이 제어는
프로필 설정과 다르다. 프로필은 무엇을 할지(개인 라디오/전시 소개)를 정하고, 능동 발화
제어는 지금 LLM·TTS·선택적 BGM을 사용해도 되는지를 정한다.

- 꺼짐: agent는 능동 발화를 시작하지 않고, 이미 진행 중인 activity는 안전하게 중단한다.
- 준비됨: 선택된 프로필과 현재 AI/TTS 경로를 표시한다. agent의 판단은 시작 **제안**으로
  보이며, 사용자는 버튼에서 허가하거나 계속 꺼 둘 수 있다.
- 실행 중: 현재 프로필과 사용 중인 AI/TTS 경로를 표시한다. 버튼 한 번으로 즉시 중단한다.
- 차단됨: TTS가 꺼져 있거나 로컬 음성/아바타 준비가 안 된 경우, 시작하지 않고 정확한
  차단 이유를 표시한다. 클라우드·로컬 비용을 추정값으로 꾸며 표시하지 않는다.

LLM은 좁은 능동 발화 도구로 profile 시작을 **요청 또는 제안**할 수 있지만, Shell의 현재
허가 상태·오디오 가능 여부·사용자 중단을 우회할 수 없다. 설정 화면은 시간대·개인정보
동의·간격·BGM 자동재생 같은 정책만 보관하며, 숨은 opt-in 토글이 런타임 허가를 대신하지 않는다.

Test Coverage Map:

- 컴포넌트: `AiControlBar`가 꺼짐/준비됨/실행 중/차단됨의 라벨, `aria-pressed`, 설명과
  시작·중단 요청을 올바르게 표현한다.
- 구성: `proactive-speech-settings`가 profile 정책과 사용자 허가를 별도로 저장·정규화하고,
  TTS-off/미구성 profile을 fail-closed 한다.
- 실제 Tauri: 새 `e2e-tauri` 시나리오가 버튼으로 시작·중단한 뒤 agent의 profile 설정과
  activity stop을 확인하고, 로컬 음성 준비 실패는 실행 성공으로 표시하지 않는지 확인한다.

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

사용자는 나이아에게 Discord 연결 방법을 물어본다. 나이아는 사용자가 Discord에서 봇을 만들고 자신의 서버에 초대해야 함을 설명한 뒤 연결 설정으로 안내한다. 연결 화면은 **봇 만들기·초대 → Windows 보안 입력창에 토큰 입력 → 연결 확인 → 활동 채널 선택** 순서를 먼저 보여 준다. 토큰은 WebView 입력칸·채팅·일반 설정에 나타나지 않으며, 사용자가 `Discord 연결`을 누를 때만 열리는 운영체제 보안 입력창에서 처리한다. 나이아가 접근 가능한 채널 중 활동을 허용할 채널을 선택한 뒤에만, 이후 나이아는 허용 채널에서 다른 참여자와 대화한다.

- 성공: 연결 상태와 허용 채널이 보이고, 봇은 허용 채널에서만 동작한다.
- 실패: 토큰 오류, 봇 미초대, 권한 부족, 채널 삭제는 원인을 보여 주며 다른 채널에는 영향을 주지 않는다.
- 안전: 토큰은 채팅·일반 설정·로그·agent 요청에 나타나지 않는다.

### UC-DISCORD-2: 여러 채널을 지구본 대화함에서 읽기

사용자의 봇이 여러 Discord 채널에 초대돼 있다. 사용자가 지구본 버튼을 누르면 최근 활동한 허용 채널의 대화가 먼저 열린다. 사용자는 목록으로 돌아가 다른 채널을 고르고, 그 채널의 대화와 읽지 않은 상태를 본다.

- 좁은 화면: 목록과 대화를 동시에 강제로 넣지 않고, 목록 → 대화 → 뒤로 가기 흐름으로 전환한다.
- 넓은 화면: 목록과 선택된 대화를 함께 보여 줄 수 있다.

### UC-DISCORD-1B: 연결 설정에서 채널 대화함으로 이어가기

사용자는 **연결 → Discord**에서 봇 토큰을 보안 입력으로 저장하고 활동을 허용할 채널을 선택한다. 저장이 성공하면 같은 화면에서 `Discord 대화함 열기`를 선택해 지구본 채널 탭으로 이동한다. 채널 탭은 방금 허용한 채널들을 서버·채널명으로 표시하고, 아직 메시지가 없어도 “대기 중”으로 구분한다.

아직 토큰이 없으면 채널 탭은 구형 Gateway 오류를 보여 주지 않고, Discord를 연결하고 채널을 허용하라는 안내와 연결 설정으로 가는 버튼을 보여 준다. 토큰은 있지만 허용 채널이 없으면 채널 선택으로 돌아가는 버튼을 보여 준다. 채널 하나라도 허용된 뒤에는 Shell 개인 채팅과 섞지 않고, 선택된 Discord 채널의 기록만 보여 준다.

- 성공: 저장 직후 같은 허용 목록이 대화함에 보이고, 사용자 선택 또는 최근 채널이 열리며 개인 채팅으로 복사되지 않는다.
- 실패: 미연결·미허용·상태 조회 실패를 서로 구분해 안내한다. 오류 원문·토큰·Agent 내부 상태는 표시하지 않는다.
- 경계: `연결`은 자격 증명과 활동 권한을 정하는 곳이고, 지구본은 허용된 Discord 채널의 읽기 전용 대화함이다. 두 화면은 동일한 binding 식별자만 공유한다.
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
| UC-DISCORD-1A | `ConnectionsSettingsTab.test.tsx`: visible four-step setup, native credential result/status-generation classification, incomplete-discovery fail-closed, binding conflict; Rust dotenv parser accepts only `DISCORD_BOT_TOKEN` for debug E2E | `e2e/discord-settings-secure.spec.ts`: no inline token and no-argument native-command contract; `e2e-tauri/specs/92-discord-secure-cancel.spec.ts`: isolated real Tauri native-cancellation seam; `e2e-tauri/specs/94-discord-live-auth.spec.ts`: private dotenv → live bot authentication/discovery without DPAPI/WebView persistence; `e2e/discord-channel-agent.spec.ts`: allow-list save. | provisioned test bot: allow-list save → Agent authority `ready` |
| UC-DISCORD-1B | `ConnectionsSettingsTab.test.tsx`: save exposes inbox handoff only for a saved binding; `ChannelsTab.test.tsx`: disconnected/unconfigured/allowed empty states and binding-scoped records; no raw status leak | `e2e-tauri/specs/93-discord-inbox-handoff.spec.ts`: real Shell settings → channels handoff and empty-state route | provisioned test bot: binding save → inbox channel list → inbound/outbound records remain in their binding |
| UC-DISCORD-2 | recency and selected-channel persistence | narrow/wide channel inbox navigation | multi-channel history visibility |
| UC-DISCORD-3 | Gateway event deduplication, per-channel context, reconnect | live status and unread rendering | two-channel message/reply/reconnect flow |

| **S-CASCADE-INSTALL-PLAN** (FR-CASCADE.2 — 2026-07-22) | 4060 profile users see a Shell-checked local-runtime plan. Loader, Python runtime, cascade service bundle, Ditto engine, VoxCPM2 model, and bundled reference voices each report a name, progress, next action, retryability, and failure reason. With no packaged artifact or download manifest, Shell reports that boundary and does not pretend to download or start anything. `ready` is true only when all prerequisites and the live :8910 requested services are verified. | Rust `cascade_installation_status` contract tests (missing prerequisite, queued model download, ready-to-start, live ready) and `SettingsTab.test.tsx` (profile plan display; no `start_cascade` when `canStart=false`). Actual download/install and Tauri voice+lipsync remain a separate E2E gate after packaged artifacts exist. |

## UC-LLM-THREE-TIER ? Pi-only development roles

The user configures `expert`, `main`, and `sub` independently in Shell. Each role selects a Codex or Claude model (or inherits another role); `memory` remains a separate consumer role. Shell writes only provider/model/credential-reference metadata to `naia-settings/config.json` and never writes credentials.

When a development task is delegated, Shell hands the saved workspace configuration and task to naia-agent. The agent resolves the selected role, validates it, then starts and supervises an embedded Pi session with that provider/model. OpenCode is neither displayed nor selected nor used as fallback on this path.

### Test Coverage Map

| Scenario | Unit / contract | Integration |
|---|---|---|
| three tiers persist and inherit | `lib/llm/roles.test.ts`, `lib/adk-store.test.ts` | config file roundtrip |
| Pi-only role handoff | 짝 naia-agent 저장소의 `pi-role-runner.contract.test.ts` (이 저장소에는 없다) | fake Pi session through supervisor |

## UC-NAIA-MODEL-ORDER — Compare only usable Naia models

A signed-in Naia user opens the AI model picker. The picker contains only
currently usable routes; models marked `comingSoon` or otherwise unavailable
are not offered. The default view is price order and there is no separate
registry/default order.

Price order estimates a general chat workload using three uncached input tokens
for every one output token: `3 * input price + output price`. Prompt-cache
prices are not included in this ordering because cache support and hit rate vary
by model and conversation. Input and output prices remain separately visible so
the user can interpret the estimate. Switching to performance order immediately
reorders the same native WebView picker without changing the selected model.

### Test Coverage Map

| Scenario | Unit / contract | UI / integration |
|---|---|---|
| weighted price is the default | registry weighted-score and stable-sort tests | Settings component and Playwright option-order assertions |
| unavailable routes are absent | registry metadata/filter contract | Settings component and Playwright absence assertions |
| performance order is evidence-based | dated recommendation-order contract | Settings sort-change assertion |

## UC-RADIO-DJ-DURABLE — Radio DJ changes music truthfully and keeps one settings owner (#414)

A user asks Naia, in any supported language, to start Radio DJ playback o
change the music. The LLM selects `skill_youtube_bgm` semantically and the
Shell refreshes that tool registration before the chat turn so an agent restart
cannot silently remove the capability. A play request is not described as
successful until the player reports an observed `playing` transition.

- If search returns the currently selected video first, Radio DJ chooses a
  different result when one exists. Explicitly replaying the same video still
  remounts the iframe and starts a new playback attempt.
- Every Agent-owned Radio DJ play carries `mode=radio_dj`. Status receipts
  include bounded recent-play and favorite title lists so Agent selection can
  combine explicit memory preferences with Shell-owned listening context;
  Shell remains the final authority for current/recent duplicate filtering.
- After an observed `ended`, Agent completes one short transition remark before
  requesting the next dynamic search. It introduces the new title only after
  the correlated playback reaches observed `playing`.
- The Tauri WebView sends an origin referrer to the YouTube embed so the playe
  is identified and does not fail with YouTube error 153.
- If the BGM sidecar exited, the next search restarts the owned sidecar. Closing
  an auxiliary window does not tear down the main Shell runtime.
- `Settings > Skills > Youtube Radio DJ` is the single owner of proactive DJ
  policy. General does not render a duplicate profile or weather-location form.
- Weather consent and coordinates remain editable across equivalent parent
  rerenders and persist after Save/reload.

### Test Coverage Map

| Scenario | Unit / contract | UI / integration |
|---|---|---|
| agent restart before a chat turn | `chat-service.test.ts` boolean delivery receipt | `e2e/bgm-skill.spec.ts` asserts same-turn `app_skills` precedes `chat_request` |
| current search result repeats | `bgm-skill.test.ts` current-video exclusion and same-video replay receipt | BGM Playwright fixture observes a fresh iframe/playback transition |
| YouTube WebView identification | embed URL/remount component contract | Playwright request verifies referrer; the paired native Linux Tauri/WebKitGTK radio queue E2E `94-radio-bgm-queue.spec.ts` verifies observed A-to-B playback, the announce gate that withholds a title until observed playing (S-RADIO-DJ-5) and a detached track A late error leaving track B untouched (S-RADIO-DJ-1) |
| variable-length and wall-clock playback | playback snapshot carries observed `currentTime`/`duration`; stale playback IDs cannot advance the queue | The default 10-track run is compressed. A 60-minute wall-clock first local fixture followed by nine ordered transitions passed, and an actual 11:58:09 YouTube video passed an eight-hour wall-clock soak with a 7,203.0-second checkpoint and 28,800.6-second final media clock. The latter is one-long-video evidence, not a mixed 20-video session. |
| autonomous next-track DJ | correlated ended observation, one completed transition remark, fresh search and observed next playback | Agent DJ-08 and the controller↔Shell handoff integration pass the full ended-to-next-playing sequence. End-before prefetch remains a separate latency improvement. |
| user override and conversation | other-song replacement, ordinary conversation preservation, barge-in and stop boundary | Playwright covers replacement, conversation preservation and stop/no-late-transition; native TTS race coverage remains pending |
| explicit preference memory | explicit like/dislike only, durable recall, inspect/edit/delete and isolation | Agent acceptance and preference-index contracts cover tagged user-only recall, persisted exact state, tombstone precedence, malformed/assistant exclusion and memory-failure fallback; physical multi-account UI remains operational coverage. |
| recent-track variety | video and normalized-track exclusion, similar-but-new selection, bounded history | Shell search/queue contracts, Agent preference+recent+favorite selector and the 60-track logical eight-hour soak cover automatic duplicate avoidance and bounded state. |
| unified Agent recommendation context | `status` bounds recent/favorite lists; Agent play includes `mode=radio_dj`; local tombstones override recalled preferences | Shell BGM unit/Playwright plus paired Agent DJ-GRPC/DJ-08 contracts |
| voice favorites | idempotent add/remove, favorites-only playback, empty and unplayable entries | Shell structured tool Playwright covers add/play/remove/empty; actual voice intent, restart and unplayable favorite coverage remain pending |
| unplayable YouTube recovery | no false playing/intro, bounded alternative search, network/sidecar recovery | Playwright covers iframe error, 15-second loading timeout, prepared fallback and exhaustion; Agent DJ-06 covers one fresh replacement after a failed play and a single terminal notice after repeated failure. Physical network-loss recovery remains operational coverage. |
| sidecar exits or auxiliary window closes | Rust lifecycle tests | native Tauri sidecar restart/health check |
| one settings owner and durable consent | Settings component rerender test | `settings-slots.spec.ts` Skills ownership, General absence, Save/reload |

## UC-BGM-ORPHAN-PORT-RECOVERY — 고아 sidecar가 BGM 포트를 선점해도 다음 실행이 회복한다 (#517)

설치본 사용자가 유튜브 뮤직플레이어를 켰는데 "BGM server failed its owned
health check on port 18791"가 뜬다. 원인은 이전 세션이 Destroyed 이벤트 없이
죽으며 남긴 고아 `bgm-server-bin.js` 프로세스가 포트를 점유한 것이다. 사용자는
원인을 유추할 수 없고, 앱 재시작은 회복 경로가 아니다 — 오히려 30초 readiness
probe 도중 앱을 닫으면 추적 불가능한 고아가 하나 더 생긴다.

- 셸은 BGM sidecar를 spawn하기 전에 대상 포트의 점유자를 확인한다. 점유자의
  command line이 `bgm-server-bin.js`이면 우리 계보의 잔재이므로 종료 후
  spawn을 계속한다. command line이 다르면 남의 프로세스이므로 손대지 않고
  점유 사실을 로그로 명확히 남긴다. 판정은 포트 소유자 기준이라 격리 dev
  인스턴스(#425, :18891)의 sidecar를 오살하지 않는다.
- sidecar 자신은 `EADDRINUSE`를 만나면 즉시 exit(1)한다. 무한 재시도로
  살아남아 있다가 기존 점유자가 죽는 순간 낡은 nonce로 포트를 승계하는
  좀비를 만들지 않는다.
- 셸 종료 시 `state.bgm_server`에 자식이 없어도(예: readiness probe 중 종료)
  PID 파일에 살아 있는 sidecar가 기록돼 있으면 검증 후 종료하고 나서 파일을
  지운다. 기록만 지워 고아를 추적 불가로 만들지 않는다.

Test Coverage Map

| UC | 단위·계약 | 비고 |
|---|---|---|
| UC-BGM-ORPHAN-PORT-RECOVERY | `src-tauri/src/lib.rs:13661` `bgm_port_reclaim_terminates_real_stale_sidecar_listener`: 실제 node 리스너를 포트에 앉히고 회수 후 해제까지 실측 / `:13612` `bgm_port_reclaim_kills_only_proven_sidecar_holder`: 남의 프로세스를 죽이지 않는지 | 재시작 회복·포트 경합·사용자에게 보이는 실패 문구를 한 UC 가 함께 덮는다 |

### Test Coverage Map

| Scenario | Unit / contract | UI / integration |
|---|---|---|
| 포트가 비어 있으면 무개입 | Rust reclaim 단위(주입 프로브: 점유자 없음 → kill 0회) | 기존 BGM 기동 경로 무회귀(vitest/Playwright 기존 스위트) |
| 고아 sidecar가 점유 → 회수 후 기동 | Rust reclaim 단위(점유자 cmdline 매치 → kill 1회) | Rust 통합 테스트: 실제 `bgm-server-bin.js` 이름의 node 리스너를 포트에 앉히고 reclaim 후 포트 해제 실측 |
| 남의 프로세스가 점유 → 회수 거부 | Rust reclaim 단위(cmdline 불일치 → kill 0회 + 경고 로그) | 동일 통합 테스트의 불일치 이름 케이스 |
| sidecar가 EADDRINUSE에서 즉시 종료 | vitest: 점유된 포트로 `startYoutubeServer()` → `process.exit(1)` 호출 검증(재시도 타이머 없음) | — |
| probe 중 앱 종료 → 다음 세션 회수 | teardown이 미저장 자식을 PID 파일로 종료(검증 후) | 종료 경로는 위 reclaim 백스톱이 최종 방어선(포트 소유자 기준이라 PID 파일 유실과 무관) |

## UC-SETTINGS-ROUNDTRIP: 설정 변경·재시작·실행 반영

설정을 바꾸고 앱을 다시 켰을 때 그 값이 살아 있어야 한다. 파일이 정본이고
localStorage 는 캐시이므로, 부팅 병합에서 파일 값이 캐시를 이겨야 한다
(FR-CONFIG-SOT.1). 이 UC 는 2026-08-03 에 표제만 선언되고 본문이 비어 있었다
— 안정성 축의 첫 항목인데 무엇을 확인하는지 적히지 않은 채였다.

- 설정에서 값을 바꾸고 저장하면 `naia-settings/config.json` 에 남는다.
- 앱을 다시 켜면 그 파일 값이 화면에 반영된다. 스테일 캐시가 이기지 않는다.
- 작업 공간을 바꾸면 설정·메모리·자격증명 경로가 함께 옮겨가고, 원자적 전환에
  실패하면 이전 경로로 되돌아간다.
- 열려 있던 터미널 세션은 다시 켠 뒤에도 복원되고, 복원에 실패한 항목이 있어도
  앱이 죽지 않는다.

Test Coverage Map

| UC | 단위·계약 | 실기 | 비고 |
|---|---|---|---|
| UC-SETTINGS-ROUNDTRIP | `src/lib/__tests__/config-boot-merge.test.ts`: 부팅 병합에서 파일이 캐시를 이긴다 / `src/lib/__tests__/adk-store.test.ts`: 작업 공간 포인터 | `e2e-tauri/specs/95-llm-role-settings.spec.ts`: 설정 저장이 파일에 남고 다시 읽힌다 | 실기 스펙은 아직 CI 에서 돌지 않는다(#550) |


## UC-ONBOARDING-APPEARANCE-VOICE: 외모와 음성을 독립적으로 시작하기

사용자는 온보딩에서 VRM뿐 아니라 설치된 NVA 외모도 고를 수 있다. 비디오
배경은 재생 기호 대신 실제 영상 프레임 썸네일로 구분한다. 사용자 이름 입력은
특정 개인 이름을 예시로 노출하지 않는다.

GPU가 감지되면 온보딩은 음성 설정에서 로컬 음성과 레퍼런스 음성을 선택할 수
있다고만 안내한다. 온보딩 완료만으로 로컬 GPU 프로파일이나 음성 서버를
자동 시작하지 않으며, NVA 선택을 VRAM 조건과 결합하지 않는다.

대화창 배치는 왼쪽 소형과 왼쪽 채움만 제공한다. 과거에 저장된 중앙 배치는
왼쪽 소형으로 마이그레이션한다. YouTube BGM이 재생 중일 때 같은 재생 버튼을
누르면 즉시 일시정지 상태가 되고, 재생 버튼으로 돌아온다.

### Test Coverage Map

| 상태 | 단위/컴포넌트 | UI/통합 |
|---|---|---|
| 기본·빈 목록 | 온보딩 VRM/NVA 목록 및 일반 이름 placeholder | Playwright 기본 화면 |
| 진행·성공 | GPU 안내, NVA 저장, 비디오 프레임 캡처 | Playwright 선택/저장 및 스크린샷 |
| 오류·복구 | 영상 캡처 실패 시 video 프레임 fallback, GPU 미감지 시 자동 프로파일 없음 | 컴포넌트 오류 fallback |
| 좁은 폭 | 외모/배경 카드와 2-way 대화 배치 | Playwright 좁은 viewport |
| BGM 토글 | listening handshake 뒤 pauseVideo와 즉시 paused 상태 | BGM Playwright |

사용자는 두뇌 역할, 기억 엔진, 음성, Radio DJ, 날씨 동의, 로컬 GPU 프로필 같은 설정을 바꾼다. 저장 성공 뒤 앱을 닫아 다시 실행해도 화면 값, 워크스페이스 파일, 파생 매니페스트와 실제 에이전트 동작이 모두 같은 선택을 사용한다.

- 메모리 LLM을 Naia 또는 상속으로 바꾸면 이전 Ollama 값이 다시 살아나지 않는다.
- sub와 memory는 독립적으로 저장되고 슬롯 요약 및 런타임도 같은 역할을 표시한다.
- API 키는 워크스페이스 파일과 로그에 나타나지 않지만 보안 저장소에서 복원되어 재입력 없이 동작한다.
- 저장 중 파일 또는 에이전트 재로드가 실패하면 성공 표시를 하지 않고, 마지막 정상 실행 구성을 유지한다.
- localStorage를 지우고 다시 열어도 파일에서 같은 값이 복원된다.

검증은 설정 UI 변경 → native 파일 원문 확인 → render cache 제거 → WebView/App 재로드 → UI 복원 → agent effective config/실제 기억 호출 순으로 연결한다.

## 2026-08-06 active Windows scenarios

The following scenarios supersede older active references to `windows_trt_8g`,
Ditto-rendered NVA, a login-gated hardware profile, and automatic Radio DJ.
Those older sections are historical evidence only.

| Scenario | User-observable outcome | Coverage |
|---|---|---|
| **UC-NVA-WEB** | 사용자는 GPU·로그인·로컬 음성 없이 NVA 외모를 선택한다. 실제 web-player가 idle/speaking/gesture/새 발화 자산을 재생하고 재시작 뒤 같은 외모를 복원한다. | clean+migration config, player states, focused UI/native capture |
| **UC-LOCAL-VOICE** | VRAM 6GB+ 사용자는 Voice 설정에서 local voice를 켜고 :8910 ready를 확인한 뒤 레퍼런스 선택·녹음·업로드를 사용한다. OFF하면 엔진과 자식이 종료된다. 로그인과 아바타 선택은 영향을 주지 않는다. | VRAM boundary, no-login, ready/timeout/off, restart roundtrip |
| **UC-MEDIA-CONSENT** | 앱 시작 시 음악은 정지 상태다. 사용자 재생 또는 LLM의 명시적 radio_dj play 호출만 세션을 시작한다. 재생 버튼을 다시 누르면 pause되고 Proactive 토글은 음악 권한이 아니다. | clean/migration negative, skill contract, pause toggle |
| **UC-SHELL-PRESENTATION** | 온보딩에서 일반 이름과 실제 video-frame 썸네일을 보고 VRM/NVA를 고른다. chat은 좌측 두 레이아웃만 제공하며 Proactive는 접근 가능한 compact icon이고 기본 OFF다. | onboarding/layout/accessibility Playwright |
| **UC-WINDOWS-DISCORD** | Windows에서 Gateway를 연결·종료·재연결해도 제한 시간 안에 끝나며 orphan agent가 남지 않는다. | isolated Windows lifecycle integration |

### 2026-08-08 field-review addendum (B8)

`docs/voice-avatar-radio-handoff-2026-08-07.md` 실측 필드리뷰가 위 표의 "완료" 표시에도 남아있던 결함 6건을 적발했다. 아래는 추가 시나리오이며 위 표를 대체하지 않는다.

| Scenario | User-observable outcome | Coverage |
|---|---|---|
| **UC-NVA-TTS-OWNERSHIP** | NVA를 선택한 상태에서 어떤 TTS provider를 골라도(로컬/클라우드/브라우저) 실제로 그 엔진의 음성이 재생된다. NVA는 오디오를 자체 합성하지 않고 Shell의 실제 재생 시작/종료에 맞춰 입모양만 움직인다. 단, 정확히 일치하는 저작 문구(온보딩 인사말 등)는 그 클립 자체의 녹음 음성이 재생된다. | ChatArea 컴포넌트 테스트(계약 재작성 포함), media-runtime-routing contract test |
| **UC-NVA-COMPOSITE** | NVA가 대기·발화·대기를 오갈 때 앱 배경이 항상 유지되고, 알파를 가질 수 없는 발화 클립(mp4 등)이라도 검은 배경이 노출되지 않는다. | prebaked-renderer 유닛 테스트; 실기 Windows 시각 검증은 이 세션에서 미실시 |
| **UC-SETTINGS-AVATAR-SYNC** | 로그인·원격 설정 반영 등으로 메인 화면의 아바타가 NVA로 바뀌면, 설정 탭의 상세/미리보기도 같은 시점에 NVA로 갱신된다(재시작 불요). | SettingsTab hydration 회귀 테스트 |
| **UC-DISCORD-TAB-LIVE** | 대화창 하단 🌐 Channels 탭을 열면 실제 연결 상태·서버·채널 목록·대화 스레드가 보인다("안정화 작업 중" 정적 문구가 아니다). | NaiaMetaArea + ChannelsTab 컴포넌트 테스트 |
| **UC-BGM-NO-FALSE-SKIP** | YouTube 곡이 실제로 재생 중이면, iframe의 "재생 중" 신호 메시지가 유실되더라도(WebView2 핸드셰이크 이슈) 12초 워치독이 다른 곡으로 강제 전환하지 않는다. 진행률(`infoDelivery`) 신호가 독립적으로 재생을 확인한다. | `components/__tests__/BgmPlayer.test.tsx`(신규) + `e2e/bgm-skill.spec.ts` 실 브라우저 재작성(대기열 보존·상태 diagnostic 확인) |
| **UC-BGM-ENDED-NOTIFY** | 곡이 실제로 끝나면(타이머 아님, 진짜 ended 이벤트) Shell이 트랙 시작 때와 동일한 방식으로 에이전트에게 즉시 통지한다. 에이전트가 다음 곡을 고르거나 멘트를 하는 결정은 naia-agent 소관(이 저장소 범위 밖)이라 이 시나리오는 "통지가 나가는지"까지만 다룬다. | `components/__tests__/BgmPlayer.test.tsx`(신규, music_ended 발신 검증) |
| **UC-VOICE-ONBOARDING** | 로그인 이후 온보딩에 음성 단계가 있다: 무료 Web TTS on/off + 시스템 보이스 미리듣기, 그리고 VRAM 6GB+ 감지 시 실제로 로컬 VoxCPM2를 켜고 끌 수 있는 버튼(안내 링크가 아니라 진짜 `start_cascade`/`stop_cascade` 호출). | OnboardingWizard 컴포넌트 테스트(음성 단계 내비게이션 + 실제 invoke 호출 + 저장된 config 필드 검증) + `e2e/onboarding-fresh.spec.ts` 실 브라우저 3/3 통과 |

이번 세션에 실제로 실행한 것: Playwright chromium 신규 설치 후 실 dev server로 `e2e/onboarding-fresh.spec.ts`(3/3) + `e2e/bgm-skill.spec.ts`(12/12, 1건은 옛 강제스킵 동작을 검증하던 낡은 테스트라 새 계약에 맞게 재작성 후 통과) 실행. 여전히 미완료: `e2e-tauri`(네이티브 Tauri/WebDriver) 스위트 미실행. UC-NVA-COMPOSITE의 실제 크로마키 정확도는 headless chromium이 WebView2 특유 경로를 타지 않아 여전히 Windows 실기 미검증.

### 2026-08-08 Naia 기본모델 변경

| Scenario | User-observable outcome | Coverage |
|---|---|---|
| **UC-LLM-DEFAULT-DEEPSEEK-FLASH** | Naia 계정으로 로그인하거나 온보딩을 완료하면 메인 LLM이 `DeepSeek V4 Flash`로 자동 선택된다. 설정 탭 모델 선택기에도 `DeepSeek V4 Flash`가 `DeepSeek V4 Pro` 옆에 나타나고, "Naia 기본값 적용"을 눌러도 같은 값이 채워진다. | `lib/llm/__tests__/registry*.test.ts`, `lib/slots/__tests__/settings-slots.contract.test.ts`, `components/__tests__/SettingsTab.test.tsx`, `e2e-tauri/specs/70c-nextain-default-chat.spec.ts`(라이브, NAIA_E2E_NAIA_KEY 필요) |

any-llm 게이트웨이 쪽(라우팅·가격)은 이미 구현·테스트돼 있어 이번 변경 대상이 아니었다(`pytest tests/gateway/test_naia_azure_models.py tests/unit/test_naia_pricing.py` 78 passed로 확인). 이 시나리오에 대한 전용 Playwright는 없음(모델 선택 자체는 기존 SettingsTab e2e 커버리지 범위 밖) — 이번 세션에서 새로 만들지 않음.

### 2026-08-15 v0.1.7 Windows release rebuild (#448)

| Scenario | User-observable outcome | Coverage |
|---|---|---|
| **UC-V017-WINDOWS-HERDR-RUNTIME** | On a clean Windows profile without a system Visual C++ Redistributable, the installed bundled `herdr.exe` loads, reports its version, starts the Workspace PTY, and reaches snapshot-ready. A missing adjacent runtime is a build failure, not an instruction for the user to install a prerequisite. | `stage-herdr.mjs` adjacency contract, Windows NSIS/MSI payload inspection, installed Workspace smoke |
| **UC-V017-WINDOWS-HERDR-COLD-SERVER** | On a clean Windows profile with no pre-existing `%APPDATA%/herdr/herdr.sock`, opening Workspace explicitly starts the bundled headless Herdr server, waits for its API socket, and only then attaches the embedded PTY. A failed server start preserves stderr and offers a retryable error instead of repeatedly surfacing `server_not_running`. | Rust server lifecycle unit tests + isolated-profile bundled-Herdr probe + clean Windows Workspace smoke |
| **UC-V017-WINDOWS-FIRST-CHAT** | After account onboarding on a clean profile, Shell awaits config/key persistence, reloads settings in the already-running paired Agent, replays the Naia credential, and only then exits onboarding. While this is running the completion action shows progress and cannot be submitted twice; a persistence/reload failure remains on the completion screen with an explicit retry. The first two turns produce non-zero provider usage without restarting the app. | onboarding completion ordering/error component tests, Agent reload IPC contract, exact Agent pairing contract, installed first/second-turn log and usage inspection |
| **UC-V017-WINDOWS-LOCAL-VOICE-MISSING** | On a clean Windows profile whose RTX GPU passes the VRAM gate but whose VoxCPM2 runtime is absent, Shell shows `installation required` with the concrete missing components and disables local-voice selection/start. It never labels the slot `starting`. A stale or failed local-voice selection is atomically restored to the bundled Edge voice in both `config.json` and `slots-manifest.json`, and disabled voice is never auto-started. | Rust installation classification + Settings/onboarding state and rollback tests + Playwright blocked-runtime desktop/narrow acceptance + clean Windows inspection |
| **UC-V017-WINDOWS-AVATAR-CROP** | The default and alternate Naia NVA cards show a recognizable face, an NVA badge, and a visible selected state without clipping the primary action at desktop or narrow width. Empty/loading/error are not applicable to bundled cards; a missing asset renders the existing fallback without blocking selection recovery. | onboarding component test, Playwright desktop/narrow screenshots and DOM/bounding-box assertions, clean Windows WebView2 confirmation |
| **UC-V017-WINDOWS-VOXCPM2-INSTALL** | On a clean Windows profile with a supported NVIDIA GPU but no system Python, model cache, Cascade checkout, or reference audio, the local-voice surface offers one explicit prepare/retry action. The installed app already contains the version-pinned standalone VoxCPM2 TRT service runtime and voices. The action downloads only the pinned model, atomically prepares the GPU-SM-specific TensorRT engine under the managed runtime, preserves a log, and starts only after verification. No Python/PyTorch/TensorRT package installer or generic Cascade source is invoked on the user machine. | standalone-runtime staging contract, Rust single-flight/model-engine/status tests, Settings and onboarding error/retry tests, clean Windows runtime-missing install/start smoke |
| **UC-V017-WINDOWS-CLEAN-REINSTALL** | Silent or interactive uninstall removes only Naia-owned WebView/application bootstrap state and credentials, not the user's ADK documents. Reinstalling the same build cannot import `onboardingComplete` from a retained workspace before the new local bootstrap has completed, so the onboarding wizard is shown. NSIS and MSI both carry and verify the cleanup contract. | generated installer configuration tests, NSIS hook/WiX cleanup payload inspection, boot-merge negative tests, clean uninstall/reinstall smoke |
| **UC-V017-WINDOWS-DIAGNOSTICS-RUNTIME** | Diagnostics tails the live Agent stderr log rather than the retired `llm-debug.log`, and the bundled Agent's optional SQLite native module is loadable by the exact bundled Node ABI. A release build fails before packaging when either diagnostic path or native ABI is stale. | Diagnostics component/Playwright test, staged-Agent bundled-Node require smoke, packaging contract test |
| **UC-V017-LIVE-AUTH-ACTIVATION** (#449) | A successful clean-install login refreshes the account balance and activates the persisted Naia credential in the already-running chat core before onboarding completes. The first request works in the same app process; a restart is never the recovery path. Delayed or duplicate auth callbacks remain idempotent, and activation failure stays on a retryable completion state. | auth-activation unit/component tests + clean-profile Playwright first balance/first chat acceptance |
| **UC-V017-WINDOWS-VOXCPM2-SELECT-INSTALL-START** (#450) | On supported Windows NVIDIA hardware, VoxCPM2 remains selectable when its model/engine is absent. Selecting it runs one transaction: verify bundled `windows_trt_6g` runtime → download pinned model → prepare/verify TensorRT LocDiT → start the direct service → require TRT-identifying health → persist provider. Failure rolls back config and slot manifest and permits retry. Local commands/state/PIDs use VoxCPM2 names. The remote Cascade WebSocket route is preserved independently and is never killed, adopted, or reconfigured by this transaction. | selector state-machine tests + Rust direct-service/model-preparation/health tests + remote Cascade health/WebSocket preservation + clean Windows native acceptance; RTX 2070 success remains unclaimed until that hardware gate passes |
| **UC-V017-ONBOARDING-DEFAULT-NVA-PREVIEW** (#451) | Entering the avatar step publishes the resolved bundled Naia NVA selection as soon as its asset is ready, so the selected card and live preview agree without a click. A later default effect cannot overwrite an explicit user choice. | onboarding component event-order tests + Playwright desktop/narrow/loading/error/keyboard review |
| **UC-V017-ONBOARDING-NAIA-VRM-ASSETS** (#451) | A user who obtains a fresh `naia-adk` sees the two official Naia VRMs alongside the four existing VRMs in onboarding. Each of the six cards has a recognizable loaded thumbnail and remains selectable, while the preselected Naia NVA stays the only initially selected card. | `naia-adk` tracked-asset/hash inspection + avatar preset unit test + Playwright six-card image-load/selection/desktop/narrow review |
| **UC-V017-HERDR-FIRST-SURFACE** (#452) | A clean-install first Workspace open distinguishes Herdr process spawn, API readiness, page load, and renderer failure. A bounded failure becomes an actionable error with retry and safe diagnostics instead of a terminal black `loading` surface; retry preserves the workspace and restarts only the failed layer. | Herdr startup state-machine unit/Rust tests + Playwright/e2e-tauri absent/delayed/exit/page/renderer/retry states |
| **UC-V017-LINUX-VOXCPM2-STANDALONE-RUNTIME** (#537) | A Naia OS (Linux) user with a supported NVIDIA GPU turns on local voice in Settings. The Shell verifies and stages the digest-pinned `linux_trt_6g` artifact, runs the bash installer (voice palette, installer-acquired TensorRT and CUDA library wheels, pinned model, GPU-local engine on the selected card), then starts the compiled loopback service with the stored Naia credential over stdin. The first sentence is spoken from this machine; no Cascade process, checkout, or fallback is involved, and a failure at any phase is shown as that phase, never as a silent switch to a remote voice. | Real-machine journey on RTX 3090 ×2 Bazzite: installer log with every `VOXCPM2_PROGRESS` phase, `VOXCPM2_READY` with `profile: linux_trt_6g`, the shell's "로컬 음성을 N번 카드에 올립니다" line, and a captured WAV (#537) |
| **UC-V017-WINDOWS-VOXCPM2-STANDALONE-RUNTIME** (#453) | A clean Windows RTX user installs and starts local VoxCPM2 without any `naia-labs`, `naia-omni`, or `naia-omni-cascade` checkout. Shell verifies and stages a digest-pinned artifact released by the standalone `voxcpm2-tensorrt` repository, automatically prepares the pinned NVIDIA dependencies and model in Shell-managed state, builds the device-specific TensorRT engine, and starts the artifact's loopback-only service under Shell lifecycle control. A user-authorized voice is installed separately because the release carries no default voice. Two complete sentence synthesis requests succeed; after a service restart the same dependencies, model, engine, and user voice are reused without another acquisition or rebuild. A missing or hash-drifted runtime fails visibly, and local TRT never falls back to or reconfigures an external Cascade provider. | standalone runtime pytest/source-boundary checks + Shell staging hash/independence contracts + Rust lifecycle tests + Settings Playwright + clean RTX 4060 install/build/health/two-speech/restart acceptance |

P02 release-state matrix: build preparation, missing required runtime, successful NSIS/MSI creation, silent install, installed launch; Herdr server already ready/cold start/process absent/delayed ready/process exit/API ready but page failure/renderer failure/timeout/error/retry; first-login config persistence/reload/credential and balance refresh progress/success/error/retry/duplicate callback/crash-before-complete, first-chat success/error without app restart; VoxCPM2 eligible-uninstalled/select-installing/download failure/engine-build failure/verify failure/start failure/health failure/rollback/retry/success and ineligible-GPU states; digest-pinned standalone runtime clean staging, missing object, size/hash drift, private-repository absence, local-model-only enforcement, two Korean synthesis requests, process restart, model/engine/reference-voice reuse, and external Cascade isolation; NVA default asset loading/ready/error, no-click preview, explicit selection, keyboard selection, six installed VRM cards with loaded thumbnails, and desktop/narrow layout; NSIS/MSI silent uninstall plus same-build reinstall; live/stale diagnostic logs; and bundled Node native ABI are checked separately. The Naia live-action card has a distinct face-alignment assertion; generic media-overflow geometry alone is not completion evidence. Publishing remains outside this scenario until the clean-install gate passes.

### 2026-08-17 private VoxCPM2 activation journey (#453)

| Scenario | User-observable outcome | Coverage |
|---|---|---|
| **UC-V017-VOXCPM2-MEMBER-INSTALL** | On RTX hardware with at least 6 GiB, a signed-in BASIC/PRO member selects local VoxCPM2 and Shell verifies the proprietary compiled runtime, automatically prepares pinned dependencies/model/engine, then starts it. Signed-out, FREE, expired, unreachable, or invalid entitlement fails visibly before voice use and offers login/retry; no secret appears in process arguments or logs. | activation/unit/native install E2E and process/log inspection |
| **UC-V017-VOXCPM2-USER-VOICE** | A fresh release keeps voices out of the immutable runtime ZIP, but the online installer downloads the Shell's approved default preset into managed `runtime/voices`, verifies its pinned byte count, SHA-256, and WAV header, and refuses `ready-to-start` while it is missing or corrupt. Preview and synthesis therefore resolve the same `cc0-ko-female-01.wav`; a member may later replace it with an authorized WAV. Two complete sentences synthesize as separate requests while the LLM answer is still streaming, and restart reuses the verified model, engine, and voice without reacquisition/rebuild. | activation-contract/default-voice mutation tests + missing/corrupt readiness tests + two-sentence/restart native E2E |
| **UC-V017-VOXCPM2-BOUNDARY** | Local TRT failure remains local and visible. The configured Cascade provider and the external Cascade baseline remain healthy and unchanged before and after install/start/stop. | provider/process diff plus external `/health` and `/ws` probes |
| **UC-V017-VOXCPM2-WATERMARK-GATE** | The shipped build reports whether watermarking is included and links its benchmark receipt. Missing or failed performance/quality/VRAM evidence results in an unwatermarked build without blocking the core release. | release manifest and benchmark receipt assertion |
| **UC-V017-VOXCPM2-PROVENANCE-PARITY** | A release operator cannot produce an installer whose downloaded ZIP passes file hashes but fails installed-payload activation. The release command automatically audits the source artifact and selected completed ZIP against the same tracked file/directory/module/default-voice contract used by the app and installer. Archive-owned omissions block the build and name all failures; declared empty runtime-state directories are materialized because ZIPs may omit them. The approved reference WAV remains outside the immutable runtime artifact, is acquired from its pinned HTTPS URL, and must match the contracted byte count and SHA-256 before activation. A field failure preserves the downloaded ZIP and pending payload for retry after a fixed Shell upgrade. | source mutation tests + selected ZIP audit + reference-voice digest/readiness tests + Rust directory-materialization/activation diagnostics + release-command integration |
| **UC-V017-VOXCPM2-PUBLIC-DOWNLOAD** | A release operator can build only when the tracked public runtime URL answers without credentials, advertises the exact selected ZIP length, and serves byte ranges. A wrong R2 host or disabled public endpoint fails staging before either installer is created, so a download page cannot publish an installer that deterministically receives HTTP 401. | URL/probe unit tests + live HEAD/range preflight + packaged manifest inspection |
| **UC-V017-WINDOWS-UPDATE-CLEANUP** | Updating Naia preserves user memory and workspaces but replaces installer-owned Agent, sidecar, runtime, and dependency trees, including stale files absent from the new release. A full uninstall leaves neither the Naia install directory nor app-owned WebView/bootstrap state; reinstall therefore cannot execute an old Agent or old `node_modules`. | NSIS/WiX contract tests + stale-file update mutation + uninstall/reinstall residue smoke |
| **UC-V017-VOXCPM2-PAYLOAD-UPGRADE** (#465) | A member upgrading from a release whose cached payload installs only the default voice does not see a false success followed by `VOXCPM2_REFERENCE_VOICE_MISSING`. Shell compares the installed control files with its packaged installer and activation contract, reuses the verified local runtime ZIP to atomically refresh a stale payload, installs the complete current voice palette, and reaches ready without another runtime archive download. | default-only stale-payload mutation + control-file digest regression + cached-ZIP upgrade/install smoke |
| **UC-V017-VOXCPM2-RUNTIME-PIN-UPGRADE** (#518) | 셸 업그레이드가 런타임 아카이브만 갱신한 경우(제어 파일 동일 — 예: v0.2.2 r2의 발화 째짐 수정), 기존 설치자의 구 payload 가 조용히 재사용되지 않는다. 셸은 번들 download-manifest 의 `artifactManifestSha256` 핀을 설치 payload 의 artifact-manifest 해시와 대조해, 불일치면 재사용을 거부하고 기존 취득 플로우로 재스테이징을 유도한다. 사용자는 업그레이드 후 실제로 수정된 엔진으로 발화를 듣는다. | Rust reuse-gate 핀 일치/불일치/manifest 부재 단위 + 실 payload 해시 대조 |
| **UC-V017-VOXCPM2-ENTITLEMENT-RECOVERY** (#470) | A signed-in member whose stored Naia credential is rejected with HTTP 401/403 starts local VoxCPM2 and sees a localized login-required recovery instead of an installed-but-not-ready generic failure. Shell clears only the rejected credential and keeps the local runtime installed. FREE/inactive membership and unavailable gateway failures remain distinct, fail closed, and preserve the credential for retry. No credential, account identifier, response body, or endpoint appears in stdout, logs, or IPC errors. | runtime BASIC/PRO/FREE/401/403/5xx/transport pytest + bounded startup envelope tests + Rust pre-readiness parser/mapping + Settings rejected/unavailable component tests |

### 2026-08-14 v0.1.7 launch QA (#447)

| Scenario | User-observable outcome | Coverage |
|---|---|---|
| **UC-V017-FRESH-INSTALL-LLM** | 깨끗한 Windows 신규 설치에서 ADK 경로를 처음 선택하면 실행 중 Agent가 그 경로와 번들 Node 환경으로 즉시 다시 시작되고, 온보딩 완료 뒤 인증·알림·LLM/TTS 자격증명이 다시 전달되어 앱 재시작 없이 첫 일반 대화가 응답한다. | ADK 저장/재시작 Rust 계약, startup credential React 계약, fresh-profile Playwright, Windows 설치본 실측 |
| **UC-V017-HERDR-READY** | 깨끗한 설치에서 Workspace를 처음 열면 번들 Herdr PTY가 먼저 시작되고 API가 준비될 때까지 제한 시간 안에 기다린 뒤 snapshot을 표시한다. 준비 실패는 무한 대기나 빈 성공이 아니라 다시 시도 가능한 오류로 보인다. | Herdr runtime unit, Workspace Playwright, Windows 설치본 실측 |
| **UC-V017-CHAT-LAYOUT** | Workspace를 열어도 대화창 형식은 사용자가 고른 `왼쪽 소형`/`왼쪽 채움`을 유지하며, 저장값이 없는 신규 프로필은 왼쪽 소형이다. 중앙 대형 채팅은 존재하지 않는다. | layout state unit + fresh/workspace Playwright |
| **UC-V017-AVATAR-PICKER** | 신규 온보딩의 외모 선택은 VRM/NVA 통합 그리드, 얼굴 중심 썸네일, 유형 배지를 제공하고 기본 Naia NVA를 미리 선택한다. 기본 완료 시 `avatarProvider=naia-video-avatar`, `nvaModel=naia`가 저장된다. | onboarding component + fresh-profile Playwright screenshot/DOM |

P02 상태 매트릭스: 신규 기본, ADK 경로 저장 중, Agent 재시작 성공/실패, Herdr 준비 중/성공/실패·재시도, Workspace의 왼쪽 소형/왼쪽 채움, 아바타 VRM/NVA 선택을 각각 확인한다. 브라우저 Playwright 전체 스위트와 Linux native Tauri가 자동 검증 범위이며, 실제 NSIS 설치·번들 Node·WebView2·Windows 프로세스 수명은 Windows 인계 후 깨끗한 VM에서 최종 확인한다.

### 2026-08-20 v0.2.0 signed updater recovery

| Scenario | User-observable outcome | Coverage |
|---|---|---|
| **UC-V020-WINDOWS-SIGNED-UPDATE** | Windows v0.1.9에서 업데이트를 확인하면 v0.2.0을 발견하고, 서명된 단일 `windows-x86_64` updater 산출물을 내려받아 설치한 뒤 재실행한 앱이 v0.2.0을 보고한다. 비밀키·비밀번호는 빌드 로그와 Git 추적 파일에 나타나지 않는다. | platform matrix/config golden, signed artifact/signature existence and public-key verification, installed v0.1.9 field acceptance |
| **UC-V020-LEGACY-FEED-COMPATIBILITY** | v0.1.9가 내장한 이전 `nextain/naia-os/releases/latest/download/latest.json` 주소와 v0.2.0의 정본 `nextain/naia-shell` 주소가 같은 검증된 v0.2.0 바이트·서명을 가리킨다. | 두 공개 endpoint의 unauthenticated HTTP/schema/URL/signature/hash probe |
| **UC-V020-UPDATER-FAILURE-HONESTY** | 네트워크, JSON 형식, 플랫폼 키 또는 서명 검증이 실패하면 설정 화면은 실패 상태를 표시하며 “최신 버전”으로 오표시하지 않는다. 정상적으로 업데이트 없음이 확인된 경우에만 최신 상태를 표시한다. | `src/lib/__tests__/updater.test.ts`, `SettingsTab` 업데이트 상태 계약 |
| **UC-UPDATE-STARTUP-PROMPT** (#468) | 온보딩을 마친 사용자가 Naia를 실행했을 때 새 버전이 있으면 현재/새 버전과 업데이트 내용을 담은 팝업을 본다. 다운로드와 설치는 `지금 업데이트`를 직접 누른 뒤에만 시작한다. `나중에`를 선택하면 팝업은 닫히고 기존 업데이트 배너에서 다시 선택할 수 있으며, 확인 실패는 앱 시작을 막지 않는다. | `UpdatePrompt` component tests + `startup-update-prompt.spec.ts` consent/banner acceptance |
| **UC-UPDATE-30-DAY-DEFERRAL** (#468) | 사용자가 `한 달간 보지 않기`를 체크하고 `나중에`를 선택하면 같은 버전의 팝업과 배너가 30일 동안 나타나지 않는다. 30일이 지나거나 그 전에 더 새 버전이 배포되면 팝업이 다시 나타난다. 손상된 유예 기록은 업데이트를 영구히 숨기지 않는다. | deterministic snooze storage tests + same-version reload/new-version Playwright acceptance |

P02 상태 매트릭스: 업데이트 없음, 새 버전 팝업, 동의 전 무설치, 지금 업데이트, 나중에+배너 유지, 30일 유예 중 같은 버전, 유예 중 더 새 버전, 유예 만료, 손상된 유예 기록, endpoint 404, malformed JSON, 기본 target과 다른 플랫폼 키, 잘못된 서명, 정본/호환 feed 불일치, 릴리즈 asset hash 불일치를 각각 독립 검증한다. 기본 Tauri target은 `windows-x86_64` 하나이며 NSIS를 정본 updater 산출물로 사용한다. MSI와 그 서명도 수동 설치·무결성 산출물로 함께 배포하지만 같은 기본 target 아래 두 URL을 위조하지 않는다.
P02 상태 매트릭스: 업데이트 없음, v0.2.0 발견, 다운로드·설치·재실행, endpoint 404, malformed JSON, 기본 target과 다른 플랫폼 키, 잘못된 서명, 정본/호환 feed 불일치, 릴리즈 asset hash 불일치를 각각 독립 검증한다. 기본 Tauri target은 `windows-x86_64` 하나이며 NSIS를 정본 updater 산출물로 사용한다. MSI와 그 서명도 수동 설치·무결성 산출물로 함께 배포하지만 같은 기본 target 아래 두 URL을 위조하지 않는다.

### 2026-08-20 v0.2.1 installed app lifecycle (#472)

| Scenario | User-observable outcome | Coverage |
|---|---|---|
| **UC-V021-APP-INSTALL-LIFECYCLE** | 깨끗한 프로필에서 앱 설치 후 즉시 목록과 탭에 나타나고 재시작 뒤에도 유지되며, 제거 성공 뒤 `~/.naia/apps/{id}`와 목록에서 함께 사라진다. 예전 `~/.naia/apps` 설치는 안전한 경우 한 번만 이동한다. | isolated filesystem lifecycle + loader tests |
| **UC-V021-APP-REMOVE-HONESTY** | 삭제 권한·파일시스템 오류가 나면 앱은 목록에 남고 실패 알림이 표시된다. symlink, 경로 탈출, 잘못된/중복 id는 외부 파일을 변경하지 않는다. | Rust boundary mutations + AppBar alert contract |

P02 상태 매트릭스: clean install/list/restart/remove/list, legacy migration, canonical duplicate, malformed id, symlink escape, 중간 삭제 실패를 각각 검증한다.
### 2026-08-20 v0.2.1 Workspace Markdown viewer (#474)

| Scenario | User-observable outcome | Coverage |
|---|---|---|
| **UC-V021-WORKSPACE-MARKDOWN** | Linux Workspace의 FileTree에서 Markdown 문서를 선택하면 GFM 미리보기가 기본으로 열리고, 원문 보기와 탭 재진입이 동작한다. 문서 상대 링크는 같은 Workspace 탭 흐름으로 열리며 로컬 이미지는 안전한 Workspace 읽기 경로를 사용한다. | Markdown component + editor viewer + Linux Chromium FileTree test |
| **UC-V021-MARKDOWN-BOUNDARY** | raw HTML/script와 `javascript:` 및 Workspace 밖 상대 경로는 실행·열기되지 않는다. 외부 HTTP(S) 링크는 외부 링크임을 알리고 시스템 opener를 명시적으로 호출하며, 누락 이미지·읽기 실패·5 MiB 초과 문서는 복구 가능한 오류로 표시된다. | resolver, opener, missing-image, load-limit and accessibility assertions |

P02 상태 매트릭스: `.md`/`.markdown`, preview/source 전환, GFM 표·체크리스트·취소선·코드 펜스, 문서/루트 상대 링크, 로컬/누락 이미지, HTTP(S)/위험 URL, 경계 밖 traversal, raw HTML, 읽기 실패와 대용량 거부, 키보드 포커스를 각각 검증한다.

### 2026-08-23 thinking/final 응답 분리 (#479)

| Scenario | User-observable outcome | Coverage |
|---|---|---|
| **UC-V022-THINKING-SEPARATION** | 모델이 구조화된 thinking 청크 또는 스트림 경계에서 나뉜 `<think>…</think>` 태그를 보내도, 사용자는 thinking을 기본으로 닫힌 별도 영역에서만 보고 일반 답변에는 최종 응답만 본다. thinking 표시 여부와 무관하게 음성은 최종 응답만 발화한다. | `thinking-stream-filter.test.ts`의 구조화/태그/모든 청크 경계 계약 + `ChatArea.test.tsx`의 저장·스트리밍 닫힘 UI 및 TTS 제외 통합 계약 |

P02 상태 매트릭스: thinking 없음, 구조화된 thinking 진행, 한 청크 태그, 여는·닫는 태그의 모든 청크 경계, thinking 뒤 최종 응답, 닫히지 않은 thinking, 완료 후 저장 메시지, 기본 닫힘과 키보드로 펼침을 검증한다. 오류·빈 목록·좁은 폭은 새 화면이나 레이아웃을 만들지 않는 인라인 `<details>`의 기존 채팅 동작을 보존하는 것으로 확인한다.
## 2026-08-23 LLM→TTS 발화 텍스트 정규화 단일화 (#480)

### UC-V022-TTS-TEXT-NORMALIZATION

- 사용자가 어떤 언어와 음성 provider를 선택해도 동일한 공통 정규화 경계를 거친다.
- Markdown 본문과 자연스러운 다국어 문장·숫자·구두점은 보존한다.
- 코드 블록, Mermaid, URL, 이모지·이모티콘, 장식 문자와 제어 태그는 음성 요청에서 제외한다.
- inline code는 선택 언어의 레지스트리 규칙을 적용하며 backtick은 발화하지 않는다.
- 정규화 결과가 비면 브라우저·로컬·원격 어느 provider에도 발화 요청을 만들지 않는다.

Test Coverage Map: `lib/tts/__tests__/text-filter.test.ts`가 공통/언어/fallback 규칙을 검증하고, `lib/tts/__tests__/sentence-pipeline.test.ts`가 실제 provider payload의 단일 정규화 경계를 검증한다.

## 2026-09-03 발화 텍스트 정규화 확장 — 카오모지 제거·한국어 숫자 읽기 (#540)

### UC-VOICE-TEXT-SPEECH-CLEANUP

- 음성 대화 중 LLM이 카오모지·이모티콘(`｡•ᴗ•｡✨`, `(´▽`)`, ㅠㅠ)을 섞어 답해도 발화에는 장식이 전혀 실리지 않고 본문만 자연스럽게 들린다.
- "90년대"는 "구십 년대"로, "3시 30분"은 "세 시 삼십 분"으로 읽힌다 — 자리읽기("구공년대")가 발생하지 않는다.
- 단위별 한자어/고유어 수사 구분, 소수점·콤마·%·℃, 전화번호형 자리읽기까지 한국어 읽기 규칙이 적용된다.
- 규칙은 provider 공유 정규화 계층에 있어 브라우저·로컬·원격 어느 음성이든 동일하게 적용되고, 영어·일어·중국어 발화의 숫자 표기는 바뀌지 않는다.
- 로컬 음성처럼 voice 이름이 locale 형식이 아니어도 본문이 한글이면 한국어 숫자 읽기가 적용된다.

Test Coverage Map: `lib/tts/__tests__/text-filter-speech.test.ts`(카오모지 제거·locale 분기)와 `lib/tts/__tests__/ko-number-reading.test.ts`(수사 변환·단위 테이블)가 검증한다.
## UC-V022-CHAT-RICH-MARKDOWN — 채팅 Markdown·코드·Mermaid

- assistant 응답의 안전한 GFM을 읽기 좋은 형태로 표시한다.
- fenced code는 언어, 복사, 접기/펼치기, 워크스페이스 전환 기능을 제공한다.
- Mermaid는 strict 보안 모드로 렌더링하고 실패 시 원문으로 복구한다.
- 스트리밍 중 미완성 fence와 긴 코드가 대화 레이아웃을 깨뜨리지 않는다.

## UC-V022-PERMISSION-SHORTCUTS — 권한 결정을 키보드로 선택 (#477)

- 도구 권한 팝업이 열렸을 때 `Alt+Y`는 이번만 허용, `Alt+A`는 항상 허용, `Alt+N`은 거부를 정확히 한 번 실행한다.
- 버튼의 플랫폼별 단축키 표기와 실제 키 해석은 같은 정의를 사용한다.
- 팝업이 닫히면 리스너가 제거되며, 일반 입력과 추가 수정키 조합은 가로채지 않는다.

## UC-V022-LOCAL-RELEASE-ACCEPTANCE — 동일 빌드 사용자 검증

- 사용자가 한국어로 온보딩하면 Host 음성 설치 준비·진행·실패 안내가 모두 한국어로 보인다.
- 상단 TTS를 끄는 즉시 현재 발화와 대기 문장이 멈추고 다음 답변도 읽지 않는다.
- thinking은 생성 중 접힌 한 줄 이탤릭 미리보기로 흐르며 클릭하면 전체 내용을 볼 수 있고, 최종 답변과 TTS에는 섞이지 않는다.
- Python 등 fenced code는 구문 강조와 정확한 복사·복사 완료 피드백을 제공한다. Mermaid fence는 다이어그램으로 렌더링되고 실패하면 원문이 남는다.
- Workspace에서 MP3/WAV/MP4를 클릭하면 UTF-8 텍스트 오류 없이 미디어 컨트롤이 열린다.
- YouTube 패널 상단에서 배경 영상 표시를 끌 수 있고 오디오는 유지된다. 음표와 재생/정지 버튼은 실제 player 이벤트와 일치한다.
- YouTube BGM을 재생해도 재생이 실제 확인되기 전에는 기존 배경이 그대로 보이고, 임베드가 실패하면 검은 화면 대신 기존 배경으로 돌아온다.
- 유튜브 즐겨찾기는 앱을 재설치·업데이트하거나 개발빌드↔설치본을 오가도 워크스페이스(naia-settings)를 따라 유지되며, 기존 localStorage 즐겨찾기는 첫 실행에서 자동 이전된다.
- Herdr가 준비되지 않아도 파일 트리는 열리며, 로컬 OpenAI 호환 Base URL과 `naia <file>` 흐름도 같은 후보 빌드에서 동작한다.
- 설치를 마친 Host 음성은 설정에서 선택하는 즉시 자동 시작되고, 시작 실패나 차단 시 사유와 되돌림 안내가 프로필·음성 화면에 보인다. 무언 revert 는 없다. (#507)
- 개발·e2e 실행도 설치본과 같은 위치(resource_dir)에서 installer 리소스를 찾으므로, 설치 완료된 엔진이 개발 빌드에서 미설치로 보이거나 재다운로드를 요구하지 않는다. (#508)
- bgm-skill 검증은 즐겨찾기를 워크스페이스 SoT(`naia-config.bgmYoutubeFavorites`)에서 읽고, 비표준 포트의 공지 API(announcements) CORS 노이즈를 BGM 오류로 오인하지 않는다.

Test Coverage Map: 관련 단위·컴포넌트 테스트만으로 완료하지 않는다. `v0.2.2` 버전과 리소스를 가진 동일 debug/release 후보를 시작해 Playwright UI 여정과 Windows Tauri smoke를 모두 통과해야 한다.
## 2026-08-26 워크스페이스 컨텍스트 해석 (#501, 에픽 #497)

> 계약: `docs/progress/issue-497-universal-agent.md`. 여기의 UC는 Naia가 ADK 워크스페이스 루트에서
> 실행한 코딩 에이전트처럼 자기 규칙을 스스로 찾아 읽는 부분만 다룬다. 실행 위임은 #500,
> 제어면은 #502가 소유한다.

### UC-WORKSPACE-CONTEXT-DISCOVER — 워크스페이스 규칙을 스스로 찾는다

- 사용자가 워크스페이스 루트를 지정하고 첫 요청을 하면, Naia는 그 루트의 진입점 문서와 그것이 가리키는 필수 인덱스를 스스로 찾아 읽는다.
- 어떤 문서를 읽었고 왜 읽었는지를 사용자가 물으면 근거와 함께 답한다. "설정된 폴더라서"가 아니라 "루트 진입점이 이 인덱스를 필수로 지정해서"라고 답할 수 있다.
- 워크스페이스 이름을 코드에 박아 두지 않는다. 진입점이 선언한 것만 읽고, 선언되지 않은 문서는 읽지 않는다.
- 요청과 무관한 문서는 발견은 하되 읽지 않는다. 매 대화마다 워크스페이스 전체를 대화에 밀어 넣지 않는다.

### UC-WORKSPACE-CONTEXT-ENTER-PROJECT — 프로젝트 안으로 들어간다

- 사용자가 특정 프로젝트의 일을 요청하면, Naia는 그 프로젝트 디렉터리의 진입점과 프로젝트 전용 필수 컨텍스트를 추가로 읽는다.
- 루트 컨텍스트가 프로젝트 컨텍스트를 대신하지 않는다. 프로젝트에 자기 규칙이 있으면 그것이 우선한다.
- 프로젝트 진입은 작업 디렉터리를 바꾸는 것으로 끝나지 않는다. 컨텍스트 전환으로 다루며 전환 사실이 관측 가능하다.
- 프로젝트에 들어갔다는 사실만으로 부모나 형제 프로젝트에 대한 작업 권한이 생기지 않는다.

### UC-WORKSPACE-CONTEXT-SWITCH-PROJECT — 프로젝트를 갈아탄다

- 다른 프로젝트로 옮기면 이전 프로젝트의 지역 컨텍스트는 버린다. 사용자가 명시한 의도는 유지한다.
- 이전 프로젝트의 규칙이 새 프로젝트의 판단 근거로 남지 않는다.
- 컨텍스트가 바뀌면 개정 번호가 바뀌고 사용자가 그것을 확인할 수 있다.
- 워크스페이스 문서가 디스크에서 바뀌면 다음 요청에서 갱신본을 쓴다. 오래된 사본으로 답하지 않는다.

### UC-WORKSPACE-CONTEXT-BROKEN-ENTRYPOINT — 규칙을 못 읽으면 정직하게 실패한다

- 진입점이 없거나, 형식이 깨졌거나, 가리키는 인덱스가 없으면 추측해서 진행하지 않는다.
- 무엇을 어디서 찾다가 왜 실패했는지 사용자가 고칠 수 있는 형태로 보고한다.
- 심볼릭 링크나 상위 경로 표기로 워크스페이스 경계 밖을 가리키면 거부한다.
- 정의되지 않은 약어나 용어를 만나면 뜻을 추측하지 않고 되묻는다.

Test Coverage Map (P02):

| UC | 검증 수단 | 대상 |
|---|---|---|
| UC-WORKSPACE-CONTEXT-DISCOVER | vitest `src/test/workspace-context-discover.contract.test.ts` | 진입점 발견, 선언된 인덱스만 로드, 선언 밖 문서 미로드, 근거 기록 |
| UC-WORKSPACE-CONTEXT-DISCOVER | vitest `src/test/workspace-context-selective-load.contract.test.ts` | 의도별 선택 로딩, 로드 토큰 상한, 전체 주입 금지 |
| UC-WORKSPACE-CONTEXT-ENTER-PROJECT | vitest `src/test/workspace-context-enter-project.contract.test.ts` | 중첩 진입점 로드, 프로젝트 규칙 우선, 권한 비확장 negative |
| UC-WORKSPACE-CONTEXT-SWITCH-PROJECT | vitest `src/test/workspace-context-switch-project.contract.test.ts` | 지역 컨텍스트 폐기, 의도 보존, 교차 누출 0 |
| UC-WORKSPACE-CONTEXT-SWITCH-PROJECT | vitest `src/test/workspace-context-revision.contract.test.ts` | 개정 번호 단조 증가, 디스크 변경 반영, 오래된 사본 거부 |
| UC-WORKSPACE-CONTEXT-BROKEN-ENTRYPOINT | vitest `src/test/workspace-context-failure-honesty.contract.test.ts` | 부재·형식 오류·인덱스 부재 진단 메시지 |
| UC-WORKSPACE-CONTEXT-BROKEN-ENTRYPOINT | vitest `src/test/workspace-context-path-boundary.contract.test.ts` | 심볼릭 링크·상위 경로 탈출 negative |
| 전체 | vitest `src/test/workspace-context-fs-adapter.contract.test.ts` | 실제 진입점 파싱, 이 저장소 AGENTS.md 실측, 임시 워크스페이스 중첩 진입, 경계 거부, 지문 변화 |
| 전체 | vitest `src/test/workspace-context-observe-adapter.contract.test.ts` | Tauri 웹뷰 경로(F2 관측 포트) 재사용, 크기 기반 지문의 한계 고정 |
| 전체 | vitest `packages/shell/src/apps/workspace/__tests__/workspace-context-app.test.tsx` | 앱 상태 매트릭스(루트 없음·성공·빈 목록·오류·프로젝트 전환·다시 읽기) |
| 전체 | Playwright `packages/shell/e2e/workspace-context.spec.ts` | 실 UI에서 근거 표시, 선언 밖 문서 미표시, 프로젝트 전환 시 범위·개정 변화, 경로 중복 없음, 근거 출처 정확성, 실패 진단, 좁은 폭 미넘침 |
| 전체 | e2e-tauri `packages/shell/e2e-tauri/specs/workspace-context.spec.ts` | 실제 파일 시스템 픽스처에서 발견·진입·전환·실패의 풀스택 왕복 |

상태 매트릭스: 기본(진입점 정상), 빈 목록(선언된 인덱스 0개), 진행(대용량 워크스페이스 스캔 중),
성공(컨텍스트 확정), 오류(진입점 깨짐), 좁은 폭(컨텍스트 근거 앱 축소)을 모두 매핑한다.

## 2026-08-26 Herdr 제어면 (#502, 에픽 #497, #434 승계)

> 계약: `docs/progress/issue-497-universal-agent.md`. #434의 인수 기준을 승계한다. 여기의 UC는
> Naia가 Herdr를 관측하고 정책을 통과한 변경을 요청하는 부분만 다룬다. 워크스페이스 규칙 해석은 #501,
> 작업자 배치는 #500이 소유한다.

### UC-HERDR-CONTROL-OBSERVE — TUI를 긁지 않고 관측한다

- Naia는 Herdr의 space, 이슈, 세션, 작업자, pane, 터미널, 진행 중 작업을 타입이 선언된 자원으로 읽는다.
- 화면 문자열을 파싱하거나 private socket을 엿보지 않는다.
- 스냅샷에는 단조 증가하는 개정 번호가 실려 있고, 이후 변화는 구독으로 받는다. 놓친 구간이 있으면 그 사실을 알 수 있다.
- 사용자가 "지금 뭐 돌고 있어?"라고 물으면 Naia는 관측한 것만 말하고 추측을 섞지 않는다.

### UC-HERDR-CONTROL-MUTATE — 정책을 통과한 변경만 요청한다

- Naia는 space 생성·포커스, 이슈 결속, 리더·작업자 시작과 종료, 터미널 생성·실행·입력·크기변경·종료를 구조화된 요청으로 보낸다.
- 명령은 인자 배열과 작업 디렉터리와 환경으로 전달한다. 문자열로 조립해 셸에 넘기지 않는다.
- 모든 요청은 요청 식별자와 멱등 키를 갖는다. 같은 키를 다시 보내도 프로세스나 명령이 두 번 생기지 않는다.
- 모든 변경은 영향을 받은 자원 식별자와 증거 참조를 돌려준다. "했습니다"만 남기지 않는다.
- 자격증명 사용, 외부 발신, 파괴적 명령, 운영 변경은 일반 편집 권한을 상속하지 않는다.

### UC-HERDR-CONTROL-STALE-REVISION — 늦게 도착한 요청은 조용히 덮어쓰지 않는다

- 요청에는 사용자가 본 시점의 기대 개정 번호가 실린다.
- 그 사이 상태가 바뀌었으면 요청은 타입이 선언된 충돌로 거절된다. 조용히 최신 상태를 덮어쓰지 않는다.
- 충돌을 받은 Naia는 현재 상태를 다시 관측하고 사용자에게 무엇이 달라졌는지 말한 뒤 다시 판단한다.

### UC-HERDR-CONTROL-RECONNECT — 끊겨도 완료를 지어내지 않는다

- 연결이 끊기거나 Herdr가 재시작되면 Naia는 다시 붙어 현재 상태를 재확인한다.
- 연결 끊김, 타임아웃, 프로세스 종료, 사용자 취소, 부분 완료는 서로 다른 결과로 구별되어 남는다.
- 재접속 직후 Naia는 작업이 멈췄다거나 끝났다고 증거 없이 말하지 않는다. 모르면 모른다고 한다.
- 재접속 시도에는 상한이 있고, 상한에 닿으면 실패를 정직하게 보고한다.

Test Coverage Map (P02):

| UC | 검증 수단 | 대상 |
|---|---|---|
| UC-HERDR-CONTROL-OBSERVE | vitest `src/test/herdr-control-resource-schema.contract.test.ts` | 자원 스키마·버전, 개정 단조 증가, 구독 누락 감지 |
| UC-HERDR-CONTROL-OBSERVE | vitest `src/test/herdr-control-no-screen-scrape.contract.test.ts` | 화면 파싱·private socket 경로 부재 negative |
| UC-HERDR-CONTROL-MUTATE | vitest `src/test/herdr-control-mutation.contract.test.ts` | 구조화 argv·cwd·env, 증거 참조 반환, 문자열 조립 negative |
| UC-HERDR-CONTROL-MUTATE | vitest `src/test/herdr-control-idempotency.contract.test.ts` | 같은 멱등 키 재전송 시 중복 생성 0 |
| UC-HERDR-CONTROL-MUTATE | vitest `src/test/herdr-control-capability-tier.contract.test.ts` | 자격증명·외부 발신·파괴적 명령의 권한 비상속 negative |
| UC-HERDR-CONTROL-STALE-REVISION | vitest `src/test/herdr-control-stale-revision.contract.test.ts` | 기대 개정 불일치 시 타입 있는 충돌, 무음 덮어쓰기 0 |
| UC-HERDR-CONTROL-RECONNECT | vitest `src/test/herdr-control-outcome-taxonomy.contract.test.ts` | 끊김·타임아웃·종료·취소·부분완료 구별 |
| UC-HERDR-CONTROL-RECONNECT | vitest `src/test/herdr-control-reconnect-bounds.contract.test.ts` | 재접속 상한, 상한 도달 시 정직 실패 |
| 전체 | vitest `src/test/herdr-protocol-conformance.contract.test.ts` | 설치된 herdr 의 `api schema` 와 우리 계약을 대조하고 요구사항별 실현 가능성을 사실에서 계산 |
| 전체 | e2e-tauri `packages/shell/e2e-tauri/specs/herdr-control.spec.ts` | 실제 Herdr 상대 관측·변경·충돌·재시작 복구 왕복 |

상태 매트릭스: 기본(Herdr 정상), 빈 목록(space 0개), 진행(작업자 실행 중), 성공(변경 반영),
오류(충돌·타임아웃·연결 끊김), 좁은 폭(제어 앱 축소)을 모두 매핑한다.

## 2026-08-26 브라우저·터미널 환경 도구 (#499, 에픽 #497)

> 계약: `docs/progress/issue-497-universal-agent.md`. 기존 UC6(브라우저 조작), UC7·UC7a(시스템 관측·조작),
> UC13a(실행 중 중단)를 확장한다. 터미널의 생명주기 소유는 #502가 Herdr에 위임한 것을 그대로 따른다.

### UC-ENV-TOOL-BROWSE — 보고 나서 누른다

- Naia는 페이지를 열고, 구조 스냅샷을 얻고, 그 스냅샷의 안정된 요소 참조로 클릭하고 입력한다.
- 좌표로 찍지 않는다. 좌표만 가능한 경우에는 그 사실을 밝힌다.
- 행동 전과 후의 관측을 남겨, 무엇이 달라졌는지 사용자에게 설명할 수 있다.
- 페이지에 담긴 문장은 자료이지 지시가 아니다. 페이지가 시키는 대로 권한을 넓히지 않는다.

### UC-ENV-TOOL-TERMINAL-EXEC — 명령을 조립하지 않고 실행한다

- Naia는 실행 파일과 인자 배열, 작업 디렉터리, 환경을 구조화해 넘긴다. 셸 문자열을 조립하지 않는다.
- 터미널의 생성과 종료는 Herdr가 소유하고 Naia는 요청자로만 참여한다.
- 종료 코드, 출력 참조, 산출물 참조가 결과에 함께 돌아온다.
- 워크스페이스 경계 밖을 건드리는 명령은 명시적 권한 없이는 거부된다.

### UC-ENV-TOOL-CANCEL — 돌아가는 것을 끊을 수 있다

- 사용자가 멈추라고 하면 진행 중인 브라우저 작업과 터미널 작업이 실제로 멈춘다.
- 취소된 작업은 실패와 구별되어 기록되고, 부분적으로 일어난 일이 있으면 그것도 남는다.
- 타임아웃에 걸린 작업은 결과 불명으로 남기고 성공으로 승격하지 않는다.
- 같은 요청을 다시 보내도 이미 실행된 작업이 두 번 일어나지 않는다.

### UC-ENV-TOOL-BOUNDARY-DENY — 권한은 상속되지 않는다

- 파일을 고칠 수 있다는 것이 메시지를 보내거나 게시하거나 결제할 수 있다는 뜻이 되지 않는다.
- 저장된 자격증명을 쓰는 호출은 별도 승인을 받는다.
- 삭제와 운영 환경 변경은 사람 결정으로 올린다.
- 거부는 조용한 무시가 아니라 사용자가 이유를 아는 명시적 응답이다.

Test Coverage Map (P02):

| UC | 검증 수단 | 대상 |
|---|---|---|
| UC-ENV-TOOL-BROWSE | vitest `src/test/env-tool-browser.contract.test.ts` | 작업 생명주기 5상태, 스냅샷 자원, 안정 요소 참조 |
| UC-ENV-TOOL-BROWSE | Playwright `packages/shell/e2e/env-tool-browser.spec.ts` | 실제 페이지 열기·스냅샷·클릭·입력·전후 관측 |
| UC-ENV-TOOL-BROWSE | Playwright `packages/shell/e2e/env-tool-injection.spec.ts` | 악성 페이지 지시 주입 무시 negative |
| UC-ENV-TOOL-TERMINAL-EXEC | vitest `src/test/env-tool-terminal.contract.test.ts` | 구조화 argv·cwd·env, Herdr 위임, 종료 코드·출력 참조 |
| UC-ENV-TOOL-TERMINAL-EXEC | vitest `src/test/env-tool-workspace-escape.contract.test.ts` | 경계 밖 명령 거부 negative |
| UC-ENV-TOOL-CANCEL | vitest `src/test/env-tool-cancel-timeout.contract.test.ts` | 취소·타임아웃·부분 실행 구별, 재전송 멱등 |
| UC-ENV-TOOL-BOUNDARY-DENY | vitest `src/test/env-tool-approval-matrix.contract.test.ts` | 등급별 승인 요구, 비상속, 명시적 거부 |
| 전체 | e2e-tauri `packages/shell/e2e-tauri/specs/env-tool.spec.ts` | 실 브라우저와 실 Herdr 터미널의 풀스택 왕복 |

상태 매트릭스: 기본, 빈 목록(열린 컨텍스트 0개), 진행(작업 실행 중), 성공, 오류(거부·타임아웃·취소),
좁은 폭(도구 결과 앱 축소)을 모두 매핑한다.

## 2026-09-09 에이전트 브라우저 호스트 (#582, 부모 #499, 에픽 #497)

> 계약: `docs/progress/issue-582-ego-browser-host.md`. UC-ENV-TOOL-BROWSE·CANCEL 을 실제 브라우저(감독자가 소유한
> 헤드리스 Chromium)로 재개하고, 아래 세 시나리오를 추가한다. 셸 임베디드 브라우저(UC6)는 그대로 둔다.

### UC-ENV-TOOL-SPACE — 에이전트는 자기 공간에서만 일한다

- Naia 가 웹 작업을 하는 동안 사용자의 창, 포커스, 마우스는 변하지 않는다. 브라우저 창은 뜨지 않는다.
- 작업 공간은 비어 있는 격리 공간이다. 사용자의 로그인·쿠키·저장소를 물려받지 않고, 공간끼리도 새지 않는다.
- 두 작업이 동시에 돌아도 서로의 탭·응답·이벤트를 보지 못한다.
- 로그인이나 captcha 처럼 사람이 필요한 순간이 오면 Naia 는 멈추고 사용자에게 보고한다. 사용자에게 브라우저를 넘겨주는 흉내를 내지 않는다.

### UC-ENV-TOOL-RECOVER — 셸이 죽어도 브라우저가 남지 않는다

- 셸이 정상 종료·재시작·Reset 되면 Naia 의 브라우저도 함께 정리된다.
- 셸이나 감독자가 강제 종료돼도 다음 시작에서 남은 브라우저가 회수되고, 다른 프로그램의 프로세스는 건드리지 않는다.
- 다른 ADK 로 전환하면 이전 ADK 의 브라우저를 먼저 닫고 새 ADK 의 상태를 조정한다.
- 작업 도중 실행기가 죽으면 그 작업은 실패로 기록되고, 작업 공간은 유지되어 다음 작업이 이어 쓴다.

### UC-ENV-TOOL-SCRIPT — 묶음 실행은 승인이 먼저다

- Naia 는 열기·이동·스냅샷·클릭·입력·캡처처럼 효과가 정해진 도구를 기본으로 쓴다.
- 여러 단계를 자바스크립트 한 덩어리로 묶어 실행하는 것은 터미널 명령 실행과 같은 등급이다. 승인 없이는 시작되지 않는다.
- 승인된 묶음 실행도 워크스페이스·네트워크·파일 경계를 벗어나지 않는다. (2026-09-10: 승인 UI 와 경계 강제는 미구현. FR-ENV-TOOL.14b Pending. 지금은 승인 참조 없는 실행이 거부되는 것까지만 검증됐다.)
- 낮은 등급의 도구가 묶음 실행으로 승격되는 길은 없다.

Test Coverage Map (P02):

| UC | 검증 수단 | 대상 |
|---|---|---|
| UC-ENV-TOOL-BROWSE | vitest `src/test/env-tool-browser-host.contract.test.ts` | 실제 어댑터로 열기·이동·스냅샷·안정 참조 클릭·입력·캡처·닫기, 증거 셋(스냅샷·캡처·주소 개정) |
| UC-ENV-TOOL-BROWSE | node:test `packages/ego-host/test/conformance.test.mjs` | 실제 감독자 + 벤더 런타임의 실행 ABI 각 행, 전송 실패 모드(15초 경계·순서·이벤트 폭주·단절·id 없는 오류 범위) |
| UC-ENV-TOOL-SPACE | vitest `src/test/env-tool-workspace-resource.contract.test.ts` | 헤드리스 소유권 전이 표(인계·회수·claim 거부), 작업 공간·페이지 자원 형태, 개정 확인, 형식 있는 실패 사유 |
| UC-ENV-TOOL-SPACE | node:test `packages/ego-host/test/isolation.test.mjs` | 로컬 출처에서 쿠키·localStorage·IndexedDB·CacheStorage·서비스 워커·권한·다운로드 경로 negative, 두 CLI 동시 id 1 |
| UC-ENV-TOOL-SPACE | node:test `packages/ego-host/test/no-interference.test.mjs` | 헤드리스 인자·활성 창 불변·감독자 트리 창 0 (Xvfb·xdotool 필수) |
| UC-ENV-TOOL-SPACE | node:test `packages/ego-host/test/mediator.test.mjs` | 기본 거부 행렬 각 셀(거부는 원래 id 오류 응답, 컨텍스트 강제는 재작성), 헤드리스 인계 거부 |
| UC-ENV-TOOL-CANCEL | vitest `src/test/env-tool-cancel-timeout.contract.test.ts` | 종결 CAS 경주, 동시 멱등 1회, 실제 deadline |
| UC-ENV-TOOL-CANCEL | node:test `packages/ego-host/test/cancel.test.mjs` | 이동·Fetch 가로채기·평가 취소 훅, 후속 이벤트 0, 열린 가로채기·스트림·세션 0 |
| UC-ENV-TOOL-RECOVER | node:test `packages/ego-host/test/lease.test.mjs` | 감독자 SIGKILL → Chromium 소멸, 시작 조정 → 고아 0, marker 불일치 프로세스 불간섭, CLI 강제 종료 → 같은 공간 재접속 |
| UC-ENV-TOOL-RECOVER | vitest `src/test/env-tool-adk-switch.contract.test.ts` | ADK A 종료 → B 조정 순서 |
| UC-ENV-TOOL-RECOVER | e2e-tauri `packages/shell/e2e-tauri/specs/env-tool-browser-host-lifecycle.spec.ts` | Reset·재시작·정상 종료 뒤 PID·marker·lease |
| UC-ENV-TOOL-SCRIPT | vitest `src/test/env-tool-approval-matrix.contract.test.ts` | 등급 고정 RPC 표(관측 둘·워크스페이스 변경 여덟), 호출자 선언을 판정에 쓰지 않음 |
| UC-ENV-TOOL-SCRIPT | Playwright `packages/shell/e2e/env-tool-browser-host.spec.ts` | 형식 도구 호출 → 증거 반환, 승인 없는 묶음 실행 거부, 기존 `skill_browser_*` 불변 |
| UC-ENV-TOOL-SCRIPT | node:test `packages/ego-host/test/handshake.test.mjs` | grant 없는 핸드셰이크 거부, 관측 연결 무영향 |
| 전체 | node:test `packages/ego-host/test/vendor-install.test.mjs` | 벤더 매니페스트 일치, 임의 디렉터리 설치·빌드·실행 |
| UC-ENV-TOOL-BROWSE·SCRIPT | e2e-tauri `packages/shell/e2e-tauri/specs/env-tool-browser-host-fullstack.spec.ts` | 실 Tauri 앱에서 도구 호출 → 실 Chromium 캡처·스냅샷·주소 개정, 참조 클릭, 승인 없는 script 거부, 종료 뒤 잔류 0 |
| UC-ENV-TOOL-SCRIPT | vitest `packages/shell/src/lib/__tests__/ego-browser-env-ipc.test.ts`·`packages/shell/src/lib/__tests__/browser-host-skill.test.ts` | IPC 어댑터가 포트를 올바른 명령으로 부르고 거부를 형식 있게 전달, 플래그·이름 비충돌 |
| UC-ENV-TOOL-RECOVER | Rust `packages/shell/src-tauri/src/ego_host.rs`·`ego_host_bridge.rs` 단위 | lease 파싱·marker 경계·unverified 처분·소켓 경로 Node 동일성·관리 비밀 불일치 거부 |

상태 매트릭스: 기본(공간 0), 진행(작업 실행 중), 성공, 오류(거부·타임아웃·취소·실행기 종료), 회수(재시작 뒤 조정)를 매핑한다.
화면이 없는 기능이므로 좁은 폭 상태는 도구 결과 카드에만 적용된다.

## 2026-08-26 이슈 리더와 코딩 작업자 오케스트레이션 (#500, 에픽 #497)

> 계약: `docs/progress/issue-497-universal-agent.md`. 선행: #501의 컨텍스트 해석과 #502의 제어면.
> 위임 위험도 등급은 워크스페이스 terminology 정의를 따르며 high는 위임하지 않는다.

### UC-ORCHESTRATION-CLASSIFY — 대화로 끝낼 일과 이슈로 만들 일을 가른다

- 사용자가 무언가를 요청하면 Naia는 그 자리에서 답할 일인지, 이슈로 만들어 위임할 일인지 먼저 판단한다.
- 이슈로 만들 일이면 GitHub 이슈를 새로 만들거나 기존 이슈에 붙이고, 그것을 Herdr space에 결속한다.
- 판단 근거를 사용자가 물으면 답할 수 있고, 사용자가 뒤집으면 그대로 따른다.
- 사소한 질문에 이슈와 작업자를 만들지 않는다.

### UC-ORCHESTRATION-ISSUE-LEAD — 리더 하나가 이슈를 책임진다

- 이슈마다 L2 리더가 하나 선다. 리더는 계획, 소유 경로 배정, 작업자 배치, 증거 통합, 완료 판정을 맡는다.
- 구현자와 독립 검증자가 최소한으로 붙는다. 구현한 작업자가 자기 결과를 검증하지 않는다.
- 작업자의 소유 경로는 겹치지 않는다. 겹칠 수밖에 없으면 순서를 정해 직렬화한다.
- 작업자는 자기 권한을 넓히거나 이슈 완료를 선언하지 못한다. 리더가 증거를 모아 L3에 올린다.

### UC-ORCHESTRATION-WORKER-REPLACE — 멈춘 작업자를 갈아 끼운다

- 작업자가 죽거나 멈추면 이슈 상태를 잃지 않고 다른 작업자로 교체한다.
- Codex, Claude, OpenCode는 명령줄 도구가 서로 달라도 같은 생명주기 의미를 노출한다.
- 교체 시 이미 만들어진 산출물과 증거는 보존한다.
- 사용자는 언제든 중단하고 다시 시작할 수 있다.

### UC-ORCHESTRATION-RESTART-RESUME — 앱을 껐다 켜도 이어진다

- 앱이나 Herdr가 재시작해도 이슈, 리더, 작업자 상태를 다시 찾아 이어간다.
- 재시작 직후 완료나 실패를 증거 없이 단정하지 않는다.
- 이어받을 수 없는 부분은 이어받을 수 없다고 보고한다.

Test Coverage Map (P02):

| UC | 검증 수단 | 대상 |
|---|---|---|
| UC-ORCHESTRATION-CLASSIFY | vitest `src/test/orchestration-classify.contract.test.ts` | 대화형·이슈형 분류, 사용자 뒤집기 반영 |
| UC-ORCHESTRATION-ISSUE-LEAD | vitest `src/test/orchestration-issue-lead.contract.test.ts` | 리더 단일성, 역할 분리, 증거 통합 |
| UC-ORCHESTRATION-ISSUE-LEAD | vitest `src/test/orchestration-ownership-conflict.contract.test.ts` | 소유 경로 중첩 거부·직렬화 negative |
| UC-ORCHESTRATION-ISSUE-LEAD | vitest `src/test/orchestration-no-self-completion.contract.test.ts` | 작업자 자가 완료 선언·권한 확장 negative |
| UC-ORCHESTRATION-WORKER-REPLACE | vitest `src/test/orchestration-worker-adapter.contract.test.ts` | Codex·Claude·OpenCode 어댑터 생명주기 동등성 |
| UC-ORCHESTRATION-WORKER-REPLACE | vitest `src/test/orchestration-replace-preserve.contract.test.ts` | 교체 시 이슈 상태·산출물 보존 |
| UC-ORCHESTRATION-RESTART-RESUME | e2e-tauri `packages/shell/e2e-tauri/specs/orchestration-restart.spec.ts` | 앱·Herdr 재시작 후 이어받기, 증거 없는 단정 0 |
| 전체 | e2e-tauri `packages/shell/e2e-tauri/specs/orchestration-reference.spec.ts` | 참조 이슈를 구현자와 독립 검증자로 완주 |

상태 매트릭스: 기본, 빈 목록(작업자 0), 진행(작업자 실행 중), 성공(검증 완료), 오류(작업자 사망·소유 충돌),
좁은 폭(작업자 목록 축소)을 모두 매핑한다.

## 2026-08-26 채널 중립 세션 (#503, 에픽 #497)

> 계약: `docs/progress/issue-497-universal-agent.md`. 기존 UC10(멀티 채널)과 UC10a(다중 클라이언트 점유
> 충돌)를 확장한다. 채널은 L3 어댑터이며 실행 소유자가 아니다.

### UC-CHANNEL-SESSION-HANDOFF — 어디서 시작하든 하나의 일이다

- Discord에서 시작한 일을 데스크톱 Naia에서 들여다보고, Herdr에서 이어가고, 다시 허가된 채널에서 마무리한다.
- 같은 이슈에는 L3 대화 정체성 하나와 Herdr 실행 소유자 하나만 존재한다.
- 채널이 달라도 대화가 갈라지지 않는다.
- 음성으로 시작한 일도 같은 세션으로 이어진다.

### UC-CHANNEL-SESSION-DUPLICATE-DELIVERY — 같은 메시지가 두 번 와도 한 번만 한다

- 채널이 같은 메시지를 중복 전달해도 이슈나 작업자가 두 개 생기지 않는다.
- 이벤트가 순서를 바꿔 도착해도 상태가 뒤집히지 않는다.
- 이미 처리한 요청의 재전달은 처리 결과를 다시 알려 주는 것으로 끝난다.

### UC-CHANNEL-SESSION-RECONNECT — 끊겼다 붙어도 지어내지 않는다

- 채널이 끊겼다 다시 붙어도 Naia는 일이 멈췄다거나 끝났다고 증거 없이 말하지 않는다.
- 재부팅 뒤에도 이어받을 수 있는 참조를 보관한다. 작업자 실행 상태를 다시 복사해 두지 않는다.
- 대화 응답과 오래 걸리는 작업의 진행 알림은 구분해서 보낸다.

### UC-CHANNEL-SESSION-DISCLOSURE-DENY — 좁은 곳의 이야기가 넓은 곳으로 새지 않는다

- 워크스페이스의 기밀 컨텍스트가 더 넓은 채널로 그대로 나가지 않는다.
- 채널마다 신원, 참여 자격, 공개 범위, 응답 경로 정책이 다르며 그것을 지킨다.
- 정책상 답할 수 없는 곳에서는 답하지 않고 그 사실을 알린다.

Test Coverage Map (P02):

| UC | 검증 수단 | 대상 |
|---|---|---|
| UC-CHANNEL-SESSION-HANDOFF | vitest `src/test/channel-session-identity.contract.test.ts` | 대화·작업·이슈·space 식별자 채널 중립성, 단일 소유 |
| UC-CHANNEL-SESSION-DUPLICATE-DELIVERY | vitest `src/test/channel-session-dedupe.contract.test.ts` | 중복 전달 시 이슈·작업자 중복 생성 0 |
| UC-CHANNEL-SESSION-DUPLICATE-DELIVERY | vitest `src/test/channel-session-out-of-order.contract.test.ts` | 순서 뒤바뀐 이벤트에서 상태 역전 0 |
| UC-CHANNEL-SESSION-RECONNECT | vitest `src/test/channel-session-resume-refs.contract.test.ts` | 재개 참조 보관, 작업자 상태 복사 금지 |
| UC-CHANNEL-SESSION-RECONNECT | e2e-tauri `packages/shell/e2e-tauri/specs/channel-reboot.spec.ts` | 재부팅 후 이어받기, 증거 없는 완료·중단 단정 0 |
| UC-CHANNEL-SESSION-DISCLOSURE-DENY | vitest `src/test/channel-session-disclosure-policy.contract.test.ts` | 채널별 공개 범위, 기밀 컨텍스트 유출 negative |
| 전체 | e2e-tauri `packages/shell/e2e-tauri/specs/channel-continuity.spec.ts` | 데스크톱과 Discord 사이 연속성 종단 시나리오 |

상태 매트릭스: 기본, 빈 목록(활성 작업 0), 진행(작업 실행 중 알림), 성공, 오류(연결 끊김·정책 거부),
좁은 폭(채널 목록 축소)을 모두 매핑한다.

## 2026-08-26 검증·벤치마크 하네스 (#498, 에픽 #497)

> 계약: `docs/progress/issue-497-universal-agent.md`. 이 하네스가 형제 이슈의 UC를 실제로 밟아
> 완료를 판정한다. 형제 이슈는 자기 주장으로 완료되지 않는다.

### UC-AGENT-BENCH-RUN — 시나리오를 실제로 밟아 판정한다

- 형제 이슈의 UC 시나리오를 하네스가 직접 실행하고 기대 결과를 확인한다.
- 목 데이터만으로 얻은 통과는 native Herdr, 실제 브라우저, 실제 코딩 작업자 게이트를 대신하지 못한다.
- 판정 결과에는 의도, 컨텍스트 개정, 수행한 작업, 산출물, 테스트, 완료 증거가 추적 가능하게 남는다.

### UC-AGENT-BENCH-FALSE-COMPLETION — 가짜 완료를 잡아낸다

- 실제로는 하지 않은 일을 했다고 보고하면 하네스가 그것을 실패로 판정한다.
- 테스트를 지우거나 범위를 줄여 얻은 통과는 완료 증거가 아니다.
- 다른 프로젝트의 컨텍스트가 답에 섞이면 실패로 판정한다.
- 허가 없는 외부 발신이 일어나면 실패로 판정한다.

### UC-AGENT-BENCH-REPORT — 통과 여부만이 아니라 비용과 지연을 보고한다

- 벤치마크는 성공률과 함께 중앙값 지연과 꼬리 지연, 토큰 비용, 사람 개입 횟수를 보고한다.
- 결과는 같은 입력에서 재현 가능하다.
- 회귀 임계값을 넘으면 그것을 드러낸다.

Test Coverage Map (P02):

| UC | 검증 수단 | 대상 |
|---|---|---|
| UC-AGENT-BENCH-RUN | vitest `src/test/agent-bench-runner.contract.test.ts` | 시나리오 실행·판정 계약, 결정론 픽스처 |
| UC-AGENT-BENCH-RUN | vitest `src/test/agent-bench-fixtures.contract.test.ts` | 중첩 진입점·다중 프로젝트 임시 워크스페이스 픽스처 |
| UC-AGENT-BENCH-RUN | vitest `src/test/agent-bench-scenario-source.contract.test.ts` | 이 문서에서 형제 UC 를 읽어 판정 목록을 만든다. 계열이 비면 실패 |
| UC-AGENT-BENCH-FALSE-COMPLETION | vitest `src/test/agent-bench-false-completion.contract.test.ts` | 미수행 보고·축소 suite·교차 누출·무단 발신 탐지 |
| UC-AGENT-BENCH-REPORT | vitest `src/test/agent-bench-report.contract.test.ts` | 지연 중앙값·꼬리, 비용, 개입 횟수, 재현성 |
| 전체 | e2e-tauri `packages/shell/e2e-tauri/specs/agent-bench.spec.ts` | 실제 Herdr·브라우저·코딩 작업자 게이트에서의 수용 실행 |

상태 매트릭스: 기본, 빈 목록(시나리오 0), 진행(벤치 실행 중), 성공(수용), 오류(가짜 완료 탐지·임계 초과),
좁은 폭(리포트 표 축소)을 모두 매핑한다.

## 2026-08-26 환경 표면 — 뇌가 보는 것과 내리는 것 (#502 슬라이스 1)

> 계약: `docs/progress/issue-497-universal-agent.md` 의 2026-08-26 계층 결정.
> 이 절은 `UC-HERDR-CONTROL-*` 과 다르다. 그쪽은 셸이 Herdr 를 어떻게 다루는가이고,
> 여기는 **뇌에 무엇을 보여 주고 뇌가 무엇을 내릴 수 있는가**다. 결정은 naia-agent 가 하고
> 셸은 번역만 한다.
> ⚠️ 기록: `environment-intent.ts` 와 `herdr-environment.ts` 는 이 UC·요구사항보다 먼저 쓰였다.
> P03 게이트를 어긴 것이며, 이 절이 그것을 뒤늦게 닫는다. 번역기부터는 순서를 지킨다.

### UC-ENV-SURFACE-OBSERVE — 나이아가 지금 무엇이 돌고 있는지 안다

- 사용자가 "지금 뭐 돌고 있어?"라고 물으면 나이아는 작업 표면 목록과 각각이 일하는 중인지 답한다.
- 나이아가 보는 것은 표면 이름과 활동 상태와 사용자가 보고 있는지 여부뿐이다. 터미널 관리자의 내부 어휘는 보지 않는다.
- 상태를 모르면 모른다고 한다. 쉬는 중으로 위장하지 않는다.
- 표면이 많아 다 싣지 못하면 몇 개를 못 실었는지 함께 말한다.
- 사용자가 보고 있는 표면이 먼저 온다. 잘릴 때 가장 관련 있는 것이 남는다.

### UC-ENV-SURFACE-ACT — 나이아가 그 세계에 손댄다

- 나이아는 관측한 표면 중 하나를 골라 사용자에게 보여 주거나, 진행 중인 것을 멈추거나, 무언가를 실행해 달라고 요청할 수 있다.
- 나이아는 표면을 가리킬 때 받은 손잡이만 쓴다. 손잡이를 만들어 내지 않는다.
- 나이아는 그 요청이 어떤 명령으로 번역되는지 모른다. 번역은 셸이 한다.
- 요청이 실제로 어떻게 전달되는지(구조화 인자인지 터미널 입력인지)는 셸이 알고, 그 한계는 사용자에게 정직하게 드러난다.

### UC-ENV-SURFACE-DENY — 열어 준 것만 나간다

- 관측만 허용된 상태에서는 나이아가 실행을 요청해도 환경에 닿지 않는다.
- 나이아가 지어낸 손잡이는 거절된다.
- 빈 요청이나 지나치게 긴 요청은 환경에 내려가기 전에 걸린다.
- 거절은 조용한 무시가 아니라 사유가 남는다.

### UC-ENV-SURFACE-DATA — 환경의 말은 지시가 아니다

- 터미널 제목이나 표면 이름에 무엇이 적혀 있든 나이아의 지시문이 되지 않는다.
- 개행과 제어문자가 든 이름은 한 줄로 눌려 전달된다.
- 지나치게 긴 이름은 잘린다. 나이아의 컨텍스트를 잠식하지 못한다.

Test Coverage Map (P02):

| UC | 검증 수단 | 대상 |
|---|---|---|
| UC-ENV-SURFACE-OBSERVE | vitest `src/test/environment-intent.contract.test.ts` | 보고 형태, 상한과 누락 총계, 포커스 우선 정렬, 상태 정규화 |
| UC-ENV-SURFACE-OBSERVE | vitest `src/test/herdr-environment.contract.test.ts` | 실제 Herdr 스냅샷 매핑, 레이블 없는 pane 대체, 살아 있는 데몬 대상 형태 확인 |
| UC-ENV-SURFACE-ACT | vitest `src/test/environment-intent-translation.contract.test.ts` | 의도 → 환경 호출 번역, 표면 종류별 실행 경로 분기, 번역 불가의 정직한 거절 |
| UC-ENV-SURFACE-DENY | vitest `src/test/environment-intent.contract.test.ts` | 허용 집합 밖 의도, 미발행 손잡이, 빈·과길이 요청, 복수 사유 |
| UC-ENV-SURFACE-DATA | vitest `src/test/environment-intent.contract.test.ts` | 제어문자 제거, 길이 상한, 정상 이름 무손상 |
| UC-ENV-SURFACE-DATA | vitest `src/test/herdr-environment.contract.test.ts` | 실제 터미널 제목 경로에서도 제어문자 잔존 0 |
| 경계 | vitest `src/test/environment-intent.contract.test.ts` | 도메인 선언에 터미널 관리자 어휘 부재(주석 제거 후, 공허 통과 방지 포함) |

상태 매트릭스: 기본(표면 여럿), 빈 목록(표면 0), 진행(작업 중 표면), 성공(의도 수용),
오류(거절 사유), 좁은 폭(표면 목록 축약)을 매핑한다. 좁은 폭은 표면 상한과 누락 총계로 다룬다.

## 2026-08-26 환경 호출 전달 (#502 슬라이스 1 — 전달)

> 계약: `docs/progress/issue-497-universal-agent.md` 의 슬라이스 1 전달 경계.
> 번역까지는 순수 계산이고, 여기는 그 결과가 실제 환경에 닿는 지점이다.

### UC-ENV-DISPATCH-STRUCTURED — 구조화된 요청이 환경에 닿는다

- 나이아가 에이전트가 붙은 표면에 무언가를 요청하면 그 표면의 에이전트가 요청을 받는다.
- 나이아가 표면을 보여 달라고 하면 사용자 화면에서 그 표면이 앞으로 나온다.
- 이 경로에는 인용 문제가 없다. 요청 문자열이 명령줄로 재해석되지 않는다.
- 환경이 거절하면 그 사유가 그대로 올라온다. 성공으로 위장하지 않는다.

### UC-ENV-DISPATCH-TERMINAL — 터미널 입력은 다른 등급이다

- 에이전트가 없는 일반 터미널에 무언가를 실행해 달라고 하면, 그것은 사용자가 그 터미널에 직접 타이핑한 것과 같은 일이 된다.
- 그래서 이 경로는 구조화 요청과 같은 권한으로 열리지 않는다. 별도로 허용돼야 한다.
- 진행 중인 것을 멈추는 것도 같은 등급이다.
- 사용자는 나이아가 자기 터미널에 무엇을 넣었는지 나중에 확인할 수 있다.

### UC-ENV-DISPATCH-REFUSE — 열지 않은 것은 나가지 않는다

- 이 슬라이스가 열기로 한 호출 외에는 환경에 도달할 수 없다.
- 형식이 어긋난 표면 식별자는 환경에 닿기 전에 걸린다.
- 지나치게 긴 요청은 거절된다.
- 빈 요청은 전달되지 않는다.

Test Coverage Map (P02):

| UC | 검증 수단 | 대상 |
|---|---|---|
| UC-ENV-DISPATCH-STRUCTURED | vitest `src/test/environment-dispatch.contract.test.ts` | 구조화 호출 3종 라우팅, 환경 오류 전파 |
| UC-ENV-DISPATCH-TERMINAL | vitest `src/test/environment-dispatch.contract.test.ts` | 터미널 입력 2종이 별도 권한 없이는 나가지 않음 |
| UC-ENV-DISPATCH-REFUSE | vitest `src/test/environment-dispatch.contract.test.ts` | 미허용 메서드, 형식 오류 식별자, 빈·과길이 요청 |
| 전체 | Rust `packages/shell/src-tauri/src/herdr/api.rs` 단위 테스트 | 식별자 형식·길이 상한 검증 |
| 전체 | e2e-tauri `packages/shell/e2e-tauri/specs/environment-dispatch.spec.ts` | 실 Tauri 백엔드에서 명령 등록·인자 검증·거절 경로 |

상태 매트릭스: 기본(구조화 전달 성공), 빈 목록(표면 0에서 전달 시도), 진행(전달 중),
성공(환경 수용), 오류(환경 거절·형식 오류), 좁은 폭(해당 없음 — 표면 UI 아님)을 매핑한다.

## 2026-08-26 두 저장소 wire 어휘 동기 (#497 후속)

> 계약: `docs/progress/issue-497-universal-agent.md` 의 "분리 이력과 wire 게이트 갭".
> 배경: 2026-06-10 교차개발 앵커 원칙이 경계를 `uc1-outbound-probe`·`uc1-variant-probe` 로
> 지키기로 했으나 두 probe 모두 옛 baseline(old-naia-os) 대조라 오늘 SKIP 된다. 그 사이
> 실제로 하나가 깨졌다(앱 컨텍스트 8주 유실, nextain/naia-agent#113).

### UC-WIRE-UNION-DRIFT — 한쪽이 wire 어휘를 바꾸면 즉시 드러난다

- 뇌가 새 메시지 종류를 내보내기 시작했는데 셸이 그것을 모르면, 사람이 눈으로 찾기 전에 테스트가 깨진다.
- 셸이 받아들이는 목록에서 종류를 빼거나 이름을 바꿔도 마찬가지다.
- 환경 세그먼트 종류도 같다. 한쪽이 kind 를 더하거나 이름을 바꾸면 양쪽이 깨진다.
- 상대 저장소가 옆에 없으면 건너뛰지 않고 실패한다. 건너뛴 게이트는 게이트가 아니다.
- 어휘 목록은 손으로 적은 표가 아니라 각 저장소의 실제 코드에서 나온다. 표와 코드가 어긋나도 깨진다.

Test Coverage Map (P02):

| UC | 검증 수단 | 대상 |
|---|---|---|
| UC-WIRE-UNION-DRIFT | vitest `src/test/wire-union-drift.contract.test.ts` | 셸 수용 목록이 표본과 일치, 뇌 송신이 셸 수용에 포함, 세그먼트 kind 일치, 상대 표본 대조 |
| UC-WIRE-UNION-DRIFT | vitest (naia-agent) `src/test/wire-union-drift.contract.test.ts` | 뇌 송신 목록이 소스에서 추출한 것과 일치, 표본과 일치, 상대 표본 대조 |

상태 매트릭스: 기본(양쪽 일치), 빈 목록(추출 결과 0 — 공허 통과 방지로 실패), 오류(불일치),
성공(대조 통과), 진행·좁은 폭(해당 없음 — UI 아님)을 매핑한다.

## 2026-08-26 #502 실배선 — 관측과 조작이 실제로 오간다

> 계약: `docs/progress/issue-497-universal-agent.md`.
> 배경: 계약·UC·FE·테스트와 Rust 명령 경계까지 있었으나 프로덕션 호출자가 0이었다.
> `observe`·`toEnvironmentSegment`·`EnvironmentDispatcher` 모두 테스트만 붙은 섬이었다.
> 배선하면서 손잡이 재사용 위험이 드러났다(아래 UC-ENV-STICKY).

### UC-ENV-LIVE-OBSERVE — 나이아가 지금 무엇이 돌고 있는지 스스로 안다

- 사용자가 "지금 뭐 돌고 있어?"라고 물으면, 나이아는 되묻지 않고 자기가 이미 받은 표면 목록으로 답한다.
- 표면 정보는 대화 요청에 실려 올라간다. 사용자가 도구를 부르라고 말하지 않아도 된다.
- Herdr 이 안 돌고 있으면 아무것도 올리지 않는다. 없는 것을 있는 척하지 않는다.
- 뇌가 보는 것은 불투명 손잡이와 네 가지 활동 상태뿐이다. pane 어휘는 올라가지 않는다.

### UC-ENV-LIVE-ACT — 나이아가 표면 하나를 실제로 건드린다

- 나이아가 "저 터미널을 앞으로 가져와" 또는 "저기서 이 명령을 실행해"를 스스로 결정해 실행한다.
- 실행은 셸이 판정한다. 뇌는 손잡이로만 말하고, 그것이 어느 pane 인지는 셸만 안다.
- 터미널 입력은 구조화 전달과 같은 권한으로 나가지 않는다. 사용자가 켜 두지 않았으면 거절된다.
- 환경이 거절하면 그대로 올라간다. 실패를 성공으로 바꾸지 않는다.

### UC-ENV-ATTENTION — 나이아가 환경을 볼지 말지 스스로 정한다

> 왜 이 UC 가 생겼는가: 배선하고 나서 값이 드러났다. 표면 목록을 요청마다 실으면 대화
> 한 번마다 토큰이 붙고, 사용자의 터미널 이름이 늘 뇌로 올라간다. 그런데 사용자의 작업
> 표면이 늘 필요한 정보는 아니다 — 대부분의 대화는 환경과 무관하다.

- 평소 나이아에게 가는 것은 "볼 것이 몇 개 있다"는 사실뿐이다. 이름도 손잡이도 가지 않는다.
- 자세히 알아야겠다고 판단하면 나이아가 스스로 지켜보기를 켠다. 그때부터 목록이 실린다.
- 사용자의 작업을 따라갈 일이 끝나면 나이아가 스스로 끈다. 사용자가 말해 줄 필요가 없다.
- 지켜본다고 조작 권한이 열리지는 않는다. 보는 것과 건드리는 것은 다른 문제다.
- 사용자가 원하면 아예 끄거나(도구도 등록되지 않는다) 늘 켜 둘 수 있다. 그 선택이 나이아를 이긴다.
- 볼 것이 하나도 없으면 개수도 보내지 않는다. "0개 있다"와 "모른다"를 뭉뚱그리지 않는다.
- 지켜보기를 켠 주체가 끄는 주체와 같아야 한다. 통화가 끝났다고 텍스트 대화에서 켠 것까지 지우지 않는다.
- 환경이 응답하지 않으면 지켜보기는 켜지지 않는다. 못 봤는데 볼 준비만 해 두는 상태를 만들지 않는다.
- 줄어든 양은 짐작이 아니라 측정으로 안다. 표면 12개 기준 표면 목록이 요청당 93.5%,
  40턴 총량 72.5%가 줄었다. 코어 세그먼트만이 아니라 실제로 나간 대화 요청에서도 잰다.
- 다만 이 기능은 도구 선언이라는 고정 비용(약 1420바이트)을 요청마다 새로 얹는다.
  그것까지 넣으면 절감은 42.6%다. 유리한 쪽 숫자만 말하지 않는다.
- 사용자가 도구 사용 자체를 꺼 두면 개수만 보내는 안내를 하지 않는다. 부를 수 없는 도구를
  가리키며 "필요하면 불러라"라고 말하지 않기 위해서다.
- 다만 사용자가 "늘 보내기"를 골라 두었으면 도구가 꺼져 있어도 목록은 그대로 간다.
  막아야 하는 것은 닫힌 길을 가리키는 안내이지 목록 자체가 아니다 — 목록만으로도
  나이아는 무엇이 돌고 있는지 말해 줄 수 있다. 사용자가 고른 것이 이긴다.
- 사용자가 "늘 켬"을 골라 둔 동안에는 지켜보기 예산이 흐르지 않는다. 되돌렸을 때 나이아가
  끈 적 없는 관찰이 사라져 있으면 안 된다.
- 뇌가 다시 켜져 도구 등록이 사라져도 다음 턴에 되돌아온다. 등록이 **실제로 닿았는지**까지
  확인하고, 닿지 않은 턴에는 표면을 아예 싣지 않는다 — 나이아에게 없는 도구를 부르라고
  안내하지 않는다. 확인이 안 와도 대화 자체는 막지 않는다 — 사용자의 말이 환경 때문에
  멈추지는 않는다. 그 대가로, 뇌가 방금 죽은 경우 한 턴 정도는 등록되어 있다고 믿는다.
- 사용자가 껐다가 다시 켜도 첫 턴부터 사실대로 움직인다. 껐을 때의 결과를 버리고 옛 상태를
  들고 있지 않는다. 끄는 데 실패했으면 조용히 두지 않고 다음 대화 때 한 번 더 끈다.
- 나이아가 필요를 스스로 판단하는지는 이 시나리오가 증명하지 않는다 — UC-ENV-ATTENTION-POLICY 가 그 자리를 따로 든다.
- 나이아가 보는 것은 지금 상태다. 앱을 켠 시점의 목록으로 "지금 뭐 돌고 있어"에 답하지 않는다.
- 작업 표면 환경이 응답하지 않게 되면 나이아는 모르는 상태로 돌아간다. 마지막으로 본 목록을
  계속 들고 있지 않는다 — 이미 닫힌 터미널 이름을 계속 말하거나, 죽은 손잡이에 명령을 넣지 않는다.
- 지켜보기는 켜 둔 채 잊히지 않는다. 일정 턴이 지나면 저절로 풀리고, 더 봐야 하면 나이아가 다시 켠다.
- 나이아는 "지금은 안 보여 주는 것"과 "상한 때문에 못 본 것"을 구별해서 안다. 앞의 것은 스스로 걷을 수 있다.
- 실시간 음성으로 이야기하는 동안에도 같은 규칙이 흐른다. 음성 턴도 지켜보기 예산을 쓰고,
  사용자가 끼어들어 중단된 턴도 마찬가지다. 통화가 끊기면 지켜보기도 끝난다.
- 다만 음성 요청에는 표면 목록이 실리지 않는다. 그래서 음성에서 지켜보기를 켜면 나이아는
  "이 경로는 요청마다 목록을 싣지 않는다"는 사실을 함께 듣는다 — 못 하는 것을 한다고 말하지 않는다.
- 다만 실시간 음성 세션은 연결 시점의 도구 목록을 쓴다. 통화 중에 사용자가 인지를 끄면
  선언은 그 세션에 남고 실행만 거절된다. 선언까지 걷으려면 통화를 다시 걸어야 한다.

### UC-ENV-ATTENTION-POLICY — 나이아가 필요를 스스로 판단한다

> 2026-08-27 11차 적대리뷰가 짚은 자리다. UC-ENV-ATTENTION 이 증명하는 것은 "도구를
> 부르면 켜지고 꺼진다"이지 "나이아가 부를 때를 스스로 안다"가 아니다. 지금까지의 테스트는
> 전부 watch·unwatch 인자를 미리 정해 넣는다 — 배선을 재는 것이지 판단을 재는 것이 아니다.
> 등급 이름 하나로 두 가지를 뭉뚱그리지 않기 위해 따로 선언한다.

- 환경과 무관한 대화에서는 표면을 들여다보지 않는다.
- 사용자의 작업을 따라가야 하는 대화에서는 스스로 `observe` 나 `watch` 를 부른다.
- 따라갈 일이 끝나면 스스로 `unwatch` 한다. 예산이 저절로 풀어 주기를 기다리지 않는다.

증명하려면 실제 모델을 여러 대화 상황에 놓고 선택을 재야 한다. 그것은 자격증명과 비용이
드는 일이라 사람 결정이다. 그때까지 이 시나리오는 미검증으로 남고, 벤치 게이트도
빨간불로 남는다 — 초록불로 만드는 것은 작성자 몫이 아니다.

### UC-ENV-STICKY — 손잡이가 다른 표면을 가리키지 않는다

- 나이아가 표면 목록을 본 뒤 그중 하나에 명령을 넣기까지 시간이 흐른다. 그 사이 터미널이 닫힐 수 있다.
- 닫힌 표면의 손잡이는 **무효**가 되어야 한다. 다른 표면에 재배정되면 나이아가 엉뚱한 터미널에 명령을 넣는다.
- 손잡이는 표면이 살아 있는 동안 같은 값을 유지한다. 목록에서의 순서가 바뀌어도 바뀌지 않는다.

Test Coverage Map (P02):

| UC | 검증 수단 | 대상 |
|---|---|---|
| UC-ENV-LIVE-OBSERVE | vitest `src/test/environment-live-wiring.contract.test.ts` | 스냅샷→세그먼트 조립, Herdr 부재 시 미전송, 손잡이만 상승 |
| UC-ENV-LIVE-OBSERVE | vitest `packages/shell/src/lib/__tests__/environment-skill.test.ts` | 도구 호출이 실제 스냅샷 경로를 탄다, 빈 결과 공허 통과 차단 |
| UC-ENV-LIVE-ACT | vitest `packages/shell/src/lib/__tests__/environment-skill.test.ts` | focus/run/interrupt 전달, 권한 없을 때 거절, 환경 오류 그대로 상승 |
| UC-ENV-LIVE-ACT | e2e-tauri `packages/shell/e2e-tauri/specs/environment-dispatch.spec.ts` | 실 Rust 명령 경계 |
| UC-ENV-STICKY | vitest `src/test/environment-live-wiring.contract.test.ts` | 표면 사라져도 재배정 없음, 순서 바뀌어도 손잡이 불변, 죽은 손잡이는 거절 |
| UC-ENV-ATTENTION | vitest `src/test/environment-live-wiring.contract.test.ts` | 기본 미관찰, 미관찰 중 이름·손잡이 미전송, 개수는 상한 포함, off/always 우선 |
| UC-ENV-ATTENTION | vitest `packages/shell/src/lib/__tests__/environment-skill.test.ts` | watch/unwatch 실행, watch 가 목록 동반, off 전면 거절, always 에서 나이아 무력 |
| UC-ENV-ATTENTION | Playwright `packages/shell/e2e/environment-skill.spec.ts` | 실 UI 에서 기본 개수만 전송, watch 후 목록 전송, unwatch 복귀, off 시 도구 미등록, 매 턴 관측 갱신 |
| UC-ENV-ATTENTION | vitest `src/test/environment-live-herdr.contract.test.ts` | 살아 있는 Herdr 의 실제 터미널 이름·손잡이가 미관찰 중 전송되지 않음 |
| UC-ENV-ATTENTION | Playwright `packages/shell/e2e/env-attention-voice.spec.ts` | 실시간 음성 턴도 예산을 소비, 음성 중 off 전환 시 거절 |
| UC-ENV-ATTENTION | e2e-tauri `packages/shell/e2e-tauri/specs/environment-dispatch.spec.ts` | 실 Rust — 뇌가 없을 때 등록이 "확인됨"으로 새지 않음(fail-closed 방향만) |

> 받는 쪽(naia-agent) 검증은 그 저장소의 `src/test/uc-environment-segments.contract.test.ts`
> 가 소유한다. 이 저장소에서 실행할 수 없으므로 위 표에 넣지 않는다 — 넣으면 벤치가
> 실행하지 못하는 경로를 문서 부패로 읽는다. 두 저장소의 표본 동기는
> `environment-wire-conformance.contract.test.ts` 가 짝 저장소 대조로 지킨다.

상태 매트릭스: 기본(표면 여럿), 빈 목록(Herdr 무응답), 오류(환경 거절), 성공(전달됨),
진행(스냅샷 대기), 좁은 폭(해당 없음 — 이 슬라이스는 UI 표면을 새로 만들지 않는다).
주의 상태는 별도 축이다: 미관찰(개수만) / 관찰(목록) / 사용자 off(아무것도 없음) /
사용자 always(나이아 무력) / 볼 것 없음(세그먼트 자체 없음) / 관측 끊김(모르는 상태로 복귀) /
예산 소진(저절로 풀림).

### UC-ORCHESTRATION-CODING-PROVIDER — 실제 코딩 모델 작업자가 돈다

> 2026-08-27 적대리뷰가 짚은 자리다. 다른 오케스트레이션 시나리오는 `shell` 제공자로
> 도는 실제 프로세스로 확인했다. 코딩 모델 제공자(codex·claude·opencode)를 실제로 띄워
> 확인한 적은 없다. 등급 이름 하나로 두 가지를 뭉뚱그리지 않기 위해 따로 선언한다.

- 나이아가 `codex`·`claude`·`opencode` 제공자로 작업자를 실제로 띄우고, 그 작업자가 격리된
  워크트리에서 일하고, 산출물과 종료 상태가 돌아온다.
- 자격증명과 비용이 실제로 소모되는 경로이므로 사람이 켜야 한다.
- 확인 수단이 생기기 전까지 이 시나리오는 증명되지 않은 것으로 남는다.

Test Coverage Map (P02):

| UC | 검증 수단 | 대상 |
|---|---|---|
| UC-ORCHESTRATION-CODING-PROVIDER | (아직 없음 — 실제 코딩 모델 제공자를 띄우는 확인 수단이 필요하다) | — |

### UC-V023-MEMORY-PAIRING — 설치본이 검증된 최신 기억 엔진을 재현한다 (#534)

- 같은 shell/agent 커밋으로 빌드하면 어느 개발 머신과 CI에서도 같은 naia-memory가 포함된다.
- memory checkout의 HEAD가 다르거나 수정 파일이 있거나 package 이름·버전이 다르면 설치본을 만들기 전에 실패한다.
- 최신 검증본의 제한된 다국어 correction/deletion 진단 표본에서 한국어 현재 사실 회상은 20/24에서 24/24로 +4건(+16.7%p, 상대 +20%) 개선됐다. 현재 사실 회상은 영어·일본어·한국어 모두 24/24이고 stale/deleted 노출은 언어별 각각 0/12다. 이는 해당 진단 workload 결과이며 보편적 성능 우위를 뜻하지 않는다.

Test Coverage Map (P02):

| UC | 검증 수단 | 대상 |
|---|---|---|
| UC-V023-MEMORY-PAIRING | vitest `src/test/agent-pairing-drift.contract.test.ts` | manifest 형식, CI checkout SHA, staging commit·clean·package gate 결선 |
| UC-V023-MEMORY-PAIRING | vitest `packages/shell/scripts/__tests__/platform-matrix.test.ts` | installer workflow의 agent·memory 정확한 revision checkout |

### UC-PERF-BUNDLE-BUDGET — 선택 기능은 필요할 때 내려받는다 (#431)

- 사용자가 일반 대화나 편집기를 열 때 Mermaid 렌더러와 그 전이 의존성은 초기 진입 JS에 포함되지 않는다.
- 워크스페이스가 백그라운드에서 살아 있어도 파일 편집기와 CodeMirror/PDF 의존성은 파일을 실제로 열기 전까지 내려받지 않는다.
- Mermaid 코드 블록을 실제로 열면 렌더러를 한 번 초기화해 기존과 같은 strict 설정으로 SVG를 만들고 정화한 뒤 표시한다.
- 렌더러 로드나 문법 해석이 실패하면 기존처럼 원문과 오류 상태를 표시한다.
- 이미 설정을 마친 사용자의 초기 진입에서는 온보딩 wizard를 내려받지 않으며, 신규 사용자가 온보딩에 진입할 때만 별도 청크를 불러온다. 청크 로딩 중에는 진행 상태를, 실패 시에는 셸을 재시작하지 않는 재시도 동작을 제공한다.
- ChatArea와 음성·STT/TTS 전이 의존성은 초기 진입 파일과 분리한다. ChatArea가 마운트되면 별도 청크를 요청한다. 로딩 중 도착한 슬라이드 나레이션 요청은 채팅 가시성과 무관하게 eager 경량 버퍼가 보존해 마운트 직후 전달하며, 표면이 해제되면 cancelled 결과로, 청크 로드가 실패하면 failed 결과로 정산한다. 상관된 실패·취소 결과를 받은 프레젠터는 speaking에서 재개 가능한 paused 상태로 전이한다. 로딩·오류 상태는 해당 영역에 표시하되, 운영 청크 실패의 재시도는 동일 URL import 캐시의 한계 때문에 셸을 재로드한다.
- CI는 초기 진입 JS의 raw/gzip 크기와 전체 배포 디렉터리 크기를 재고, 예산을 넘으면 실패하면서 기계 판독 가능한 보고서를 남긴다.
- #431 최종 후보 측정에서 초기 진입 파일은 raw 2,913,442→439,810바이트, gzip 836,096→138,469바이트로 감소했다. 빌드 시각이 엔트리에 포함되어 gzip 값은 수 바이트 변동할 수 있다. 이 값은 파싱·평가 대상 엔트리 파일의 크기이며, 즉시 마운트되는 ChatArea 청크까지 포함한 초기 총 전송량 지표로 해석하지 않는다.

Test Coverage Map (P02):

| UC | 검증 수단 | 대상 |
|---|---|---|
| UC-PERF-BUNDLE-BUDGET | vitest `packages/shell/src/components/__tests__/MarkdownCodeBlock.test.tsx` | 지연 로드 뒤 단일 초기화·렌더링·오류 fallback |
| UC-PERF-BUNDLE-BUDGET | vitest `packages/shell/src/apps/workspace/__tests__/herdr-workspace.test.tsx` | 지연 편집기 경계를 포함한 워크스페이스 터미널·파일 열기 동작 |
| UC-PERF-BUNDLE-BUDGET | vitest `packages/shell/src/components/__tests__/DeferredOnboardingWizard.test.tsx` | 온보딩 청크 로딩·완료 전달·오류 후 국소 재시도 |
| UC-PERF-BUNDLE-BUDGET | vitest `packages/shell/src/components/__tests__/DeferredChatArea.test.tsx`, `packages/shell/src/apps/__tests__/slides-center-area.test.tsx`, `packages/shell/src/lib/__tests__/slide-presenter.test.ts` | ChatArea 청크 로딩·오류 격리·StrictMode 1회 전달·숨김 상태 버퍼 보존·실제 소비 경로 전달·언마운트 취소 정산·청크 실패 정산·발표자 paused 복구 |
| UC-PERF-BUNDLE-BUDGET | Playwright `packages/shell/e2e/205-onboarding-avatar-grid.spec.ts`, production-preview `packages/shell/e2e/deferred-chat-area.spec.ts` | 실제 초기 진입에서 지연 로드된 wizard와 Chat 로딩 상태가 표시된다. Chat은 빌드된 `dist`와 manifest가 지정한 해시 청크를 직접 지연·실패시켜 접근 가능한 재시도에서 셸 재로드 후 복구하며, 협폭에서도 주변 셸과 Chat이 유지됨을 검증한다. |
| UC-PERF-BUNDLE-BUDGET | vitest `packages/shell/scripts/__tests__/check-bundle-budget.test.mjs` | 진입점 탐색, raw/gzip/전체 크기, 동적 import 도달성, orphan 청크 거부, 예산 초과 fail-closed, JSON 보고서 |
| UC-PERF-BUNDLE-BUDGET | production build + CI artifact | 초기 번들에서 Mermaid·ChatArea 분리, 강화된 예산 및 보고서 보존 |

Chat 지연 로드 UI 상태 매트릭스: **기본**은 variant를 지정하지 않은 지연 경계가 기본 Chat 표면을 렌더링하는 상태, **빈 상태**는 대화 기록이 없어 `.chat-message`가 0개인 실제 ChatArea, **진행**은 `aria-live` 로딩 출력, **성공**은 로드된 Chat 입력, **오류**는 `alert`와 접근 가능한 재시도 버튼, **좁은 폭**은 480×800에서 주변 AppBar와 Chat을 유지하고 수평 overflow가 없는 상태로 검증한다. `DeferredChatArea.test.tsx`가 기본 variant·진행·성공·오류 및 재시도 분기를 고정한다. production-preview `deferred-chat-area.spec.ts`는 빌드된 청크에서 빈 대화 상태와 주변 셸, 진행→성공, 오류 버튼의 키보드 초점→재로드→복구 및 좁은 폭 레이아웃을 검증한다.


> **S-APP-SANDBOX / S-BGM-LIB / S-APP-OPEN-GRANT / S-SLIDES-REC / S-I18N-COMPLETE (2026-09-05, #528 #543 #546 — bgm-wip 통합 완성)**
> - **S-APP-SANDBOX**: 앱(BGM 위젯·슬라이드)이 자기 파일을 저장·복원할 때 사용자의 다른 파일이나 워크스페이스 밖을 건드리지 못한다. 경로는 항상 `<adkPath>/data-private/apps/<appId>/` 안으로 강제된다(상대경로·탈출 차단). FR-APP-SANDBOX.1.
> - **S-BGM-LIB**: 사용자가 곡을 즐겨찾기하거나 이름 있는 재생목록을 만들고 순서를 바꾸고 셔플·반복을 켜면, 그 상태가 앱 샌드박스 라이브러리에 저장되어 재시작·워크스페이스 전환 후에도 남고 음성 스킬(라디오 DJ)이 같은 SoT 를 읽는다. FR-BGM-LIB.1. (UC8 "음악 틀어줘" 의 라이브러리 확장.)
> - **S-APP-OPEN-GRANT**: 사용자가 워크스페이스 밖 파일을 드래그드롭하거나 CLI 로 열면 그 파일만 이 세션에서 열람·쓰기가 허용된다(열림=동의). FR-APP-OPEN-GRANT.1.
> - **S-SLIDES-REC**: 사용자가 슬라이드 발표를 녹화하면 MP4 가 앱 샌드박스 video 폴더에 남고, 이미 녹화 중이면 새 녹화를 거부한다. FR-SLIDES-REC.1. **전제: 슬라이드는 번들 앱이 아니라 naia.land 앱스토어에서 받아 설치하는 앱이다.** 설치 전에는 앱바에 슬라이드 버튼이 없는 것이 정상이며(갓 설치한 셸의 앱바는 데스크톱·브라우저·워크스페이스 셋뿐이다), 이 시나리오는 설치를 마친 뒤부터 성립한다. 설치 경로는 앱바 `+` → 앱스토어(시스템 브라우저로 `naia.land/<locale>/apps`) → 딥링크 `naia://app-install` 또는 Git/ZIP 창 → `~/.naia/apps/<appId>/` → `app_list_installed` → 앱바 버튼이다. 이 전제가 적혀 있지 않아, 실기 탐색에서 앱바에 슬라이드가 없는 것을 결함으로 읽은 일이 있다(2026-09-06 win-rtx4060·naia-os-3090).
> - **S-I18N-COMPLETE**: 사용자가 어느 언어로 쓰든 플레이리스트 탭·새 재생목록·셔플/반복·장르(K-Pop/시티팝)·슬라이드 컨트롤 라벨이 그 언어로 보인다(빈 라벨 없음). FR-I18N-COMPLETE.1.

| S-ID | 기능 | 근거 UC | 검증 |
|------|------|---------|------|
| S-APP-SANDBOX | 앱 샌드박스 경로 강제 | UC9 앱 | app_sandbox.rs 단위·cargo |
| S-BGM-LIB | BGM 라이브러리 SoT(#528) | UC8 확장 | bgm-library(-store).test.ts·BgmPlayer.test.tsx |
| S-APP-OPEN-GRANT | 열림=동의 grant(#543) | UC9 앱 | workspace.rs 단위 |
| S-SLIDES-REC | 슬라이드 MP4 녹화(#546) | UC9 앱 | app_sandbox.rs 상태머신 · 설치 전제는 e2e/467-slide-presenter.spec.ts(설치 매니페스트·`naia://app-install` 창) |
| S-I18N-COMPLETE | t() 키 14개 언어 완비 | 전 UC | check-compile-integrity·i18n-user-facing.test.ts(로케일 파일이 정본, #559) |


## 2026-09-05 시작 지연 한도 (#549)

### UC-PERF-STARTUP-LATENCY

- 셸을 열면 첫 화면이 한도 안에 뜬다. 번들 크기가 늘지 않아도 초기화가 느려질
  수 있으므로, 크기와 별개로 시간에 한도를 건다.
- 러너 성능은 실행마다 흔들리므로 세 번 재서 중앙값으로 판정한다. 한 번의
  튐으로 붉어지면 사람이 곧 테스트를 꺼 버린다.
- 한도를 넘으면 실패한다. 측정값을 기록만 하는 것은 아무것도 막지 못한다.

Test Coverage Map

| UC | 단위·계약 | 실기 | 비고 |
|---|---|---|---|
| UC-PERF-STARTUP-LATENCY | — | `e2e/900-startup-latency.spec.ts`: 셸이 스스로 준비됐다고 말하는 시점(`data-app-ready`)까지 벽시계 시간을 재되 콜드(첫 표본)와 웜(이후 다섯 표본의 중앙값)을 따로 판정 | 한도 콜드 2,000ms · 웜 500ms. 이 기계 실측은 콜드 733~912ms, 웜 중앙값 123~166ms. 설정 읽기에 1.5초를 넣으면 웜 중앙값이 1,988ms 로 올라 실제로 붉어진다. 화면 요소가 그려진 순간을 재던 때는 같은 주입에 숫자가 움직이지 않았다 |


## 2026-09-05 품질 축 — 사용자에게 보이는 문구 (#549)

### UC-QUALITY-I18N-USER-FACING

- 사용자에게 보이는 문구는 화면에 박히지 않고 i18n 을 지난다. 로케일을 바꾸면
  같은 자리에서 다른 말이 나와야 한다.
- 로케일 열넷이 같은 키 집합을 갖는다. 한 언어만 키가 빠지면 그 언어 사용자는
  그 자리에서 아무 말도 듣지 못한다.
- 사용자가 막혔을 때 다음에 무엇을 하라고 말하는 문구는 키로 존재한다.
- 이 UC 는 사용성 축의 첫 자리다. 화면이 아름다운지는 재지 않는다 — "어떤
  언어에서는 아무 말도 안 나온다" 는 부류의 실패를 잡는다.

Test Coverage Map

| UC | 단위·계약 | 비고 |
|---|---|---|
| UC-QUALITY-I18N-USER-FACING | `src/lib/__tests__/i18n-user-facing.test.ts`: 로케일 전환 시 문구 변화 / 키 집합 일치 / 실패·복구 문구의 키 존재 | 화면에 박힌 한국어를 줄이는 일은 `scripts/check-untranslated-ui.mjs` 가 늘지 않게 막는다 |


### UC-QUALITY-DESTRUCTIVE-AFFORDANCE

- 되돌릴 수 없는 동작은 실행 전에 사용자에게 묻는다. 묻지 않는다면 되돌릴 수
  있어야 한다.
- 파괴의 무게와 방어의 무게가 같은 방향이어야 한다. 이 UC 를 세울 때 실제로
  그 반대였다 — 대화 세션 삭제(되돌릴 수 있는 기록)에는 확인이 있었고, 설치된
  앱을 디스크에서 지우는 두 경로(되돌릴 수 없음)에는 확인도 되돌리기도 없었다.
- 확인 문구는 무엇이 사라지는지와 되돌릴 수 없다는 사실을 말한다. "삭제할까요?"
  만으로는 사용자가 무게를 알 수 없다.
- 되돌릴 수 있는 동작에까지 확인을 걸지는 않는다. 빌드 내장 앱 숨기기는 설정에
  기록만 하므로 묻지 않는다 — 모든 것에 물으면 사용자는 읽지 않고 누른다.

Test Coverage Map

| UC | 단위·계약 | 비고 |
|---|---|---|
| UC-QUALITY-DESTRUCTIVE-AFFORDANCE | `scripts/check-destructive-affordance.mjs`: 파괴적 Tauri 명령을 부르는 자리마다 감싼 함수 안에 확인 또는 되돌리기가 있는지 | 확인을 지우면 실제로 붉어지는 것을 확인했다. 문구가 좋은지와 되돌리기가 실제로 동작하는지는 정적으로 못 재므로 이 게이트가 말하지 않는다 |

## 2026-09-05 품질 축 — 안정성 (#549)

### UC-QUALITY-STABILITY-DEPENDENCY-DOWN

- 의존이 죽었을 때 화면은 무슨 일이 일어났는지와 **다음에 무엇을 할 수 있는지**를
  함께 보여준다. 실패만 알리고 끝나면 사용자가 할 수 있는 일은 앱을 껐다 켜는
  것뿐이다.
- 특히 실패가 화면을 통째로 대신하는 자리(지연 로딩이 깨진 화면, 엔진이 꺼진
  화면)에서는 원래 화면의 버튼도 함께 사라지므로, 그 자리에 빠져나갈 수단이
  반드시 있어야 한다.
- 호스트 음성 엔진이 꺼져 있을 때는 그 사실을 말하고 그 자리에서 켤 수 있게
  한다. 조용히 다른 음성으로 대신 말하지 않는다 — 사용자는 다른 목소리가
  나오는 이유를 알 수 없다.

Test Coverage Map

| UC | 단위·계약 | 비고 |
|---|---|---|
| UC-QUALITY-STABILITY-DEPENDENCY-DOWN | `scripts/check-recovery-affordance.mjs`: 실패가 화면을 통째로 대신하는 자리마다 복구 수단이 있는지 / `src/components/__tests__/RefAudioSection.test.tsx`(FR-VOICE.14): 엔진이 꺼져 있으면 그 상태와 시작 동작을 그 자리에 보여준다 | 복구 버튼을 지우면 게이트가 실제로 붉어지는 것을 확인했다. 그 행동이 정말 복구시키는지는 정적으로 못 재므로 게이트가 말하지 않는다 |

### UC-QUALITY-STABILITY-CONCURRENCY

- 같은 자산을 동시에 만져도 데이터가 찢어지지 않는다. 쓰는 도중에 읽은 쪽이
  반쪽짜리를 보면 안 된다.
- 앱마다 제 구역 안에서만 쓴다. 동시에 써도 서로의 구역으로 새지 않는다.
- 이 UC 를 세울 때 실제로 그 결함이 있었다. 앞선 동시성 테스트는 스레드마다
  다른 파일을 써서 아무것도 경합하지 않았고, 한 파일을 두고 다투게 고치자
  곧바로 깨졌다 — 자르고 나서 쓰는 사이에 빈 내용이 읽혔다.

Test Coverage Map

| UC | 단위·계약 | 비고 |
|---|---|---|
| UC-QUALITY-STABILITY-CONCURRENCY | `packages/shell/src-tauri/src/app_sandbox.rs`: 여덟 스레드가 한 파일을 두고 다투는 동안 읽는 스레드 둘이 반쪽짜리를 보는지 감시 | 원자적 쓰기를 비원자적으로 되돌리면 스무 번 중 스무 번 잡는다. 처음에는 쓰는 내용이 한 글자라 절반만 잡았다 |
