# CLI descriptors (L0b stand-in for #605)

Minimal durable CLI descriptor set used by the shell Rust detection module
(`src/cli_detect.rs`). Full L0b provider ports live in #597; until that lands,
these JSON files are the shared readiness contract for Claude Code, Codex, Grok,
and Antigravity CLI (`agy`).

## Covered

| id | Notes |
|----|--------|
| `claude` | Claude Code CLI — `auth status --json` (`loggedIn`) |
| `codex` | Codex CLI — OS-specific executable candidates + `login status` exit code |
| `grok` | Grok CLI — install via PATH; login via non-empty `~/.grok/auth.json` |
| `agy` | Antigravity CLI — `models` readiness probe; interactive login fallback |

## Explicitly out (D6 / L12)

- **Gemini CLI / OpenCode** — removed from detection and PTY agent lists per D6.

Classification prefers spawn errors, exit codes, timeouts, and structured
JSON/file checks. Do not match English prose error strings for install state.
