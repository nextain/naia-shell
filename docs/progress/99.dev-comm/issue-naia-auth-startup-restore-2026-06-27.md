# Naia auth startup restore fix

Date: 2026-06-27
Status: implemented
Fix commit: `553edd79`

## Scope Clarification

This fix targets the case where an already logged-in user had to re-login after
app startup before credits and chat worked. The re-login path itself was not the
broken path; it worked because it refreshed auth after the secure store had
finished loading. After this fix, startup restore should make that manual
re-login workaround unnecessary.

Out of scope: failures inside the interactive login flow itself, such as browser
auth monitor failures, missing `naia_auth_complete` emission from the Rust side,
or gateway/deep-link login errors.

## Symptom

When a user already had a Naia account logged in, the first app entry could fail
to show credits and chat could fail. Re-login fixed both because the login path
re-emitted `naia_auth_complete` after the secure store was already ready.

## Root Cause

`secure-keys.dat` persisted `naiaKey`, but startup consumers treated auth
restore as a one-shot read:

- `CostDashboard` fetched balance once and only retried on `naia_auth_complete`.
- `App` pushed startup auth to the agent, but a rejected secure-store restore
  could stop the flow before `auth_update`.
- localStorage no longer stores `naiaKey`, so the intended fallback was empty.

## Fix

- Retry initial Tauri Store load and reset the cached store promise on load
  failure.
- Make `loadConfigWithSecrets`, `hasApiKeySecure`, and `getNaiaKeySecure`
  tolerate transient secure-store read/write failures.
- Emit a local `naia_auth_ready` event after startup auth restore succeeds.
- Have `CostDashboard` retry balance fetch on `naia_auth_ready`, not only after
  explicit re-login.

## Verification

```bash
cd packages/shell
pnpm test src/lib/__tests__/config-secrets.test.ts src/components/__tests__/CostDashboard.test.tsx src/__tests__/secure-store.test.ts
pnpm exec tsc -b
pnpm build
pnpm exec biome lint src/App.tsx src/components/CostDashboard.tsx src/components/__tests__/CostDashboard.test.tsx src/lib/__tests__/config-secrets.test.ts src/lib/config.ts src/lib/secure-store.ts
```

All passed. Biome lint reported only pre-existing warnings in `config.ts` and
one existing `App.tsx` hook dependency warning.
