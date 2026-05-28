# Issue #337 — ADK-centric session persistence + AES-GCM + agent-managed OAuth

**Status**: Phase 1 (design lock) — **v2 (codex + gemini cross-review integrated 2026-05-28)**
**Owner**: claude (parent), sub-agents for Phase 2+
**Mode**: B-mode (parent re-verify after each sub-agent)
**Cross-review artifacts**:
- `.agents/plans/issue-337-codex-review.txt` (4253 lines, gpt-5.5)
- `.agents/plans/issue-337-gemini-review.txt` (90 lines, gemini-cli)
- Integration findings in §9 of this doc

## 1. Problem statement (verified)

| # | Defect | Evidence |
|---|---|---|
| D1 | shell-centric SoT (single-truth in `secure-keys.dat`) — incompatible with user-intended "ADK 영속 / agent self-restore" | `config.ts:413 saveConfigSecure`, `secure-store.ts:9 STORE_FILE` |
| D2 | dev/prod naiaKey single-slot collision | `secure-keys.dat` has slot `naiaKey: len=67` only, mode switch overwrites |
| D3 | secure-keys.dat stale-garbage survival | observed slot `apiKey: len=7` after #329 (B); `saveConfigSecure` only purges on `provider==="nextain"` writes, not on stale-only restart |
| D4 | restart → 401 (no auto-restore) | `bin/naia-agent.ts:1541 auth_update` sets process.env only, no disk persistence |
| D5 | dual key source (shell `secure-keys.dat` ↔ env-loader from `naia-settings/llm.json`) sync drift | `env-loader.ts:159-195` first-match-wins, never overwrites process.env |

## 2. Target architecture

### 2.1 SoT relocation
```
BEFORE:                          AFTER:
shell secure-keys.dat            agent + <ADK_PATH>/naia-settings/auth/
  └─ naiaKey (single slot)         ├── dev.json.enc
                                   └── prod.json.enc
```

### 2.2 Encrypted blob format (per file)

```jsonc
// decrypted payload — what the agent operates on in memory
{
  "schema": 1,
  "mode": "dev" | "prod",
  "naiaKey": "gw-...",              // bearer used for X-AnyLLM-Key header
  "refreshToken": "rt-..." | null,  // null until portal supports rotation
  "userId": "naia_...",
  "issuer": "http://localhost:3001" | "https://naia.nextain.io",
  "scope": ["chat","memory","..."], // empty array allowed
  "issuedAt": 1748400000,            // unix seconds
  "expiresAt": 1748403600 | null,    // null = static key (current portal)
  "rotatedAt": null                  // populated by refresh handler
}
```

**On-disk blob format** — reuse only the **crypto envelope layout** from
naia-memory v6 (magic `NAIA` + version + salt(16) + nonce(12) + authTag(16) +
ciphertext). **Do NOT** consume `BackupCapable.export/import` API directly:
that adapter is bound to memory-store shape and one SQLite path is a stub
(codex finding §9.1). Extract envelope encode/decode into a new generic util:

```
packages/runtime/src/utils/crypto-envelope.ts    (new)
  encryptEnvelope(plaintext: Uint8Array, password: string): Uint8Array
  decryptEnvelope(blob: Uint8Array, password: string): Uint8Array
  // Magic: "NAIA" + 0x01, salt(16), nonce(12), authTag(16), ciphertext(N)
```

naia-memory **also** migrates to consume this util in a follow-up (no breaking
change — same on-disk format). Cross-repo coordination but no churn now.

**Master password** = 32 random bytes (hex string), stored once via OS keyring
abstraction (see §2.9). Keyring slot: service `io.nextain.naia`, account
`auth-master-v1` (the `-v1` suffix = `keyVersion` for future rotation, codex
finding §9.4). Plaintext stored in blob payload:

```jsonc
{
  "schema": 1,
  "keyVersion": 1,     // matches keyring account suffix, future rotation supports multi-key try-decrypt
  ...
}
```

### 2.3 Mode awareness

