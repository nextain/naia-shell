<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Discord Integration Architecture

> SoT: `.agents/context/channels-discord.yaml`

## Core Principle

**Naia is a LOCAL AI project. Cloud is relay only.**

- LLM processing: LOCAL (Shell Agent with full persona/memory/tools)
- Message storage: LOCAL (Discord server retains messages natively)
- Cloud Run bot: PURE RELAY (receive Discord messages, forward to Shell, relay replies)
- Cloud Run MUST NOT call LLM, store messages, or process anything.

See: `philosophy.yaml` → `privacy_first` ("Local execution by default — cloud is opt-in")

## Message Pipeline

### PC Online

```
Discord user DM → Cloud Run bot (relay) → Shell (polling/push)
Shell → Agent → LLM (full context: persona, memory, tools, history)
Shell → Cloud Run relay → Discord reply
```

**Cloud Run NEVER calls LLM. Shell does ALL processing.**

### PC Offline

```
Discord user DM → Cloud Run bot receives but no Shell available
No response. Messages remain on Discord server.
When PC comes online → Shell checks Discord history → processes unread messages
```

**No response when PC is off. This is by design.**

## Cloud Run Bot (Pure Relay)

- **Service**: `naia-discord-bot` (asia-northeast3)
- **Role**: Receive, forward, reply. Nothing else.
- **MUST NOT**: Call LLM, store messages, process content, make decisions
- **MUST**: Maintain Discord WebSocket, forward messages, accept Shell responses, send alert on token expiry

### Key Files (naia.nextain.io)
- `src/lib/discord-bot.ts` — Bot logic
- `scripts/start-discord-bot.ts` — Entry point + health server
- `Dockerfile.discord-bot` — Cloud Run container

## Components

### Shell (Tauri 2 + React)
- **Role**: LLM processing hub
- Polls Cloud Run for new Discord messages
- Processes through Agent + LLM with full context
- Sends response back to Cloud Run for delivery
- Displays conversation in ChannelsTab

### Agent
- `skill_naia_discord` skill (send/status/history)
- Forwards Gateway events to Shell (`channel.message` / `channels.message` → `discord_message`)

### Naia Gateway
- **Role**: Local daemon for tool execution only — NOT for Discord
- **Discord plugin**: DISABLED
- Bot token in `gateway.json` is for Shell REST API access only

## Token Management

| Item | Location |
|------|----------|
| Bot token (runtime) | Cloud Run env var `DISCORD_BOT_TOKEN` |
| Bot token (Shell REST API) | `gateway.json → channels.discord.token` |
| Bot token (backup) | `my-envs/naia.nextain.io.env` |
| Gateway Discord plugin | DISABLED — do not use |
| One-connection rule | Discord allows ONE WebSocket per token. Cloud Run holds it. |

## Login / Channel Separation

**Login flow**: `naia://auth?key=gw-xxx&user_id=xxx&state=xxx` — no Discord fields, provider-agnostic.

**Channel flow** (after `naia_auth_complete`):
1. Shell calls `syncLinkedChannels()`
2. Fetches `GET /api/gateway/linked-channels` (BFF)
3. Returns `{ channels: [{ type: "discord", userId: "..." }] }`
4. Shell persists `discordDefaultUserId`, opens DM channel, persists channel ID

## Known Issues

- `ChatPanel.tsx:985` — `discord_message` ignored (`break`). Should route to LLM pipeline. See #155
- `discord-bot.ts` has `callLLM()` — violates relay-only principle. Must be removed. See #155
- Shell → Cloud Run reply API not yet implemented. See #155
- Gateway config dependency in Shell (`read_discord_bot_token` from `gateway.json`). See #154

## Related Issues

- **#144** — Bot token expired (resolved: new token + Cloud Run deployment)
- **#154** — Remove OpenClaw dependency for Discord
- **#155** — Implement Shell-driven Discord response pipeline

---

*Korean mirror: [.users/context/ko/channels-discord.md](ko/channels-discord.md)*
*AI context: [.agents/context/channels-discord.yaml](../../.agents/context/channels-discord.yaml)*
