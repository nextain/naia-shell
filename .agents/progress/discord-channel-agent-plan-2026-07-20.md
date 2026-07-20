# Discord Channel Agent — implementation plan

- Date: 2026-07-20
- Scope mode: EXPANSION
- Working branches:
  - `naia-shell`: `feat/discord-channel-agent` from `origin/main@e210da85`
  - `naia-agent`: a dedicated worktree will be cut from `origin/main@2b6bbaa`
- Requirements SoT:
  - `docs/requirements.md` `FR-DISCORD.1`–`FR-DISCORD.10`
  - `.agents/context/channels-discord.yaml`
  - `naia-agent/docs/requirements.md` `FR-DISCORD-RT-1`–`FR-DISCORD-RT-7`
- Related live work: radio/continuous-speech development owns the current
  `naia-shell` issue-82 worktree and current `naia-agent` checkout. This work
  uses separate worktrees and coordinates before touching shared files.

## Execution status

- Automated implementation is complete; final stage convergence was reopened
  after the native CAS production hardening and integration-artifact findings.
- Paired Agent runtime commit:
  `cd6b76310eac73df2a90635fd1bedc9c42751b6d`
- Agent test-evidence commit:
  `be78b852ca9c6ba8e1bccbd795ac4e26e2864911`
- Agent V-model evidence HEAD:
  `5f8ff165837594f5f5b100f8938ab109a293babc`
- Shell strengthened-test commit:
  `c756a9c9feed4be38c7592a5e33f8c4d11ccc930`
- Reviewed Shell production HEAD:
  `2261c2ffb6567b7925a5c29b0bef90c663ffb4a7`
- Paired proto SHA-256:
  `4258d959f254e9ad3816679010e425d7e0d76f872fa17e3384a329692ea98caa`
- Live Discord and real OS credential-store acceptance remain explicit
  operator gates and are not represented as automated passes.
- The original DEVELOPMENT gate had three consecutive CLEAN reviews before the
  CAS hardening. After test-strengthening findings were fixed, the TEST gate
  independently reconverged with two consecutive CLEAN reviews on the
  Agent/Shell evidence HEADs above. DEVELOPMENT and INTEGRATION are explicitly
  rerun on the final production/evidence snapshots.

## Outcome

Naia Shell can securely configure a Discord bot, discover the guilds and text
channels that bot can actually access, allow-list multiple channels, and show a
responsive Discord inbox. Naia Agent keeps a durable Gateway connection and
answers in the originating channel according to each binding's participation
rule (`mentions`, `all`, or `paused`) with per-channel context isolation.

The raw bot token never enters WebView JavaScript, normal settings, logs,
conversation history, or agent requests. The UI receives only secret-free
status and Discord data for explicitly allowed channels.

## Non-goals

- Replacing Discord Gateway with REST polling.
- Supporting Discord DMs in the first multi-channel release.
- Managing Discord server roles or permissions.
- Editing radio/continuous-speech behavior.
- Changing the agent gRPC protocol merely to transport Discord inbox events.
- Claiming live Discord acceptance without an operator-configured bot.
- Running a background daemon or cloud relay after the local Agent/PC stops.

## Architecture

```text
native secret prompt ──> OS credential store
                              │ one-shot inherited pipe/handle
                              v
Connections UI ──invoke──> Shell Rust Discord service ──spawn──> Naia Agent
 status/metadata only          │ REST discovery/history          │ Gateway
                               │                                 │
                               └── watches private event file <──┘
                                      │ Tauri events
                                      v
                             responsive Discord inbox
```

The private event file is a bounded, owner-only local cache, not a log. It
contains only messages from allow-listed channels and is written atomically.
Agent is its sole writer and owns its fsync/rename/generation contract. Shell is
a read-only watcher and emits live Tauri events, so periodic Discord REST
polling is not the primary real-time path. REST history is fetched only when a
user opens or explicitly refreshes a channel. Agent writes only while its local
runtime is alive; persisted files do not imply a daemon or post-exit relay.

## Security invariants

1. Secret capture is an OS-native/native-process prompt launched by Rust.
   React requests capture but never supplies or receives a token string.
