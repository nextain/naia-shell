# naia-adk Integration — Phase 3: Business Operations Hub

> Design document for #227 Phase 3.  
> Prerequisites: Phase 1 (Viewer) ✅, Phase 2 (Skill Executor) ✅

## Goal

All AI-assisted business operations managed from Naia Shell — from the current CLI-based workflow (opencode, Claude Code) to a unified desktop experience.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Naia Shell (Tauri)                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ FileTree  │  │  Editor  │  │ SkillLauncher │  │
│  └──────────┘  └──────────┘  └───────┬───────┘  │
│                                       │          │
│  ┌────────────────────────────────────▼───────┐  │
│  │           Session Manager                   │  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐      │  │
│  │  │Session 1│ │Session 2│ │Session 3│      │  │
│  │  │(review) │ │(patent) │ │(weekly) │      │  │
│  │  └─────────┘ └─────────┘ └─────────┘      │  │
│  └────────────────────────────────────────────┘  │
│                    │ IPC                         │
│  ┌─────────────────▼──────────────────────────┐  │
│  │  Rust Backend                               │  │
│  │  - workspace_* commands                     │  │
│  │  - PTY management                           │  │
│  │  - File watching                            │  │
│  └────────────────────────────────────────────┘  │
│                    │ HTTP                        │
│  ┌─────────────────▼──────────────────────────┐  │
│  │  naia-adk Server (Fastify :3141)            │  │
│  │  - /api/workspace/*                        │  │
│  │  - /api/skills/*                           │  │
│  │  - /api/files/*                            │  │
│  │  - /api/ws/* (WebSocket)                   │  │
│  └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

## Phase 3 Tasks (dependency order)

### P3-5: Agent Session Manager (foundation)
**Priority: First** — all other P3 tasks depend on this.

- Multi-session PTY management (up to 3 concurrent)
- Per-session state isolation (CWD, env, history)
- Session lifecycle: create → run → pause → resume → close
- Session-to-skill binding (which skill launched this session)
- Token usage tracking per session

**Key files:**
- `shell/src-tauri/src/workspace.rs` — add session management commands
- `shell/src/panels/workspace/SessionDashboard.tsx` — enhance with skill info
- `shell/src/lib/session-manager.ts` — new session orchestration layer

### P3-2: Skill-to-Session Wiring
**Depends on: P3-5**

- When "실행" is clicked in SkillLauncher:
  1. Create new PTY session with skill-specific CWD
  2. Inject SKILL.md content as system prompt
  3. Apply SkillTemplate (tools, maxTurns, model)
  4. Track session → skill mapping
- Session shows in SessionDashboard with skill badge
- Skill sessions are grouped separately from manual terminals

**Key files:**
- `shell/src/panels/workspace/SkillLauncher.tsx` — `onLaunchSkill` → create session
- `shell/src/panels/workspace/WorkspaceCenterPanel.tsx` — wire callback
- `shell/src-tauri/src/workspace.rs` — `workspace_create_skill_session` command

### P3-1: Skill Execution Monitor
**Depends on: P3-2**

- Real-time progress display for skill sessions
- Token usage bar (prompt vs completion)
- Phase tracking (from `.agents/progress/*.json`)
- Error/timeout indicators
- Auto-refresh on file changes via WebSocket

**Key files:**
- `shell/src/panels/workspace/SessionDashboard.tsx` — add progress cards
- `shell/src/panels/workspace/SessionCard.tsx` — skill-specific card variant

### P3-3: Business Operations Dashboard
**Depends on: P3-1**

- Overview of all business operations across sessions
- Recent activity timeline (patent filed, document generated, etc.)
- Quick-launch tiles for common operations
- Template library (proposal templates, patent templates, etc.)

**Key files:**
- `shell/src/panels/workspace/OperationsDashboard.tsx` — new component
- `naia-adk/packages/dashboard/` — enhance Next.js dashboard

### P3-4: naia-adk Server Integration
**Depends on: P3-3**

- naia-os connects to naia-adk Fastify server at startup
- Dashboard embedded as webview panel
- API proxy for skill execution from dashboard
- Bi-directional sync: naia-adk ↔ naia-os state

**Key files:**
- `shell/src-tauri/src/workspace.rs` — server discovery + health check
- `naia-adk/packages/server/` — CORS for naia-os origin

## API Surface (naia-adk Server)

```
GET  /api/health                    — health check
GET  /api/workspace/meta            — workspace metadata
GET  /api/workspace/index           — project-index.yaml
GET  /api/workspace/tree?depth=N    — file tree
GET  /api/workspace/classify        — classified dirs
GET  /api/skills                    — list skills
GET  /api/skills/:name              — skill metadata
GET  /api/skills/:name/content      — SKILL.md raw content
GET  /api/files/*                   — file content/listing
WS   /api/ws/*                      — file change stream
```

## Risks

| Risk | Mitigation |
|------|-----------|
| Multi-session PTY memory usage | Limit to 3 concurrent, auto-cleanup idle |
| Skill template drift from actual SKILL.md | Template as defaults, SKILL.md overrides |
| naia-adk server not running | Auto-discover + auto-start + fallback |
| Token cost tracking accuracy | Use OpenAI usage API, not estimated |

## Open Questions

1. Should skill sessions use the gateway (naia-anyllm) or direct API keys?
2. How to handle skills that require user input mid-execution?
3. Should the dashboard be embedded (webview) or native (React)?
