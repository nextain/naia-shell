<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Phase 3: OpenClaw Hybrid Integration Plan (ARCHIVED — pre-#201)

> ⚠️ **This plan is historical**. The OpenClaw gateway daemon was removed in
> #201, and the hybrid integration was reconciled in #272 / #273 / #274 /
> #271 Phase 1. Current architecture is documented in:
>
> - [`.agents/context/agent-bridges.yaml`](../../.agents/context/agent-bridges.yaml) — SoT for the current shell↔agent↔memory wire
> - [`.users/context/architecture.md`](./architecture.md) — current architecture doc (post-#201 status header at top)
>
> The rest of this document captures the original Phase 3 design rationale.
> Useful for understanding what was tried + why we moved away from it. Do
> not treat any of the steps below as actionable today.

> SoT: `.agents/context/phase3-plan.yaml` (also marked obsolete in plan.yaml step_4_0)
> Korean: `.users/context/ko/phase3-openclaw-hybrid-plan.md`

> "Alpha does the work" — file editing, command execution, web search — safely.

## 1. Design Philosophy

### Hybrid Approach

Borrow **optimal patterns only** from 3 reference projects. Naia Gateway daemon installation is deferred to Phase 4. Phase 3 executes tools directly inside the Agent process.

| Source | Borrowed | Not Borrowed |
|--------|----------|-------------|
| **project-careti** (Cline fork) | ToolHandler registry, AutoApprovalSettings UI pattern, requires_approval LLM hint, PreToolUse/PostToolUse hooks, .caretignore pattern | VS Code dependency, gRPC/protobuf, Plan/Act mode |
| **ref-opencode** | tree-sitter bash parsing, BashArity dictionary (160+), pattern-based permission (wildcards), once/always/reject 3-level, Zod schema validation, doom loop detection, output truncation | Bun runtime, Solid.js TUI, SQLite sessions, MCP (Phase 4) |
| **ref-moltbot** (OpenClaw) | Gateway protocol reference (Phase 4 prep), config preset structure | Gateway daemon, channels, device auth, mDNS |

### Origin Tracking Rules (Merge-friendliness)

All borrowed code has an **ORIGIN comment header**:

```typescript
// ORIGIN: ref-opencode/packages/opencode/src/permission/arity.ts
// PURPOSE: Command arity dictionary for "always allow" pattern scoping
// MODIFICATIONS: Removed Bun-specific imports, added naia-specific commands
```

---

## 2. Conflict Analysis (3-System Hybrid)

### 2.1 Permission Model Conflict

| Area | project-careti | ref-opencode | Resolution |
|------|---------------|-------------|-----------|
| **Approval unit** | Per-tool toggle (readFiles, editFiles...) | Per-command wildcard (`npm *`) | **2-layer**: tool-type toggle (UI) → pattern matching (fine control) |
| **LLM hint** | `requires_approval` parameter (LLM decides) | None (rules only) | **Both**: LLM hint + rule evaluation. Auto-approve only when both allow |
| **"Always allow"** | Yolo mode (global ON/OFF) | Per-pattern always (`npm install *`) | **OpenCode approach**. Yolo mode = shortcut for "all always" |
| **On reject** | Simple rejection (empty response) | reject + feedback message | **OpenCode approach**. Rejection feedback forwarded to LLM |

**Final permission evaluation flow**:
```
1. Tool-type toggle check (OFF in Settings → immediate block)
2. Tier 3 hard-block check (rm -rf /, sudo, etc.)
3. tree-sitter command analysis (bash tool only)
4. Pattern ruleset evaluation (allow/deny/ask)
5. LLM requires_approval hint reference
6. On ask → send approval request to Shell
```

### 2.2 Tool Interface Conflict

| project-careti | ref-opencode | Resolution |
|---------------|-------------|-----------|
| `IToolHandler { name, execute, getDescription }` | `Tool.Info { id, init → { description, parameters, execute } }` | **Hybrid**: Careti registry structure + OpenCode Zod parameter validation |

### 2.3 Protocol Conflict

| Current (Naia) | Careti | OpenCode | Resolution |
|---------------|--------|----------|-----------|
| stdio JSON lines (text, audio, usage, finish, error) | gRPC/protobuf | HTTP + SSE | **Extend existing stdio**. Add new chunk types only |

New chunk types (backward-compatible):
```typescript
| { type: "tool_use"; requestId: string; toolId: string; args: Record<string, unknown> }
| { type: "tool_result"; requestId: string; toolId: string; output: string; success: boolean }
| { type: "approval_request"; requestId: string; approvalId: string; toolId: string; description: string; tier: number }
| { type: "approval_response"; requestId: string; approvalId: string; decision: "once" | "always" | "reject"; message?: string }
```

### 2.4 Security Model Conflict

| agents-rules.json (Tier 0-3) | Careti (safe/risky) | OpenCode (rule + pattern) | Resolution |
|------|------|------|------|
| 4-level fixed hierarchy | LLM 2-level judgment | Dynamic rule-based | **3-layer combination**: Tier hardcoded → pattern ruleset → LLM hint |

---

## 3. Implementation Phases

Development cycle: **PLAN → CHECK → BUILD → VERIFY → CLEAN → COMMIT** (per sub-phase)

### Phase 3.1: Tool Framework + Protocol Extension
**Goal**: Build tool registry and execution framework in Agent. Zero tools, framework only.

### Phase 3.2: LLM Function Calling (Gemini first)
**Goal**: Enable LLM tool calling. Start with Gemini, extend to Claude/xAI.

### Phase 3.3: Basic Tools (5)
**Goal**: Implement file_read, file_write, glob, grep, bash tools.

### Phase 3.4: Shell UI — Tool Display + Approval Modal
**Goal**: Display tool execution state in chat, modal confirmation for approval-required actions.

### Phase 3.5: Full Integration + Settings Tool Section
**Goal**: Agent ↔ Shell full connection, tool configuration in Settings.

---

## 4. File Changes

### New Files (18)
- `agent/src/tools/` — types, registry, permission, permission-rules, tool-loop
- `agent/src/tools/handlers/` — file-read, file-write, glob, grep, bash
- `agent/src/tools/bash/` — parser, arity, blocked
- `shell/src/components/` — ToolProgress, PermissionModal + tests

### Modified Files (10)
- `agent/src/protocol.ts`, `providers/types.ts`, `providers/gemini.ts`, `providers/anthropic.ts`, `providers/xai.ts`, `index.ts`, `package.json`
- `shell/src/lib/types.ts`, `config.ts`, `components/ChatPanel.tsx`, `stores/chat.ts`, `components/SettingsModal.tsx`, `src-tauri/src/lib.rs`

---

## 5. Dependencies

```json
{
  "dependencies": {
    "zod": "^3.23.0",
    "web-tree-sitter": "^0.24.0",
    "tree-sitter-bash": "^0.23.0"
  }
}
```

---

## 6. Implementation Order

| # | Sub-phase | Branch | Commit Message |
|---|-----------|--------|---------------|
| 1 | 3.1 Tool Framework | `feature/phase3-tool-framework` | `feat(agent): add tool registry and permission framework` |
| 2 | 3.2 Function Calling | `feature/phase3-function-calling` | `feat(agent): add LLM function calling support` |
| 3 | 3.3 Basic Tools (5) | `feature/phase3-basic-tools` | `feat(agent): implement file, glob, grep, bash tools` |
| 4 | 3.4 Shell UI | `feature/phase3-tool-ui` | `feat(shell): add ToolProgress and PermissionModal` |
| 5 | 3.5 Full Integration | `feature/phase3-integration` | `feat: integrate tool system end-to-end` |

Each sub-phase is independently testable and depends on the previous phase.

---

*AI context: [.agents/context/phase3-plan.yaml](../../.agents/context/phase3-plan.yaml)*
