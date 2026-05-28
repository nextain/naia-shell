# Auth Login Fix Plan — 2026-05-28

**Author**: claude (Opus 4.7)
**Predecessor**: `projects/naia-os/.agents/plans/auth-login-diagnosis-2026-05-28.md`
**Cross-review round 1** (analysis-review profile, 3 reviewers): FOUND_ISSUES — 8 findings folded into this plan
**Status**: Awaiting round 2 cross-review (this document) before implementation

## A. Diagnosis corrections (from round 1)

### A1. Line-number citations (LOW × 2, CONFIRMED by 2 reviewers)

- `projects/naia-agent/packages/runtime/src/utils/oauth-flow.ts:173` → actual `:175`
- `projects/naia.nextain.io/src/proxy.ts:95` → actual `:94`

Documentation-only. No impact on root cause.

### A2. Hypothesis A re-ranked HIGH → MEDIUM (CONFIRMED by 2 reviewers)

Round 1 found a logical inconsistency: if `dist/index.cjs` has no `"auth_start"` string
(grep confirmed), the shell's `agentAuthStart` would time out at 15s and `openUrl` would
never fire. But the user reported `openUrl` DOES navigate (to `naia.nextain.io`). These
are mutually exclusive: either the dist is stale (no openUrl) OR the dist is fresh
(openUrl works, ranking not relevant).

**Re-rank**: A → MEDIUM. The HIGH ranking was inflated by the desire to explain the
user-reported "dashboard, not callback" symptom; in reality A and the user-observable
are inconsistent, so A should be tested but is not the primary hypothesis.

### A3. Hypothesis F is a sub-step of B, not independent (CONFIRMED by 1 reviewer, solo but logically forced)

The `missing_state` rejection (oauth-flow.ts:175) IS the downstream effect of the
proxy state-drop (Hypothesis B). They cannot be independent: if B is true, F always
fires; if B is false, F never fires.

**Fix**: collapse F into B as a sub-step. Update §3 to enumerate the agent-side
rejection path as part of B's predicted observable, not as a separate hypothesis.

### A4. Missing alternative — residual browser session (CONFIRMED by 1 reviewer, HIGH impact)

The diagnosis assumed the user clicks login from a fresh browser. In reality, the
system browser likely has an active NextAuth session cookie on `naia.nextain.io`.
On any new openUrl(authUrl), the portal middleware (`proxy.ts:79`) hits
`pathAfterLocale[0] === "login" && request.auth` immediately, fires the
`isDesktopAuth` branch, redirects to `/callback?source=desktop` — losing state.

This is **the same code path as B**, but is the trigger condition that explains why
the user observes the dashboard/callback symptom on every login attempt without
waiting at the OAuth provider. It does NOT change the root cause (state drop in
proxy.ts) but DOES explain why every attempt fails the same way.

**Add as a new "Trigger Condition" note under B**, not as a separate hypothesis G.

### A5. Hypothesis C2 (stale portal deploy) needs independent assessment

C2 (production portal lacking the `isDesktopAuth` branch) is structurally separate
from C1 (agent-side stale dist producing param-less authUrl). C2 affects ALL users
of the production portal; C1 affects only users with stale local dist.

**Action**: enumerate C2 as **HypB-v2**: portal deploy version mismatch — production
portal may lack the proxy.ts code we examined. Decisive probe: open browser dev tools,
check the actual `Location:` header on the post-login redirect to determine if the
portal middleware is the one we read.

### A6. callback page state expression precision (CONFIRMED by 1 reviewer)

Diagnosis wrote `buildNaiaAuthDeepLink({ key, userId, state: null })` implying
hardcoded null. Actual: `state` is a variable read from searchParams that resolves
to null because proxy didn't forward it. The failure mechanism is identical, but
the fix targeting is different.

**Correct phrasing**: "`state` variable resolves to null at callback page load because
the proxy redirect omitted the `state` query param."

### A7. OAuth state TTL expiry (LOW, 1 reviewer)

A 5-minute TTL on `stateMap` entries means slow logins produce `reject("unknown_state")`
rather than `reject("missing_state")`. Different log signature, but same end-user
visible failure mode.

