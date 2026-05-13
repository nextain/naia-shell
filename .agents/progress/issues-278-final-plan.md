# Naia Workspace Redesign — Final Plan
# Issue #278: Project Context Awareness

## Core Principle

> **이슈 = 컨텍스트 단위**
> 1 PTY : 1 Issue : 1 Agent

모든 설계 결정은 이 원칙에서 파생됨.

---

## Architecture

```
GitHub Issue        ← 이슈 트래킹 (원래 용도), 공개 요약만
Naia 계정           ← 작업 컨텍스트 (이슈 열린 동안만)
PTY (로컬)          ← 실행 환경, 재시작 복원용 최소 상태
```

### 데이터 흐름

```
사용자가 이슈 #278 작업 시작
  → PTY 생성 (dir: ~/dev/naia-os)
  → git branch: issue-278 → issueId: 278 자동 감지
  → 프로세스 감지: claude 실행 중 → agent: "claude"
  → Naia 계정에 context 생성: { issueId: 278, dir, agent, goal }

작업 중
  → Naia가 주기적으로 context 업데이트
  → 민감 정보는 Naia 계정 암호화 저장 (GitHub에 안 올라감)

PC 이동 시
  → Naia 계정에서 active contexts 로드
  → PTY 복원 (dir, issueId, agent)

이슈 closed
  → Naia 계정에서 context 자동 삭제
  → 요약만 GitHub Issue 코멘트로 남김 (사용자 승인 후)
```

### Naia 계정 저장 구조 (per user)

```json
{
  "active_contexts": {
    "278": {
      "issueId": 278,
      "repo": "nextain/naia-os",
      "goal": "project context awareness",
      "dir": "~/dev/naia-os",
      "agent": "claude",
      "phase": "build",
      "decisions": ["이슈 = 컨텍스트 단위", "Naia 계정 저장"],
      "updatedAt": "2026-05-12T04:00:00Z"
    }
  }
}
```

용량: 이슈당 ~20-50KB → 20개 동시 진행 = ~1MB → 무료 티어 내 처리

---

## UI 레이아웃 변경

```
┌──────────┬────────────────────────────────┬──────────────┐
│          │  Editor (파일 뷰어)             │ Issues Panel │
│ FileTree │────────────────────────────────│              │
│  (좌)    │  Terminal Grid                 │ #278 claude  │
│          │  [#278 claude] [#270 opencode] │ #270 opencode│
│          │  [#264 claude] [    + 추가   ] │              │
└──────────┴────────────────────────────────┴──────────────┘
```

### 터미널 탭 배지

```
[#278 claude ●]   ← 이슈번호 + 에이전트 + 활성 상태
[#270 opencode]
[    + 새 터미널]
```

### 우측 Issues Panel

```
[열린 이슈]
┌─────────────────────────────┐
│ #278 ● project context      │ ← Naia 계정 컨텍스트 있음
│      claude | ~/dev/naia-os │
│ #270 ● tabbar UX overhaul   │
│      opencode | ~/dev/...   │
│ #264   file explorer bug    │ ← 터미널 미연결
└─────────────────────────────┘
[모든 이슈 보기]
```

클릭 시: Naia 채팅에 해당 이슈 컨텍스트 자동 로드

---

## 구현 Phases

### Phase 1 — Issues Panel + 터미널 배지 [즉시 시작]

**목표**: 우측에 이슈 목록, 터미널에 이슈 배지

**구현:**
1. `IssuesPanel.tsx` 신규
   - `workspace_execute("gh issue list --json number,title,labels,state")`
   - 이슈 카드: 번호 / 제목 / 연결된 터미널
   - 클릭 → `onSendToChat(issueContext)`
   - gh CLI 없으면 graceful fallback ("GitHub CLI 필요" 안내)
   - 폴링: 5분 + 이슈 closed 시 수동 refresh

2. `TerminalTab` 확장
   ```ts
   interface TerminalTab {
     pty_id: string
     dir: string
     pid: number
     issueId?: number    // git branch에서 자동 감지
     agent?: AgentType   // 프로세스에서 자동 감지
   }
   ```

3. `WorkspaceCenterPanel.tsx` 수정
   - 우측 패널: SessionDashboard → IssuesPanel + Sessions(collapsible)
   - 터미널 탭 렌더링에 `#issueId agent` 배지 추가

4. Git branch 자동 감지 (Rust)
   - `workspace_get_branch(dir)` → `issue-278` → issueId: 278

5. 프로세스 자동 감지 (Rust)
   - `workspace_get_agent(pty_pid)` → child process 이름 → agent type

**파일:**
- `shell/src/panels/workspace/IssuesPanel.tsx` (신규, ~200줄)
- `shell/src/panels/workspace/WorkspaceCenterPanel.tsx` (수정)
- `shell/src-tauri/src/workspace.rs` (branch, agent 감지 추가)

---

### Phase 2 — Terminal Grid [Phase 1 이후]

**목표**: 여러 터미널을 한 화면에서 동시에 보기

**구현:**
- 터미널 1개: full width (현행 유지)
- 터미널 2개: 좌우 50:50
- 터미널 3-4개: 2×2 grid
- 비활성 pane: canvas pause (Visibility API) → 성능 최적화
- 중앙 상하 drag-resize: 에디터 ↔ 터미널 그리드 비율 조절

---

### Phase 3 — Session Persistence [Phase 2 이후]

**목표**: 앱 재시작 후 터미널 세션 복원 (VS Code 차별점)

**구현:**
- `tauri://close-requested` 시 `{ dir, issueId, agent }` 4개 필드만 저장
  - 스크롤백 저장 안 함 (에이전트 재실행 시 재생성)
  - Atomic write: temp file → rename
- 재시작 시 "이전 세션 3개 복원할까요?" 토스트
- 복원: 각 dir에 `workspace_new_session` 호출

---

### Phase 4 — Naia 계정 Context Sync [Phase 3 이후]

**목표**: 크로스 PC 작업 컨텍스트 동기화

**구현:**
- `naia.nextain.io` API: `PUT /contexts/{issueId}`, `GET /contexts/active`
- 저장: goal, decisions, phase, dir, agent (민감 정보 암호화)
- 이슈 closed → context 자동 삭제
- GitHub 코멘트: 사용자 승인 후만 게시, 민감 정보 필터링 자동

---

## Build Order (PM 리뷰 반영)

Phase 1 + 2 동시 개발 권장 (이슈 패널만으론 value 반감)
Phase 4는 naia.nextain.io API 준비 필요

```
Phase 1 (Issues Panel + 배지)  ← 즉시
Phase 2 (Terminal Grid)        ← Phase 1과 병행
Phase 3 (Persistence)          ← P1+2 완료 후
Phase 4 (Naia 계정 Sync)       ← 별도 API 개발 필요
```

## 보류 (v1 제외)

- Drift detection (Phase 4 원안) — v1에서 제외, 별도 이슈
- Issue 코멘트 자동 작성 — Phase 4 이후
- 다중 레포 동시 조회 — Phase 1은 현재 레포만

---

## 핵심 차별점 vs VS Code

| | VS Code | Naia OS |
|---|---|---|
| 터미널 재시작 후 | 전부 사라짐 | 복원됨 |
| 터미널이 뭐하는지 | 모름 | #278 claude 표시 |
| 여러 에이전트 동시 | 탭 전환 필요 | 그리드로 한눈에 |
| 작업 컨텍스트 | 없음 | Naia 계정에 보존 |
| PC 이동 시 | 처음부터 다시 | 이슈 클릭 → 복원 |
