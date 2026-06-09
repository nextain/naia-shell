# UC1 수평 계약 — ChatPort + protocol + transport (2026-06-10)

> 06 실행 = UC1(텍스트 대화) **수평 배선** 계약. 진실=UC1 시나리오. **이식(동작 흐름)을 ChatPort/protocol(transport-neutral)로 재표현 + transport 어댑터(stdio now→gRPC)**. grounding=Explore 실코드(채팅 동작 확인). 레이어 규칙=STRUCTURE.md(F0~F3 동일). 언어중립 시그니처.
> 직교: 이 수평은 **UC1 전용 아님** — 다중 클라이언트(ClientSessionPort)·비-Chat UC(ToolPort 등)가 같은 transport 위에. AppPort=ChatPort+ToolPort *조립 facade*(재흡수 아님).

---

# §A. Old-Baseline (Explore 실코드 — 동작 흐름)
| 단계 | 소스 | 거동 |
|---|---|---|
| 송신 | `ChatPanel.tsx:754 handleSend`→`chat-service.ts:136 sendChatMessage`→`:208 invoke("send_to_agent_command",{message:JSON})` | shell→Tauri→stdin |
| transport | `lib.rs:923 spawn_agent_core`(node --stdio)·`:1461 send_to_agent`(stdin write)·`:1175` stdout→`agent_response` event | **stdio JSON-line(프레이밍 없음)**. gRPC 0 |
| 수신(agent) | `agent/index.ts:1219 readline`→`:1358 chat_request`→`:381 handleChatRequest`→`provider.chat()` 스트리밍 | LLM 추론 |
| 응답 | `index.ts:268 writeLine`→chunk(text/thinking/tool_use/tool_result/approval_request/finish/error) | stdout JSON-line |
| 수신(shell) | `chat-service.ts:179 listen("agent_response")`→`ChatPanel.tsx:1002 handleChunk` | 렌더 |
| DTO | `agent/protocol.ts` ChatRequest{type,requestId,sessionId?,provider,messages,systemPrompt?,enableTools?,...} · AgentResponseChunk(union) | flat |
| 추상화 | **없음** — shell이 Tauri invoke/event에 직결. protocol-bridge.ts(StdioFrame v1)=미사용 scaffold |

**판정**: 흐름·DTO = **이식**(동작·old-auth). **ChatPort/AppPort 추상화·transport-neutrality = 보충**(직결→포트 재표현). "agent 미연결"=memory/deep(UC3+), 기본 chat 아님.

---

# §B. 포트 계약

## B.1 domain/ (순수, import 0)
| 값객체 | 규칙 |
|---|---|
| `ChatRequest` | `{requestId, sessionId?, messages:[{role,content}], systemPrompt?, enableTools?, enableThinking?}`. **provider/creds 제외**(별 채널 — secret 누출 방지, F0 stripForAgent 정합). |
| `ChatChunk` | union: `text·thinking·toolUse·toolResult·approvalRequest·finish·error`(+ panelToolCall 등). **transport-neutral**(stdio frame·gRPC 메시지 누출 금지). |
| `ChatTurn` | requestId 로 묶인 chunk 시퀀스 상태(streaming→finish/error). 순수 상태기계. |

## B.2 ports/ (driven+driving)
```
# ports/protocol — transport-neutral DTO (직렬화/프레이밍은 transport 어댑터만)
ChatRequestPayload / ChatChunkPayload = { ...의미 구조, wire-framing 누출 금지 }

# AppPort = ChatPort + ToolPort *조립 facade* (재흡수 아님, canon)
ChatPort:                                   # 대화 ingress (driving — shell이 호출)
    send(req: ChatRequest): void             # 비동기 발신 (NFR-efferent-async)
    subscribe(requestId, onChunk): Unsub     # 응답 스트림 구독
ToolPort:                                    # 툴 interaction (독립, UC5) — 별 계약
AgentTransportPort:                          # driven — agent(brain) 닿는 transport
    send(payload): Promise<void>             # stdio now / gRPC later
    onMessage(cb): Unsub                      # agent→os 수신
ClientSessionPort:                           # 다중 클라이언트(이 수평 공통, UC10a) — UC1 단일 owner
```
> ⚠️ transport-neutral: ChatChunkPayload 에 stdio/gRPC 형식 누출 금지 → stdio→gRPC = `AgentTransportPort` 어댑터 교체만.

## B.3 app/ (포트 사용)
```
ChatService:
  send(req): AgentTransportPort.send(encode(ChatRequest))   # provider/creds 별 채널(이미 creds_update)
  on transport message → decode → ChatChunk → ChatPort.subscribe 콜백 라우팅(requestId)
  # ChatTurn 상태기계: text 누적·finish/error 종결. 인지: Chat ingress→agent(brain)→Express 출력
```

## B.4 adapters/
| 어댑터 | 포트 | 구현 |
|---|---|---|
| `StdioTransportAdapter` | AgentTransportPort | `send_to_agent_command`(stdin) + `agent_response` event(stdout). 현 transport. |
| `GrpcTransportAdapter` (future) | AgentTransportPort | gRPC 다중클라이언트 — 어댑터 교체만(protocol 불변) |
| `TauriChatBridge` | ChatPort | shell ChatPanel ↔ ChatService 연결 |

## B.5 composition/ — `src/main/composition/` 단일 root, ChatPort+AppPort+AgentTransport(stdio) 주입.

## B.6 검증
- **계약 테스트**: mock AgentTransport → ChatService 가 chunk(text/finish/error) 라우팅·ChatTurn 종결·provider/creds 미포함(누출). drift-gate.
- **Old-Baseline 등가**: 옛 흐름(send→stream→finish) 행동 등가(old-auth). transport-neutral DTO 가 stdio/gRPC 무관.
- **라이브 trace**(루크 머신): 실제 채팅 1턴(입력→스트리밍 응답).

## B.7 다음
2클린 리뷰 → 코드 스캐폴드(`src/main` ChatPort/protocol/StdioTransportAdapter) → UC1 수직(U1.1~1.6) 엮기 → 라이브 trace.
