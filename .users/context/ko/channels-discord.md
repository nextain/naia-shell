<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Discord 통합 아키텍처

> SoT: `.agents/context/channels-discord.yaml`

## 핵심 원칙

**Naia는 로컬 AI 프로젝트. 클라우드는 중계만.**

- LLM 처리: 로컬 (Shell Agent — 페르소나, 메모리, 도구 포함)
- 메시지 저장: 로컬 (Discord 서버가 메시지를 자체 보관)
- Cloud Run 봇: 순수 릴레이 (수신, 전달, 회신 중계)
- Cloud Run은 LLM 호출, 메시지 저장, 어떤 처리도 하면 안 됨

참조: `philosophy.yaml` → `privacy_first` ("Local execution by default — cloud is opt-in")

## 메시지 파이프라인

### PC 온라인

```
Discord 유저 DM → Cloud Run 봇 (릴레이) → Shell (polling/push)
Shell → Agent → LLM (풀 컨텍스트: 페르소나, 메모리, 도구, 대화 히스토리)
Shell → Cloud Run 릴레이 → Discord reply
```

**Cloud Run은 절대 LLM을 호출하지 않음. Shell이 모든 처리를 담당.**

### PC 오프라인

```
Discord 유저 DM → Cloud Run 봇 수신, Shell 없음
응답 없음. 메시지는 Discord 서버에 남아있음.
PC 켜지면 → Shell이 Discord 히스토리 확인 → 미처리 메시지 처리
```

**PC 꺼져있으면 응답 없음. 이것이 설계 의도.**

## Cloud Run 봇 (순수 릴레이)

- **서비스**: `naia-discord-bot` (asia-northeast3)
- **역할**: 수신, 전달, 회신. 그 외 아무것도 하지 않음.
- **금지**: LLM 호출, 메시지 저장, 콘텐츠 처리, 응답 결정
- **필수**: Discord WebSocket 유지, 메시지 전달, Shell 응답 수신, 토큰 만료 시 알림 이메일

### 핵심 파일 (naia.nextain.io)
- `src/lib/discord-bot.ts` — 봇 로직
- `scripts/start-discord-bot.ts` — 진입점 + 헬스 서버
- `Dockerfile.discord-bot` — Cloud Run 컨테이너

## 컴포넌트

### Shell (Tauri 2 + React)
- **역할**: LLM 처리 허브
- Cloud Run에서 새 Discord 메시지 가져오기
- Agent + LLM으로 풀 컨텍스트 처리
- 응답을 Cloud Run으로 전송
- ChannelsTab에서 대화 표시

### Agent
- `skill_naia_discord` 스킬 (send/status/history)
- Gateway 이벤트를 Shell로 전달 (`channel.message` / `channels.message` → `discord_message`)

### Naia Gateway
- **역할**: 로컬 도구 실행 전용 — Discord 메시지 라우팅 아님
- **Discord 플러그인**: 비활성화 (DISABLED)
- `gateway.json`의 봇 토큰은 Shell REST API 접근용일 뿐

## 토큰 관리

| 항목 | 위치 |
|------|------|
| 봇 토큰 (런타임) | Cloud Run 환경변수 `DISCORD_BOT_TOKEN` |
| 봇 토큰 (Shell REST API) | `gateway.json → channels.discord.token` |
| 봇 토큰 (백업) | `my-envs/naia.nextain.io.env` |
| Gateway Discord 플러그인 | 비활성화 — 사용하지 않음 |
| 단일 연결 규칙 | 토큰당 WebSocket 1개. Cloud Run이 점유. |

## 로그인 / 채널 분리

**로그인**: `naia://auth?key=gw-xxx&user_id=xxx&state=xxx` — Discord 필드 없음, 프로바이더 무관.

**채널 연동** (`naia_auth_complete` 이후):
1. Shell이 `syncLinkedChannels()` 호출
2. BFF `GET /api/gateway/linked-channels` 호출
3. `{ channels: [{ type: "discord", userId: "..." }] }` 반환
4. Shell이 `discordDefaultUserId` 저장, DM 채널 열기, 채널 ID 저장

## 알려진 이슈

- `ChatPanel.tsx:985` — `discord_message`를 무시 (`break`). LLM 파이프라인 연결 필요. #155 참조
- `discord-bot.ts`에 `callLLM()` 있음 — 릴레이 전용 원칙 위반. 제거 필요. #155 참조
- Shell → Cloud Run 응답 API 미구현. #155 참조
- Shell의 Gateway config 의존성 (`read_discord_bot_token` from `gateway.json`). #154 참조

## 관련 이슈

- **#144** — 봇 토큰 만료 (해결: 새 토큰 + Cloud Run 배포)
- **#154** — Discord OpenClaw 의존성 제거
- **#155** — Shell 주도 Discord 응답 파이프라인 구현

---

*English mirror: [.users/context/channels-discord.md](../channels-discord.md)*
*AI context: [.agents/context/channels-discord.yaml](../../../.agents/context/channels-discord.yaml)*
