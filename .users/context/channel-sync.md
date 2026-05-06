# Channel Sync Architecture

## Login / Channel Separation

Login and channel logic are fully separated:

### Login Flow
1. Deep link: `naia://auth?key=gw-xxx&user_id=xxx&state=xxx`
2. No Discord fields in deep link — login is provider-agnostic
3. Callback page issues desktop key only, no channel resolution

### Channel Flow
1. After `lab_auth_complete`, Shell calls `syncLinkedChannels()`
2. Shell fetches `GET /api/gateway/linked-channels` (BFF) with `X-Desktop-Key` + `X-User-Id` headers
3. BFF calls Gateway `lookupUser` → reads `linked_accounts` from metadata
4. Returns: `{ channels: [{ type: "discord", userId: "..." }] }`
5. Shell persists `discordDefaultUserId` to config
6. Shell calls `openDmChannel(discordUserId)` via Rust Discord Bot API → gets DM channel ID
7. Shell persists `discordDmChannelId` to config
8. Shell awaits `syncGatewayWithChannels()` → writes `gateway.json` + restarts Gateway

### DM Channel ID Refresh
- DM channel ID is **always refreshed** on every `syncLinkedChannels()` call, even if already set
- This is critical because:
  - DM channel ID enables `fetchDiscordMessages()` (conversation history)
  - DM channel ID enables receiving Discord DMs
  - DM channel ID must be in `gateway.json` for Gateway to route messages
- Flow: `openDmChannel(userId)` → Discord API `POST /users/@me/channels` → returns channel ID

### Key Files
| File | Role |
|------|------|
| `shell/src/lib/channel-sync.ts` | Main channel sync logic |
| `shell/src/lib/discord-api.ts` | Discord REST API client (via Rust proxy) |
| `naia.nextain.io/src/app/api/gateway/linked-channels/route.ts` | BFF API |
| `naia.nextain.io/src/lib/deep-link.ts` | Simplified (no discord params) |
| `shell/src-tauri/src/lib.rs` | No user_id→discord fallback |

### Test Files
| File | Coverage |
|------|----------|
| `shell/src/lib/__tests__/channel-sync.test.ts` | Unit tests (9 cases: full flow, refresh, error handling) |
| `shell/e2e-tauri/specs/70-channel-sync-dm.spec.ts` | Tauri E2E (requires LAB_KEY + LAB_USER_ID) |

## Gateway linked_accounts

The Gateway stores linked provider accounts in `CaretUser.metadata_.linked_accounts`:

```json
{
  "linked_accounts": {
    "google": "google-account-id",
    "discord": "discord-snowflake-id"
  }
}
```

This is populated automatically when a user logs in with multiple providers using the same email.

The `GET /v1/auth/lookup` endpoint now returns `linked_accounts` in its response.

## Gateway Sync

After DM channel ID is resolved, `channel-sync.ts` performs a single **awaited** sync:

- **Persistent config** (`syncGatewayWithChannels`): Writes to `gateway.json` via `syncToGateway()` + `restartGateway()` — survives Gateway restarts

> **Note:** The previous runtime patch (`syncDiscordToGateway` via `skill_config` tool call) was removed to prevent race conditions from concurrent file writes to `gateway.json`.

## Extensibility

The channel sync architecture supports future messaging channels:
- Discord (implemented)
- Slack (planned)
- Google Chat (planned)

Each channel type follows the same pattern:
1. Gateway stores the linked account in `metadata_.linked_accounts`
2. BFF `linked-channels` endpoint maps providers to channel descriptors
3. Shell syncs each channel type independently
