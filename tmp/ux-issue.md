# [UX/Feature] Herdr 및 Naia Shell 사용성 개선 및 AI 연동 강화 (QA 피드백)

## 요약
최근 사용성 테스트 결과, `naia-shell` 및 `herdr`의 UI/UX 마찰점, 버그, 그리고 AI 에이전트 연동 강화를 위한 요구사항이 수집되었습니다. 본 이슈는 해당 피드백을 해결하기 위한 작업 목록을 추적합니다.

---

## 🐛 버그 수정 (Bug Fixes)

- [x] **1. Herdr 마우스 이벤트 버그 수정**
  - **문제:** 팝업 선택 메뉴, 상단 탭 리네임, `spaces`, `agents` 등의 마우스 클릭 이벤트 및 메뉴가 동작하지 않음.
  - **원인 분석 (이전 세션의 한계):** 이전 세션에서는 `term.onBinary`만 연결하고 완료 처리했으나, Windows ConPTY 환경에서는 crossterm의 마우스 활성화가 xterm.js로 전달되지 않아 마우스 모드가 꺼져 있었음.
  - **해결:** `Terminal.tsx`에서 xterm attach 및 redraw 시 SGR 마우스 모드 시퀀스(`\x1b[?1000h\x1b[?1002h\x1b[?1006h`)를 전송하고 `contextmenu` preventDefault를 적용하여 정상 동작 완료.
- [x] **2. 파일 검색 (`Ctrl + P`) 무한 로딩 수정**
  - **해결:** Rust 백엔드에 `workspace_list_files_recursive`를 구현하여 단일 호출로 파일 트리를 즉시 색인하도록 완료.

---

## 🎨 UX 및 레이아웃 개선 (UX & Layout)

- [x] **3. 뷰어 - Herdr 전환 토글 버튼 추가**
  - **해결:** `HerdrWorkspaceRail.tsx`에 문서 열람 시 Herdr 메인 화면으로 돌아가는 "Herdr 화면으로" 버튼 추가 완료.
- [x] **4. 파일 뷰어 상단 헤더 레이아웃 개선**
  - **해결:** 긴 파일 경로에 `title` 툴팁 부여 및 flex 정렬로 우측 액션 버튼 사이 여백 정상화 완료.
- [x] **5. "워크스페이스 컨텍스트" UI 문구 명확화**
  - **해결:** `ko.ts`의 `workspace.contextTitle`을 "AI 참조 컨텍스트"로 변경 완료.
- [x] **6. 단축키 지원: 문서 닫기 (`Ctrl + W`)**
  - **해결:** `useHerdrDocuments.ts`에 `Ctrl+W` / `Cmd+W` 윈도우 키다운 핸들러 및 `preventDefault()` 추가 완료.

---

## ✨ 신규 기능 (Features)

- [x] **7. Herdr 터미널 내 파일 링크 `Ctrl + Click` 연동**
  - **해결:** `Terminal.tsx`에서 확장자 정규식 지원 확대, `fs_exists` 검증 토스트 처리, 그리고 외부 파일 클릭 시 `workspace_register_open_file` 보안 권한 획득 파이프라인 연동 완료.
- [x] **8. 드래그 앤 드롭 (OS 파일 드롭)**
  - **원인 분석 (이전 세션의 한계):** `Terminal.tsx`의 `onDragOverCapture`에 `e.stopPropagation()`만 있고 `e.preventDefault()`가 누락되어 WebView2가 OS 파일 드롭을 거부(🚫)하고 있었음.
  - **해결:** `e.preventDefault()` 추가 및 Tauri `onDragDropEvent` → `workspace_register_open_file` → `openFile` 파이프라인 정상 연동.
- [x] **9. CLI 릴리즈 자동 등록 (`code` 처럼 동작)**
  - **해결:** NSIS 인스톨러(`installer-hooks.nsh`)가 `%LOCALAPPDATA%\Microsoft\WindowsApps\naia.cmd`를 자동 생성/업데이트하여, 설치 시 시스템 PATH에 즉시 등록되어 어디서든 `naia <file>`로 동작함.

---

## 🚀 에픽: AI 연동 강화 (Epics - 이슈 #680 완료)

- [x] **10. AI의 워크스페이스/Herdr 컨텍스트 읽기 인지 (Context Awareness)**
  - **해결:** `EditorHandle`에 `getCursorLocation` 추가, `TerminalHandle`에 `getBufferText` 추가, `naia.pushContext` 및 `skill_workspace_get_open_file`에 `openDocs`, `cursor`, `terminalTail` 주입 연동 완료.
- [x] **11. AI의 UI 컨트롤 및 가시적 터미널 명령 연동 (Action & Control)**
  - **해결:** `skill_workspace_terminal_exec` (사용자 화면에서 보이는 Herdr 터미널로 명령 전달), `skill_workspace_get_terminal_output`, `skill_workspace_set_surface`, `skill_workspace_close_file`, `skill_workspace_focus_space` 구현 및 `MODEL_FACING_TOOL_KEEP_LIST` 등록 완료.