**Action**: add as a tail hypothesis (low-likelihood) and ensure §5 probe instructs
inspection of which reject reason appears in agent log.

## B. Updated hypothesis list (post-correction)

| ID | Rank | Hypothesis | Status |
|----|:----:|------------|--------|
| **B** | **HIGH** | Portal proxy.ts:94 drops `state` query param when redirecting authenticated users to `/callback`. Agent's `receiveOAuthDeepLink` rejects with `missing_state`. | **PRIMARY** — confirmed by code reading |
| **B-trigger** | — | Residual NextAuth session cookie on `naia.nextain.io` causes every login to hit the authenticated-user middleware branch on first request, with no fresh OAuth round-trip. | Explains "always fails the same way" |
| **B-v2** | MEDIUM | Production portal deploy lacks the `isDesktopAuth` branch entirely (older version than the source we read). | Independent root cause if B-v2 holds |
| A | MEDIUM | naia-os/agent/dist/index.cjs (mtime 5/20) is stale; missing `redirect=desktop` param in authUrl. | Likely but inconsistent with observable |
| D | MEDIUM | Windows registry has stale `naia://` scheme pointing to a previous build's exe. | Plausible; discriminate via reg query |
| E | LOW | `tauri-with-mode.mjs` missing `NAIA_AGENT_MODE=dev` env. | Not the login-disconnect cause but a correctness bug |
| TTL | LOW | OAuth state expired (>5 min between authUrl emit and deep-link receive). | Different log signature |

Hypothesis F removed (folded into B as sub-step).

## C. Fix actions (ordered)

### Fix 1 — Portal middleware preserves query params (PRIMARY FIX)

**File**: `projects/naia.nextain.io/src/proxy.ts:94-96`

**Current**:
```ts
const target = isDesktopAuth
  ? `/${urlLocale}/callback?source=${source === "embedded" ? "embedded" : "desktop"}`
  : `/${urlLocale}/dashboard`;
return NextResponse.redirect(new URL(target, request.url));
```

**Proposed**:
```ts
const target = isDesktopAuth
  ? `/${urlLocale}/callback`
  : `/${urlLocale}/dashboard`;
const targetUrl = new URL(target, request.url);
if (isDesktopAuth) {
  // Forward all query params from the original /login request so the callback
  // page receives `state` (CSRF token from naia-agent) and any other context.
  // Without this the agent's receiveOAuthDeepLink rejects with `missing_state`.
  // Source param normalization: "embedded" stays, otherwise → "desktop".
  for (const [k, v] of request.nextUrl.searchParams) {
    if (k === "source") continue; // we normalize source separately
    targetUrl.searchParams.set(k, v);
  }
  targetUrl.searchParams.set("source", source === "embedded" ? "embedded" : "desktop");
}
return NextResponse.redirect(targetUrl);
```

**Rationale**: Preserves `state`, `app`, `scope`, `platform`, `locale` — all
naia-agent OAuth params survive the middleware. `source` is normalized as before.
Non-desktop redirects to `/dashboard` remain param-free (current behavior unchanged).

**Test**: open `https://naia.nextain.io/en/login?state=ABC123&app=naia-os&redirect=desktop&source=desktop`
while authenticated → expect `Location: /en/callback?state=ABC123&app=naia-os&redirect=desktop&source=desktop`.

**Risk**: open-redirect / param injection via the login URL. Mitigation: the source
param is sanitized (only "embedded" or "desktop"); other params are passed to the
callback page (a trusted internal page), not to external URLs. The callback page's
existing logic — `buildNaiaAuthDeepLink` constructs a fixed `naia://` URL with only
known fields — limits the blast radius.

### Fix 2 — Rebuild naia-os/agent bundle (MAINTENANCE, but discriminates A)

```bash
cd projects/naia-os/agent
pnpm build
# Verify new dist contains #337 IPC handlers:
grep -c '"auth_start"' dist/index.cjs        # expect >0
grep -c '"auth_received"' dist/index.cjs     # expect >0
grep -c 'redirect=desktop' dist/index.cjs    # expect >0
```

**Rationale**: even if Fix 1 resolves the login disconnect for current users, the
stale dist is a latent bug for any user whose env doesn't trigger the auto-build
on `dev-setup.mjs`. This MUST be done before E2E verification.

