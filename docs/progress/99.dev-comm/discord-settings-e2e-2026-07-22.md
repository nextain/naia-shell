# Discord Settings E2E recovery plan

## Scope and baseline

- Shell worktree: `D:\alpha-adk\projects\naia-shell-worktrees\discord-e2e-settings`
- Shell branch/base: `feat/discord-settings-e2e` from `3e621c708f5a00495529c51f589a6096cbf72221`
- Paired Agent observation baseline: `5c496c394e2d54bdffdce37d3730353e34832827`
- Shared-main working tree was already dirty and is intentionally untouched.

## Observed contract

The Shell owns the native-only credential lifecycle and channel binding manifest:

1. `discord_capture_bot_token` opens an OS password prompt, writes the token through
   `write_agent_key`, and restarts the Agent. Its IPC result is only
   `{ configured, code }`; a token must never cross WebView IPC.
2. `discord_connection_status` reports token presence, binding generation, runtime
   state/code, and whether the Agent has published authority for the same generation.
3. `discord_discover_channels` returns only accessible Discord metadata; the native
   command keeps the token in native memory.
4. `discord_save_bindings` persists explicit guild/channel/user allow-lists with an
   expected generation and restarts the Agent. The Agent receives channel context via
   its existing `DiscordChannel` proto message; no Agent proto change is planned.

## Initial drift gate

- Worktree status: clean before this track.
- `node scripts/check-assembly-coverage.mjs`: passed (`S 69 / UC 20`).
- `bash scripts/enforce-root-structure.sh`: not runnable in this Windows checkout
  because the tracked script has CRLF (`$'\r': command not found`, `pipefail\r` invalid).
  This is an environment/repository harness defect, not treated as a passing gate.

## Planned owned files

- `docs/user-scenarios.md`, `docs/requirements.md`, this log
- `packages/shell/src/components/ConnectionsSettingsTab.tsx`
- `packages/shell/src/components/__tests__/ConnectionsSettingsTab.test.tsx`
- `packages/shell/e2e/discord-channel-agent.spec.ts`
- a focused `packages/shell/e2e-tauri/specs/` Settings flow spec if the current native
  harness can launch on Windows without live Discord credentials.

No `SettingsTab.tsx`, generic config files, ChatArea, or Agent files are in scope.
Any Rust command/API signature change will be re-announced before editing.

## Acceptance plan

- Plan gates: expand UC-DISCORD-1 and the test map, then reconcile the stale
  preflight requirement before code.
- UI contract: prove disconnected, native-prompt cancellation/error, actual runtime
  failure, incomplete discovery, and save payload behavior.
- Native E2E: drive the real Tauri Settings view through the no-token/status and
  native-prompt cancellation paths. A live Discord token is never inserted by tests;
  live bot discovery remains a separately provisioned acceptance run.

## Verification to date

- `pnpm build` at the worktree root: passed; this creates the local
  `@nextain/naia-os-core/shell-compat` build output required by Shell Vite.
- `pnpm --dir packages/shell exec tsc --noEmit`: passed.
- `pnpm --dir packages/shell test --run src/components/__tests__/ConnectionsSettingsTab.test.tsx`:
  passed (23 tests).
- Isolated Playwright with `PLAYWRIGHT_HOST=127.0.0.1`, `PLAYWRIGHT_PORT=1422`,
  and a worktree-local Vite server: passed for
  `e2e/discord-settings-secure.spec.ts` and the existing Connections allow-list
  flow in `e2e/discord-channel-agent.spec.ts`.

## Native Tauri gate — blocked, not passed

The checked-in `e2e-tauri/wdio.conf.ts` kills/reuses the default Tauri/Vite
ports and process names. The debug Tauri config also hard-codes
`devUrl: http://localhost:1420`. It therefore cannot run a second native app
against a worktree-local Vite port while a user's Shell is running, and running
the current command may terminate the user's app. The native harness needs
explicit isolated dev URL, app-data/ADK path, WebDriver port, and cleanup scope
before this UC can be safely automated. No user process was stopped and no
native E2E pass is claimed.

The remaining provisioned acceptance needs an approved disposable Discord bot:
OS secure prompt → DPAPI/keychain storage → discovery → allow-list save → same
generation Agent authority `ready`. The raw token remains operator-entered and
must not be supplied by test code or logs.