| Layer | Source of truth | Code |
|---|---|---|
| shell (Vite-time) | `import.meta.env.VITE_NAIA_USE_DEV_GATEWAY === "1"` | `config.ts:677` (existing) |
| shell (runtime → agent) | extends `config_update` IPC with new `mode: "dev"\|"prod"` field | new |
| agent (boot) | `NAIA_AGENT_MODE` env var (set by `scripts/tauri-with-mode.mjs`) | new env in wrapper |
| agent (runtime override) | `config_update.mode` IPC field | new field |

Wrapper script change:
```diff
// scripts/tauri-with-mode.mjs
- if (mode === "dev") env.VITE_NAIA_USE_DEV_GATEWAY = "1";
+ if (mode === "dev") {
+   env.VITE_NAIA_USE_DEV_GATEWAY = "1";
+   env.NAIA_AGENT_MODE = "dev";
+ } else {
+   env.NAIA_AGENT_MODE = "prod";
+ }
```

### 2.4 Responsibility matrix

| Action | Before | After |
|---|---|---|
| Open OAuth URL in webview | shell `SettingsTab.tsx:1245 startLabLogin` | shell (unchanged — Tauri webview only available shell-side) |
| Generate OAuth state token | Rust `generate_oauth_state` | **agent** (CSRF check + scope binding) |
| Receive deep-link callback | Rust `process_deep_link_url` → emit `naia_auth_complete` | Rust (unchanged) **but** emits to agent IPC instead of frontend listener |
| Validate state + persist token | frontend `App.tsx:532-550 listen → saveSecretKey` | **agent** `auth_received` handler |
| Provide naiaKey for chat | shell loads from `secure-keys.dat`, pushes via `auth_update` | **agent** reads from own cache populated from `auth/{mode}.json.enc` |
| Refresh rotation | none | **agent** — 401 retry → refreshToken exchange → re-encrypt file |
| Logout | shell clears slot + localStorage | shell IPCs `auth_logout` → **agent** wipes file + cache |

### 2.5 New IPC surface (agent ↔ shell)

```ts
// shell → agent
{ type: "auth_start",    mode: "dev"|"prod" }              // returns { authUrl, state }
{ type: "auth_received", deepLinkUrl: string }              // raw naia://... — agent parses
{ type: "auth_logout",   mode: "dev"|"prod" }
{ type: "auth_query",    mode: "dev"|"prod" }              // returns { loggedIn, expiresAt, userId, scope[] } — no naiaKey

// agent → shell (emit)
{ type: "auth_expired",  mode: "dev"|"prod", reason: "refresh_failed"|"revoked" }
{ type: "auth_changed",  mode: "dev"|"prod", loggedIn: boolean }
```

**Critical**: `auth_query` response **never includes the naiaKey itself**. Shell
only needs to know "logged in or not" for UI gating. Chat calls go through
agent directly, never through shell-held key.

### 2.6 401 retry loop (agent)

```
chat_request → lab-proxy fetch → 401
  ↓
  loadAuth(mode) → has refreshToken?
    ├─ no  → emit auth_expired → reject chat with sentinel error
    └─ yes → POST {issuer}/api/auth/refresh { refreshToken }
              ↓
              200 → save new {naiaKey, refreshToken, expiresAt} → re-encrypt
                  → invalidate cachedLlm → retry chat once
              4xx/5xx → emit auth_expired → reject
```

Refresh races: serialize via **single-flight mutex per mode**. Concurrent chats
during refresh **await the same in-flight promise** and receive the new token
from its resolution — they never trigger a duplicate refresh, nor fail-fast
(gemini finding §9.6). Pseudocode:

```ts
const refreshInflight = new Map<Mode, Promise<AuthState>>();
async function getAuthForChat(mode: Mode): Promise<AuthState> {
  const inflight = refreshInflight.get(mode);
  if (inflight) return inflight;       // join existing refresh, not fail-fast
  // ... normal load path
}
async function refresh(mode: Mode): Promise<AuthState> {
  let p = refreshInflight.get(mode);
  if (p) return p;
  p = doRefresh(mode).finally(() => refreshInflight.delete(mode));
  refreshInflight.set(mode, p);
  return p;
}
```