**Risk**: build failure cascading. Mitigation: build is idempotent; existing dist
is preserved if build fails. Verify mtime advance.

### Fix 3 — Add `NAIA_AGENT_MODE` to wrapper (CORRECTNESS, addresses Hypothesis E)

**File**: `projects/naia-os/scripts/tauri-with-mode.mjs`

**Current** (dev branch):
```js
if (mode === "dev") {
  env.VITE_NAIA_USE_DEV_GATEWAY = "1";
  env.VITE_NAIA_DEV_GATEWAY_URL = env.VITE_NAIA_DEV_GATEWAY_URL || "...";
  process.stdout.write(...);
}
```

**Proposed**:
```js
if (mode === "dev") {
  env.VITE_NAIA_USE_DEV_GATEWAY = "1";
  env.VITE_NAIA_DEV_GATEWAY_URL = env.VITE_NAIA_DEV_GATEWAY_URL || "...";
  env.NAIA_AGENT_MODE = "dev";  // #337 §2.3 — agent auth-store + lab-proxy fall-back
  process.stdout.write(...);
} else {
  delete env.VITE_NAIA_USE_DEV_GATEWAY;
  delete env.VITE_NAIA_DEV_GATEWAY_URL;
  env.NAIA_AGENT_MODE = "prod";
  process.stdout.write(...);
}
```

**Rationale**: per #337 design doc §2.3, the agent needs `NAIA_AGENT_MODE` for
`getCurrentMode()` fall-back (auth-store.ts:62). All explicit-mode IPC handlers
already pass `mode`, so this is a defense-in-depth fix, not on the critical path.

### Fix 4 — Surface auth_received rejection to shell UI (UX, prevents silent fails)

**File**: `projects/naia-os/shell/src/App.tsx:556-568`

**Current**: warn-log only.

**Proposed**: on `result.ok === false`, also setState an error banner via a context
or pubsub. Shell currently has no UI for "login failed" — the user sees the
"waiting..." spinner indefinitely. Recommend adding a useAuthStatus error field
that the tri-state badge component can render.

**Risk**: UX surface area expands. Mitigation: keep banner low-key, dismissable.

**Defer decision**: if Fix 1 lands, the rejection path stops firing. Surfacing is
hygiene only. Suggest tracking as a separate hygiene issue rather than blocking
this fix bundle.

### Fix 5 — Agent state TTL extension OR shell retry on `unknown_state` (LOW priority)

Not in critical path. Defer to follow-up if §5 probe reveals `unknown_state`
rejection in agent logs.

## D. Context (AI doc) sync — required for round-2 acceptance

Even if the code fixes land, the next AI session needs to know:

### D1. `projects/naia-os/.agents/context/agent-bridges.yaml`

