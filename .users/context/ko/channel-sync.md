# 채널 동기화 아키텍처

## Login / Channel 분리

로그인과 채널 로직이 완전히 분리됨:

### 로그인 흐름
1. 딥링크: `naia://auth?key=gw-xxx&user_id=xxx&state=xxx`
2. 딥링크에 Discord 필드 없음 — 로그인은 프로바이더에 무관
3. Callback 페이지는 데스크톱 키만 발급, 채널 해결 없음

### 채널 흐름
1. `lab_auth_complete` 후, Shell에서 `syncLinkedChannels()` 호출
2. Shell이 `GET /api/gateway/linked-channels` (BFF) 호출 (`X-Desktop-Key` + `X-User-Id` 헤더)
3. BFF가 Gateway `lookupUser` 호출 → `metadata`에서 `linked_accounts` 읽기
4. 응답: `{ channels: [{ type: "discord", userId: "..." }] }`
5. Shell이 `discordDefaultUserId`를 config에 저장
6. Shell이 `openDmChannel(discordUserId)` 호출 (Rust Discord Bot API 경유) → DM 채널 ID 획득
7. Shell이 `discordDmChannelId`를 config에 저장
8. Shell이 `syncGatewayWithChannels()` await → `gateway.json` 기록 + Gateway 재시작

### DM 채널 ID 갱신
- DM 채널 ID는 `syncLinkedChannels()` 호출 시 **항상 갱신** (이미 설정되어 있어도)
- 갱신이 중요한 이유:
  - DM 채널 ID가 있어야 `fetchDiscordMessages()` (대화 목록 조회) 가능
  - DM 채널 ID가 있어야 Discord DM 수신 가능
  - DM 채널 ID가 `gateway.json`에 있어야 Gateway가 메시지를 라우팅
- 흐름: `openDmChannel(userId)` → Discord API `POST /users/@me/channels` → 채널 ID 반환

### 핵심 파일
| 파일 | 역할 |
|------|------|
| `shell/src/lib/channel-sync.ts` | 채널 동기화 메인 로직 |
| `shell/src/lib/discord-api.ts` | Discord REST API 클라이언트 (Rust 프록시 경유) |
| `naia.nextain.io/src/app/api/gateway/linked-channels/route.ts` | BFF API |
| `naia.nextain.io/src/lib/deep-link.ts` | 간소화 (discord 파라미터 제거) |
| `shell/src-tauri/src/lib.rs` | user_id→discord 폴백 제거 |

### 테스트 파일
| 파일 | 커버리지 |
|------|----------|
| `shell/src/lib/__tests__/channel-sync.test.ts` | 단위 테스트 (9개: 전체 흐름, 갱신, 에러 처리) |
| `shell/e2e-tauri/specs/70-channel-sync-dm.spec.ts` | Tauri E2E (LAB_KEY + LAB_USER_ID 필요) |

## Gateway linked_accounts

Gateway는 연결된 프로바이더 계정을 `CaretUser.metadata_.linked_accounts`에 저장:

```json
{
  "linked_accounts": {
    "google": "google-account-id",
    "discord": "discord-snowflake-id"
  }
}
```

같은 이메일로 여러 프로바이더 로그인 시 자동 연결됨.

`GET /v1/auth/lookup` 엔드포인트가 이제 응답에 `linked_accounts`를 포함.

## Gateway 동기화

DM 채널 ID 해결 후, `channel-sync.ts`가 단일 **await** 동기화 수행:

- **영구 설정** (`syncGatewayWithChannels`): `syncToGateway()` + `restartGateway()`로 `gateway.json` 기록 — Gateway 재시작 시에도 유지

> **참고:** 기존 런타임 패치(`syncDiscordToGateway` → `skill_config` 도구 호출)는 `gateway.json` 동시 쓰기 race condition 방지를 위해 제거됨.

## 확장성

채널 동기화 아키텍처는 향후 메시징 채널 지원:
- Discord (구현 완료)
- Slack (계획)
- Google Chat (계획)

각 채널 타입은 동일한 패턴:
1. Gateway가 `metadata_.linked_accounts`에 연결된 계정 저장
2. BFF `linked-channels` 엔드포인트가 프로바이더를 채널 디스크립터로 변환
3. Shell이 각 채널 타입을 독립적으로 동기화
