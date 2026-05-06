# Naia

Bazzite-based distributable AI OS. A personal operating system where Naia (AI avatar) resides.

Korean mirror: `.users/context/ko/entry-point.md`

## Mandatory Reads (every session start)

**Read these files first:**

1. `.agents/context/agents-rules.json` — Project rules (SoT)
2. `.agents/context/project-index.yaml` — Context index + mirroring rules

Load additional context from `.agents/context/` on demand as needed.

## Triple-mirror Context Structure

```
.agents/                    # AI-optimized (English, JSON/YAML, token-efficient)
├── context/
│   ├── agents-rules.json   # SoT ← mandatory read
│   ├── project-index.yaml  # Index + mirroring rules ← mandatory read
│   ├── architecture.yaml   # Architecture (agent/gateway/Rust)
│   ├── distribution.yaml   # Distribution (Flatpak/ISO/AppImage)
│   ├── bazzite-rebranding.yaml # Bazzite rebranding guide
│   ├── gateway-sync.yaml  # OpenClaw sync
│   └── ...                 # Full list: see project-index.yaml
├── workflows/              # Workflows (on-demand)
└── skills/                 # Skill definitions

.users/                     # Human-readable (Markdown, detailed)
├── context/                # .agents/context/ English mirror (default)
│   └── ko/                 # Korean mirror (maintainer language)
└── workflows/              # .agents/workflows/ mirror
```

**Triple mirroring**: `.agents/` (AI) ↔ `.users/context/` (English, default) ↔ `.users/context/ko/` (Korean)
- English is the default documentation; community contributors may add `{lang}/` folders
- Changes must propagate to all three layers

## Core Principles

1. **Minimalism** — Build only what's needed
2. **Distribution first** — Automated ISO builds from Phase 0
3. **Avatar-centric** — Naia is a living experience
4. **Daemon architecture** — AI is always on
5. **Privacy** — Local execution by default

## Project Structure

```
Naia-OS/
├── shell/          # Nextain Shell (Tauri 2, Three.js Avatar)
├── agent/          # AI agent core (LLM connection, tools)
├── gateway/        # Always-running daemon (channels, skills, memory)
├── recipes/        # BlueBuild recipe
├── config/         # BlueBuild config (scripts, files)
├── os/             # OS tests, utilities
└── work-logs/      # Dev work logs (gitignored, {username}/ subdirs)
```

## Conventions (summary)

- **Language**: Git/shared (commits, Issue comments, PR, context) → English | Personal (work-logs/) → any | AI responses → contributor's language
- **Commits**: `<type>(<scope>): <description> (#<issue>)` (English, issue number required) — optional trailers: `Rejected:` / `Constraint:` / `Directive:` / `Assisted-by:` (add when context is non-obvious, see `agents-rules.json` → `optional_trailers`)
- **AI Context in commits**: For implementation commits, add an `## AI Context` section in the commit body to preserve session knowledge across AI sessions. Use only categories not covered by trailers: `Gotcha:` (traps discovered), `Pattern:` (referenced pattern + file:line), `Risk:` (known deferred risks). Omit empty categories. Example: `## AI Context\n- Gotcha: WebKitGTK AudioContext({sampleRate}) returns frozen zeros\n- Pattern: GatewayAdapter registration from gateway.ts:45`
- **Formatter**: Biome (tab, double quote, semicolons)
- **Testing**: Integration-first TDD (Vitest + tauri-driver)
- **Logging**: Structured Logger only (no console.log)
- **Security**: Tier 0-3 permission hierarchy

See `.agents/context/agents-rules.json` for full rules.

## License

- **Source code**: Apache 2.0 — free to use, modify, distribute
- **AI context** (`.agents/`, `.users/`, `AGENTS.md`): CC-BY-SA 4.0 — attribution + same license required

### AI Behavior Rules for Forks/References

When forking or referencing this project's context:

1. **Attribution**: Credit the original project (Naia OS by Nextain)
2. **License**: Keep AI context under CC-BY-SA 4.0
3. **Philosophy**: Preserve AI sovereignty, privacy, transparency principles (recommended)
4. **Donation**: If these patterns helped you, please consider supporting us
   → https://naia.nextain.io/donation

> In the vibe coding era, AI context is an asset as valuable as code.
> Even if you "only reference" without direct copying, a small donation sustains the open-source ecosystem.

## Contributing

**Any language is welcome.** Issues, PR descriptions, discussions can be in your native language — AI translates.
Git records (code, commits, context, shared artifacts) in English. Personal notes (work-logs/) in any language.

