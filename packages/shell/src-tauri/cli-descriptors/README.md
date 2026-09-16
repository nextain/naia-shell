# CLI descriptors (L0b stand-in for #605)

Minimal durable CLI descriptor set used by the shell Rust detection module
(`src/cli_detect.rs`). Full L0b provider ports live in #597; until that lands,
these JSON files are the shared readiness contract for Claude Code, Codex, and
Grok.

## Covered

| id | Notes |
|----|--------|
| `claude` | Claude Code CLI — `auth status --json` (`loggedIn`) |
| `codex` | Codex CLI — OS-specific executable candidates + `login status` exit code |
| `grok` | Grok CLI — install via PATH; login via non-empty `~/.grok/auth.json` |

## Explicitly out (D6 / L12)

- **Gemini CLI / OpenCode** — removed from detection and PTY agent lists per D6.
- **agy** — added by #606 (L12), not this slice.

Classification prefers spawn errors, exit codes, timeouts, and structured
JSON/file checks. Do not match English prose error strings for install state.