**Concurrent read during refresh** (gemini §9.7): file reads use a separate
**read-write lock**. `loadAuth` takes read-lock, `saveAuth` takes write-lock.
Multiple concurrent reads OK; write blocks until reads drain; new reads queue
behind write. No partial-state observations possible.

### 2.7 OAuth security — PKCE deferral (gemini §9.5)

Current Naia portal returns `naia://auth?key=<naiaKey>&user_id=<id>&state=<csrf>`
directly — a simplified non-PKCE flow. **Risk**: malicious local app
registering the same URL scheme could intercept the `naiaKey` directly.

**Decision (v2)**: defer PKCE to a separate cross-repo issue:
- Portal-side: add `POST /api/auth/token` endpoint accepting `code` +
  `code_verifier`, returning `{naiaKey, refreshToken, expiresAt}`.
- Portal-side: change deep-link from `?key=` to `?code=`.
- Agent-side: generate `code_verifier` (43-128 random chars), derive
  `code_challenge = base64url(sha256(code_verifier))`, send challenge in initial
  authorize URL, send verifier in token exchange.

**Interim mitigation (this issue)**:
1. Tighten state token — bind to mode + issuer + scope + agent PID + 5-min TTL,
   in-memory only.
2. Reject deep-link if state token unknown / expired / mode mismatch.
3. Add agent log entry on every deep-link receive (success or reject) for
   forensic trail.
4. File a separate `nextain/naia.nextain.io` issue tagged "auth-security":
   "Add PKCE to gateway OAuth flow — required for native desktop apps".

### 2.8 Shell-side balance/usage fetch regression (codex §9.3)

