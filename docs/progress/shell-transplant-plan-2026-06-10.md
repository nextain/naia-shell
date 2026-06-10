# 실 Shell 편입 (Option B) 계획 — 2026-06-10

> 전제: os UC1 수평(계약·코드 2-clean) + agent UC1(계약·코드 2-clean) + **수직 결선 PASS**(os↔agent 실 stdio) 완료.
> 남은 = 실 shell(UI)을 새 os 코어에 결선 + 실 LLM provider + 기존 provider설정/로그인 흐름 활용.
> ⚠️ 절대기준 유지: 시나리오→계약→코드 격리, 단계별 2-clean, 결정론 게이트, 앵커 이탈 시 멈춤.

## 0. 현 결선 (검증됨, 헤드리스)
```
shell(ChatPanel) ──?── ChatBridge → ChatService(ChatPort) → makeLiveStdioTransport/child-stdio
                                      → MessageRouter ← agent_response
new-naia-agent: ingress → ChatTurnHandler → provider(fake) → egress
```
`?` = 아직 실 shell 미결선(헤드리스 harness/mock 으로만 검증).

## 1. 편입 방식 (단계, 깨짐 방지)
- **B0. 작업장**: `new-naia-os/packages/shell` = old-naia-os/shell verbatim 복사(frozen 무수정). `pnpm-workspace.yaml` 등록. Tauri src-tauri 포함.
- **B1. 결선 1점**: shell `lib/chat-service.ts sendChatMessage` 를 **새 core 경유**로 교체 — `wireChatUC1({live:{invoke,listen}})` + `ChatBridge.submit`. 실 `@tauri-apps/api` invoke/listen 주입. 다른 chat 경로(voice/tool)는 후속 UC.
- **B2. 실 provider**: new-naia-agent `providers/`(ollama/openai/vllm) 이식 → fake 대체. agent 빌드 → AGENT_CMD 실 provider.
- **B3. provider설정/로그인**: 기존 개발분(provider config UI + login OAuth) 재사용 — chat_request 의 provider/creds_update 채널로 흘림. (이미 어느정도 개발됨 = 루크 지시.)

## 2. 검증 게이트 (각 단계)
- B0/B1: tsc 빌드 + 기존 shell 테스트 green + **그래프트 관측**(`uc1-graft-observe` 스니펫으로 실 wire 등가).
- B2: 수직 결선 harness 를 실 provider 로(AGENT_CMD + 로컬 모델) — 단 GPU/ollama 충돌 확인 후(루크 환경).
- B3: 라이브 1턴 trace(실 앱 채팅) — 루크 가시성.

## 3. 위험 / 경계
- 75K shell 복사 + Tauri 빌드 = 대형. **중간 깨짐 방지** = B0→B1→B2→B3 각 단계 빌드 green 유지, 단계마다 커밋.
- 실 앱/GPU 접촉(B2 실 LLM, B3 라이브) = 루크 환경/확인 필요(라이브 admin 충돌 주의, [[feedback_no_second_cascade_beside_live_demo]]).
- 앵커: shell 편입해도 H-agent wire 계약 불변(probe 양방향 게이트 유지). UC1 수직만, 다른 UC 는 매트릭스 backlog.

## 4. 다음 액션 (이어서)
1. B0 작업장(packages/shell 복사 + workspace) — 빌드 green 확인.
2. B1 chat-service 결선 1점 — 계약(이미 ChatBridge/makeLiveStdioTransport 있음) 대로, 2-clean.
3. (루크 환경) B2 실 provider + B3 라이브 trace.