2. The credential backend is replaceable in tests. Production fails closed
   when the platform credential store or secure prompt is unavailable.
3. Agent receives the token through the spawned gRPC host process's dedicated
   one-shot anonymous stdin pipe, not through argv, an environment value,
   gRPC, a file, or WebView IPC. In this host mode stdin has no command/data
   protocol: Shell writes only the bounded token bytes and immediately closes
   its end. The bootstrap reads once, destroys stdin, and only then dynamically
   imports or constructs provider/tool/runtime dependencies. Descendants and
   re-exec therefore start after the secret descriptor is closed. Unsupported
   pipe setup fails closed; there is no argv, temporary-file, clipboard,
   WebView, or normal-stdin fallback.
4. IPC responses, status files, manifests, errors, and logs are tested to
   contain no token or token fragment. Default diagnostics also contain no
   Discord message/response body, private document, or search evidence;
   identifiers are reduced to necessary classifications and counts. The
   explicitly named owner-only inbox cache is application data, never a
   diagnostic/log sink.
5. Public binding configuration is atomically written and contains guild,
   channel, participation rule, optional allowed users, and processing profile;
   it never contains credentials.
6. Discord data exposed to WebView is restricted to discovered metadata or
   allow-listed channel history. Message content is not persisted in
   local/session storage, IndexedDB, Cache Storage, service workers, or any
   Tauri preference namespace.
7. Destructive credential deletion is explicit and reports whether the agent
   has stopped using the previous generation.

## Requirement trace

| Requirement | Implementation | Evidence |
|---|---|---|
| FR-DISCORD.1 | exact Profile → Brain → Voice → Avatar → Persona → Memory → Knowledge → Skills → Connections → General order plus status/setup/permissions/troubleshooting | exact-order component assertion, accessibility test, Playwright/Tauri E2E |
| FR-DISCORD.2 | intent detector emits navigation event and safe setup guidance | intent unit tests; no-token-string scan; shared-file gate |
| FR-DISCORD.3 | native secret capture + OS credential store + redaction tests | Rust backend tests, failure-path tests, IPC contract tests |
| FR-DISCORD.4 | native REST discovery and explicit multi-channel allow-list | mocked Discord API tests, permission/removed-channel tests |
| FR-DISCORD.5 | existing Gateway runtime extended without REST polling fallback | automated reconnect/dedupe probe plus separate mandatory live Discord acceptance; automated green alone leaves status Pending |
| FR-DISCORD.6 | binding/guild/channel/user-keyed sessions and histories plus channel-keyed read/status/event cache | crossed channel/user isolation and read-cursor restart tests |
| FR-DISCORD.7 | `mentions` / `all` / `paused` policy per binding | policy truth-table tests and fake-Gateway E2E |
| FR-DISCORD.8 | globe inbox, responsive list/detail/back layouts | component + viewport E2E screenshots |
| FR-DISCORD.9 | recent allowed channel and last-opened non-secret preference | store, removed/disabled fallback, restart, and empty-state E2E |
| FR-DISCORD.10 | channel name/server/last-message preview/unread/read cursor/last activity/accessibility | component, cursor restart, and keyboard/screen-reader assertions |
| RT-1 | injection-only token use with zero config/wire/log persistence | canary-token serialization, file, log, child-env tests |
| RT-2 | exact authenticated tuple check; reject DM/bot/self/not-allowed/not-triggered | ingress policy truth table |
| RT-3 | existing agent ingress and same-message reply with scoped bounded history | crossed two-channel/user isolation test |
| RT-4 | durable `reserved → replying(cursor) → completed/partial` transitions | crash/replay/partial-send/corrupt-store tests |
| RT-5 | RESUME-first reconnect, bounded backoff, complete stop, secret-free generation status | fake-clock lifecycle and shutdown tests |
| RT-6 | 2,000-character chunks, total cap, bounded rate-limit retry, classified failures | chunk/rate-limit/auth/permission/provider tests |
| RT-7 | binding-scoped one-time friend code and fully bound, expiring consent | replay/expiry/wrong-binding/profile/destination tests |