Settings tab currently fetches `/api/balance`, `/api/usage` etc. using `naiaKey`
directly from secure-store. If shell loses key access (rule: "shell never
receives the naiaKey"), these break.

**Resolution**:
- New agent IPC: `{ type: "lab_proxy_request", mode, path, method, body? }`
- Agent forwards request through its own authenticated channel
- Response surface: same JSON shell already parses
- Audit list (codex pointed to `Settings` regression — exact sites grepped in
  Phase 6 sub-agent prep):
  - balance fetch
  - usage / quota fetch
  - linked-channels (`channel-sync.ts:11`)
  - discord-bot-token (`channel-sync.ts:12`)
  - lab-sync (`lab-sync.ts:5`)

Phase 6 scope expanded to cover all of these.

### 2.9 Cross-platform keyring abstraction (codex §9.2)

**Audit finding**: naia-agent currently uses Linux-only `secret-tool` CLI for
its secret-store, with no plaintext fallback and no Win/Mac support. Cannot
ship cross-platform persistence on top of this as-is.

**Resolution (Phase 2 expanded)**:
```
packages/runtime/src/utils/keyring.ts    (new abstraction)
  setMasterPassword(service, account, password): Promise<void>
  getMasterPassword(service, account): Promise<string | null>
  deleteMasterPassword(service, account): Promise<void>

Backends:
  - Windows: `wincred` via Node-API binding OR Tauri's existing DPAPI plugin
    (since shell already imports tauri-plugin-store, evaluate whether agent
    can call into it via IPC vs native module)
  - macOS: `security` CLI or `keytar` npm module
  - Linux: existing `secret-tool` (libsecret) + headless fallback (see below)

Linux headless fallback (gemini §9.8):
  If libsecret unavailable (D-Bus missing / headless / SSH-only):
    1. Derive master password from machine-id (etc.) + user-id + fixed salt
       — NOT secure against local attacker but consistent across restarts
    2. Write a SECURITY_DEGRADED marker to ADK auth/ + log warning every boot
    3. Document in user manual: "headless install loses keyring protection"
  This is acceptable for naia-os which is a GUI desktop app, but agent-only
  CLI deployments need awareness.
```

Phase 2 sub-agent must produce the keyring abstraction first, then encrypt
utility on top.

### 2.10 UI tri-state auth status (codex+gemini §9.4-5)

Shell renders three explicit states for the auth badge:
```
"checking"    → agent boot in progress, decrypting auth file
"logged_in"   → agent confirmed naiaKey loaded + non-expired
"logged_out"  → no file, or refresh failed, or user logged out
```

No optimistic "assume logged-in" with rollback — that flicker + briefly enables
gated UI which is unsafe. Agent boot path:

```
agent start → keyring.getMasterPassword() → loadAuth(mode) → decrypt
  → emit auth_changed { loggedIn: true|false }
shell mount → render "checking" → wait first auth_changed → settle
```

Boot SLA target: agent answers `auth_query` within 200ms p95 of process spawn.
If exceeded, file a perf issue rather than weakening UX.

## 3. Migration (Phase 8)

```
shell boot:
  if secure-keys.dat has naiaKey AND <ADK>/auth/{mode}.json.enc absent:
    1. infer mode from VITE_NAIA_USE_DEV_GATEWAY (canonical, not LAB_GATEWAY_URL)
    2. IPC: { type: "auth_legacy_migrate", mode, naiaKey, userId? }
    3. wait for agent ack OR timeout (5s)
       3a. ack OK → deleteSecretKey("naiaKey"), deleteSecretKey("apiKey") (purge D3)
       3b. ack FAIL / timeout → HARD-FAIL: leave secure-keys.dat slot intact,
                                emit auth_changed { loggedIn: false },
                                surface UI toast "Migration failed — please log in again"
    4. log to console + lessons-learned regardless of outcome
  if naiaKey missing in BOTH places → normal logged-out state
  if BOTH present → trust ADK file, purge secure-keys.dat slot (silent)
```

**Hard-fail on ack failure (codex+gemini §9.6)**: no fallback-to-shell-store
path. The whole point of #337 is to remove dual-SoT. A silent fallback would
preserve exactly the bug we're fixing.

`gatewayToken` slot is **untouched** by this migration — strictly deferred to
follow-up issue (see TODO marker in code + new GH issue filing in Phase 13).

## 4. Security review (preliminary)

| Risk | Mitigation |
|---|---|
| Master password leak | OS keyring (DPAPI / libsecret / Keychain). Never logged. Never sent via IPC. |
| Nonce reuse | naia-memory generates fresh 12B `randomBytes(12)` per `export()`. Each re-encrypt = new nonce. |
| File tampering | AES-GCM authTag (16B) — `import()` rejects with "Decryption failed" |
| TOCTOU on file write | atomic-write: `auth/{mode}.json.enc.tmp` → fsync → rename. Existing rollback path in naia-memory (line 1222-1226). |
| Refresh token replay | one-time use enforced by portal (cross-repo work — out of scope; agent assumes server-side enforcement). |
| Deep-link CSRF | state token bound to mode + agent process PID + 5-min TTL. agent verifies before storing. |
| IPC race during migration | single-flight mutex on `auth_legacy_migrate`. shell waits for agent ack before purging secure store. |
| Concurrent dev+prod sessions | separate files per mode → no contention. Shared master password, one keyring entry, both files derived with separate PBKDF2 salts (per-file salt in envelope). |
| **PKCE missing** (gemini §9.5) | Out-of-scope this issue — Naia portal uses simplified direct-token deep-link. Mitigation: tighter state token + 5min TTL + agent log trail. Follow-up issue filed in `nextain/naia.nextain.io` for full PKCE rollout. |
| **Cross-platform keyring** (codex §9.2) | naia-agent currently Linux-only `secret-tool`. Phase 2 produces abstraction with Win/Mac/Linux backends + headless fallback marker. |
| **Concurrent reads during refresh** (gemini §9.7) | Read-write lock on auth file. Reads can run concurrent; writes drain readers first. |
| **Refresh-token race** (gemini §9.6) | Single-flight mutex per mode; concurrent chats join in-flight refresh promise (no duplicate refresh, no fail-fast). |
| **Shell balance fetch regression** (codex §9.3) | New `lab_proxy_request` IPC; Phase 6 audits all shell-side fetch sites using `naiaKey` (balance, usage, linked-channels, discord-token, lab-sync). |

## 5. Phases (mapped to tasks #30-#42, **v2 scope updates**)

| # | Task ID | Phase | Scope notes (v2) | Verify (B-mode) |
|---|---|---|---|---|
| 1 | 30 | Plan + cross-review | ✓ This doc, v2 integrated | codex + gemini done |
| 2 | 31 | **crypto-envelope util** + **keyring abstraction** (Win/Mac/Linux + headless fallback) | Split from BackupCapable adapter. envelope util is naia-agent-local; backport to naia-memory follow-up. | parent reads diff |
| 3 | 32 | auth file reader/writer + mode inference + RW lock | Add `keyVersion: 1` field, RW lock, atomic write via .tmp+rename | parent reads diff |
| 4 | 33 | OAuth flow handler (in-memory state TTL + scope/mode/issuer bind) | NO PKCE this issue. Forensic logging on every deep-link receive. | parent reads diff |
| 5 | 34 | shell: OAuth trigger IPC delegation + `lab_proxy_request` IPC | New IPC for balance/usage/linked-channels/discord-token/lab-sync routed through agent | parent reads diff |
| 6 | 35 | shell: secure-keys.dat slot read removal + **shell balance fetch audit** | Grep all `naiaKey` reads; replace with `auth_query` or `lab_proxy_request`. Tri-state badge UI (checking/in/out). | parent reads diff |
| 7 | 36 | refresh rotation + 401 retry loop + single-flight | concurrent chats join in-flight promise | parent reads diff |
| 8 | 37 | legacy migration — **hard-fail on ack failure**, no fallback-to-shell | timeout 5s + UI toast on failure | parent reads diff |
| 9 | 38 | unit tests | envelope round-trip, keyring per-backend (mocked), RW lock, single-flight, hard-fail migration | parent runs full vitest |
| 10 | 39 | E2E (24 보완/25 모드swap/26 legacy migrate/27 migration-fail) | spec 27 신규 (ack timeout 시뮬레이션) | parent runs wdio |
| 11 | 40 | full cross-review (security focus) — PKCE deferral re-check, keyring backend audit | codex + gemini | parent reconciles findings |
| 12 | 41 | docs + lessons L061 + filed follow-up issues | follow-ups: (a) PKCE on portal, (b) gatewayToken migration, (c) naia-memory consume envelope util | parent reads diff |
| 13 | 42 | commit + close (naia-os + naia-agent + naia-adk PRs) | naia-adk: register `auth/` standard + `.gitignore` entry | smoke test |

## 6. Out of scope (deferred)

- `gatewayToken` WebSocket auth (separate slot, separate flow) — follow-up issue
- Multi-account swap within a single mode — follow-up issue
- Hardware-backed master key (TPM / Secure Enclave) — follow-up
- OIDC / external IdP (Google, Discord, ...) — already implemented via Naia portal as OAuth proxy
- Portal-side refresh-token endpoint implementation — cross-repo `naia.nextain.io` work, agent will tolerate absence (null refreshToken)

## 7. Acceptance criteria

1. After `pnpm run tauri:prod` login + app close + re-open in **either mode**, no re-login required for the mode that was logged in. Other mode shows logged-out state.
2. After `pnpm run tauri:dev` login + close + `pnpm run tauri:prod` open, prod-side login (if previously logged in) still valid. Dev-side login also valid on re-open.
3. `secure-keys.dat` after migration contains no `naiaKey` / `apiKey` / legacy slots (only `gatewayToken` if it existed pre-migration).
4. `<ADK>/auth/dev.json.enc` and `prod.json.enc` exist as binary blobs (no readable JSON).
5. `gh issue list` shows no auth-related 401 follow-up issues for 7 days post-merge.
6. unit + e2e all green; vitest + tsc --noEmit pass.

## 8. Cross-review questions (for codex + gemini)

1. **Master password lifecycle**: is "32 random bytes → OS keyring, never rotated" acceptable? Or should we add a rotation path (e.g. version field in keyring + multi-key try-decrypt)?
2. **`BackupCapable` reuse**: naia-memory's `export()` writes a self-contained PBKDF2-derived blob. Since we're using a stored-in-keyring password, the 200k PBKDF2 work is wasted on each read. Acceptable cost (~50ms) or do we want a thinner crypto wrapper?
3. **State token binding**: tying OAuth `state` to agent PID means state becomes invalid if agent crashes mid-login. Better: state stored in encrypted-at-rest file? Or accept "user has to retry login if agent crashes" (current shell-side behavior is identical)?
4. **`auth_query` race**: shell UI on cold-boot wants to render "logged in" badge fast. Agent boot + decrypt + answer query might take ~100ms. Show "checking..." state during that window, or assume logged-in and rollback on `auth_changed { loggedIn: false }` ?
5. **gatewayToken scope decision**: leaving it in `secure-keys.dat` for now creates a temporary inconsistency. Worth folding into this issue or strictly defer?
6. **Migration backout**: if agent fails to ack `auth_legacy_migrate`, shell currently does not purge slot. Should we add a max-retry + fall-back-to-shell-store path, or hard-fail with logout?

## 9. Cross-review integration (2026-05-28)

### 9.1 BackupCapable misuse (codex) — RESOLVED
naia-memory `BackupCapable.export/import` is memory-store-shaped (one SQLite
path is a stub). Cannot consume directly. **Action**: extract crypto envelope
into new `packages/runtime/src/utils/crypto-envelope.ts`. naia-memory follow-up
migration to consume same util (no on-disk format change).

### 9.2 Cross-platform keyring (codex) — RESOLVED
naia-agent's existing secret-store is Linux-only `secret-tool`, no fallback,
no Win/Mac. **Action**: Phase 2 produces keyring abstraction with three
backends + headless degraded mode (machine-id derived key + UI warning).

### 9.3 Shell balance fetch regression (codex) — RESOLVED
Shell Settings currently fetches balance/usage/etc. with `naiaKey` directly.
"Shell never receives key" breaks them. **Action**: new `lab_proxy_request`
IPC. Phase 6 audits all sites: balance, usage, linked-channels, discord-token,
lab-sync. Phase 6 scope expanded.

### 9.4 keyVersion metadata day-1 (codex) — RESOLVED
Add `keyVersion: 1` to blob payload + keyring account suffix `auth-master-v1`.
Future rotation = bump version + multi-key try-decrypt. No migration hack
needed later.

### 9.5 PKCE missing (gemini) — DEFERRED
Naia portal returns naiaKey directly in deep-link. PKCE requires portal-side
endpoint changes (cross-repo). **Action**: file follow-up issue in
`nextain/naia.nextain.io`. Interim mitigation: tighter state token (mode +
issuer + scope + PID + 5min TTL in-memory) + forensic deep-link log.

### 9.6 Refresh-token race condition (gemini) — RESOLVED
Concurrent chats during refresh **join the in-flight promise** rather than
fail-fast or duplicate-refresh. Implementation in §2.6.

### 9.7 Concurrent reads during refresh (gemini) — RESOLVED
Read-write lock on auth file. Reads concurrent, writes drain readers. No
partial-state observation. Implementation in §2.6.

### 9.8 Linux headless keyring (gemini) — RESOLVED
`secret-tool` may fail on headless / SSH-only. **Action**: degraded mode
(§2.9) with machine-id-derived key + SECURITY_DEGRADED marker + boot warning.
Documented in user manual.

### Universal answers (Q1-Q6 from §8)
| Q | Decision | Source |
|---|---|---|
| 1 | keyVersion meta day-1, single key for v1, multi-key try-decrypt for v2+ | codex |
| 2 | crypto envelope as separate util, NOT BackupCapable adapter API | codex |
| 3 | state token in-memory + TTL + mode/issuer/scope bind | both agree |
| 4 | explicit tri-state UI (checking/logged_in/logged_out), no optimistic | both agree |
| 5 | gatewayToken strict defer + loud TODO + follow-up issue | both agree |
| 6 | migration hard-fail + leave slot for retry, no fallback-to-shell | both agree |

---

**Next step**: user plan-gate confirm → Phase 2 begin.

User said "당장 진행해" — interpreted as implicit plan-gate approval after this
v2 integration. Phase 2 sub-agents start on parent's next turn.
