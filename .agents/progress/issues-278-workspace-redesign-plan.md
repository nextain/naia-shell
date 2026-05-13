# Workspace Redesign + Issues Panel Plan
# Issue #278 + Layout Vision

## Context

이슈 #91 (IssueDesk — closed) + 이슈 #278 (project context awareness) + 사용자 레이아웃 비전 통합.

## Problem Statement

1. 우측 패널이 Claude Code 세션 카드만 표시 — GitHub 이슈와 연결 없음
2. 터미널이 탭 하나씩만 보임 — 다중 에이전트 동시 작업 시 컨텍스트 전환 비용
3. VS Code 고질적 문제: 재시작하면 모든 터미널 세션 소멸
4. Naia가 "지금 뭐 하고 있어?"를 답하려면 이슈-터미널 연결이 없음

## Target Layout (v1)

```
┌──────────┬────────────────────────────────┬──────────────┐
│          │  Editor (파일 뷰어)             │              │
│ FileTree │─────────────────────────────── │ Issues Panel │
│ (탐색기) │  Terminal Grid                 │  (우측)      │
│  (좌)   │  [T1] [T2] [T3] [T4]          │              │
│          │  (2열 그리드 또는 split pane)   │              │
└──────────┴────────────────────────────────┴──────────────┘
```

### 좌 (FileTree) — 현행 유지

### 중 — 레이아웃 변경
- 상단 절반: Editor (현행)
- 하단 절반: Terminal Grid
  - 현재: 탭 1개 full width
  - 변경: 탭 bar + split view (2열 또는 2x2)
  - 키 바인딩: Ctrl+Shift+T = 신규 터미널 추가, Ctrl+\ = 세로 분할

### 우 (Issues Panel) — 신규
- 현재: SessionDashboard (Claude Code 세션 카드)
- 변경: IssuesPanel + Sessions 통합
  - Section 1: Open Issues (GitHub API)
  - Section 2: Active Sessions (현행 SessionDashboard)
  - 이슈 클릭 → Naia에 컨텍스트 로드
  - 이슈-터미널 연결: 터미널 탭에 이슈 번호 배지

### 터미널 세션 복원 (vs VS Code 차별점)
- 앱 종료 시 pty_id, dir, issueId, scrollback 저장 (로컬 JSON)
- 재시작 시 "이전 세션 복원?" 토스트
- 실제 PTY는 재시작되나 스크롤백은 유지

---

## Phases

### Phase 1 — Issues Panel (우측 패널 교체) [이슈 #278 v1]
**목표**: 우측 패널에 열린 GitHub 이슈 목록 표시

**구현**:
1. `IssuesPanel.tsx` 신규 컴포넌트
   - `gh issue list --json number,title,state,labels,updatedAt` 호출
   - Rust 커맨드 `workspace_list_issues` (기존 `workspace_execute` 활용 가능)
   - 이슈 카드: #번호 / 제목 / 라벨 / 업데이트 시각
   - 클릭 시 `onSendToChat({ issueNumber, title, body })` 호출
2. `WorkspaceCenterPanel.tsx` 우측 패널 교체
   - Sessions 섹션 → 이슈 패널 상단 + Sessions 하단 (collapsible)
3. `WORKSPACE_TOOLS`에 `skill_workspace_list_issues` tool 추가

**갭 분석**:
- `gh` CLI가 Tauri 내부에서 실행 가능한지 확인 필요 (workspace_execute로 가능)
- GitHub auth token은 gh CLI keyring에서 가져옴 — 추가 설정 불필요
- 다중 레포 지원: `project-index.yaml`의 레포 목록 파싱

**파일**:
- `shell/src/panels/workspace/IssuesPanel.tsx` (신규)
- `shell/src/panels/workspace/WorkspaceCenterPanel.tsx` (수정)
- `shell/src/panels/workspace/index.tsx` (tool 추가)
- `shell/src/panels/workspace/workspace.css` (스타일)

---