## Phased delivery

### P0 — Contract freeze and collision control

- Record file ownership in the cross-session coordination channel.
- Audit current `origin/main` against the requirement trace.
- Create a dedicated `naia-agent` worktree.
- Freeze versioned public schemas for bindings, runtime status, and inbox
  events before UI work.
- Freeze numeric/runtime contracts from current implementation as named
  constants: 2,000 characters per chunk, 6 chunks / 12,000 characters total,
  2 rate-limit retries, server `retry_after` clamped to 0–30 seconds,
  reconnect default 1–30 seconds (configured ceiling 300 seconds), dedupe
  4,096 entries / 7 days, and explicit trusted-store expiry timestamps with no
  non-expiring default.
- Replies beyond 12,000 characters are deterministically truncated at the last
  safe character with a localized truncation marker; the secret-free runtime
  status increments a truncation count. Tests cover Unicode boundaries, exactly
  at/over the cap, and never place the omitted content in diagnostics.
- At every phase boundary, machine-check both Discord worktree diffs against
  this shared-file allow-list and append the result to the coordination file:
  `agent_grpc.rs`, proto files, `ChatArea.tsx`, `chat-service.ts`,
  `process-status.json`, requirements/scenarios, Rust agent-spawn wiring, and
  `src/main/adapters/discord-gateway.ts`. An unannounced match blocks the
  phase.
- Shared files use an atomic lock directory under
  `.agents/work/xsession-locks/discord-radio-shared` containing owner, branch,
  base SHA, paths, and acquisition time. Acquisition fails if it already
  exists; locks are never stolen by timeout and require the owner or user to
  release. A shared edit requires both coordination acknowledgment and a clean
  merge-base/diff against the other lane's latest HEAD.
- This lock is a development-session coordination artifact only. It is not read
  by product code and has no relationship to Agent runtime stop, generations,
  processes, or configuration.

Exit evidence: reviewed schema examples; no edits in the radio-owned worktrees.

### P1 — Agent participation policy and inbox event adapter

Primary files:

- `naia-agent/src/main/adapters/discord-gateway.ts`
- new `naia-agent/src/main/adapters/discord-inbox-store.ts`
- `naia-agent/scripts/builds/agent-stdio-entry.mjs`
- adjacent tests

Changes:

- Extend each binding with `participation: mentions | all | paused`.
- Preserve optional allowed-user authority independently of participation.
- Emit bounded incoming/outgoing message records and binding/runtime status to
  an owner-only atomic file.
- Scope session and bounded history by
  `(bindingId, guildId, channelId, userId)`; scope channel UI/read state by
  `(bindingId, guildId, channelId)`; scope dedupe by
  `(bindingId, Discord messageId)`.
- Preserve the existing durable
  `reserved → replying(outbox cursor) → completed/partial` state machine and
  prove it survives restart, partial sends, and out-of-order Gateway replay.
- Key dedupe by `(bindingId, Discord messageId)`. Claim each reply chunk in a
  durable write-ahead transition before sending it; after an ambiguous crash,
  mark that cursor `partial` and never resend automatically. This deliberately
  prefers an honestly incomplete reply over a duplicate. A corrupt dedupe
  store fails closed and cannot be rebuilt from message history: Agent pauses
  ingress and replies for every binding covered by that store, publishes a
  terminal `dedupe_corrupt` status, and requires explicit user repair/reset
  after backup. It never resumes automatically from Discord history.
- Migrate a missing/unknown participation rule to `paused`. Existing bindings
  remain visible but cannot respond until the owner explicitly chooses
  `mentions` or `all`, preserving FR-DISCORD.7's fail-closed default.
- Preserve and reverify the current RT-7 adapters: binding-scoped hashed
  one-time friend-code claim before expiry, plus trusted consent atomically
  bound to profile, destination, workload, and session with expiry and replay
  rejection. No plaintext code enters Agent requests or durable storage.

Exit evidence:

- full Cartesian truth-table tests for
  `(allowed channel × allowed user × mentions/all/paused × mentioned/replied)`
  including missing-rule and missing-user fail-closed defaults;