Replace `auth_flow:` section (currently describes pre-#337 `auth_update` IPC) with:

```yaml
auth_flow_v2:
  introduced: "#337 (2026-05-28)"
  credential_owner: agent
  storage: "<NAIA_ADK_PATH>/naia-settings/auth/{dev,prod}.json.enc (AES-256-GCM)"
  master_key: "OS keyring service=io.nextain.naia account=auth-master-v1"
  ipc:
    auth_start: "shell → agent. returns {authUrl, state}. authUrl includes redirect=desktop, app=naia-os, source=desktop, state=<64hex>, platform"
    auth_received: "shell → agent. raw deepLinkUrl forwarded. agent parses + validates state map. saves to encrypted file. emits auth_changed."
    auth_query: "shell → agent. returns {loggedIn, expiresAt?, userId?, scope?[]} — never naiaKey."
    auth_logout: "shell → agent. deletes encrypted file. emits auth_changed loggedIn:false."
    auth_legacy_migrate: "Phase 8 one-shot. seeds encrypted file from legacy shell secure-keys.dat."
    lab_proxy_request: "shell → agent. shell never holds naiaKey. agent injects X-AnyLLM-Key. 401 → single-flight refresh + retry."
  push_events:
    auth_changed: "agent → shell. {mode, loggedIn}. fires on save/delete."
    auth_expired: "agent → shell. {mode, reason}. fires on refresh failure."
  state_token:
    storage: "in-memory only (oauth-flow.ts stateMap)"
    ttl: "5 minutes"
    bindings: ["mode", "issuer", "scope"]
    crash_semantics: "agent crash forces re-login (state lost)"
  cross_repo_coupling:
    portal_middleware: "naia.nextain.io/src/proxy.ts must forward all query params (especially state) to /callback redirect — otherwise agent rejects missing_state. See auth-login-fix-plan-2026-05-28.md Fix 1."
    portal_callback_page: "naia.nextain.io/src/app/[lang]/(auth)/callback/page.tsx fires naia:// deep-link via buildNaiaAuthDeepLink (deep-link.ts). state field is conditionally included only when truthy."
  shell_ui:
    tri_state_badge: "checking / logged_in / logged_out — useAuthStatus consumes onAgentAuthChanged"
  legacy_removed:
    auth_update_ipc: "removed in #337 Phase 6c — shell never holds naiaKey"
    shell_secure_keys_naia_slot: "removed in commit c44fdd6c — secure-keys.dat retains only gatewayToken (deferred to follow-up)"
```

### D2. `projects/naia-os/.agents/context/gateway-sync.yaml`

Update `lab_auth_complete event` reference to note new payload shape (`{deepLinkUrl}`)
and that legacy `{naiaKey, naiaUserId}` payload from browser.rs fallback path is a
distinct emission path used only by headed-Chrome standalone (browser.rs:1247).

### D3. Triple-mirror

Per project mirroring rules, propagate D1+D2 changes to `.users/context/agent-bridges.md`
and `.users/context/ko/agent-bridges.md`, same for gateway-sync.

## E. Implementation order (sub-agent assignment plan)

1. **Sub-agent S1 — naia.nextain.io fix** — apply Fix 1 to proxy.ts, write unit test
   verifying query-param forwarding for `/login → /callback` redirect on authenticated
   user. Plan-gate: human verifies test passes locally on port 3001.

2. **Sub-agent S2 — naia-os agent rebuild** — apply Fix 2 + Fix 3, verify grep outputs.

3. **Sub-agent S3 — Context sync** — apply D1+D2+D3 changes.

4. **Verification (human-in-the-loop)** — run `pnpm run tauri:dev`, click Lab Login,
   confirm:
   - System browser opens `localhost:3001/{lang}/login?state=...&redirect=desktop&...`
   - Portal redirects to `/{lang}/callback?state=...&redirect=desktop&...&source=desktop` (state preserved)
   - Callback page fires `naia://auth?key=...&user_id=...&state=...` (state present)
   - Tauri receives deep-link, agent persists to `<NAIA_ADK_PATH>/naia-settings/auth/dev.json.enc`
   - Tri-state badge → `logged_in`

5. **Optional follow-ups (track separately)** — Fix 4 (shell UX), Fix 5 (TTL/retry),
   browser.rs:1247 legacy-shape emit cleanup.

## F. Acceptance criteria

| # | Criterion | Verification |
|---|-----------|-------------|
| F1 | proxy.ts forwards all original query params to `/callback` redirect | unit test in `naia.nextain.io/src/__tests__` |
| F2 | E2E login on `pnpm run tauri:dev` succeeds without manual re-login | manual walkthrough §E.4 |
| F3 | `dist/index.cjs` contains `auth_start`, `redirect=desktop` strings | grep verification §C.Fix 2 |
| F4 | `agent-bridges.yaml` documents the 5 new IPC types + 2 push events + storage path | grep / human read |
| F5 | No re-introduction of shell-side naiaKey handling | grep `naiaKey` in shell/src returns only test fixtures + removed comments |
| F6 | Triple-mirror parity (`.users/{en,ko}/`) for context changes | sync-entry-points hook clean |

## G. Out of scope (deferred)

- PKCE on portal OAuth (cross-repo follow-up; tracked in #337 §6)
- gatewayToken slot migration (separate slot, separate flow; #337 §6)
- Hardware-backed master key (TPM / Secure Enclave; #337 §6)
- Embedded Chrome path (browser.rs:1247 legacy emit shape) — file separate hygiene issue
