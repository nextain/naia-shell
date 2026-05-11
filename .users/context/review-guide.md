# Naia OS — Code Review Guide

> **SPDX-License-Identifier: CC-BY-SA-4.0**
>
> AI context (source of truth): `.agents/context/review-guide.yaml`
> Korean mirror: `.users/context/ko/review-guide.md`
>
> This file **supplements** `agents-rules.json` (which remains the SoT).
> On any conflict, `agents-rules.json` wins.

Unified reference for all review dimensions. Apply at every review gate: per-phase self-review, PR human review, and adversarial cross-review. **All six dimensions must pass before merge.**

---

## When to Apply

| Gate | Trigger | Dimensions |
|------|---------|-----------|
| Per-phase review | After each build phase | Architecture, Conventions, Requirements |
| Pre-commit self-review | Before every commit | Conventions, Process, Security |
| CI automated (gate_2) | On PR creation | Biome, typecheck, tests, knip, gitleaks, cargo audit |
| PR human review (gate_3) | Before PR merge | **All six** |
| Post-merge (gate_4) | After dev → main | BlueBuild + OS smoke test (CI-only) |
| Adversarial cross-review | See mandatory triggers | All six (specialist profiles) |

**Pass criteria**: All applicable checklist items pass with **two consecutive clean passes**. Record each pass in `review_evidence[]` with files read and date.

**N/A policy**: A dimension may be marked N/A only when the change has no surface area for it. Write explicitly *which* items are N/A and *why* in `review_evidence[]`. N/A is a declaration, not a skip. Remaining applicable items must still achieve two clean passes.

---

## Dimension 1: Architecture Consistency

### Layer Definitions

| Layer | Purpose | Must NOT contain |
|-------|---------|-----------------|
| `shell` | UI, Tauri IPC handlers, avatar, panel system | Business logic, direct DB, LLM calls |
| `agent` | LLM connection, tools, sub-agent orchestration | UI state, WebSocket server |
| `gateway` | Always-on daemon, channels, memory, skills | Direct UI interaction, shell type imports |
| `os` | BlueBuild recipe, systemd, OS config | App-level code, runtime logic |

### Communication Contracts

- **shell → agent**: stdio JSON lines (Tauri spawns agent as child process) — semi-trusted
- **shell → gateway**: WebSocket `ws://localhost:18789` — semi-trusted
- **gateway → agent**: stdio JSON lines — semi-trusted; compromised gateway can inject tool calls
- **Tauri event payloads**: RUNTIME type guard required — TypeScript generic `listen<T>()` is compile-time only
- **New Tauri commands**: registered in `shell/src-tauri/capabilities/*.json`

### Panel System

Panels register via `panelRegistry.register()`. Tools in `descriptor.tools[]`, sent via `sendPanelSkills()`. Run `/verify-implementation` to check all panel-specific invariants (verify-* skills).

### Checklist

- [ ] Code in correct layer (shell / agent / gateway / os)?
- [ ] No cross-layer direct imports?
- [ ] stdio / WebSocket protocol changes backwards-compatible?
- [ ] New Tauri commands registered in capabilities?
- [ ] Panel tools declared in descriptor, not hardcoded in App.tsx?
- [ ] `/verify-implementation` — all verify-* skills pass?
- [ ] No unnecessary new files (could extend existing)?
- [ ] Understandable 6 months from now?

---

## Dimension 2: Coding Conventions

### Formatter (Biome)

```
indent: tab | quotes: double | semicolons: always | trailing_comma: all | line_width: 100
```

`pnpm biome check --diagnostic-level=error` — run before every commit.

### Naming

| Target | Convention |
|--------|-----------|
| Files / dirs | kebab-case |
| Components / classes | PascalCase |
| Functions / hooks | camelCase |
| Constants | UPPER_SNAKE_CASE |
| Types / interfaces | PascalCase, no `I-` prefix |
| Rust files | snake_case |

### Logging

**Forbidden**: `console.log`, `console.warn`, `console.error`, `console.debug`, `eprintln!`, `println!`

**Required (TypeScript)**: `Logger.info/warn/error/debug` — import path is relative to the file's location (not always `./lib/logger` — that's only correct from `shell/src/` level).

**Build-time rule**: logging added during implementation, not after bugs appear. Every new async op, state transition, and external call must have a Logger entry.

### Checklist

- [ ] Biome lint + format pass?
- [ ] All new files in kebab-case?
- [ ] No `console.log` / `console.debug` / `eprintln!`?
- [ ] Logger import path correct for file location?
- [ ] New async ops / state transitions / external calls have `Logger.debug`?
- [ ] Named imports — no new default exports?
- [ ] No unguarded `any` or `!` assertions?
- [ ] Error handling only at system boundaries?