- crossed two-channel and same-channel/two-user isolation, dedupe, reconnect,
  corrupt-file recovery, and permission-loss tests;
- default diagnostic assertions reject Discord input/output bodies, private
  document/search evidence, raw identifiers beyond approved classes/counts,
  and all credentials;
- RT-7 replay/expiry/wrong-binding/profile/destination/workload/session tests
  rerun against the changed runtime;
- touched package tests and repository typecheck/build.

### P2 — Shell native secure setup and Discord service

Primary files:

- new Rust modules under `packages/shell/src-tauri/src/discord/`
- minimal registration/wiring in `packages/shell/src-tauri/src/lib.rs`
- new typed WebView wrapper under `packages/shell/src/lib/discord/`
- native tests and TypeScript contract tests

Changes:

- Native secret capture with platform adapters and injected fake adapter tests.
- OS credential create/status/rotate/delete lifecycle with generation state.
- Atomic public binding manifest and rollback on failed agent restart.
- Native guild/channel discovery, permission validation, explicit history fetch,
  stable error codes, rate-limit/backoff handling, and response caps.
- Discovery calls `/users/@me`, `/users/@me/guilds`, the bot member/role
  endpoints, and `/guilds/{guild}/channels`; Rust computes effective guild-role
  plus channel-overwrite permissions for the authenticated bot and exposes only
  guild text channels with `VIEW_CHANNEL`. A channel is selectable for active
  participation only with `SEND_MESSAGES` and `READ_MESSAGE_HISTORY`; missing
  message-content intent or permissions produce stable disabled reasons.
- The REST adapter serializes Discord rate-limit buckets by route, honors
  `Retry-After` and global 429 state with bounded jitter, caps pages/items and
  bodies before deserialization, and never turns retries into a polling loop.
- Agent spawn injects the credential through the one-shot inherited handle and
  passes only non-secret schema paths through normal process configuration.
- Watch the private inbox file and publish sanitized Tauri events.

Atomicity contract:

- Owner-only files live below `naia-settings`: `discord-bindings.json`,
  `discord-runtime/{authority,status,inbox,dedupe}.json`, and
  `discord-ui.json`. Files are `0600` where supported.
- Every replaced owner-only JSON file, including the inbox cache, uses a
  same-directory unique temporary file, file flush/fsync, rename/replace, then
  parent-directory fsync where supported.
- A binding update atomically replaces the public manifest, restarts Agent, and
  returns success only after both status and authority report the matching
  ready generation. On spawn/readiness failure Shell atomically restores the
  previous manifest and restarts that configuration before returning an error.
  This contract provides rollback and honest success reporting; it does not
  claim zero-downtime handover between two simultaneously running Agents.
- The inbox cache is schema-versioned, checksummed, capped by message count and
  bytes per allowed channel, and safely truncates oldest records. Agent alone
  applies the same atomic replace primitive and writes the matching active
  generation; Shell never writes it. Corruption quarantines only the inbox,
  never the dedupe authority.

Exit evidence:

- tests prove raw token never crosses WebView IPC or disk;
- one-shot pipe/handle closure and non-inheritance tests cover crash,
  descendant, and re-exec cases;
- mocked 401/403/404/429/network/malformed responses;
- missing message-content intent and each missing Discord permission produce
  their stable disabled reason in native contract tests;
- corrupt-inbox recovery proves the explicit REST fetch is user/open-triggered,
  page/body capped, memory-only, performs exactly one request sequence, writes
  no inbox file, and creates no timer/retry loop;
- restart/rollback/delete-in-use tests;
- every Tauri Discord command has a Rust-side allow-list, bounded typed input
  and typed status/data output; property tests reject unknown fields, oversized
  values, secret-shaped fields, and unauthorized channel IDs;
- Rust format, clippy/test, shell typecheck.

### P3 — Connections settings

Primary files:

- `packages/shell/src/components/settings/SettingsTab.tsx`
- new `packages/shell/src/components/settings/connections/DiscordConnection.tsx`
- new localized message keys for every supported locale

