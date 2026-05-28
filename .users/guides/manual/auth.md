<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Authentication — Login persistence and dev/prod mode

> Spec: `.agents/plans/issue-337-adk-auth-persistence.md` · E2E scenarios: S115/S116/S117/S118

This page explains how Naia OS stores your login so you don't have to sign in
on every restart, how `tauri:dev` and `tauri:prod` modes keep separate
sessions, and what to do when something goes wrong.

## TL;DR

- **Log in once per environment.** Dev (`localhost:3001`) and prod (`naia.nextain.io`) sessions are stored separately. Switching modes does not log you out of the other one.
- **App restart preserves login.** Your encrypted session lives in your ADK folder under `naia-settings/auth/`.
- **The agent owns the key.** The shell never sees your `naiaKey` directly — every authenticated API call goes through the agent.
- **If you see "Migration failed" toast**, see [Troubleshooting](#troubleshooting) below.

## Where your session is stored

```
<ADK_PATH>/
└── naia-settings/
    └── auth/
        ├── dev.json.enc    ← localhost:3001 dev portal session
        └── prod.json.enc   ← naia.nextain.io prod portal session
```

Each file is encrypted with AES-256-GCM (the same envelope format used by
naia-memory v6 backups). The master password lives in your OS keychain
(Windows DPAPI / macOS Keychain / Linux Secret Service), not in any file.

### What's inside each blob (decrypted)

```jsonc
{
  "schema": 1,
  "keyVersion": 1,
  "mode": "dev" | "prod",
  "naiaKey": "gw-...",          // bearer for X-AnyLLM-Key header
  "refreshToken": "rt-..." | null,
  "userId": "naia_...",
  "issuer": "http://localhost:3001" | "https://naia.nextain.io",
  "scope": [...],
  "issuedAt": 1748400000,
  "expiresAt": null,             // null = static key (current portal)
  "rotatedAt": null
}
```

Only the agent decrypts this. The shell receives `{loggedIn, userId, expiresAt}` via the `auth_query` IPC — never the bearer itself.

## The dev/prod mode separation

| Run | Mode | Portal | Auth file |
|---|---|---|---|
| `pnpm run tauri:dev` | dev | http://localhost:3001 | `auth/dev.json.enc` |
| `pnpm run tauri:prod` | prod | https://naia.nextain.io | `auth/prod.json.enc` |

The two are independent. Logging in to dev does not affect prod, and vice
versa. The badge in **Settings → Naia 계정** shows the **current** mode's
status.

## What the auth badge means (Settings panel)

The badge is a tri-state:

| State | Meaning |
|---|---|
| **확인 중...** (checking) | Agent is decrypting your session file on boot. Usually under 200ms. |
| **로그인됨** (logged_in) | Active session, agent has your key in memory + on disk. |
| **로그인되지 않음** (logged_out) | No session for this mode. Click "Naia 연결" to log in. |

Do NOT take any action while the badge says "checking" — the agent is mid-boot.

## First-time login

1. Open Settings → Naia 계정.
2. Click **Naia 연결**. The portal opens in your default browser.
3. Sign in. The portal redirects to `naia://auth?...` which Naia OS receives.
4. The agent validates the state token, decrypts/creates your auth file, and the badge flips to **로그인됨**.

The shell never receives your `naiaKey` in this flow — the deep-link URL is forwarded straight to the agent, which parses, validates, and persists.

## Restart behavior

When you close and reopen Naia OS:

1. The agent reads its master password from your OS keychain.
2. It decrypts `<ADK>/naia-settings/auth/<mode>.json.enc`.
3. The badge settles to **로그인됨** within ~200ms.
4. Chat, voice, and memory all work immediately — no login prompt.

If you switch modes (`tauri:dev` ↔ `tauri:prod`) and the other mode also has a session, that one is preserved too. They sit in different files.

## Logout

Click **Naia 연결 해제** in Settings. This:

1. Calls `agent_logout` IPC.
2. Agent deletes `<ADK>/naia-settings/auth/<current-mode>.json.enc`.
3. Badge flips to **로그인되지 않음**.

The OTHER mode's auth file is untouched. The master password in your OS
keychain stays (it's reused next login).

## Legacy migration (from pre-#337 versions)

If you had a Naia OS login from before this redesign, the shell still has
your `naiaKey` in Tauri's secure store (`secure-keys.dat`). On first boot
after upgrading:

1. Shell detects the legacy key.
2. Calls `agent_legacy_migrate` IPC with the legacy key + your user ID.
3. Agent creates the encrypted auth file as if you had just logged in.
4. Shell purges the legacy slot from `secure-keys.dat`.
5. No re-login required.

Migration is **silent on success**. If the agent fails to acknowledge within
5 seconds, the shell shows a Korean toast: **이전 로그인 정보를 옮기지
못했습니다. 다시 로그인해 주세요.** The legacy slot is preserved so a future
launch can retry — no data loss.

## Troubleshooting

### "Migration failed — please log in again" toast

Cause: agent didn't acknowledge the migration IPC within 5 seconds. Usually
means the agent process crashed during boot.

Fix: click **Naia 연결** to log in normally. The legacy slot will be
unused but harmless. To clear it manually, you can disconnect (which calls
`deleteSecretKey` for the legacy keys as well).

### Badge stuck on "확인 중..."

Cause: agent didn't answer `auth_query` within the SLA. Usually the agent
crashed or is still building (`tauri:dev` runs `pnpm install + build` in the
background on first run).

Fix: check the agent terminal output. If `pnpm install` is still running,
wait. If the agent has crashed, restart Naia OS.

### `[오류] Unauthorized` on chat

Cause #1 (most common): your portal session token has been revoked or
expired server-side, and the portal doesn't yet support refresh-token
rotation. In the current implementation this means re-login.

Cause #2: you're running `tauri:dev` against a dev gateway whose JWT secret
doesn't match the portal's signing key. Rare — usually only happens during
infra changes.

Fix: click **Naia 연결 해제**, then **Naia 연결** again to get a fresh
session.

### Voice features (gemini-live, naia-talk) broken after login

Known issue tracked as [#338](https://github.com/nextain/naia-os/issues/338).
WebSocket voice auth is the last shell-side reader of the legacy slot. For
**new accounts created after the #337 redesign**, the legacy slot is empty,
so the voice WebSocket can't authenticate.

Workaround (until #338 lands): use a previous account that already had the
legacy slot populated, OR wait for the voice auth migration into the agent.

### "OS keyring unavailable — degraded protection" warning (Linux headless)

Cause: D-Bus session not available or libsecret not installed. The agent
falls back to a machine-id-derived master password. Your auth file is still
encrypted but the master password is recoverable by any process with file-
read access on your machine.

Fix on Linux GUI: install `libsecret-tools` and start a graphical session.
Fix on headless: accept the degraded protection or use a different
secret-store. The encrypted file is still confidential against attackers
without local FS access.

## Security model

- AES-256-GCM, 200,000 PBKDF2 iterations, 12-byte nonce per encryption, 16-byte authentication tag. Same crypto envelope as naia-memory v6 backups.
- File permissions: 0o600 (auth files), 0o700 (auth/ directory). Windows uses NTFS ACLs (per-user default).
- Master password: 32 random bytes (hex), stored in OS keychain. Generated once per machine, never rotated in v1 (multi-key try-decrypt is reserved via the `keyVersion` field for a future migration).
- Shell never sees the `naiaKey`. Every authenticated HTTP call from the shell goes through the agent's `lab_proxy_request` IPC, which restricts the target host to your issuer's origin to prevent exfiltration.
- OAuth state token: 32 random bytes, in-memory, 5-minute TTL, bound to `{mode, issuer, scope}`. Single-use.
- Forensic log: every `auth_start` / `auth_received` event is logged to an in-memory ring buffer (cap 1000). No secrets in the log. Accessible via the `oauth_log_query` IPC for diagnostics.

## Limitations

- No PKCE yet — the current portal flow returns the key directly in the deep-link query. Tracked as a follow-up issue against the portal repo.
- No refresh-token endpoint on the portal yet. The agent's refresh code is implemented and waits for the portal to expose `POST /api/auth/refresh`.
- Multi-account swap within a single mode is not supported. Logging in switches the file's contents wholesale.
- See [#339](https://github.com/nextain/naia-os/issues/339) for additional follow-ups (fsync, expired-state check, SECURITY_DEGRADED marker, PID binding).
