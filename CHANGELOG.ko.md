# 변경 이력

Naia OS의 주요 변경 사항을 기록합니다.
원본 데이터: [`releases/v*.yaml`](releases/)

> 이 저장소는 2026-06 post-OpenClaw 아키텍처 재작성으로 새로 시작했습니다. 재작성 이전(구 아키텍처)의 전체 소스와 상세 커밋 이력은 [`backup/main-2026-06-22`](https://github.com/nextain/naia-os/tree/backup/main-2026-06-22) 브랜치에 보존돼 있습니다.

[English](CHANGELOG.md)

---

## v0.1.5 (2026-06-05)

RTX 3090 PC에서 목소리 복제와 실시간 대화, 스킬까지 가능한 똑똑한 AI — Naia-0.9-Omni-24g 출시. 음성 대화 중 도구 실행, 녹음·미리듣기를 갖춘 음성 복제 UI 재설계, 자연스러운 끼어들기, 30개국어, 네이티브 Ollama 로컬 AI, MS Store·Steam 배포.

음성 (naia-omni):

- **feat(voice)**: naia-0.9-omni-24g가 음성 대화 중 도구를 실행 — 말로 시키면 파일 생성·검색·스킬 실행까지 실제로 수행 (대화만 하지 않음) ([#352](https://github.com/nextain/naia-os/issues/352))
- **feat(voice)**: 레퍼런스 음성(음성 복제) 설정 재설계 — 카드 UI, 앱 내 녹음, 즉시 미리듣기 ([#349](https://github.com/nextain/naia-os/issues/349))
- **feat(voice)**: 음성 답변의 운율 태그를 아바타 표정·채팅 이모지로 매핑 — 말하는 동안 아바타가 반응 ([#350](https://github.com/nextain/naia-os/issues/350))
- **feat(voice)**: Gemini Live 음성 경험 — 컨텍스트 브릿지, 끼어들기(말하는 도중 중단), 텍스트·음성 동등, 음성 패널 도구 ([#313](https://github.com/nextain/naia-os/issues/313))
- **feat(voice)**: Naia Local 레퍼런스 음성 — 직접 ref-audio 지정, 기본 음성 선택, 세션 중 음성 전환
- **fix(voice)**: 실시간 음성 안정화 — 서버 VAD passthrough, 자막(transcript) 처리, 콜드스타트 소켓 경쟁, 레퍼런스 음성 인증 수정 ([#219](https://github.com/nextain/naia-os/issues/219))

로컬 AI:

- **feat(agent)**: 네이티브 Ollama 프로바이더 — 추론, 도구 호출, num_ctx 처리로 완전 로컬 LLM 지원 ([#357](https://github.com/nextain/naia-os/issues/357))

배포:

- **feat(dist)**: MS Store(Win32) 및 Steam 포터블 배포 — 조건부 코드 서명 지원 ([#314](https://github.com/nextain/naia-os/issues/314))

셸 & UX:

- **feat(shell)**: 확장형 패널 시스템 스펙·문서·예제 + zip 탭 게이트 ([#358](https://github.com/nextain/naia-os/issues/358))
- **feat(launch)**: 실행 시 YouTube BGM 배경 fallback — AI 연결 전에도 음악이 이어짐

인증:

- **feat(auth)**: Rust localhost HTTP 콜백 서버 — 데스크탑 OAuth·딥링크 로그인 안정성 향상 ([#341](https://github.com/nextain/naia-os/issues/341))

적대적 리뷰 배치 — 5건 P0-critical 보안 + 1건 P0-UX + 1건 P1 gateway 라우팅, 후속 아키텍처 문서 정비.

보안 hardening (2026-05-12):

- **fix(agent)**: `handleToolRequest` 가 `executeTool` 전에 `needsApproval` 게이트 — 패널/shell 직접 도구 호출 경로의 tier 검사 우회 차단 ([#256](https://github.com/nextain/naia-os/issues/256))
- **fix(agent)**: `panel_install` 이 non-HTTPS 소스 거부 — `file://` / `http://` / `git@` / `data:` / `javascript:` / bare local path 모두 spawn 전 거부 ([#257](https://github.com/nextain/naia-os/issues/257))
- **fix(shell)**: `assetProtocol.scope` 를 `FsScope` 객체로 재작성 — bare `**`, drive-root, bare `/tmp/**` 제거; `requireLiteralLeadingDot: true` 가 `~/.ssh` / `~/.gnupg` / `~/.aws` 차단 ([#258](https://github.com/nextain/naia-os/issues/258))
- **fix(shell)**: CSP `connect-src` 에서 `https://discord.com` 제거 — 모든 Discord API 는 Rust `invoke('discord_api', ...)` 경유 ([#259](https://github.com/nextain/naia-os/issues/259))
- **fix(agent/shell)**: webhook URL 을 per-request stdio 에서 분리 — 새 `notify_config` one-shot 메시지 ([#260](https://github.com/nextain/naia-os/issues/260))
- **fix(shell)**: `copy_bundled_assets` 에서 `asset_protocol_scope.allow_directory` 런타임 확장 — `$HOME` / `/var/home/*/naia-adk/**` 밖의 ADK workspace (예: `/mnt/external`, `/opt/custom`, `D:\custom\naia`) 도 `asset://` URL 로 VRM / BGM / 배경 서빙. `protocol-asset` Cargo feature + `assetProtocol.enable: true` 필요 ([#277](https://github.com/nextain/naia-os/issues/277))
- **fix(agent/shell)**: `provider.apiKey` 를 one-shot `creds_update` 메시지로 이동 — `auth_update` + `notify_config` 와 동일 패턴. Agent 가 provider별 캐싱; `buildProvider` resolution: cache → per-request fallback → envVar. `ChatRequest.provider.apiKey` 는 마이그레이션 윈도우 동안 하위호환 유지. (#260 follow-up)
- **fix(agent/shell)**: `creds_update` 에 `ttsKeys` (TTS provider별) + `gatewayToken` 추가. `SendChatOptions` 가 `ttsApiKey` / `gatewayToken` 받지 않음; `directToolCall` opts 가 `gatewayToken` 받지 않음 — 컴파일 단계에서 자격증명이 per-request frame 에 절대 안 들어가도록 강제. 모든 shell callsite 정리 (ChatPanel / SettingsTab / AgentsTab / SkillsTab / DiagnosticsTab / discord-relay). (#260 follow-up)

버그:

- **fix(shell)**: 0.1.5 런치 버그픽스 — 시작, 설정, 프로바이더 라우팅 보정 ([#342](https://github.com/nextain/naia-os/issues/342))
- **fix(env)**: dev/prod 게이트웨이 환경 분리 — `tauri:dev`·`tauri:prod`가 올바른 게이트웨이로 연결 ([#333](https://github.com/nextain/naia-os/issues/333))
- **fix(agent/shell)**: Naia gateway 가 Vertex AI gemini-3.x 접근 권한 없음 — picker 에서 제거, fallback fix, 0-byte SSE 에러 정확화, 저장된 config 자동 마이그레이션 ([#248](https://github.com/nextain/naia-os/issues/248))
- **fix(shell)**: startup white flash + onboarding splash deadlock 해소 ([#254](https://github.com/nextain/naia-os/issues/254))

문서:

- **docs(context)**: `#271` Phase 2 — post-OpenClaw 아키텍처 문서 재작성, `current_runtime` 섹션 추가 ([#271](https://github.com/nextain/naia-os/issues/271))
- **docs(bridges)**: `agent-bridges.yaml/md` 에 `notify_flow` + `security_hardening` 섹션 추가
- **test(e2e)**: 통합 검증 스펙 — Playwright + Tauri IPC mock 으로 shell↔agent↔skill 등록 wire 검증 (5/5 pass)

## v0.1.4 (2026-04-04)

Alpha Memory System v1, 지식 그래프, 메모리 벤치마크

- **feat(agent)**: Alpha Memory System v1 — 4-스토어 아키텍처 (에피소드/의미/절차/작업기억) + Ebbinghaus 망각 곡선, Hebbian 연상, 통합(consolidation) 파이프라인 ([#145](https://github.com/nextain/naia-os/issues/145))
- **feat(agent)**: 지식 그래프(Knowledge Graph) 통합 — TF-IDF 인덱싱, Louvain 커뮤니티 탐지, 중심성 점수 ([#173](https://github.com/nextain/naia-os/issues/173))
- **feat(agent)**: 메모리 시스템 와이어링 — encode/recall/sessionRecall을 에이전트 대화 루프에 통합 ([#150](https://github.com/nextain/naia-os/issues/150))
- **feat(shell)**: 메모리 관리 UI — 설정 탭에서 팩트 목록 보기/삭제/전체 초기화 ([#174](https://github.com/nextain/naia-os/issues/174))
- **feat(agent)**: mem0 어댑터 — 로컬 JSON 대신 선택적으로 사용 가능한 클라우드 백엔드(mem0.ai) ([#148](https://github.com/nextain/naia-os/issues/148))
- **feat(agent)**: 임베딩 지원 — 메모리 recall을 위한 로컬/API 기반 벡터 유사도 검색 ([#149](https://github.com/nextain/naia-os/issues/149))
- **fix(agent)**: sessionRecall이 팩트와 함께 항상 에피소드도 반환하도록 수정 ([#151](https://github.com/nextain/naia-os/issues/151))
- **fix(agent)**: 빠른 팩트 추출을 위해 통합(consolidation) 임계값을 1시간에서 5분으로 단축 ([#151](https://github.com/nextain/naia-os/issues/151))

## v0.1.3 (2026-03-23)

워크스페이스 패널, 브라우저 패널, PTY 터미널, 프로바이더 레지스트리, 인스톨러 개선

- **feat(shell)**: 워크스페이스 패널 — 세션 대시보드, 파일 탐색기, 코드 에디터 ([#99](https://github.com/nextain/naia-os/issues/99))
- **feat(workspace)**: xterm.js 기반 PTY 터미널 탭 ([#119](https://github.com/nextain/naia-os/issues/119))
- **feat(workspace)**: 이미지·CSV·로그 파일 뷰어 및 채팅 딥링크 ([#116](https://github.com/nextain/naia-os/issues/116))
- **feat(workspace)**: 세션 대시보드 git 워크트리 그룹핑 ([#121](https://github.com/nextain/naia-os/issues/121))
- **feat(shell)**: 브라우저 패널 — Chrome X11 임베드, CDP 툴, 음성 툴, 테마 지원 ([#95](https://github.com/nextain/naia-os/issues/95))
- **feat(panels)**: 패널 통신을 위한 iframe 브릿지 및 NaiaContextBridge 확장 ([#122](https://github.com/nextain/naia-os/issues/122))
- **feat(shell)**: Panel API — panelRegistry를 통한 프로그래매틱 인터페이스 ([#118](https://github.com/nextain/naia-os/issues/118))
- **feat(shell)**: 설치된 패널 동적 iframe 렌더링 ([#89](https://github.com/nextain/naia-os/issues/89))
- **feat(shell)**: STT/TTS 프로바이더 레지스트리 (Web Speech API, Browser TTS 지원) ([#51](https://github.com/nextain/naia-os/issues/51))
- **feat(shell)**: vLLM STT/TTS 프로바이더 + STT 모델 선택기 + 오디오 장치 설정 ([#79](https://github.com/nextain/naia-os/issues/79))
- **feat(shell)**: 마이크 테스트 포함 오디오 입출력 장치 선택 ([#81](https://github.com/nextain/naia-os/issues/81))
- **fix(installer)**: GRUB USB 부팅 수정 — insmod iso9660 추가로 부팅 메뉴 미표시 해결
- **fix(browser)**: 브라우저 패널 keepAlive, 모달 타이밍, 툴바 오버플로우 수정 ([#102](https://github.com/nextain/naia-os/issues/102))

## v0.1.2 (2026-03-10)

인앱 자동 업데이트, 음성 프로바이더 리팩토링, 스킬/음성 버그 수정, CI 품질 게이트 및 OS 개선

- **feat(shell)**: 배너 알림 및 설정 버전 푸터가 포함된 인앱 업데이트 체커 ([#30](https://github.com/nextain/naia-os/issues/30))
- **feat(ci)**: Tauri 업데이터 서명, latest.json 생성 및 itch.io butler 자동 배포 ([#30](https://github.com/nextain/naia-os/issues/30))
- **feat(web)**: releases/*.yaml 기반 naia.nextain.io 다운로드 페이지 changelog 섹션 ([#30](https://github.com/nextain/naia-os/issues/30))
- **feat(voice)**: 라이브 대화를 프로바이더 패턴으로 추상화 (Gemini Live, OpenAI Realtime) ([#25](https://github.com/nextain/naia-os/issues/25))
- **fix(shell)**: 음성 대화 에코 억제 및 VRM 성별 기반 음성 기본값 추가 ([#22](https://github.com/nextain/naia-os/issues/22))
- **refactor(shell)**: 미사용 STT 코드 및 레거시 SettingsModal 제거 ([#25](https://github.com/nextain/naia-os/issues/25))
- **fix(agent)**: 비영어 환경에서 커스텀 스킬 탐색 실패 수정 ([#28](https://github.com/nextain/naia-os/issues/28))
- **fix(skills)**: 스킬 설치 피드백, 이벤트 릭, i18n 수정 및 20개 빌트인 스킬 동기화 ([#28](https://github.com/nextain/naia-os/issues/28))
- **refactor(agent)**: 시스템 프롬프트 파이프라인 중복 제거
- **feat(agent)**: Ollama 호스트 설정 지원
- **feat(shell)**: Shell-OpenClaw 간 양방향 메모리 동기화
- **fix(shell)**: AI 응답 언어가 로케일 설정을 따르도록 수정
- **feat(ci)**: CI 품질 게이트 (lint, typecheck, build-test) 및 Biome 적용 ([#12](https://github.com/nextain/naia-os/issues/12))
- **feat(ci)**: 파이프라인 체인: Release → Build OS → Generate ISO, 주간 자동 리빌드 ([#12](https://github.com/nextain/naia-os/issues/12))
- **fix(installer)**: DNS 삼중 fallback 복원, CJK 폰트 수정, Plymouth two-step 모듈
- **fix(branding)**: 설치된 시스템에 태스크바 핀, 배경화면, 잠금화면 추가

## v0.1.1 (2026-03-05)

Flatpak 지원 및 OpenClaw 통합이 포함된 첫 공개 릴리스

- **feat(shell)**: OpenClaw 번들 Flatpak 패키징
- **feat(shell)**: 감정 표현이 있는 VRM 3D 아바타
- **feat(agent)**: 멀티 프로바이더 LLM 지원 (Gemini, Claude, OpenAI, xAI, Ollama)
- **feat(shell)**: Edge, Google, OpenAI, ElevenLabs TTS 음성 대화
- **feat(shell)**: 14개 언어 UI 다국어 지원 ([#1](https://github.com/nextain/naia-os/issues/1))