Changes:

- Insert Connections between Skills and General.
- Status-first setup, rotate/remove controls, native secret-capture action.
- Discover only accessible guild text channels and configure multiple
  allow-listed channels.
- Per-channel participation, allowed users, and processing profile controls.
- Honest permission/removal/troubleshooting states.

Exit evidence:

- component and accessibility tests;
- localization and hardcoded-string checks;
- setup, rotate, permission-loss, and remove E2E with fake native backend.

### P4 — Globe inbox and live updates

Primary files:

- replace legacy `packages/shell/src/components/channels/ChannelsTab.tsx`
- `packages/shell/src/components/layout/NaiaMetaArea.tsx`
- isolated Discord inbox store/hooks/components

Changes:

- Wide split layout; narrow channel-list → conversation → back navigation.
- Metadata, unread badges, last activity, empty/setup guidance, keyboard and
  screen-reader semantics.
- Persist only the last selected channel ID and read cursors.
- Store those non-secret preferences in the Tauri application store under a
  Discord-specific namespace. Secret commands and the preference store have
  separate typed APIs; neither messages nor credentials are accepted by the
  preference writer.
- Honor a stored last-opened channel only while it remains allowed and
  accessible; otherwise discard that preference and fall back to the most
  recently active accessible channel, then to the empty/list guidance state.
- Merge Gateway-driven Tauri events with explicit REST history fetches.
- First pass the new Gateway inbox fake E2E, then remove the legacy single-DM
  10-second polling path and its relay lifecycle as an independent code
  migration gate. It cannot remain behind a fallback flag and is never treated
  as a substitute for live acceptance.

Exit evidence:

- viewport E2E at narrow/wide widths, keyboard navigation, unread behavior;
- list assertions cover last-message preview, formatted last-activity time,
  unread-count increments, badge reset when the read cursor advances,
  read-cursor persistence, and restart restoration;
- deterministic ordering assertion: last-opened allowed channel wins on
  restart; if the stored channel became disallowed/inaccessible it is discarded
  and selection falls back to the most recently active accessible channel;
  when no accessible channel has any activity, the list plus setup/empty
  guidance is shown without selecting a conversation;
- live fake-Gateway event appears without REST polling;
- static/runtime assertions prove no legacy relay import, fallback flag,
  periodic Discord REST timer, or relay process can start, independently of the
  full inbox E2E;
- no message bodies in Web storage.

### P5 — Chat intent and cross-repo integration

Potential shared files:

- `packages/shell/src/components/ChatArea.tsx`
- agent spawn wiring in Rust

These files are changed only after a `BLOCKING` notice in the coordination
channel, shared-file lock acquisition, and a clean merge-base/diff against the
radio lane's latest HEAD. Under the user's explicit autonomous/no-question
instruction, the coordination channel's no-blocking-response window served as
the go-ahead; no synchronous bilateral acknowledgment is claimed.

Changes:

- Detect Discord connection intent locally, insert Naia's reviewed localized
  Developer Portal/bot/invite/channel-permission guidance as an assistant
  message, and navigate to Connections. This deterministic safety flow does not
  ask an LLM or the user to place a token in chat.
- Validate Shell ↔ Agent schema/version compatibility and restart lifecycle.
- Run fake-Gateway E2E and full builds autonomously. Real Tauri credential-flow
  E2E and opt-in live Discord acceptance remain operator gates for an isolated
  test guild when a credential is configured through native UI. The live gate
  covers Identify/READY, message-content intent,
  receive/reply in two allow-listed channels, RESUME/reconnect, dedupe, 403,
  and revoke/rotate recovery; without that evidence FR-DISCORD.5 remains
  `Pending` and the product is not reported complete.

Exit evidence:

- no conflict with continuous-speech changes;
- intent and navigation E2E;
- full repository verification and two consecutive clean development, test,
  and integration reviews.
- If the new Gateway path regresses after release, rollback is a signed build
  rollback/code revert to the last known release. The inadequate single-DM
  polling relay is not retained as a runtime fallback.
