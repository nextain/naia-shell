<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Naia Project Rules

> SoT: `.agents/context/agents-rules.json`

## Project Identity

- **Name**: Naia
- **Nature**: Bazzite-based personal AI OS with virtual avatar
- **Philosophy**: OS itself is the AI's tool. Assemble, don't build from scratch.
- **Core concept**: USB boot -> Naia avatar greets -> AI controls OS

## Design Principles

All rules in this file derive from these four principles. AI agents must understand WHY rules exist, not just follow them mechanically.

### Four Pillars

| Pillar | Meaning |
|--------|---------|
| **Simple** | No unnecessary complexity. Code explains itself. Minimal abstraction. |
| **Robust** | Handles edge cases. Fails gracefully. Tests are diagnostic tools that verify this -- not scoreboards to pass. |
| **Debuggable** | Sufficient debug logging from BUILD TIME (not added after bugs appear). Every failure is diagnosable from the first occurrence. |
| **Extensible** | New providers/features added without modifying existing code. Provider registry pattern. |

**Abstraction rule**: Abstraction is a tool to achieve these four principles, not a goal in itself.

**Examples**: LLM/STT/TTS provider registry (#51, #60), Gateway interface abstraction (#64).

### AI Behavioral Traps

Known AI tendencies that violate the four principles:

| Trap | Description | Counter |
|------|-------------|---------|
| **Optimistic code** | AI writes only happy-path code, assuming all calls succeed and all inputs are valid. | Consciously implement error paths during BUILD, not after failures are discovered. |
| **Goal fixation** | AI converges on the most measurable goal (test pass, build success) and loses sight of the actual purpose. | Before acting, ask: what is the PURPOSE of this test/log/review? Act on the purpose, not the metric. |
| **Success bias reporting** | AI reports uncertain states as "complete" or "working". E.g., marking work done when E2E was not actually run. | If not verified, it is not complete. Report honestly: "E2E blocked by X, implementation done but unverified." |
| **Front-back inconsistency** | Sequential generation causes earlier code/comments to contradict later code in the same file. | Iterative review catches this. Re-read the full file after writing, check for internal consistency. |
| **Compaction identifier loss** | When context compresses, AI rewrites identifiers from memory — issue numbers get wrong, UUIDs get truncated, file paths get guessed. | Preserve all opaque identifiers exactly as found in files/tools: issue numbers, UUIDs, file paths, API keys, hostnames, URLs, port numbers. If unsure, read the source file rather than recalling. |
| **PII in public repo** | AI uses real user names, addresses, family info, company names in test data, examples, or documentation committed to public repos. | This is a PUBLIC open-source repo. NEVER use real personal information (maintainer names, addresses, family, company names) in any committed file. Always use fictional personas (e.g., 김하늘). If real data is needed, it belongs in private repos only (docs-business, etc.). |

---

## Architecture (4 Layers)

| Layer | Technology | Role |
|-------|-----------|------|
| Shell | Tauri 2 + Three.js | Avatar UI, user interaction |
| Agent | Node.js | LLM connection, tools, sub-agents |
| Gateway | WebSocket daemon | Channels, Skills, memory |
| OS | Bazzite (Fedora Atomic) | Immutable OS, BlueBuild |

### Communication

```
Shell <-stdio JSON lines-> Agent Core
Shell <-WebSocket-> Gateway <-stdio-> Agent Core
Gateway <-channel SDK-> Discord, Telegram, etc.
```

### Source Directories

```
naia-os/
├── shell/      # Tauri desktop app (Avatar + UI)
├── agent/      # AI agent core
├── gateway/    # Always-on daemon
└── os/         # BlueBuild recipe + systemd
```

---

## Coding Conventions

### Languages & Runtime
- **TypeScript**: Shell frontend, Agent, Gateway
- **Rust**: Tauri backend
- **Package manager**: pnpm (monorepo workspaces)
- **Runtime**: Node.js 22+

### Formatter: Biome
- Indent: tab
- Quotes: double
- Semicolons: always
- Trailing comma: always
- Line width: 100

### Naming

| Target | Style | Example |
|--------|-------|---------|
| Files/directories | kebab-case | `agent-core.ts` |
| Classes | PascalCase | `AvatarRenderer` |
| Functions | camelCase | `sendMessage()` |
| Constants | UPPER_SNAKE_CASE | `MAX_RETRIES` |
| Types/interfaces | PascalCase | `AgentConfig` (no I- prefix) |
| Rust files | snake_case | `stdio_bridge.rs` |

### Import Order
1. Node.js builtins
2. External packages
3. Internal modules
4. Relative paths

### Comments
- Code comments: English
- Docs: Korean (maintainer language)
- No comments on self-evident logic

### Error Handling
- Validate only at system boundaries (user input, external APIs, LLM responses)
- Rust: `Result<T, Error>` pattern
- TypeScript: try-catch at boundaries

---

## Testing

### Philosophy
**Integration-first TDD.** Test real usage scenarios first.

### TDD Cycle
```
Wrong: unit test helpers -> implement -> integrate later
Right: write integration/E2E test (RED) -> minimal code (GREEN) -> REFACTOR
```

### Test Code Review Rule
Test code MUST be iteratively reviewed before trusting results. Faulty test logic masks real bugs.
- Write test → review test code (assertions correct? target accurate? edge cases?) → fix → re-review → TWO consecutive clean passes → run
- After pass: re-confirm "does this test actually validate the intended behavior?"
- Why: Incorrect test logic causes tests to pass while real bugs remain hidden.

### Test Attitude

Tests exist to make the implementation complete and correct — not to be passed. Test code itself can be wrong and may not be maintained. Tests are not always right. A failing test means "investigate", not "fix the implementation to match".

**On failure:**
1. Read FULL test output (error message, stack trace, actual vs expected)
2. Read the IMPLEMENTATION to understand the intended behavior and WHY it was written that way
3. Read the TEST to understand what behavior it claims to verify
4. Diagnose: is the failure in app code or test code? Understand the business logic FIRST.
5. If app code → fix app code, re-run test
6. If test code → fix test code, re-run test
7. Record diagnosis in progress file (`test_findings`)

**Anti-patterns:**
- Loosening assertions (e.g., `===` to `includes`, removing checks) to make a failing test pass
- Modifying expected values to match buggy actual output
- Deleting or skipping failing test cases without investigation
- Reporting "tests pass" without reading what the tests actually verified
- **CRITICAL: Changing implementation to match a failing test WITHOUT reading the code context** — the test may be wrong. A test name like "strips X" does not prove that stripping is the correct behavior; the implementation may intentionally do something different for a valid reason. Always read the implementation first and understand WHY it works the way it does before deciding which side to fix.

**Why:** Goal fixation causes AI to treat "pass" as the objective. The actual objective is understanding system state. A passing test with wrong assertions is worse than a failing test with correct assertions. Fixing the implementation to match a wrong test DELETES working features silently.

### Frameworks

| Type | Framework |
|------|-----------|
| Unit/integration | Vitest |
| E2E (Shell) | @tauri-apps/cli (tauri-driver) + WebDriver |
| E2E (OS) | QEMU VM boot (libvirt in CI) |
| Mocking | msw (Mock Service Worker) |
| Rust | cargo test |

### Test File Locations

```
<module>/__tests__/*.test.ts      # Unit
tests/integration/*.test.ts       # Integration
tests/e2e/*.spec.ts               # E2E
<crate>/src/*.rs                  # Rust (#[cfg(test)])
```

### E2E Scenarios

**Shell:**
- App launch -> avatar render -> idle animation
- Message input -> LLM response -> lip-sync
- File edit request -> permission approval -> file modified
- App crash -> auto-restart -> session restored

**Agent:**
- stdin message -> LLM call -> stdout streaming response
- Tool call -> permission check -> execution -> result
- Sub-agent spawn -> parallel execution -> results merged

**OS:**
- ISO boot -> login -> Naia Shell auto-starts
- First boot -> onboarding wizard -> API key setup -> first chat

### Test Commands

```bash
pnpm test:unit         # Unit tests
pnpm test:integration  # Integration tests
pnpm test:e2e          # E2E tests
pnpm test              # All
pnpm test:coverage     # With coverage
```

### Coverage Goals
- Agent Core: 80%+
- Shell components: 70%+
- Gateway: 80%+
- E2E: all critical user flows

---

## Logging

### TypeScript (Shell frontend, Agent)

**Forbidden**: `console.log`, `console.warn`, `console.error`

```typescript
import { Logger } from "./logger"; // shell/src/lib/logger.ts

Logger.debug("[AgentCore] Processing message", { id });
Logger.info("[AgentCore] LLM response received", { model, tokens });
Logger.warn("[Gateway] Channel reconnecting", { channel: "discord" });
Logger.error("[Shell] Avatar render failed", error);
```

| Level | Purpose |
|-------|---------|
| debug | Dev debugging (stripped in production) |
| info | Important operations completed, state changes |
| warn | Potential issues, degraded performance |
| error | Actual errors, exceptions |

### Rust (Tauri backend -- `shell/src-tauri/src/lib.rs`)

**Forbidden**: raw `eprintln!`, `println!`

| Function | stderr | File | Use for |
|----------|--------|------|---------|
| `log_both` | always | always | Session start/end, errors, auth events, critical state changes |
| `log_verbose` | debug builds only | always | Path discovery, PID, env vars, progress, window state |
| `log_to_file` | never | always | High-frequency internal events |

**Security**: Never log API keys, tokens, passwords. Mask env var values with `***`.

**Log file location**: `~/.naia/logs/` (naia.log, gateway.log, node-host.log)

### Debug Logging

**When**: Debug logging is a BUILD-TIME activity, not a DEBUG-TIME activity. Add logging DURING implementation, not after problems are discovered. If logging is added only after a problem occurs, the first occurrence is always undiagnosed. Build-time logging ensures every failure is diagnosable from the first occurrence.

**Build-time checklist:**
- Every new async operation: log start, success, failure with context
- Every new state transition: log before and after values
- Every new external call (API, IPC, file I/O): log request and response summary
- Every new error handling path: log the error with full context

**Anti-pattern**: Adding `Logger.debug()` calls only after a bug is reported or test fails.

**Principles:**
- Every async wait/poll must log what it is waiting for and current state
- UI blocking states (modals, dialogs, loading spinners) must be captured in traces
- State transitions must be logged with before and after values
- Timeout errors must include full context: expected, found, elapsed time

### Audit Log
- **Purpose**: Record all AI actions for security and transparency
- **Storage**: `~/.naia/audit.db` (SQLite)
- **Fields**: timestamp, tier, action, target, result
- **Retention**: 90 days default

---

## Security

### Permission Tiers

| Tier | Policy | Examples |
|------|--------|---------|
| **0: Free** | No confirmation | File read, info queries, conversation, search |
| **1: Notify** | Post-execution report | File create/modify (in ~/), non-destructive commands, app launch |
| **2: Approve** | Pre-execution confirmation | File delete, package install/remove, system config, git push |
| **3: Blocked** | Never allowed | System file modification, other user data, security settings, credential exfiltration |

### Sandbox
- **Default scope**: User home directory only
- **Dangerous commands**: Run in Podman disposable container
- **Network isolation**: Sensitive operations in network-restricted container

### OS Security
- **Immutable base**: rpm-ostree prevents system corruption, rollback available
- **SELinux**: Enforcing mode, per-process access control
- **Flatpak**: App sandboxing
- **Podman**: Rootless containers

### Credentials
- **Storage**: `~/.naia/credentials/` (encrypted)
- **Rule**: Agent can USE keys but never SEE or TRANSMIT raw values
- **Never log**: API keys, tokens, passwords

### Remote Access
- **Default**: localhost only (127.0.0.1)
- **Allowed**: Tailscale VPN or SSH tunnel
- **External channels**: Discord/Telegram limited to Tier 0-1

---

## Development Process

### Branch Strategy

```
main <- Stable, always deployable (BlueBuild builds from main)
  └── dev <- Integration branch
        └── issue-{N}-{desc} <- Feature branches (short-lived, PR to dev)
```

**Workspace Isolation:**

| Mode | When | Command |
|------|------|---------|
| **Worktree** (default) | Concurrent work — multiple issues active simultaneously | `git worktree add ../{project}-issue-{N}-{desc} issue-{N}-{desc} dev` |
| **Branch only** | Solo work — only one issue at a time | `git checkout -b issue-{N}-{desc} dev` |

**Long-lived Branch Policy:**

- Feature branches MUST NOT diverge from main for more than 2 weeks without rebasing.
- Lesson: `issue-4-windows-support` diverged for months (69 commits), caused 13-file merge conflict.
- Before merging a stale branch: analyze full scope first, categorize commits by topic, identify pattern superiority — never resolve conflicts file-by-file.
- Prevention: weekly rebase, or create a new branch from current main if paused >2 weeks.

### Commit Convention

```
<type>(<scope>): <description> (#<issue>)

types: feat, fix, refactor, test, docs, chore, ci
scopes: shell, agent, gateway, os, context

⚠️ Issue reference is MANDATORY.
  - Append (#N) to the first line (N = GitHub Issue number)
  - Add "Closes #N" in commit body for the final commit
  - Exceptions: merge commits, initial repository setup

Examples:
feat(shell): add VRM avatar idle animation (#36)
fix(agent): handle LLM timeout gracefully (#26)
ci(os): add BlueBuild GitHub Action (#12)
```

### Optional Trailers

Add to commit body **only when context is non-obvious** and would take significant investigation to rediscover. Not required on every commit.

**Trigger**: If progress file has `rejected_alternatives[]` or `constraints_discovered[]` — distill them into trailers at commit time.

| Trailer | Format | Purpose |
|---------|--------|---------|
| `Rejected:` | `<approach> \| <reason>` | Approach considered but discarded |
| `Constraint:` | `<constraint>` | Technical/architectural constraint that shaped the decision |
| `Directive:` | `<warning>` | Forward-looking instruction for the next AI session |
| `Assisted-by:` | `<tool>` | AI tool used (encouraged for transparency) |

```
feat(shell): fix audio recording in WebKitGTK (#79)

Rejected: AudioContext({sampleRate:16000}) | WebKitGTK freezes audio to zeros
Constraint: WebKitGTK AudioContext — default sampleRate only, SW downsampling required
Directive: Do not hardcode sampleRate in AudioContext for this platform
Assisted-by: Claude Sonnet 4.6
```

### PR Process
1. Concurrent work: `git worktree add ../{project}-issue-{N}-{desc} issue-{N}-{desc} dev` (worktree + branch from dev)
   Solo work: `git checkout -b issue-{N}-{desc} dev` (simple branch from dev)
2. Write tests first (TDD)
3. Implement minimal code
4. Ensure all tests pass
5. PR to dev with description
6. Squash merge
7. Periodic dev -> main merge for release

### CI Pipeline

| Trigger | Steps |
|---------|-------|
| push | lint, typecheck, unit tests, build |
| PR | above + integration tests |
| main merge | above + E2E + BlueBuild image + ISO generation |

### Code Review

AI review encouraged; human review required for security-critical changes.

**Fix policy:** All issues found during review MUST be fixed — regardless of whether they are bugs or code quality improvements. Do not defer "non-bug" findings. If it was worth identifying, it is worth fixing.

**Code quality:**
- [ ] Tests added/updated for new behavior?
- [ ] No duplicate code (same logic in 2+ places)?
- [ ] No unused imports/functions/files (knip clean)?
- [ ] No zombie code from previous implementation?
- [ ] Structured logger used (no console.log)?
- [ ] New code paths have sufficient debug logging (async ops, state transitions, external calls, error paths)?

**Security:**
- [ ] Correct permission tier for new tools?
- [ ] Audit log records new AI actions?
- [ ] No hardcoded credentials or API keys?
- [ ] Podman sandbox for dangerous operations?
- [ ] External network access justified?
- [ ] LLM prompt changes reviewed for safety?

**Architecture:**
- [ ] Code in the correct module (shell/agent/gateway/os)?
- [ ] stdio protocol changes backwards compatible?
- [ ] No unnecessary new files (could extend existing)?
- [ ] Still understandable 6 months from now?

---

## Context Management

### Dual-Directory Architecture
```
.agents/   -> AI-optimized (English, JSON/YAML, token-efficient)
.users/    -> Human-readable (English default, Markdown; .users/context/ko/ for Korean)
```

### Rules
- **SoT**: `.agents/context/agents-rules.json` is the single source of truth
- **Mirroring**: Changes to `.agents/` must be reflected in `.users/` and vice versa
- **On-demand loading**: Read workflow files only when performing specific tasks
- **Always read**: `agents-rules.json`
- **On-demand**: `workflows/*`, `skills/*`

### Cascade (Propagation) Rules
- Context change -> update `.users/` mirror
- Module added -> update parent index
- Rule change -> propagate to all dependent contexts
- **Order**: self -> parent -> siblings -> children -> mirror

### Harness Engineering

Mechanical enforcement of project rules via Claude Code hooks.
Text rules get forgotten; mechanical enforcement doesn't.

**Hooks** (`.claude/hooks/`):

| Hook | Trigger | Purpose |
|------|---------|---------|
| `sync-entry-points.js` | Edit\|Write on entry points | Auto-sync CLAUDE.md ↔ AGENTS.md ↔ GEMINI.md |
| `cascade-check.js` | Edit\|Write on context files | Remind triple-mirror updates |
| `commit-guard.js` | Bash with `git commit` | Warn if committing before sync_verify; checks gate_approvals + phase order; upstream contribution advisory when upstream_issue_ref is set |
| `process-guard.js` | Stop (response end) | Block review-completion claims without actual Read/Grep/Glob calls |

**Progress Files** (`.agents/progress/*.json`):
- Session handoff JSON — survives context compaction and session boundaries
- Gitignored (session-local only, not committed)
- Schema: issue, title, project, current_phase, gate_approvals, decisions, surprises, blockers, review_evidence

**Tests**: `bash .agents/tests/harness/run-all.sh` (77 tests)

Detail: `.agents/context/harness.yaml`

---

## AI Workflow

- **Response language**: Contributor's preferred language (Korean default for maintainer)
- **Pre-work mandatory**: Read `agents-rules.json`
- **Identify work scope**: shell / agent / gateway / os
- **TDD mandatory**: Integration-first
- **Security check**: Verify tier for new tools/commands

### Work Logs
- **Location**: `work-logs/` (gitignored, project-internal)
- **Format**: `YYYYMMDD-{number}-{topic}.md`
- **Convention**: `{username}/` subdirectory per contributor
- **Language**: Contributor's preferred language

## 금융 무결성 (Financial Integrity)
- **비용 추산 우선**: 대규모 클라우드 작업 전 반드시 비용 산출 및 사용자 승인 필수.
- **고비용 작업 블랙리스트**: GCS 10GB+ 이동, 1,000+ API 호출, 고성능 GPU 생성, 배치 추론 등.