---

## Dimension 3: Development Process Compliance

### Key Rules

- **Issue traceability**: every commit references `#N`
- **TDD**: test written before/alongside implementation
- **Gate compliance**: all **five** gates recorded before final commit: `understand`, `scope`, `plan`, `sync`, `close`
- **Branch target**: PR targets `dev` branch — NOT `main` directly
- **Context sync**: `.agents/` changes propagated to `.users/` mirror

### Checklist

- [ ] All commits reference a GitHub Issue (#N)?
- [ ] Tests written before / alongside implementation?
- [ ] All **five** gate approvals in progress file (including `close`)?
- [ ] PR targets `dev` branch, not `main`?
- [ ] `.agents/` changes reflected in `.users/` mirror?
- [ ] No zombie code (knip clean)?
- [ ] No unused imports / functions / files?
- [ ] TODO comments have issue number?

---

## Dimension 4: Security Threats

Evaluate actual attack feasibility — checklist pass alone is not sufficient. Any finding severity ≥ medium triggers adversarial cross-review.

### Threat Table

| Threat | Severity | Key Check |
|--------|----------|-----------|
| IPC injection via `listen()` | **High** | Runtime type guard on ALL `event.payload` |
| `tool_request` tier bypass | **High** | `handleToolRequest` calls `needsApproval()` before `executeTool()` |
| `panel_install` RCE via `file://` | **High** | Source URL restricted to HTTPS only |
| Asset protocol `**` scope → filesystem read | **High** | `assetProtocol.scope` must not contain `**` |
| `discord.com` in connect-src → exfiltration | **High** | Route Discord through gateway; remove from connect-src |
| Webhook URLs in stdio per-request | **High** | Credentials not transmitted per-request over stdio |
| CSP bypass (XSS → innerHTML) | **High** | Never render LLM output as raw HTML |
| Credential exposure in logs | **High** | No API keys / webhook URLs in Logger calls |
| Permission tier bypass (new tool) | **High** | All tools declare explicit `permission_tier` |
| Panel tool tier injection | **Medium** | Tiers validated at install time, not from live stdio |
| gateway → agent stdio injection | **Medium** | Agent validates message schema from all sources |
| Prompt injection / sub-agent laundering | **Medium** | External content demarcated; sub-agents cannot auto-approve Tier 2+ |
| Path traversal / execute_command bypass | **High** | Path validation; Podman sandbox for execute_command |
| Auto-update supply chain | **Medium** | minisign private key offline; update URL not changed without deliberate decision |
| Config file tampering by malicious panel | **Medium** | Security-sensitive configs validated against strict schema |

### Checklist

- [ ] All `event.payload` validated with **runtime** type guard (not TypeScript generic)?
- [ ] `handleToolRequest` calls `needsApproval()` before `executeTool()`?
- [ ] `panel_install` source restricted to HTTPS only (`file://` blocked)?
- [ ] `assetProtocol.scope` does NOT contain `**`?
- [ ] `discord.com` removed from `connect-src` or explicitly justified?
- [ ] No credential fields (webhook URLs, API keys) in stdio per-request messages?
- [ ] No `innerHTML` / `dangerouslySetInnerHTML` with unsanitized content?
- [ ] No credential fields in Logger calls?
- [ ] All new tools have explicit `permission_tier`?
- [ ] Panel tool tiers validated at install time?
- [ ] LLM system prompt changes reviewed for injection surface?
- [ ] `execute_command` uses Podman sandbox?
- [ ] Dev gateway URL not in production `tauri.conf.json`?
- [ ] Deep-link handler validates URL parameters as untrusted?
- [ ] External channel input limited to Tier 0–1?

---

## Dimension 5: Practical Tests

### Test Quality Rule

1. Write test → review assertions (strict? correct target? edge cases?)
2. Fix issues → re-review → **two consecutive clean passes on test code**
3. Only then run the test
4. After pass: confirm test validates behavior, not implementation detail

### When E2E Cannot Run

If E2E is blocked (missing API key, hardware, gateway): mark item **DEFERRED** (not PASS). Document the blocker in `progress.blockers[]`, link the skipped path. DEFERRED items must pass before merge approval.

### Required Coverage by Type

**UI component**: render without crash, user interaction → state change, edge cases (empty/loading/error)

**Agent tool**: happy path, permission tier rejection, error/timeout

**Gateway skill**: route dispatch, channel isolation

**BGM player** (specific):
- Audio context created on user gesture, not on mount (autoplay policy)
- `setPlaying(true)` called after `audio.play()` resolves, not before
- Track switch does not double-assign `audio.src`
- Panel hide (Ctrl+B) does not kill BGM if global audio node is used

**Shell startup** (specific):
- Splash dismissal gated on real readiness signal + minDuration floor (not timer alone)
- ADK setup path: splash waits — no `isReady` deadlock
- Onboarding path: splash waits — no `isReady` deadlock
- VRM load failure: timeout fallback fires — splash never hangs indefinitely

### E2E Critical Paths (all must pass)

- Fresh install: App launch → splash → ADK setup screen
- First run post-ADK: App launch → splash → onboarding wizard
- Returning user: App launch → splash → main UI (no white flash)
- Chat message → LLM response (streaming)
- Tool execution → permission prompt → result returned
- Panel switch → skills updated correctly
- Settings change → persisted → reload reflects change
- Layout resize (drag) → width persisted → reload restores
- BGM play → panel switch → return → still playing

### Performance Criteria

"Jank" = frame drop below 60 fps during user interaction (measurable with DevTools Performance tab).

- Layout resize: max one `setState` per animation frame (no unbounded `setState` on every `pointermove`)
- Background video: `<video>` load does not block main thread
- BGM state change: does not trigger full component tree re-render
- Tool: Chrome DevTools Performance tab via Tauri WebView inspector

### Checklist

- [ ] Tests added for every new behavior?
- [ ] Assertions are strict (exact match preferred over contains)?
- [ ] Edge cases covered (empty, null, error, timeout)?
- [ ] E2E tests run on real app, or DEFERRED with documented blocker?
- [ ] Test code itself reviewed (two clean passes)?
- [ ] No skipped tests without justification?
- [ ] Coverage targets met (agent 80%, shell 70%, gateway 80%)?
- [ ] BGM autoplay policy test: audio context created on user gesture?
- [ ] Splash readiness gate test: VRM failure → timeout fires (no hang)?

---

## Dimension 6: Requirements Conformance

### Levels

1. **Functional** — does it do what the Issue specified?
2. **Behavioral** — does it behave correctly from the user's perspective?
3. **Experiential** — does it feel right? (UX, performance, visual polish)
4. **Non-regression** — does it break anything that was working?

### UX Criteria (for shell UI changes)

Applies to: splash transitions, layout changes, animations, avatar, BGM, background video.

- No visible flash or flicker during state transitions
- **Splash dismissal gated on real readiness signal** — fixed timer alone is not acceptable as gate
- Splash fade CSS transition duration matches the JS timer gap
- Animations complete before next state appears
- Loading states covered (spinner or skeleton)
- Error states handled visually (not just `console.error`)
- Background video swap (null → URL) invisible during splash coverage
- Background video load failure handled gracefully (fallback div shown)
- Window resize does not break layout
- Dark background maintained throughout startup sequence

### Definition of Done

- [ ] Original Issue re-read — all acceptance criteria met?
- [ ] User-visible outcome achievable without manual workaround?
- [ ] No regression: existing features still work?
- [ ] Splash dismissal gated on real readiness signal?
- [ ] UX: no flash, animations complete, loading + error states handled?
- [ ] Background video + BGM edge cases handled (null, load failure, panel hide)?
- [ ] No new blocking calls on main thread?
- [ ] Performance verified with DevTools (no jank < 60 fps)?
- [ ] Side effects documented if any?

---

## Cross-Review (Adversarial) Invocation

Skill: `/cross-review`

### Mandatory Triggers

- Any security finding severity ≥ medium
- New Tauri IPC command or `listen()` handler
- Architecture boundary change
- New URL in CSP `connect-src`
- LLM system prompt / persona change
- Permission model change (new tier or tool)
- `panel_install` source validation changed
- `assetProtocol.scope` changed

### Review Profiles (all 6)

| Profile | Focus |
|---------|-------|
| Architecture | Layer violations, contracts, backward compatibility, panel invariants |
| Security | IPC injection, credentials, CSP, tier bypass, path traversal, supply chain |
| Code | Convention compliance, logging, type safety |
| Requirements | User story satisfaction, UX, non-regression, performance |
| Process | Gate compliance, branch discipline, context sync |
| Testing | Coverage completeness, E2E paths, test code correctness |

### Outcome

- **Pass**: all profiles, no medium/high findings
- **Conditional**: low findings only — fix before merge, no re-review
- **Fail**: any medium/high finding — fix + re-run

**If `/cross-review` is unavailable**: require minimum two human reviewers for security and architecture dimensions. Do not self-certify and merge.
