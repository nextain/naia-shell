# Auth Login Diagnosis — 2026-05-28

**Author**: claude (Opus 4.7)
**Scope**: Tauri shell ↔ naia-agent ↔ naia.nextain.io portal login disconnect
**Context**: Issue #337 (ADK-centric auth persistence) is functionally landed (commits b05386a0 → 6a3b18af).
User reports: `pnpm run tauri:dev` login button → system browser → portal redirects to `/dashboard`
(NOT `/callback`) → no `naia://` deep-link → Tauri app waits indefinitely.

User stipulated requirements (must verify against code):
1. Login + naiaKey ownership = **naia-agent only**. naia-os shell is a "shell" (껍데기).
2. Encrypted auth blob persisted at **NAIA_ADK_PATH user-specified path**.
3. Shell → agent IPC plumbing must be wired (user's hypothesis: this is the disconnect).

## 1. Code flow — login (system browser path, mode="dev")

```
[Shell SettingsTab.startLabLogin] (projects/naia-os/shell/src/components/SettingsTab.tsx:1319)
  ↓ const mode = resolveAuthMode()  // "dev" iff VITE_NAIA_USE_DEV_GATEWAY === "1"
  ↓ const { authUrl } = await agentAuthStart({ mode, locale })
[Shell agent-ipc.agentAuthStart] (projects/naia-os/shell/src/lib/agent-ipc.ts:179)
  ↓ send_to_agent_command { type: "auth_start", id, mode, locale }
  ↓ listen("agent_response", type === "auth_start_response", same id)
[Agent bin/naia-agent.ts dispatch] (projects/naia-agent/bin/naia-agent.ts:1603)
  ↓ case "auth_start": handleAuthStart({ mode, scope?, locale? })
[Agent ipc-handlers.handleAuthStart] (projects/naia-agent/packages/runtime/src/auth/ipc-handlers.ts:100)
  ↓ startOAuth({ mode, scope, locale })
[Agent oauth-flow.startOAuth] (projects/naia-agent/packages/runtime/src/utils/oauth-flow.ts:118)
  ↓ const issuer = resolveIssuer(mode)            // dev → http://localhost:3001
  ↓                                                // prod → https://naia.nextain.io
  ↓ const state = randomBytes(32).toString("hex")
  ↓ stateMap.set(state, { mode, issuer, scope, expiresAt: now+5min })
  ↓ params: state, app="naia-os", platform, redirect="desktop", source="desktop", scope?
  ↓ authUrl = `${issuer}/${locale}/login?${params}`
[Shell openUrl(authUrl)] → system browser (system default browser)
  ↓
[Portal naia.nextain.io proxy.ts:79] auth(request) wraps middleware
  ↓ pathAfterLocale[0] === "login" && request.auth (already authenticated)
  ↓ redirect = "desktop", source = "desktop", app = "naia-os"
  ↓ isDesktopAuth = redirect === "desktop" || app === "naia-os" → TRUE
  ↓ target = `/${urlLocale}/callback?source=desktop`   // <-- state NOT forwarded
  ↓ NextResponse.redirect(new URL(target, request.url))
[Portal callback page] projects/naia.nextain.io/src/app/[lang]/(auth)/callback/page.tsx
  ↓ source = searchParams.get("source") → "desktop"
  ↓ state = searchParams.get("state") → NULL  // lost in proxy redirect!
  ↓ fetch("/api/gateway/desktop-key", POST) → { key, userId }
  ↓ source !== "embedded" && source !== "web"
  ↓ window.location.href = buildNaiaAuthDeepLink({ key, userId, state: null })
  ↓ → "naia://auth?key=gw-...&user_id=..."   // no state param!
[OS naia:// scheme] → Windows registry HKCU/SOFTWARE/Classes/naia
  ↓ → spawns the registered handler (should be the running Tauri exe)
[Tauri tauri_plugin_deep_link.on_open_url] (projects/naia-os/shell/src-tauri/src/lib.rs:3830)
  ↓ process_deep_link_url(url, app_handle, Some(&oauth_state), "plugin")
[Rust process_deep_link_url] (projects/naia-os/shell/src-tauri/src/lib.rs:39)
  ↓ parses naia://auth?key=...&user_id=...   // no state
  ↓ Some(state_mutex), expected = None (shell never set Rust-side state since #337)
  ↓ check passes (no shell-side state to compare against)
  ↓ payload = { "deepLinkUrl": url_str }
  ↓ app_handle.emit("naia_auth_complete", payload)
[Shell App.tsx listener] (projects/naia-os/shell/src/App.tsx:546)
  ↓ listen("naia_auth_complete", e => agentAuthReceived(e.payload.deepLinkUrl))
[Shell agentAuthReceived] → IPC → agent
[Agent handleAuthReceived] (projects/naia-agent/packages/runtime/src/auth/ipc-handlers.ts:108)
  ↓ receiveOAuthDeepLink(deepLinkUrl)
[Agent receiveOAuthDeepLink] (projects/naia-agent/packages/runtime/src/utils/oauth-flow.ts:159)
  ↓ params.get("state") → NULL
  ↓ return reject("missing_state")     // <-- fails here
  ↓ // OR if portal preserved state via callback ?state=, then OK path:
  ↓ saveAuth(authState) → <NAIA_ADK_PATH>/naia-settings/auth/{mode}.json.enc
  ↓ // emit "auth_changed" { loggedIn: true } via bin/naia-agent.ts:1629-1637
```

## 2. Verifying user-stipulated requirements against code

### Req 1: naia-agent owns login + naiaKey, shell is shell

| Check | Code | Status |
|---|---|---|
| Shell never reads naiaKey | grep `"naiaKey"` in shell/src → only test fixtures + envelope-removed comments | ✅ Phase 6c removed (commit `c44fdd6c`) |
| Shell sends raw deepLinkUrl, not parsed key | `App.tsx:546-571` forwards `event.payload.deepLinkUrl` verbatim | ✅ |
| Agent owns state generation + validation | `oauth-flow.ts:124` randomBytes(32) → in-memory stateMap | ✅ |
| Agent persists key | `auth-store.saveAuth` writes encrypted blob | ✅ |
| Shell uses lab_proxy IPC for balance/usage | `SettingsTab.fetchLabBalance` → `agentLabProxyRequest` | ✅ Phase 6b (commit `c5fbf1d3`) |

### Req 2: Encrypted at NAIA_ADK_PATH

| Check | Code |
|---|---|
| File path | `auth-store.ts:66-72` `<NAIA_ADK_PATH>/naia-settings/auth/{mode}.json.enc` |
| Encryption | `auth-store` uses `crypto-envelope` (AES-256-GCM, salt+nonce+authTag) |
| Master key | `keyring` abstraction — Windows DPAPI / macOS Keychain / Linux secret-tool |
| Atomic write | `.tmp` + rename pattern |

✅ Fully matches user requirement.

### Req 3: Shell ↔ agent IPC wiring (user's primary suspicion)

| IPC type | Shell sender | Agent dispatch | Status |
|---|---|---|---|
| auth_start | `agentAuthStart` (agent-ipc.ts:179) | `bin/naia-agent.ts:1603` → `handleAuthStart` | ✅ wired |
| auth_received | `agentAuthReceived` (agent-ipc.ts:208) | `bin/naia-agent.ts:1622` → `handleAuthReceived` | ✅ wired |
| auth_query | `agentAuthQuery` (agent-ipc.ts:246) | `bin/naia-agent.ts:1665` → `handleAuthQuery` | ✅ wired |
| auth_logout | `agentAuthLogout` (agent-ipc.ts:236) | `bin/naia-agent.ts:1646` → `handleAuthLogout` | ✅ wired |
| auth_legacy_migrate | `agentAuthLegacyMigrate` (agent-ipc.ts:273) | `bin/naia-agent.ts:1679` → `handleAuthLegacyMigrate` | ✅ wired |
| lab_proxy_request | `agentLabProxyRequest` (agent-ipc.ts:302) | (assumed wired, not verified in this pass) | ⚠ verify |
| naia_auth_complete (Tauri event) | App.tsx:546 listener | Rust `lib.rs:135` emit | ✅ wired |
| auth_changed (push event) | `onAgentAuthChanged` (agent-ipc.ts:334) | agent emit on saveAuth success | ✅ wired |

**Conclusion**: Static IPC wiring appears intact end-to-end. User's "껍데기 → naia-agent 연결 끊김" hypothesis
is **not supported by source code inspection**. The disconnect is not at the IPC plumbing layer.

## 3. Failure hypotheses (ranked by likelihood)

### Hypothesis A — `projects/naia-os/agent/dist/index.cjs` stale (HIGH likelihood)

**Evidence**:
- `naia-os/agent/dist/index.cjs` mtime: **2026-05-20 14:57**
- `naia-agent/packages/runtime/dist/auth/ipc-handlers.js` mtime: **2026-05-28 15:47**
- `naia-agent/bin/naia-agent.ts` mtime: **2026-05-28 13:45**
- 8-day gap → agent bundle does NOT include #337 auth IPC handlers
- Recent commit `33c28b07` added auto-build to `dev-setup.mjs`, but if it failed silently
  on user's last `pnpm run tauri:dev`, stale dist persists

**Predicted observable**: Shell sends `auth_start` IPC → agent (5/20 vintage) has no `auth_start`
case in dispatch → silent drop or "unknown message type" → 15s timeout in `requestAgent`
→ openUrl never called OR called with cached/null authUrl.

**Quick check**: build agent, compare `dist/index.cjs` mtime to source mtimes after build,
inspect `dist/index.cjs` for presence of string `"auth_start"`.

**Caveat**: User reports openUrl DOES navigate to `https://naia.nextain.io/...` (per AskUserQuestion answer).
This suggests authUrl IS being produced by the agent. If dist were stale (no #337 handlers),
shell would time out before openUrl. **This weakens hypothesis A** — but the URL the user sees
may NOT include `redirect=desktop`/`app=naia-os` params, which would cause portal to send them
to `/dashboard` (matching reported symptom). Need to verify exact URL bar.

### Hypothesis B — Portal proxy.ts loses `state` query param (HIGH likelihood, deep failure)

**Evidence**:
- `naia.nextain.io/src/proxy.ts:95`:
  ```ts
  target = isDesktopAuth
    ? `/${urlLocale}/callback?source=${...}`
    : `/${urlLocale}/dashboard`
  ```
  → **state, app, redirect, platform, scope query params are dropped** when constructing target
- Callback page reads `searchParams.get("state")` (callback/page.tsx:16) → NULL
- `buildNaiaAuthDeepLink({key, userId, state: null})` produces `naia://auth?key=...&user_id=...`
  (no state)
- Agent `receiveOAuthDeepLink` (oauth-flow.ts:173): `if (!stateParam) return reject("missing_state")`
- Login fails silently from user perspective (no UI feedback that state was missing)

**Predicted observable**: deep-link DOES reach Tauri (Rust emits `naia_auth_complete`), shell DOES
forward to agent, but agent rejects with `reason: "missing_state"`. Shell logs `[auth] agentAuthReceived not ok`
but no UI surfacing. App.tsx:559 logs to Logger.warn but does not surface to user.

**Quick check**: tail naia.log under naia logs directory for `Deep link received` and `auth_received_response`
with `ok: false, reason: "missing_state"`.

### Hypothesis C — Portal redirects to `/dashboard` instead of `/callback` (MEDIUM likelihood, surfaces as user-reported symptom)

**Evidence**:
- User's last clarification: "로그인 버튼 클릭시 로컬호스트 3001 대시보드야"
  (button click → localhost:3001/dashboard)
- BUT user's earlier AskUserQuestion answer: "https://naia.nextain.io/... → 로그인 페이지/대시보드 정상"
  - These are inconsistent: localhost:3001 vs naia.nextain.io
  - User may be conflating two test scenarios (running `npm run dev` portal locally on :3001 +
    OS Chrome already logged into naia.nextain.io for a different test run)

**Failure mode**: if portal middleware does NOT see `redirect=desktop` or `app=naia-os`
(because they're missing from authUrl), `isDesktopAuth = false` → user sent to dashboard,
deep-link never fires.

**Subcase C1 — agent dist stale, missing params**: Connects to Hypothesis A. If 5/20 vintage
oauth-flow lacked `redirect=desktop`, agent emits authUrl without those params → portal
sends user to dashboard. Combined hypothesis: A → C1 → reported symptom.

**Subcase C2 — naia.nextain.io portal deploy stale**: localhost dev portal may have a different
proxy.ts than the production code we read. Production deploy may lack the `isDesktopAuth` branch
at all (older portal version).

**Quick check**: open dev tools in system browser BEFORE clicking login button. Observe URL bar
after redirect chain. Look for `redirect=desktop` in the original openUrl URL AND in the
post-middleware-redirect URL.

### Hypothesis D — `naia://` scheme not registered to current dev exe (MEDIUM likelihood)

**Evidence**:
- Tauri `app.deep_link().register_all()` (`lib.rs:3820`) registers the *running* exe in
  Windows HKCU/SOFTWARE/Classes/naia at app init
- `pnpm run tauri:dev` builds a fresh debug exe each time but runs from a randomized cargo target dir
- If a previous prod build registered an absolute path that no longer exists, the OS will:
  - silently fail to launch (Windows) OR
  - show "find an app in Store" dialog OR
  - launch the previous build's exe (if still on disk)

**Predicted observable**: clicking the manual `<a href={deepLinkUrl}>` link on the callback
page produces no Tauri-side log entry. naia.log shows NO `Deep link received` lines.

**Quick check**: `reg query HKCU\SOFTWARE\Classes\naia\shell\open\command /ve` (Windows).
Compare exe path against currently-running Tauri dev process.

### Hypothesis E — `tauri-with-mode.mjs` missing `NAIA_AGENT_MODE` (LOW likelihood, edge case)

**Evidence**:
- `scripts/tauri-with-mode.mjs` sets `VITE_NAIA_USE_DEV_GATEWAY=1` but NOT `NAIA_AGENT_MODE=dev`
- Issue #337 design doc §2.3 explicitly diff'd this in: `+ env.NAIA_AGENT_MODE = "dev"`
- Wrapper does not implement that part of the design

**Predicted impact**: `getCurrentMode()` (auth-store.ts:62) returns "prod" default. IPC handlers
take mode as explicit arg from shell, so `auth_start` / `auth_received` / `auth_query` are safe.
BUT `lab_proxy_request` and any internal path that falls back to `getCurrentMode()` will mis-route.

**Not the login-disconnect cause** but a correctness bug nonetheless.

### Hypothesis F — Disconnect in process_deep_link_url for keyless naia:// without state (LOW)

**Evidence**:
- `lib.rs:80-99`: when `oauth_state` mutex is None (Phase 6c removed shell-side state),
  the no-state branch falls into `None => log_both("[Naia] Deep link rejected: missing state parameter"); return;`
- Wait — re-reading: the check is `if let Some(state_mutex)` then `if let Some(ref expected_val)`.
  If `expected = None` (shell never set Rust state), the inner check is skipped. ✅ safe.
- BUT — `has_direct_gateway_key` shortcut works only if `key` is present AND valid format.
  If portal sends deep-link with only `key=gw-XYZ` (no state, no user_id), Rust accepts and emits.
  Agent rejects later for `missing_state`. End-user-visible failure.

## 4. Documentation gap — context for next AI session

Files needing update to capture #337 v2:

| File | Current state | Gap |
|---|---|---|
| `.agents/context/agent-bridges.yaml` | documents pre-#337 `auth_update` IPC | missing `auth_start/received/query/logout/legacy_migrate` IPC contract, missing `lab_proxy_request`, missing `auth_changed`/`auth_expired` push events |
| `.agents/context/agent-bridges.yaml` | mentions `_agentNaiaKey` module-scope cache | superseded by encrypted ADK file persistence + tri-state badge |
| `.agents/context/gateway-sync.yaml` | mentions `naia_auth_complete` as trigger | does not document new `deepLinkUrl` payload shape vs legacy `{naiaKey, naiaUserId}` |
| no file documents tri-state auth badge | — | `useAuthStatus` lifecycle (checking/logged_in/logged_out) is not in context |
| no file documents OAuth state TTL or in-memory map | — | crash semantics ("force re-login on agent crash") not surfaced |
| no file documents portal `redirect=desktop` contract | — | cross-repo coupling between naia-agent oauth-flow and naia.nextain.io proxy.ts not captured |

## 5. Recommended decisive probe

The fastest way to discriminate between Hypotheses A vs B vs C vs D is to **read the actual
state** rather than spawn more code:

1. Rebuild naia-os/agent bundle (`cd projects/naia-os/agent && pnpm build`)
2. `grep "auth_start\|redirect=desktop" projects/naia-os/agent/dist/index.cjs` → discriminates A
3. Launch `pnpm run tauri:dev`, click Lab Login
4. Observe system browser address bar at every step (initial URL, post-redirect URL)
5. Tail naia.log under naia logs directory — look for `Deep link received` / `Naia auth complete`
6. `reg query HKCU\SOFTWARE\Classes\naia\shell\open\command /ve` — discriminates D
