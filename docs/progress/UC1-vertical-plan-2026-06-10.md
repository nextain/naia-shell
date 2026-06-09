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

## 3.1 ✅ Option A 진행 결과 (2026-06-10, 루크 선택)
- **관측 도구**: `uc1-graft-observe.sh`(→ `uc1-graft-snippet.js`, DevTools `window.uc1` 헬퍼). withGlobalTauri:false 라 콘솔 관측+수동 classify 범위. node 스모크 통과. **실 paste+채팅은 루크 손 필요**(앱 + DevTools).
- **헤드리스 등가 게이트**: `uc1-variant-probe.mjs` — 앱 없이 frozen shell `AgentResponseChunk`(소비자 권위 17종)을 새 core 분류와 결정론 비교.
- **🔎 발견(drift→수정)**: 새 core variant 세트(18)가 shell 이 실제 받는 `config_update`·`discord_message`·`gateway_approval_request` 3종을 **누락 → unknown 오분류**였음. NONCHAT_KNOWN 에 추가(비-chat, 해당 UC 배선까지 PendingRouteSink). **probe 재실행 = PASS**(missing 0). superset-only(token_warning·object·ready·embedding_progress = agent emit superset, 무해).
- 의의: Option A 의 헤드리스 부분이 **라이브 paste 없이 실제 drift 1건을 잡음**(= f0-boot-probe 처럼). 라이브 paste 는 동적 추가 확인용.
- **🔎 추가 정정(codex S1)**: `gateway_approval_request`(requestId 보유·ChatPanel chunk 처리=turn-bound 승인)를 nonchat 으로 오분류 → 보류 시 turn 끊김. **chat-turn 으로 이동**(approval_request 동급) + ChatChunk `gatewayApprovalRequest` kind 추가. 최종 분류 = 11 chat-turn + 19 nonchat-known(=30). audio 는 codex 미지적(UC1=텍스트라 voice UC 보류 의도 수용).

## 3.2 ✅ Option C 진행(헤드리스 trace, 라이브 admin 무접촉)
- `child-stdio` transport 어댑터(순수, LineIO 추상) — 직접 agent stdin/stdout(Tauri command 분리 없이 전부 writeLine, agent readline 이 type 분기). mock LineIO 테스트 4건.
- `uc1-trace-harness.mjs` — 새 core(dist)를 **실 child_process stdio** 로 구동. fake agent(chat_request→text+usage+finish 에코)로 **1턴 end-to-end PASS**(송신→스트리밍→렌더 순서→finish 해제, exit 0). **mock 아닌 실 process/stdio 통합** 입증.
- 실 frozen agent 로 전환 = `AGENT_CMD="node ../old-naia-os/agent/dist/index.js --stdio"`(단 agent dist 빌드=frozen 트리에 artifact + LLM provider 필요 → 루크 결정). Tauri GUI 대신 Node child_process라 라이브 admin 무접촉.

## 4. 검증 게이트 (P02 3-tier)
1. **Old-Baseline 등가**: 라이브 wire(JSON-line) 캡처 ↔ adapter encode/decode 바이트 등가(drift-gate).
2. **계약 테스트**: 이미 green(94/94).
3. **통합 reafference**: 실제 1턴 trace(입력→스트리밍→finish) 관측.

## 4.1 ✅ 라이브 배선 실제 결합 (baseline 실측 — 계약이 추상화했던 부분, 라이브가 표면화)
shell→rust hop = **타입별 별도 Tauri command**(계약 §A "stdin JSON-line"은 rust→agent hop 얘기):
| outbound | shell invoke command | 인자 |
|---|---|---|
| chat_request | `send_to_agent_command` | `{ message: JSON.stringify(payload) }` |
| approval_response | `send_to_agent_command` | `{ message: JSON.stringify(payload) }` |
| creds_update | `send_to_agent_command` | `{ message: ... }` (App.tsx:566) |
| cancel | **`cancel_stream`** (별 command) | `{ requestId }` |
| 수신 | `listen<string>("agent_response")` | payload = **JSON 문자열** → decodeAgentMessage |

→ `makeLiveStdioTransport(LiveTransportDeps)` 구현 완료(주입형, F0 makeF0LiveAdapters 패턴). Tauri invoke/listen 을 shell-edge 가 주입 = 어댑터 로직 실제이되 앱 무접촉 mock 테스트(6건 green). `wireChatUC1({ live })` 로 라이브 주입.
- ⚠️ **approval decision 불일치**: baseline = `once|always|reject`(3), 계약 DomainOutbound = `approve|reject`(2). UC1 기본 chat 은 승인 미발생이라 범위 밖 — **승인 배선 UC(UC5)에서 once/always/reject 로 정정** 필요.

## 5. 미해결/주의
- StdioTransportAdapter 실 send/onMessage = `@tauri-apps/api` 필요(new-naia-os 는 현재 node TS — Tauri 의존 추가 or shell 편입 시점에).
- requestId 고유성 불변식(§B.4.1) = 라이브에서도 baseline 이 보장(매 send UUID). 위반 시 레지스트리 충돌거부가 1차 방어.
- voice/tool/panel(비-chat variant) = PendingRouteSink 보류 중 → 각 UC(UC5/UC9/voice)에서 실제 포트 배선.