### Phase 2 — Terminal Grid (중앙 하단 분할)
**목표**: 여러 터미널을 한 화면에서 동시에 볼 수 있는 그리드

**구현**:
1. `TerminalGrid.tsx` 신규 컴포넌트
   - `terminals: TerminalTab[]` prop
   - 1개: full width / 2개: 2열 / 3-4개: 2x2 grid
   - 각 pane에 현재 `Terminal.tsx` 재사용
   - 포커스된 pane에 border highlight
2. `WorkspaceCenterPanel.tsx` 중앙 영역
   - 상하 분할 (drag-resize 가능)
   - 상: Editor (현행)
   - 하: TerminalGrid

**TerminalTab 확장**:
```ts
interface TerminalTab {
  pty_id: string;
  dir: string;
  pid: number;
  issueId?: number;   // NEW: 연결된 이슈 번호
  label?: string;     // NEW: 사용자 지정 레이블
}
```

---

### Phase 3 — Terminal Session Persistence (VS Code 차별점)
**목표**: 앱 재시작 후 터미널 세션 복원

**구현**:
1. `session-store.ts` 신규
   - 앱 종료 이벤트(`tauri://close-requested`) listen
   - 현재 terminals 상태 → `~/.config/naia/session-store.json` 저장
   - 저장 항목: `{ dir, issueId, label, lastCommand, scrollback_last_100 }`
2. 재시작 시
   - `WorkspaceCenterPanel` mount 시 session-store.json 읽기
   - "이전 세션 3개를 복원할까요?" 토스트
   - 확인 시 각 dir에 `workspace_new_session` 호출

**Rust 추가**:
- `tauri::Manager::on_window_event` → `WindowEvent::CloseRequested` 훅으로 저장 트리거

---

### Phase 4 — Issue-Terminal Link + Naia Drift Detection
**목표**: 터미널과 이슈 연결, Naia가 drift 감지

**구현**:
1. 터미널 탭에 이슈 배지 표시 (`#278`)
2. `skill_workspace_get_sessions` 반환값에 `issueId` 포함
3. Naia tool `skill_workspace_watch_drift`
   - 특정 이슈의 터미널 scrollback을 30s 간격으로 샘플링
   - progress.json의 scope/plan 대비 비교
   - 이탈 감지 시 채팅 패널에 알림

---

## Build Order

```
Phase 1 (Issues Panel)     → 즉시 시작 가능, 가장 가시적 효과
Phase 2 (Terminal Grid)    → Phase 1과 병행 가능
Phase 3 (Persistence)      → Phase 2 완료 후
Phase 4 (Drift Detection)  → Phase 1 + 3 완료 후
```

## Key Risks

| 리스크 | 대응 |
|--------|------|
| gh CLI 없는 환경 | gh 없으면 "GitHub CLI 필요" 안내 + fallback graceful degradation |
| 다중 레포 이슈 수백개 | 페이지네이션 + "내 레포만 / 전체" 토글 |
| PTY scrollback 메모리 | 최대 100줄만 저장 |
| Terminal grid 성능 | 4개 xterm 동시 렌더링 → 비활성 pane은 canvas pause |
| false positive drift | 첫 버전은 알림 없이 시각적 표시만 |

## Success Criteria (v1)

- [ ] 우측 패널에 열린 이슈 목록 표시
- [ ] 이슈 클릭 → Naia 채팅에 컨텍스트 로드
- [ ] 터미널 2개 이상 열면 그리드로 표시
- [ ] 앱 재시작 후 "이전 세션 복원" 토스트
- [ ] `skill_workspace_list_issues` Naia tool 동작

## References

- Issue #91 (closed): IssueDesk panel 원안 — 이번 구현의 상위 호환
- Issue #278: project context awareness (현재 이슈)
- `shell/src/panels/workspace/WorkspaceCenterPanel.tsx`
- `shell/src/panels/workspace/SessionDashboard.tsx`
- `shell/src/panels/workspace/Terminal.tsx`
