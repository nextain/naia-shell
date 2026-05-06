<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# skill_naia_discord -- Discord Messaging Skill

> SoT: `.agents/context/skill-naia-discord.yaml`

## Overview

Discord message send/receive skill for the Naia agent.
Sends and receives DM/channel messages through the Naia Gateway's Discord channel.

## Actions

### `send` -- Send Message
- **Required**: `message`
- **Optional**: `to`, `channelId`, `userId`, `accountId`
- Gateway RPC: `send`

### `status` -- Check Connection Status
- Gateway RPC: `channels.status`
- Returns Discord channel accounts with connection state

### `history` -- Read Recent Messages
- **Optional**: `limit` (default 20, max 100), `to`, `channelId`, `userId`
- Gateway RPC: `channels.discord.readMessages`

## Target Resolution (4-step fallback)

1. **Explicit params**: `to` / `channelId` / `userId`
2. **Environment variables**: `DISCORD_DEFAULT_USER_ID` -> `DISCORD_DEFAULT_TARGET` -> `DISCORD_DEFAULT_CHANNEL_ID`
3. **Gateway status**: `channels.status` -> `extractUserTargetFromChannelsStatus()`
4. **null** -> Error (target required)

## discordUserId Flow

```
OAuth login (naia.nextain.io)
  -> Callback deep link (with discord_user_id)
  -> Rust parses deep link (lib.rs:1378-1505)
  -> discord_auth_complete event
  -> persistDiscordDefaults()
  -> config.discordDefaultUserId
  -> ChatPanel loadConfig() -> sendChatMessage -> agent env
  -> process.env.DISCORD_DEFAULT_USER_ID
  -> resolveEnvDefaultTarget()
```

**Warning**: discordUserId comes from OAuth, NOT from `.env` hardcoding.

## Allowlist

Before every DM send, the target user is added to `discord-allowFrom.json` so they can reply.
- File: `~/.naia/credentials/discord-allowFrom.json`
- Function: `ensureDiscordAllowlisted()`

## Key Files

- `agent/src/skills/built-in/naia-discord.ts` -- skill implementation
- `shell/src/lib/discord-auth.ts` -- OAuth callback handling
- `shell/src-tauri/src/lib.rs` (lines 1378-1505) -- deep link parsing

## Constraints

- All target resolution happens in our agent code
- Gateway must be connected for any action
