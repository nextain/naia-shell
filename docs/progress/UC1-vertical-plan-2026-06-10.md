# UC1 수직 엮기 + 라이브 trace 계획 (2026-06-10)

> 수평 계약·코드 = 2-clean 완료. 이 문서 = **다음 단계(수직 U1.1~U1.6 → 라이브 채팅 1턴)** 접근 계획.
> ⚠️ 라이브 trace = stdin/stdout 실배선(현재 NotWired)을 실제 Tauri shell↔agent 에 연결 = **실제 앱 동작 생성** = 루크 가시성 지점. 루크 확인하에 진행 권장(이 계획 먼저 검토).

## 1. 현재 (수평, 검증됨)
- `ChatService`(domain) ─ `AgentTransportPort` ─ `StdioTransportAdapter`(변환만, 전송=NotWired) ─ `MessageRouter`(demux) ─ `ClientSessionPort`(ownership).
- 계약 테스트 = mock transport 로 송수신·상태기계·ownership·exhaustive demux 전부 green(94/94). **실제 stdin/stdout 만 미연결.**

## 2. 수직 U1.1~U1.6 (UC1 시나리오 = 사용자가 한 줄 입력→스트리밍 응답)
| 단계 | 수평 컴포넌트 | 라이브 배선 대상(old-naia-os 경로) |
|---|---|---|
| U1.1 입력 | shell ChatPanel → ChatPort.startTurn | `ChatPanel.tsx handleSend`→`chat-service.ts sendChatMessage` 를 TauriChatBridge 로 대체(invoke 직결 제거) |
| U1.2 송신 | StdioTransportAdapter.send → wire | `invoke("send_to_agent_command")`(stdin write) — adapter 의 NotWired send 를 실제 invoke 로 |
| U1.3 agent 추론 | (out of new-naia — old agent) | `agent/index.ts handleChatRequest`→`provider.chat()` (frozen, 그대로 사용) |
| U1.4 수신 | onMessage → MessageRouter | `listen("agent_response")` → adapter onMessage 로 방출 |
| U1.5 demux/라우팅 | MessageRouter → ChatPort.deliverChunk | (구현됨 — 그대로) |
| U1.6 렌더 | ChatService onChunk → shell | TauriChatBridge 가 onChunk → ChatPanel 렌더 event |

## 3. 라이브 배선 방법 (3 옵션 — 루크 결정)
- **A. 그래프트 스니펫 검증 먼저**(F0 패턴): 실제 naia-os 띄우고 DevTools 에서 새 core 의 송수신 매핑이 라이브 wire 와 등가인지 확인(앱 무수정, 관측만). → 안전, 가시성 확보.
- **B. shell 편입 후 배선**: `packages/shell`(old shell verbatim 편입) 안에서 chat-service 를 TauriChatBridge 로 교체. → 실제 동작하지만 shell 수정.
- **C. 최소 실행 harness**: new-naia-os 에 얇은 Tauri 실행 타깃 추가, 단일 채팅 1턴 trace. → 격리 검증, old 앱 무접촉.

권고: **A(관측) → C(격리 trace) → B(편입)** 순. A·C 는 old 앱 무접촉(라이브 admin 안전, [[feedback_no_second_cascade_beside_live_demo]] 정합).

## 4. 검증 게이트 (P02 3-tier)
1. **Old-Baseline 등가**: 라이브 wire(JSON-line) 캡처 ↔ adapter encode/decode 바이트 등가(drift-gate).
2. **계약 테스트**: 이미 green(94/94).
3. **통합 reafference**: 실제 1턴 trace(입력→스트리밍→finish) 관측.

## 5. 미해결/주의
- StdioTransportAdapter 실 send/onMessage = `@tauri-apps/api` 필요(new-naia-os 는 현재 node TS — Tauri 의존 추가 or shell 편입 시점에).
- requestId 고유성 불변식(§B.4.1) = 라이브에서도 baseline 이 보장(매 send UUID). 위반 시 레지스트리 충돌거부가 1차 방어.
- voice/tool/panel(비-chat variant) = PendingRouteSink 보류 중 → 각 UC(UC5/UC9/voice)에서 실제 포트 배선.
