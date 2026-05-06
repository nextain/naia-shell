# skill_naia_discord — Discord 메시징 스킬

## 개요

Naia agent의 Discord 메시지 전송/수신 스킬입니다.
Naia Gateway의 Discord 채널을 통해 DM/채널 메시지를 보내고 받습니다.

## 액션

### `send` — 메시지 전송
- **필수**: `message`
- **선택**: `to`, `channelId`, `userId`, `accountId`
- Gateway RPC: `send`

### `status` — 연결 상태 확인
- Gateway RPC: `channels.status`
- Discord 계정 연결 상태 반환

### `history` — 최근 메시지 조회
- **선택**: `limit` (기본 20, 최대 100), `to`, `channelId`, `userId`
- Gateway RPC: `channels.discord.readMessages`

## 타깃 해석 (4단계 fallback)

1. **명시적 파라미터**: `to` / `channelId` / `userId`
2. **환경변수**: `DISCORD_DEFAULT_USER_ID` → `DISCORD_DEFAULT_TARGET` → `DISCORD_DEFAULT_CHANNEL_ID`
3. **Gateway 상태**: `channels.status` → `extractUserTargetFromChannelsStatus()`
4. **null** → 에러 반환 (타깃 필수)

## discordUserId 흐름

```
OAuth 로그인 (naia.nextain.io)
  → 콜백 deep link (discord_user_id 포함)
  → Rust 파싱 (lib.rs:1378~1505)
  → discord_auth_complete 이벤트
  → persistDiscordDefaults()
  → config.discordDefaultUserId
  → ChatPanel loadConfig() → sendChatMessage
  → agent applyNotifyWebhookEnv
  → process.env.DISCORD_DEFAULT_USER_ID
  → resolveEnvDefaultTarget()
```

**주의**: discordUserId는 OAuth에서 가져오는 것. `.env` 하드코딩은 잘못된 접근.

## Allowlist

DM 전송 전 `discord-allowFrom.json`에 타깃 사용자를 추가하여 답장 가능하게 합니다.
- 파일: `~/.naia/credentials/discord-allowFrom.json`
- 함수: `ensureDiscordAllowlisted()`

## 관련 파일

- `agent/src/skills/built-in/naia-discord.ts` — 스킬 구현
- `shell/src/lib/discord-auth.ts` — OAuth 콜백 처리
- `shell/src-tauri/src/lib.rs` (1378~1505) — deep link 파싱

## 제약사항

- 모든 타깃 해석은 자체 에이전트 코드에서 처리
- 모든 타깃 해석은 우리 agent 코드에서 수행
- Gateway 연결 필수