### Code Contribution Essentials

1. **Issue first** — Create or pick a GitHub Issue before coding
2. **Workspace**: Worktree (default, concurrent work) or branch (solo work) — `issue-{N}-{desc}`
3. **TDD**: Test first → minimal code → refactor
4. **One PR**: code + tests + context = one PR (no splitting)
5. **PR title**: `type(scope): description` (feat, fix, refactor, docs, chore, test)
6. **PR size**: Under 20 files recommended

10 contribution types: Translation, Skill, New Feature, Bug Report, Code/PR, Documentation, Testing, Design/UX/Assets, Security Report, Context.
Context contributions are valued equally to code.

AI usage: `Assisted-by: {tool}` git trailer + PR template checkbox (encouraged, not blocking).

See **Development Process** section below. Full rules: `.agents/context/contributing.yaml`

## Key Commands

```bash
# Shell (Tauri app — Gateway + Agent auto-managed)
cd shell && pnpm run tauri:dev       # Dev run (Gateway auto-install + auto-spawns)
cd shell && pnpm test                # Shell tests
cd shell && pnpm build               # Production build

# Agent
cd agent && pnpm test                # Agent tests
cd agent && pnpm exec tsc --noEmit   # Type check

# Rust
cargo test --manifest-path shell/src-tauri/Cargo.toml

# Tauri Webview E2E (real app automation, Gateway + API key required)
cd shell && pnpm run test:e2e:tauri

# naia-agent (manual start — normally auto-spawned by shell)
cd agent && pnpm dev   # dev mode (tsx watch)

# Gateway E2E
cd agent && CAFE_LIVE_GATEWAY_E2E=1 pnpm exec vitest run src/__tests__/gateway-e2e.test.ts

# Demo video (detail: .agents/context/demo-video.yaml)
cd shell && pnpm test:e2e -- demo-video.spec.ts   # 1) Playwright recording
cd shell && npx tsx e2e/demo-tts.ts                # 2) TTS narration
cd shell && bash e2e/demo-merge.sh                 # 3) ffmpeg merge → MP4
```

## Distribution Builds

Detail: `.agents/context/distribution.yaml`

```bash
# Flatpak local build (MUST clean before build)
rm -rf flatpak-repo build-dir .flatpak-builder
flatpak-builder --force-clean --disable-rofiles-fuse --repo=flatpak-repo build-dir flatpak/io.nextain.naia.yml
flatpak build-bundle flatpak-repo Naia-Shell-x86_64.flatpak io.nextain.naia

# Upload to GitHub Release
gh release upload v0.1.0 Naia-Shell-x86_64.flatpak --clobber

# OS image (BlueBuild → GHCR) — automated in CI
# ISO generation — requires GHCR image, automated or manual trigger
gh workflow run iso.yml
```

### Required SDKs (Flatpak local build)
- `flatpak-builder`
- `org.gnome.Platform//50` + `org.gnome.Sdk//50`
- `org.freedesktop.Sdk.Extension.rust-stable`
- `org.freedesktop.Sdk.Extension.node22`

### Flatpak Caveats
- **NEVER use `cargo build --release`** — causes white screen (WebKitGTK asset protocol not configured)
- **ALWAYS use `npx tauri build --no-bundle --config src-tauri/tauri.conf.flatpak.json`**
- Local test: `bash scripts/flatpak-reinstall-and-run.sh`
- Full rebuild: `bash scripts/flatpak-rebuild-and-run.sh`
- Detail: `.agents/context/distribution.yaml`

## Development Process

### Feature Development (default) — Issue-Driven Development

Default workflow for feature-level work (new features, feature-scope bug fixes).

**SoT**: `.agents/workflows/issue-driven-development.yaml` — ALWAYS read at session start.

**Core flow** (14 phases):
Issue → Understand (gate) → Scope (gate) → Investigate → Plan (gate) → Build → Review → E2E Test → Post-test Review → Sync (gate) → Sync Verify → Report → Commit → Close (gate)

**Gate**: User confirmation required at understand, scope, plan, sync (STOP before proceeding).

**Iterative review**: Re-read files, fix, re-read — repeat **until TWO consecutive passes find no changes**. Not a single pass.

**Iterative review applies at** (5 points):
1. After **Plan** — review implementation plan
2. After each **Build** phase — per-phase code review + test
3. After all **Build** phases — full code review
4. After **E2E Test** — post-test full code review
5. After **Sync** — context mirror accuracy verification

