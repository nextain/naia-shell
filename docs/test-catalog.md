# Naia OS — Test Catalog

> **목적**: 모든 테스트를 한눈에 파악하고, 기능별로 무엇이 검증되는지 확인하는 레퍼런스 문서.
> 실제 테스트 파일과 1:1 대응. 변경 시 함께 업데이트.

## 목차

- [테스트 실행 방법](#테스트-실행-방법)
- [Shell 테스트](#shell-테스트)
  - [워크스페이스 패널](#워크스페이스-패널)
  - [컴포넌트](#컴포넌트)
  - [라이브러리 / 스토어](#라이브러리--스토어)
  - [VRM / 아바타](#vrm--아바타)
  - [E2E (Playwright)](#e2e-playwright)
- [Agent 테스트](#agent-테스트)
  - [코어 루프](#코어-루프)
  - [Gateway 브리지](#gateway-브리지)
  - [프로바이더](#프로바이더)
  - [스킬 시스템](#스킬-시스템)
  - [기타](#기타)
- [갭 분석 — 누락 테스트](#갭-분석--누락-테스트)

---

## 테스트 실행 방법

```bash
# Shell 단위 테스트 (1회)
cd shell && pnpm test

# Shell 단위 테스트 (watch mode)
cd shell && pnpm test:watch

# Shell 단위 테스트 (웹 UI — 브라우저에서 개별 실행)
cd shell && pnpm test:ui

# Agent 단위 테스트 (1회)
cd agent && pnpm test

# Agent 단위 테스트 (웹 UI)
cd agent && pnpm test:ui

# E2E (Playwright + Tauri, 실 앱 필요)
cd shell && pnpm test:e2e

# E2E (Playwright only, mock 환경)
cd shell && pnpm exec playwright test e2e/
```

> **Vitest UI**: `pnpm test:ui` 실행 후 `http://localhost:51204/__vitest__/` 접속.
> 테스트를 클릭하면 개별 실행 / 결과 확인 / 소스 이동 가능.

---

## Shell 테스트

### 워크스페이스 패널

워크스페이스 패널은 Naia의 핵심 개발 환경 UI. 이슈 트래킹, 세션 관리, 파일 편집, 터미널을 통합.

#### `shell/src/panels/__tests__/workspace-panel.test.tsx`

**WorkspaceCenterPanel** — 워크스페이스 패널 메인 컴포넌트

| # | 테스트 | 검증 내용 |
|---|-------|---------|
| 1 | renders left FileTree and right area | "탐색기" 헤더 렌더링 |
| 2 | registers skill_workspace_get_sessions handler | 마운트 시 툴 핸들러 등록 |
| 3 | registers skill_workspace_open_file handler | 마운트 시 툴 핸들러 등록 |
| 4 | registers skill_workspace_classify_dirs handler | 마운트 시 툴 핸들러 등록 |
| 5 | skill_workspace_get_sessions returns JSON session list | sessions + summary 구조 반환 |
| 6 | skill_workspace_get_sessions counts sessions by status | active/idle/stopped/error 카운트 정확성 |
| 7 | Panel API: getApi returns WorkspacePanelApi after mount | openFile/focusSession/getActiveSessions API |
| 8 | registers skill_workspace_focus_session handler | 마운트 시 툴 핸들러 등록 |
| 9 | skill_workspace_focus_session error when dir missing | 파라미터 유효성 검사 |
| 10 | skill_workspace_focus_session error when session not found | 세션 없을 때 에러 반환 |
| 11 | skill_workspace_focus_session returns Focused + highlightedDir | 세션 포커스 + IssuesPanel 하이라이트 |
| 12 | skill_workspace_focus_session with open_recent_file | 최근 파일 경로 자동 오픈 |
| 13 | skill_workspace_focus_session ignores non-boolean open_recent_file | LLM 신뢰 경계 (truthy string 거부) |
| 14 | skill_workspace_focus_session clears badge when no recent_file | recent_file 없을 때 graceful |
| 15 | skill_workspace_open_file updates editor filepath | 에디터 파일 경로 업데이트 |
| 16 | pushes errorAlert context when session has status=error | error 세션 → 컨텍스트 푸시 (중복 방지) |
| 17 | re-arms errorAlert after session recovers to idle/active | 회복 후 재발 시 다시 알림 |

**SessionCard** — 세션 카드 컴포넌트

| # | 테스트 | 검증 내용 |
|---|-------|---------|
| 18 | renders active session with green emoji | 🟢 이모지 + dir 이름 |
| 19 | renders idle session with yellow emoji | 🟡 이모지 |
| 20 | renders stopped session with black emoji | ⚫ 이모지 |
| 21 | shows progress issue and phase in badge | "#79 · build" 배지 |
| 22 | calls onClick when card is clicked | 클릭 콜백 |

**Editor** — 파일 에디터 컴포넌트

| # | 테스트 | 검증 내용 |
|---|-------|---------|
| 23 | renders empty hint when no file selected | 파일 미선택 안내 메시지 |
| 24 | shows filename in header when file is opened | 헤더에 파일명 표시 |
| 25 | shows badge when provided | 배지 렌더링 |
| 26 | shows edit toggle button for markdown files | 마크다운 미리보기 모드 토글 |
| 27 | shows read-only label for ref- directories | 읽기 전용 표시 |

**Workspace Panel Registry** — 패널 레지스트리

| # | 테스트 | 검증 내용 |
|---|-------|---------|
| 28 | registers workspace panel as builtIn | builtIn: true 등록 |
| 29 | workspace panel has skill_workspace_get_sessions tool | tier:0 툴 등록 |
| 30 | workspace panel has skill_workspace_open_file tool | tier:1 툴 등록 |
| 31 | workspace panel has skill_workspace_focus_session tool | tier:1 툴 등록 |
| 32 | workspace panel has onActivate and onDeactivate hooks | 라이프사이클 훅 |

---

#### `shell/src/panels/__tests__/editor-viewer.test.tsx`

**Editor 파일 타입 뷰어** — 이미지/CSV/로그/PDF/마크다운 (#116)

| # | 테스트 | 검증 내용 |
|---|-------|---------|
| 1 | renders image viewer for .png | 이미지 뷰어 분기 |
| 2 | renders image viewer for .jpg | 이미지 뷰어 분기 |
| 3 | renders image viewer for .webp | 이미지 뷰어 분기 |
| 4 | renders image viewer for .svg | SVG → 이미지 뷰어 (텍스트 에디터 X) |
| 5 | does NOT call workspace_read_file for image files | 이미지는 read_file 호출 없음 (convertFileSrc 사용) |
| 6 | renders CSV table viewer for .csv | CSV 테이블 뷰어 |
| 7 | CSV table is sortable — clicking header | 오름차순→내림차순 정렬 |
| 8 | CSV header onKeyDown (Enter/Space) sorts | 접근성 키보드 정렬 |
| 9 | shows empty hint for empty CSV | 빈 CSV 처리 |
| 10 | renders log viewer for .log | 로그 뷰어 (pre 요소) |
| 11 | renders log content (ANSI stripped/converted) | ANSI 코드 변환 |
| 12 | does NOT show markdown view-mode buttons for image files | 뷰어 타입별 UI 격리 |
| 13 | does NOT show markdown view-mode buttons for CSV files | 뷰어 타입별 UI 격리 |
| 14 | shows file name in header for all viewer types | 헤더 파일명 공통 |
| 15 | resets sort when file changes | 파일 변경 시 정렬 초기화 |
| 16 | renders PDF viewer for .pdf | PDF 뷰어 |
| 17 | does NOT call workspace_read_file for PDF files | PDF는 read_file 호출 없음 |
| 18 | does NOT show markdown view-mode buttons for PDF files | PDF UI 격리 |
| 19 | renders Mermaid diagram in Markdown preview | 마크다운 내 Mermaid 렌더링 |
| 20 | shows error for invalid Mermaid syntax | Mermaid 오류 표시 |
| 21 | shows load error for failed file read | 파일 읽기 실패 오류 |
| 22 | shows reload button in editor header | 새로고침 버튼 |
| 23 | reload button re-reads file from disk | 새로고침 → 파일 재읽기 |
| 24 | markdown files open in preview mode by default | 마크다운 기본 미리보기 |

---

#### `shell/src/panels/__tests__/terminal-grid.test.tsx`

**Terminal Grid** — 다중 터미널 그리드 (#119)

| # | 테스트 | 검증 내용 |
|---|-------|---------|
| 1 | tab mode: only one terminal visible when a single terminal is open | 단일 터미널 → 탭 모드 |
| 2 | grid mode activates automatically when 2nd terminal is opened | 2개 이상 → 그리드 모드 자동 전환 |
| 3 | grid cell headers show dir basename | 셀 헤더에 디렉토리 basename |
| 4 | grid drops back to tab mode when terminal count falls to 1 | 1개로 줄면 탭 모드 복귀 |
| 5 | closing focused terminal falls back to next terminal, not editor | 포커스 터미널 닫기 → 다음 터미널 (에디터 X) |

---

#### `shell/src/panels/__tests__/grid-resize.test.tsx`

**Grid Resize** — 터미널 그리드 드래그 리사이즈 (#119)

| # | 테스트 | 검증 내용 |
|---|-------|---------|
| 1 | no resize handle with 0 terminals | 터미널 없음 → 핸들 없음 |
| 2 | no resize handle with 1 terminal (tab mode) | 탭 모드 → 핸들 없음 |
| 3 | resize handle appears with exactly 2 terminals | 2개 → 핸들 표시 |
| 4 | terminal area gets --resizable class with 2 terminals | CSS 클래스 |
| 5 | no resize handle with 3 terminals (auto-grid, no drag) | 3개 → 핸들 없음 (auto-grid) |
| 6 | terminal area has inline gridTemplateColumns with 2 terminals | 인라인 그리드 스타일 |
| 7 | removes body.resizing-col on pointercancel | 취소 시 cursor 초기화 |
| 8 | adds body.resizing-col on pointerdown, removes on pointerup | 드래그 cursor 클래스 |
| 9 | gridSplit updates (style changes) after drag | 드래그 후 비율 업데이트 |

---

#### `shell/src/panels/__tests__/session-persistence.test.tsx`

**Session Persistence** — 터미널 세션 복원 (#119)

| # | 테스트 | 검증 내용 |
|---|-------|---------|
| 1 | saves terminal dirs to localStorage when a terminal is opened | localStorage 저장 |
| 2 | saves activeDir when switching between terminals | activeDir 저장 |
| 3 | restores terminals from localStorage after workspace is ready | 복원 |
| 4 | restores the previously active terminal as the focused tab | 활성 탭 복원 |
| 5 | skips dirs that fail pty_create without crashing | graceful degradation |
| 6 | does not save an empty session before restore runs | 복원 전 빈 세션 덮어쓰기 방지 |
| 7 | removes a terminal dir from saved session when terminal is closed | 종료 시 저장 데이터 정리 |

---

#### `shell/src/panels/__tests__/terminal-exit.test.tsx`

**Terminal Exit** — PTY 프로세스 종료 처리 (#119)

| # | 테스트 | 검증 내용 |
|---|-------|---------|
| 1 | shows dead overlay (not Terminal) after process exits | 종료 후 dead overlay 표시 |
| 2 | shows restart button in dead overlay | 재시작 버튼 |
| 3 | tab stays visible after exit (not removed) | 종료 후 탭 유지 |
| 4 | restart button creates new PTY in the same dir | 재시작 → pty_create |
| 5 | restarted terminal replaces the exited one in-place | 제자리 교체 |
| 6 | close button removes the exited terminal | 닫기 → 제거 |
| 7 | blocks duplicate open while exited tab is visible | 중복 오픈 방지 |

---

#### `shell/src/panels/__tests__/terminal-tab-badge.test.tsx`

**Terminal Tab Badge** — 터미널 탭 배지 (#119)

| # | 테스트 | 검증 내용 |
|---|-------|---------|
| 1 | shows no badges when issueId and agent are undefined | 배지 없음 |
| 2 | shows #issueId badge when issueId is set | 이슈 배지 |
| 3 | shows agent badge when agent is set | 에이전트 배지 |
| 4 | shows both badges when issueId and agent are set | 두 배지 동시 |
| 5 | shows issueId 0 as badge (falsy number edge case) | 0 처리 |
| 6 | uses dir basename for label (unix path) | Unix 경로 basename |
| 7 | uses dir basename for label (windows path) | Windows 경로 basename |
| 8 | all AgentType values render as badge text | 모든 AgentType 커버 |

---

#### `shell/src/panels/__tests__/agent-poll.test.tsx`

**Agent Poll** — AI 에이전트 폴링 (#119)

| # | 테스트 | 검증 내용 |
|---|-------|---------|
| 1 | calls workspace_get_pty_agents with all open terminal PIDs every 5s | 5초 주기 배치 폴링 |
| 2 | updates terminal.agent when batch result contains the pid | 에이전트 배지 업데이트 |
| 3 | clears terminal.agent when pid is absent from batch result | 에이전트 배지 제거 |
| 4 | ignores unknown agent names returned by Rust | 런타임 유효성 검사 |
| 5 | all valid AgentType values are recognized and displayed as badge | AgentType 전체 커버 |
| 6 | handles workspace_get_pty_agents failure gracefully | 실패 시 no crash |

---

#### `shell/src/panels/__tests__/issue-terminal-link.test.tsx`

**Issue-Terminal Link** — 이슈 클릭 → 터미널 포커스 (#119)

| # | 테스트 | 검증 내용 |
|---|-------|---------|
| 1 | focuses the matching terminal when issue is clicked | 이슈 → 해당 터미널 포커스 |
| 2 | always pushes Naia context when an issue is clicked | 컨텍스트 푸시 |
| 3 | does NOT switch tabs when clicked issue has no matching terminal | 매칭 없을 때 탭 전환 안 함 |
| 4 | focuses the correct terminal among multiple | 다중 터미널 중 정확한 포커스 |
| 5 | still pushes context even when no matching terminal exists | 매칭 없어도 컨텍스트 푸시 |

---

#### `shell/src/panels/__tests__/quick-open.test.tsx`

**QuickOpen** — 파일 빠른 열기 다이얼로그

| # | 테스트 | 검증 내용 |
|---|-------|---------|
| 1 | renders input and file list | 입력창 + 파일 목록 |
| 2 | filters files by query | 쿼리 필터링 |
| 3 | calls onSelect and onClose when Enter is pressed | Enter → 선택 + 닫기 |
| 4 | calls onClose when Escape is pressed | Escape → 닫기 |
| 5 | navigates with ArrowDown/ArrowUp | 키보드 네비게이션 |
| 6 | shows empty message when no matches | 검색 결과 없음 |

---

#### `shell/src/panels/__tests__/issues-panel.test.tsx`

**IssuesPanel** — GitHub 이슈 + 세션 대시보드

| # | 테스트 | 검증 내용 |
|---|-------|---------|
| 1 | shows loading spinner initially | 초기 로딩 |
| 2 | renders issue cards on success | 이슈 카드 렌더링 |
| 3 | shows label badges | 레이블 배지 |
| 4 | shows gh not installed message when exit_code 127 | gh CLI 미설치 안내 |
| 5 | shows gh not installed when output contains 'not found' | gh CLI 미설치 안내 |
| 6 | shows error state with retry button on non-gh failure | 에러 + 재시도 버튼 |
| 7 | shows empty state when issues list is empty | 빈 상태 |
| 8 | calls onIssueClick with issue data when card is clicked | 클릭 콜백 |
| 9 | uses cache on second render (no second pty_execute_sync call) | 캐시 (중복 gh 호출 방지) |
| 10 | refresh button busts cache and re-fetches | 새로고침 → 캐시 무효화 |
| 11 | sessions section collapses on toggle click | 세션 섹션 접기/펼치기 |
| 12 | shows relative time on cards | 상대 시간 표시 |

---

#### `shell/src/panels/__tests__/panel-system.test.tsx`

**Panel Registry** — 패널 레지스트리 시스템

| # | 테스트 | 검증 내용 |
|---|-------|---------|
| Panel Registry | list, get, register, unregister | 기본 CRUD |
| Panel Registry — API | getApi, registerApi, unregisterApi | API 등록/해제 |
| SampleNote Panel — tool interaction | tool handler onToolCall, callTool | 패널 툴 인터랙션 |

---

### 컴포넌트

#### `shell/src/components/__tests__/ChatPanel.test.tsx`

**ChatPanel** — 채팅 패널

| 테스트 | 검증 내용 |
|-------|---------|
| renders input field and buttons | 기본 렌더링 |
| does not send empty message | 빈 메시지 방지 |
| sends message on Enter | Enter 전송 |
| displays session cost header | 비용 헤더 |
| shows streaming indicator when streaming | 스트리밍 인디케이터 |
| renders ToolActivity for tool_use chunk | 툴 사용 활동 표시 |
| updates tool call on tool_result chunk | 툴 결과 업데이트 |
| renders ToolActivity for completed messages with toolCalls | 완료된 툴 표시 |
| sets pendingApproval on approval_request chunk | 승인 요청 처리 |
| auto-approves when tool is in allowedTools | 허용 툴 자동 승인 |
| renders PermissionModal when pendingApproval is set | 권한 모달 |
| sets isSpeaking and pendingAudio on audio chunk | 오디오 청크 처리 |
| loads session from Gateway on mount | 마운트 시 세션 로드 |
| renders new conversation button | 새 대화 버튼 |
| new conversation resets messages | 새 대화 → 초기화 |
| recalls previous input with ArrowUp | 히스토리 복원 |
| navigates history with ArrowUp/ArrowDown | 히스토리 네비게이션 |

#### `shell/src/components/__tests__/SettingsTab.test.tsx`

**SettingsTab** — 설정 탭

#### `shell/src/components/__tests__/SkillsTab.test.tsx`

**SkillsTab** — 스킬 관리 탭

#### `shell/src/components/__tests__/OnboardingWizard.test.tsx`

**OnboardingWizard** — 온보딩 마법사

#### `shell/src/components/__tests__/ModeBar.test.tsx`

**ModeBar** — 패널 전환 모드바

#### `shell/src/components/__tests__/ChannelsTab.test.tsx`

**ChannelsTab** — 채널 탭

#### `shell/src/components/__tests__/HistoryTab.test.tsx`

**HistoryTab** — 대화 히스토리 탭

#### `shell/src/components/__tests__/WorkProgressPanel.test.tsx`

**WorkProgressPanel** — 작업 진행 패널

#### `shell/src/components/__tests__/CostDashboard.test.tsx`

**CostDashboard** — 비용 대시보드

#### `shell/src/components/__tests__/PermissionModal.test.tsx`

**PermissionModal** — 툴 권한 승인 모달

#### `shell/src/components/__tests__/ToolActivity.test.tsx`

**ToolActivity** — 툴 사용 활동 표시

#### `shell/src/components/__tests__/SplashScreen.test.tsx`

**SplashScreen** — 스플래시 화면

#### `shell/src/components/__tests__/chat-deeplink.test.tsx`

**Chat Deeplink** — 딥링크 처리

---

### 라이브러리 / 스토어

#### `shell/src/stores/__tests__/chat.test.ts`

**Chat Store** — Zustand 채팅 스토어

| 테스트 | 검증 내용 |
|-------|---------|
| has correct initial state | 초기 상태 |
| setSessionId / setMessages / newConversation | 상태 변이 |
| addMessage (user/assistant) | 메시지 추가 |
| startStreaming / appendStreamChunk / finishStreaming | 스트리밍 상태 기계 |
| addCostEntry | 비용 누적 |
| setProvider | 프로바이더 전환 |
| streamingToolCalls (add/update/finish) | 툴 콜 스트리밍 |
| setPendingApproval / clearPendingApproval | 승인 상태 |
| **finishStreaming clears pendingApproval** | Browser Panel 불변식 (#102) |

#### `shell/src/stores/__tests__/progress.test.ts`

**Progress Store** — 작업 진행 상태

#### `shell/src/stores/__tests__/skills.test.ts`

**Skills Store** — 스킬 목록 상태

#### `shell/src/lib/__tests__/config.test.ts` / `config-secrets.test.ts` / `config-skills.test.ts`

**Config** — 설정 로드/저장/시크릿/스킬

#### `shell/src/lib/__tests__/chat-service.test.ts`

**ChatService** — 채팅 서비스 로직

#### `shell/src/lib/__tests__/gateway-sync.test.ts`

**Gateway Sync** — 게이트웨이 설정 동기화

#### `shell/src/lib/__tests__/gateway-sessions.test.ts`

**Gateway Sessions** — 게이트웨이 세션 관리

#### `shell/src/lib/__tests__/panel-loader.test.ts`

**Panel Loader** — 동적 패널 로더

#### `shell/src/lib/__tests__/iframe-bridge.test.ts`

**IFrame Bridge** — 외부 패널 통신 브리지

#### `shell/src/lib/__tests__/logger.test.ts`

**Logger** — 구조화 로거

#### `shell/src/lib/__tests__/db.test.ts`

**DB** — SQLite 로컬 DB

#### `shell/src/lib/__tests__/audio-player.test.ts`

**AudioPlayer** — 오디오 재생기

#### `shell/src/lib/__tests__/browser-prefs.test.ts`

**BrowserPrefs** — 브라우저 패널 설정

#### `shell/src/lib/__tests__/channel-sync.test.ts`

**ChannelSync** — 채널 동기화

#### `shell/src/lib/__tests__/discord-auth.test.ts` / `shell/src/__tests__/app-discord-auth.test.tsx`

**Discord Auth** — Discord OAuth 인증

#### `shell/src/lib/__tests__/lab-sync.test.ts` / `shell/src/__tests__/lab-auth.test.ts`

**Lab Auth/Sync** — Nextain Lab 인증/동기화

#### `shell/src/lib/__tests__/persona.test.ts`

**Persona** — 페르소나 로드

#### `shell/src/lib/__tests__/adk-store.test.ts` / `shell/src/lib/__tests__/adk-assets-e2e.test.ts`

**ADK Store/Assets** — ADK 데이터 스토어 + 에셋

#### `shell/src/lib/__tests__/issue-branch.test.ts`

**Issue Branch** — 이슈 브랜치 연동

#### `shell/src/lib/llm/__tests__/registry.test.ts`

**LLM Registry** — LLM 프로바이더 레지스트리

#### `shell/src/lib/tts/__tests__/cost.test.ts`

**TTS Cost** — TTS 비용 계산

#### `shell/src/__tests__/secure-store.test.ts`

**Secure Store** — 암호화 키 저장소

---

### VRM / 아바타

#### `shell/src/lib/vrm/__tests__/animation.test.ts`

**VRM Animation** — 아바타 애니메이션

#### `shell/src/lib/vrm/__tests__/expression.test.ts`

**VRM Expression** — 아바타 표정

#### `shell/src/lib/vrm/__tests__/eye-motions.test.ts`

**VRM Eye Motions** — 눈 움직임

#### `shell/src/lib/vrm/__tests__/mouth.test.ts`

**VRM Mouth** — 입 모양

---

### 음성 (Voice)

#### `shell/src/lib/voice/__tests__/voice-session-factory.test.ts`

**Voice Session Factory** — 음성 세션 팩토리

#### `shell/src/lib/voice/__tests__/gemini-live.test.ts`

**Gemini Live** — Gemini Live API 음성

#### `shell/src/lib/voice/__tests__/openai-realtime.test.ts`

**OpenAI Realtime** — OpenAI 실시간 음성

#### `shell/src/lib/voice/__tests__/minicpm-o-ref-audio.test.ts`

**MiniCPM-o Ref Audio** — 로컬 음성 레퍼런스

#### `shell/src/lib/voice/__tests__/voice-e2e.test.ts`

**Voice E2E** — 음성 파이프라인 통합

---

### E2E (Playwright)

#### `shell/e2e/` — Playwright 단독 (mock 환경)

| 파일 | 내용 |
|-----|-----|
| `91-workspace-panel.spec.ts` | 워크스페이스 패널 전체 (S1~S13) + Worktree 그룹핑 (WG1~WG2) |
| `116-resource-viewer.spec.ts` | 이미지/CSV/로그/PDF 리소스 뷰어 |
| `119-pty-terminal.spec.ts` | PTY 터미널 전체 흐름 |
| `120-send-to-session.spec.ts` | skill_workspace_send_to_session |
| `197-browser-login.spec.ts` | 브라우저 패널 로그인 |
| `204-onboarding-login.spec.ts` | 온보딩 로그인 흐름 |
| `chat-tools.spec.ts` | 채팅 툴 호출 흐름 |
| `memory-settings.spec.ts` | 메모리 설정 |
| `memory-sync.spec.ts` | 메모리 동기화 |
| `onboarding-fresh.spec.ts` | 새 설치 온보딩 |
| `pipeline-voice.spec.ts` | 음성 파이프라인 |

**워크스페이스 패널 E2E 테스트 목록** (`91-workspace-panel.spec.ts`):

| 테스트 ID | 내용 |
|----------|-----|
| S1-a | 워크스페이스 패널 탭이 ModeBar에 표시됨 |
| S1-b | 패널 탭 클릭 시 FileTree와 SessionDashboard 표시 |
| S1-c | 세션 카드 3개 표시 (active, idle, stopped) |
| S2 | 세션 카드에 이슈/단계 배지 표시 (#79 · build) |
| S3 | 세션 카드 클릭 시 에디터에 최근 파일 표시 |
| S4 | 에디터 상단 배지에 이슈/단계 표시 |
| S5 | FileTree에 루트 디렉토리 목록 표시 |
| S6 | FileTree 파일 클릭 시 에디터에 파일 내용 표시 |
| S7 | 마크다운 파일 선택 시 미리보기 기본 표시 및 편집 버튼 전환 |
| S8 | ref-* 디렉토리 파일 선택 시 읽기 전용 표시 |
| S9 | 파일 선택 전 에디터 빈 힌트 메시지 표시 |
| S10 | 다른 패널로 전환 시 워크스페이스 패널 비활성화 |
| S11 | workspace:file-changed 이벤트 수신 시 세션 새로고침 |
| S12 | workspaceReady 게이트 — workspace_set_root 완료 후 세션 로드됨 |
| S13 | config workspaceRoot 설정 시 workspace_set_root가 해당 경로로 호출됨 |
| WG1 | 같은 origin_path 세션이 WorktreeGroup으로 묶임 |
| WG2 | WorktreeGroup 헤더 클릭 시 접기/펼치기 |

#### `shell/e2e-tauri/specs/` — Playwright + Tauri (실 앱 필요)

| 번호 | 파일 | 내용 |
|-----|-----|-----|
| 01 | app-launch | 앱 실행 |
| 02 | configure | 초기 설정 |
| 03 | basic-chat | 기본 채팅 |
| 04 | skill-time | time 스킬 |
| 05 | skill-system | system 스킬 |
| 06 | skill-memo | memo 스킬 |
| 07 | cleanup | 정리 |
| 08 | memory | 메모리 기능 |
| 09 | onboarding | 온보딩 |
| 10 | history-tab | 히스토리 탭 |
| 11 | cost-dashboard | 비용 대시보드 |
| 12 | skills-gateway | 게이트웨이 스킬 |
| 13 | lab-login | Lab 로그인 |
| 14 | skills-tab | 스킬 탭 |
| 15 | skill-manager-ai | AI 스킬 매니저 |
| 16 | skill-weather | weather 스킬 |
| 17 | skill-notify | notify 스킬 |
| 18 | provider-tool-calling | 프로바이더 툴 호출 |
| 19 | skills-bulk | 벌크 스킬 |
| 20 | cron-basic | 크론 기본 |

---

## Agent 테스트

### 코어 루프

#### `agent/src/__tests__/tool-loop.test.ts`

**Tool Loop** — LLM 툴 호출 루프

| 테스트 | 검증 내용 |
|-------|---------|
| executes tool calls and re-invokes LLM with results | 툴 → LLM 재호출 |
| blocks dangerous commands and sends error result to LLM | 위험 명령 차단 |
| skips tool loop when enableTools is not set | enableTools 게이트 |
| handles multiple tool calls in a single response | 다중 툴 콜 |
| limits tool call iterations to prevent infinite loops | 무한 루프 방지 |

#### `agent/src/__tests__/stdio.test.ts`

**Stdio** — stdin/stdout 프로토콜

#### `agent/src/__tests__/approval-flow.test.ts`

**Approval Flow** — 툴 승인 흐름

---

### Gateway 브리지

#### `agent/src/gateway/__tests__/tool-bridge.test.ts`

**Tool Bridge** — 게이트웨이 툴 브리지

#### `agent/src/gateway/__tests__/tool-bridge-security.test.ts`

**Tool Bridge Security** — Tier 0~3 보안 정책

#### `agent/src/gateway/__tests__/tool-tiers.test.ts`

**Tool Tiers** — 티어별 툴 분류

#### `agent/src/gateway/__tests__/tool-bridge-filter.test.ts`

`agent/src/__tests__/tool-bridge-filter.test.ts`

**Tool Bridge Filter** — 툴 필터링

#### `agent/src/gateway/__tests__/client.test.ts` / `client-offEvent.test.ts`

**Gateway Client** — WebSocket 클라이언트 + 이벤트 관리

#### `agent/src/gateway/__tests__/native-executor.test.ts`

**Native Executor** — 네이티브 명령 실행기

#### `agent/src/gateway/__tests__/command-executor.test.ts`

**Command Executor** — 명령 실행기

#### `agent/src/gateway/__tests__/path-resolver.test.ts`

**Path Resolver** — 경로 해석

#### `agent/src/gateway/__tests__/sessions-proxy.test.ts` / `sessions-spawn.test.ts`

**Sessions** — 세션 프록시 + 스폰

#### `agent/src/gateway/__tests__/skills-proxy.test.ts`

**Skills Proxy** — 스킬 프록시

#### `agent/src/gateway/__tests__/event-handler.test.ts`

**Event Handler** — 이벤트 핸들러

---

### 프로바이더

#### `agent/src/providers/__tests__/anthropic-tools.test.ts`

**Anthropic Tools** — Anthropic 툴 호출 포맷

#### `agent/src/providers/__tests__/openai-tools.test.ts` / `openai-compat.test.ts`

**OpenAI Tools/Compat** — OpenAI 포맷 + 호환 레이어

#### `agent/src/providers/__tests__/factory-regex.test.ts` / `factory-toggle.test.ts`

**Provider Factory** — 프로바이더 팩토리 정규식 + 토글

#### `agent/src/providers/adapters/__tests__/`

**Provider Adapters** — Anthropic/Gemini/OpenAI/Claude CLI/Lab Proxy 어댑터

---

### 스킬 시스템

#### `agent/src/skills/__tests__/registry.test.ts`

**Skill Registry** — 스킬 레지스트리

#### `agent/src/skills/__tests__/loader.test.ts`

**Skill Loader** — 스킬 파일 로더

#### `agent/src/skills/__tests__/skill-manager.test.ts`

**Skill Manager** — AI 스킬 매니저

#### `agent/src/skills/__tests__/bulk-migration.test.ts`

**Bulk Migration** (51 bundled skills) — 전체 빌트인 스킬 로드/검증

> **주의**: `~/.naia/skills/` 디렉토리가 세팅된 환경에서만 통과. CI에서는 일부 skip.

#### `agent/src/skills/__tests__/bundled-naia-skills.test.ts`

**Bundled Naia Skills** — `@naia-adk/skills-builtin` 번들 스킬

#### 개별 스킬 테스트

| 파일 | 스킬 |
|-----|-----|
| `agents.test.ts` | 에이전트 관리 스킬 |
| `approvals.test.ts` | 승인 스킬 |
| `channels.test.ts` | 채널 스킬 |
| `config.test.ts` | 설정 스킬 |
| `cron.test.ts` | 크론 스킬 |
| `device.test.ts` | 디바이스 스킬 |
| `diagnostics.test.ts` | 진단 스킬 |
| `memo.test.ts` | 메모 스킬 |
| `naia-discord.test.ts` | Discord 스킬 |
| `notify-config.test.ts` | 알림 설정 |
| `notify-discord.test.ts` | Discord 알림 |
| `notify-slack.test.ts` | Slack 알림 |
| `sessions.test.ts` | 세션 스킬 |
| `system-status.test.ts` | 시스템 상태 |
| `time.test.ts` | 시간 스킬 |
| `tts.test.ts` | TTS 스킬 |
| `voicewake.test.ts` | 음성 웨이크 |
| `weather.test.ts` | 날씨 스킬 |

---

### 기타

#### `agent/src/cron/__tests__/scheduler.test.ts` / `store.test.ts`

**Cron** — 스케줄러 + 스토어

#### `agent/src/conversation/__tests__/token-budget.test.ts`

**Token Budget** — 토큰 예산 관리

#### `agent/src/mcp/__tests__/client.test.ts` / `server.test.ts`

**MCP** — Model Context Protocol 클라이언트/서버

#### `agent/src/tasks/__tests__/tracker.test.ts`

**Task Tracker** — 작업 추적기

---

## 갭 분석 — 누락 테스트

아래는 verify-* 스킬이 정의한 불변식 중 **단위 테스트가 없는** 항목.
E2E로 커버되지만 단위 레벨 회귀 탐지가 없어 취약.

### ~~GAP-1: WorktreeGroup.tsx 단위 테스트 없음~~ ✅ 해결됨

**파일**: `shell/src/panels/__tests__/worktree-group.test.tsx` (11개 테스트)

검증 항목:
- `useState(false)` 초기 expanded 상태
- 헤더 클릭 → collapse/expand 토글 (▼/▶)
- collapsed 시 카드 숨김, expanded 시 표시
- `highlightedDir` 전달 정확성 (`data-dir` 속성)
- repoName / count 헤더 표시
- `onSessionClick` 콜백 전달

### ~~GAP-2: SessionDashboard.tsx 단위 테스트 없음~~ ✅ 해결됨

**파일**: `shell/src/panels/__tests__/session-dashboard.test.tsx` (12개 테스트)

검증 항목:
- 초기 로딩 상태 ("세션 스캔 중")
- 빈 상태 (Git 레포 없음 메시지 + workspaceRoot 경로 표시)
- origin_path 없는 세션 → standalone SessionCard
- 2개 이상 동일 origin_path → WorktreeGroup 렌더링
- repoName = basename of origin_path
- 3개 세션 묶음 시 count=3
- origin_path 없는 세션들이 서로 묶이지 않음 (각자 standalone)
- `onSessionsUpdate` 콜백 호출
- 첫 실패 시 `onSessionsUpdate([])` 호출 (부모 언블록)
- 새로고침 버튼 → workspace_get_sessions 재호출
- `workspace:file-changed` 이벤트 → debounce 300ms 후 재로드
- 헤더의 세션 수 표시 "세션 (N)"

> **구현 팁**: `vi.useFakeTimers()`는 debounce 테스트에만 로컬 scope로 사용.
> 전역 `beforeEach`에 쓰면 `waitFor` 내부 polling이 멈춤.
> 동적 import는 `vi.resetModules()`를 `afterEach`에 추가해야 격리됨.

### ~~GAP-3: skill_workspace_send_to_session 단위 테스트 없음~~ ✅ 해결됨

**파일**: `shell/src/panels/__tests__/workspace-panel.test.tsx` (5개 테스트 추가)

검증 항목:
- 마운트 시 핸들러 등록 (`bridge.hasHandler("skill_workspace_send_to_session")`)
- dir 또는 text 누락 시 Error 반환
- PTY 세션 없을 때 Error 반환 ("no PTY session for: {dir}")
- `pty_write` invoke 호출 및 `"Sent to: {dir}"` 반환
- `index.tsx` tool descriptor에 `dir`, `text` required 필드 확인

> **구현 팁**: `Terminal` 컴포넌트를 `vi.mock`으로 대체해야 jsdom에서 `ResizeObserver` 크래시 방지.
> `new_session` → `pty_create` 모킹 후 `waitFor`로 터미널 탭 반영 대기.

### GAP-4: Browser Panel WebView2 타이밍 통합 테스트 없음

**verify-browser-panel** 불변식:
- `setPendingApproval` invoke-before-set (`browser_wv_hide` → `set()` 순서)
- `clearPendingApproval` guard

현재 커버: chat.test.ts에 상태 변이만 확인 (invoke 순서 미검증).
추천 추가: `shell/src/components/__tests__/browser-panel.test.tsx`

### GAP-5: 환경 의존 테스트 (CI 주의)

| 테스트 | 이유 | 해결 방법 |
|-------|-----|---------|
| `tts-voice-validity.test.ts` | Edge TTS 네트워크 필요 | `describe.skip` 또는 환경변수 게이트 |
| `bulk-migration.test.ts` | `~/.naia/skills/` 디렉토리 필요 | CI fixture 또는 mock |
| `tool-loop.test.ts` (loop limit) | 5000ms 타임아웃 | `{ timeout: 15000 }` 추가 |
| `native-executor.test.ts` (cwd) | OS 환경 의존 | 환경 감지 skip |

---

*마지막 업데이트: 2026-05-16 | 테스트 수: Shell 단위 163개 (panels), Agent 단위 약 1,200개*