- Removing the legacy code after fake E2E is a migration/code gate only. It does
  not complete FR-DISCORD.5 or authorize a release-complete claim; those remain
  `Pending` until the P5 live Discord acceptance passes.

## Compatibility and migration

- Existing single-binding environment JSON remains readable but defaults to
  `paused` until the owner explicitly confirms a participation rule.
- The legacy relay/polling UI is removed only after the Gateway inbox path
  passes E2E.
- Schema files carry a version; a newer unsupported version fails with a
  user-facing upgrade message rather than silently weakening policy.
- Removed or inaccessible channels remain visible as disabled until the user
  acknowledges/removes them, preserving truthful state.

## Failure and rescue table

| Failure | User-visible behavior | Recovery |
|---|---|---|
| Native secure prompt unavailable | Setup disabled with platform-specific help | install/enable supported credential backend; no fallback text field |
| Invalid/revoked token | Disconnected, credential retained until explicit rotate/remove | rotate through native prompt |
| Discovery 403 | Show missing permission per guild/channel | update Discord role/overwrites, retry |
| Discord 429/network outage | Stale status with retry time; no tight loop | bounded exponential backoff with jitter |
| Agent restart fails after config edit | Previous manifest/generation remains active | atomic rollback and diagnostic |
| Inbox cache corrupt | Quarantine/reset cache; Gateway remains authoritative | Agent starts an empty cache and rebuilds only from future Gateway events; Shell may perform one bounded REST history fetch for WebView memory only and never writes the inbox or starts polling |
| Inbox and dedupe both corrupt | Terminal dedupe error takes precedence | pause all affected ingress/replies; no history fetch, cache rebuild, or automatic resume until explicit dedupe repair/reset |
| Event watcher misses change | generation mismatch triggers rescan | reopen/watch and read latest atomic snapshot |
| Channel deleted or bot removed | disabled binding, no response attempts | user removes binding or restores access |
| Radio branch changes a shared file | lock or dual diff/ack gate blocks the edit | release/reacquire after rebase and coordinated merge; no timeout lock stealing |

## Alternatives rejected

- WebView password field: violates the frozen no-secret-over-string-IPC rule.
- REST polling relay: violates Gateway-primary real-time requirements and
  duplicates agent ownership.
- gRPC/protobuf extension for inbox events now: unnecessarily collides with the
  radio session; an owner-only local adapter preserves the boundary.
- Copying the old issue-388 worktree: it is single-binding/manual-ID oriented
  and passes a raw token through WebView IPC.
- Storing messages in browser storage: unnecessary privacy exposure. This bans
  message bodies from every persistent WebView storage surface; content exists
  only in bounded React memory and the owner-only native inbox cache.

## Premortem

1. **Secret leaks through an error or test fixture.** Countermeasure: typed
   status-only IPC, redaction at Rust boundaries, canary-token scans over IPC,
   files, logs, and snapshots.
2. **Gateway and UI disagree after restart.** Countermeasure: generation IDs,
   versioned atomic schemas, explicit applying/active/failed states, and
   rollback tests.
3. **Parallel radio work causes semantic conflicts despite separate
   worktrees.** Countermeasure: avoid proto/gRPC changes, list shared files in
   advance, block before touching them, and rebase/check diffs at every phase.

## Review and completion gates

Each stage uses `review-pass`. Findings are fixed and the stage repeats until
two consecutive passes contain no new blocking or actionable findings:

1. planning review before implementation;
2. development review after P1–P4;
3. test review after automated and real UI tests;
4. integration review after rebasing both branches onto latest main.

Completed autonomous verification includes conflict-marker scan, scoped
hardcoded-string/i18n checks, Rust checks, Shell package typecheck/build, Agent
test/build, Playwright UI tests, secret-canary contracts, Git diff/status
inspection, and deterministic lifecycle tests for epoch cancellation,
authority revoke, child terminate/reap, and legacy relay removal. A real Tauri
credential-flow run and OS-level post-exit process audit remain operator
acceptance items; they are not represented as automated passes. Live Discord
acceptance is likewise PASS only when an operator has configured a credential
through the native UI.