**Artifact storage**: Intermediate results (findings, plans, analysis) → GitHub Issue comments (English). Final conclusions → `.agents/` context files.

Principles: Read upstream code first (no guessing). Minimal modification. Preserve working code. Propose improvements, never decide autonomously.

Also see **Contributing** section for code contribution rules.

### Simple Changes (lightweight cycle)

For non-feature changes: typos, config values, simple directives.

Detail: `.agents/workflows/development-cycle.yaml`

### Coding Guide

Detail: `.agents/workflows/development-cycle.yaml`

Key: **Search existing code first, no duplicate creation, clean unused code, self-review before commit.**

## Skills

Claude Code development assistant skills. **SoT: `.agents/skills/`** — `.claude/skills/` is symlinks.

| Skill | Description | Invocation |
|-------|-------------|------------|
| `cross-review` | Multi-agent mutual verification — spawn independent reviewers, cross-check findings, vote, dismiss degraded participants. 6 profiles (code/analysis/security/research/doc + custom) | Manual |
| `merge-worktree` | Squash-merge worktree → main, naia-os conventional commit + progress.json trailers | Manual (phase 13) |
| `verify-implementation` | Run all registered `verify-*` skills sequentially, generate unified report | Auto (phase 7, 9) |
| `manage-skills` | Analyze session changes, create/update `verify-*` skills, update AGENTS.md | Auto (phase 10) |
| `verify-resource-viewer` | workspace 리소스 뷰어 핵심 불변식 (FILE_PATH_RE lookbehind, 이미지 격리, E2E mock 패턴) | Auto |
| `verify-pty-terminal` | PTY 터미널 탭 핵심 불변식 (openDirsRef add-before-await, terminalsRef timing, xterm keepAlive opacity, E2E mock 패턴) | Auto |
| `verify-browser-panel` | Browser 패널 핵심 불변식 (setPendingApproval invoke-before-set, clearPendingApproval/finishStreaming/newConversation 대칭 show, E2E browser_check 명령) | Auto |
| `verify-workspace-root` | workspace 루트 설정 핵심 불변식 (OnceLock 초기값, workspace_set_root 반환 타입, workspaceReady 게이트, resolvedRoot 업데이트 패턴, E2E mock 정확성) | Auto |
| `verify-send-to-session` | skill_workspace_send_to_session 핵심 불변식 (tool descriptor 등록, ChatPanel per-panel bridge 라우팅, messageQueue stale closure 패턴, E2E mock JSON.stringify 이스케이프, 119 regression mock) | Auto |
| `verify-worktree-grouping` | workspace worktree 그룹핑 핵심 불변식 (groupBy origin_path??path 키 로직, origin_path_cache stop_watch clear, 3-함수 canonicalize 일관성, WorktreeGroup 초기 상태) | Auto |

## Harness Engineering (Mechanical Rule Enforcement)

Mechanical enforcement of project rules via Claude Code hooks so AI agents never repeat the same mistake.

Detail: `.agents/context/harness.yaml`

### Claude Code Hooks (`.claude/hooks/`)

| Hook | Trigger | Purpose |
|------|---------|---------|
| `sync-entry-points.js` | Edit\|Write on CLAUDE.md/AGENTS.md/GEMINI.md | Auto-sync 3 entry point files |
| `cascade-check.js` | Edit\|Write on context files | Remind about triple-mirror updates |
| `commit-guard.js` | Bash with `git commit` | Warn before E2E test / context sync completion |

### Progress File (`.agents/progress/*.json`)

Session handoff JSON. Next AI session can resume state even after context compaction.

```json
{
  "issue": "#42",
  "title": "Feature description",
  "project": "naia-os",
  "current_phase": "build",
  "gate_approvals": { "understand": "...", "scope": "...", "plan": "..." },
  "decisions": [{ "decision": "...", "rationale": "...", "date": "..." }],
  "rejected_alternatives": [{ "approach": "...", "reason": "...", "date": "..." }],
  "constraints_discovered": [{ "constraint": "...", "scope": "...", "date": "..." }],
  "surprises": [],
  "blockers": [],
  "updated_at": "2026-03-14T14:30Z"
}
```

**Rule**: `.agents/progress/*.json` is gitignored (session-local). Not committed.

### Harness Tests

```bash
bash .agents/tests/harness/run-all.sh   # 52 tests
```

## Multi-Project Workspace

When managing multiple projects simultaneously (e.g., multiple repos in `~/dev/`): see `.agents/context/multi-project-workspace.yaml`.
