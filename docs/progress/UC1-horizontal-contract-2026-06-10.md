# UC1 수평 계약 — ChatPort + protocol + transport (2026-06-10)

> 06 실행 = UC1(텍스트 대화) **수평 배선** 계약. 진실=UC1 시나리오. **이식(동작 흐름)을 ChatPort/protocol(transport-neutral)로 재표현 + transport 어댑터(stdio now→gRPC)**. grounding=Explore 실코드(채팅 동작 확인). 레이어 규칙=STRUCTURE.md(F0~F3 동일). 언어중립 시그니처.
> 직교: 이 수평은 **UC1 전용 아님** — 다중 클라이언트(ClientSessionPort)·비-Chat UC(ToolPort 등)가 같은 transport 위에. AppPort=ChatPort+ToolPort *조립 facade*(재흡수 아님).

---

# §A. Old-Baseline (Explore 실코드 — 동작 흐름)
| 단계 | 소스 | 거동 |
|---|---|---|
| 송신 | `ChatPanel.tsx:754 handleSend`→`chat-service.ts:136 sendChatMessage`→`:208 invoke("send_to_agent_command",{message:JSON})` | shell→Tauri→stdin |
| transport | `lib.rs:923 spawn_agent_core`(node --stdio)·`:1461 send_to_agent`(stdin write)·`:1175` stdout→`agent_response` event | **stdio JSON-line(newline-delimited=프레이밍)**. gRPC 0 |
| 수신(agent) | `agent/index.ts:1219 readline`→`:1358 chat_request`→`:381 handleChatRequest`→`provider.chat()` 스트리밍 | LLM 추론 |
| 응답 | `index.ts:268 writeLine`→chunk(text/thinking/tool_use/tool_result/approval_request/finish/error/**audio/usage/log_entry/token_warning**) | stdout JSON-line |
| 제어 | `cancel_stream`(중단)·`approval_response`(승인 응답) = shell→agent 반환 경로 | stdin JSON-line |
| 수신(shell) | `chat-service.ts:179 listen("agent_response")`→`ChatPanel.tsx:1002 handleChunk` | 렌더 |
| DTO | `agent/protocol.ts` ChatRequest{type,requestId,sessionId?,provider,messages,systemPrompt?,enableTools?,...} · AgentResponseChunk(union, 정의=`shell/src/lib/types.ts`) | flat |
| 추상화 | **없음** — shell이 Tauri invoke/event에 직결. protocol-bridge.ts(StdioFrame v1)=미사용 scaffold |

**판정**: 흐름·DTO = **이식**(동작·old-auth). **ChatPort/AppPort 추상화·transport-neutrality = 보충**(직결→포트 재표현). "agent 미연결"=memory/deep(UC3+), 기본 chat 아님.

---

# §B. 포트 계약

## B.1 domain/ (순수, import 0)
| 값객체 | 규칙 |
|---|---|
| `ChatRequest` | `{requestId, clientId, sessionId?, provider:ProviderConfig*, gatewayUrl?(도구/enableTools 게이트웨이 — provider 와 별개), messages, systemPrompt?, enableTools?, disabledSkills?}`. ⚠️ **provider = baseline `ProviderConfig`(providers/types.ts) 형상 *verbatim passthrough*** — 키 재명명·재형상화 **없음**(`provider, model, ollamaHost?, vllmHost?, labGatewayUrl?, enableThinking?, ollamaNumCtx?`). **단 secret(`apiKey`/`naiaKey`@deprecated)만 strip**(`creds_update` 별채널, F0 stripForAgent 정합). 어댑터=ProviderConfig 스키마로 검증(secret 제외 키만 허용). 필수=`provider,model`. clientId=다중클라이언트 라우팅. **최상위 `gatewayUrl`=도구 gateway(enableTools 흐름)** — provider 내부 `labGatewayUrl`(provider 라우팅, ProviderConfig 소속)과 *별개 canon*. |
| `ChatChunk` | **chat-turn 관련 subset (권위=agent writeLine 출력 index.ts; shell types.ts=부분뷰, 추측 금지): 최소 `text·thinking·toolUse·toolResult·approvalRequest·finish·error` + 스트림 부수(usage·logEntry 등 types.ts 에 *실재하는* 것만). **transport-neutral**, `{requestId,clientId}` 소유권. payload canon=agent 출력(index.ts) 기준. ⚠️ **demux 규칙(exhaustive — 열거 아닌 클래스, 수행=transport-adapter 라우터 B.4)**: `AgentMessage`(권위=agent index.ts 출력) *전 variant* 를 switch — chat-turn(text·thinking·tool_use·tool_result·approval_request·finish·error·usage·log_entry·token_warning)→ChatChunk / 비-chat(panel_control·panel_install_result·panel_tool_call=UC9·skill_list_response=UC5·audio=voice·object·embedding_progress·ready 등 — *실재 variant 만*)→해당 포트 / **미지 타입=error+log, silent drop 금지**. variant 권위 = `AgentMessage`(=agent writeLine 출력 index.ts, superset). shell `lib/types.ts AgentResponseChunk`=부분뷰. demux exhaustive=AgentMessage 기준, 미지=error+log. |
| `ChatTurn` | requestId 로 묶인 chunk 시퀀스 상태(streaming→finish/error). 순수 상태기계. |

## B.2 ports/ (driven+driving)
```
# ports/protocol — transport-neutral DTO (직렬화/프레이밍은 transport 어댑터만)
ChatRequestPayload / ChatChunkPayload = { ...의미 구조, wire-framing 누출 금지 }   # ⚠️ domain VO(B.1)와 별 레이어: app 이 domain→Payload 매핑, adapter 가 Payload↔wire
AgentOutbound = **shell→agent 송신 protocol DTO union**(ChatRequestPayload | CancelPayload(cancel_stream) | ApprovalResponsePayload | CredsUpdatePayload ...). ⚠️ transport 는 payload-agnostic — 전 outbound 가 같은 send 경로. AgentMessage(수신)과 대칭.
AgentMessage = **raw 디코드 union (SoT here)**. variant 집합 권위 = agent writeLine 출력(`agent/index.ts`) — wire 실집합(superset). shell `lib/types.ts AgentResponseChunk`=소비측 부분뷰(≠SoT). 소유=ports/protocol, 스키마=index.ts 출력 미러. 미지 variant 허용(=error 라우팅 대상).

# AppPort = ChatPort + ToolPort *조립 facade* (재흡수 아님, canon)
ChatPort:                                   # 대화 ingress (driving — shell이 호출)
    startTurn(req, onChunk): { handle: TurnHandle, sent: Promise<void> }   # ⚠️ 원자적 listen-then-send. **sent Promise = send reject 호출자 전파(baseline 등가)**; 추가로 onChunk(error)+구독/레지스트리 해제. handle=취소/소유, sent=발신 결과.
    cancel(handle: TurnHandle): Promise<void> # cancel_stream (실행 중 중단) = `AgentTransportPort.send(CancelPayload)`. 비동기 — 전송 실패 reject 전파(send 등가)
    deliverChunk(chunk: ChatChunk): void      # ⚠️ 수신 sink (driving-in, **ports 계약**) — router(B.4)가 chat-turn chunk 를 여기로. app 의 ChatService 가 *구현*(adapter→ports canon, 구상 직접의존 금지). requestId→onChunk 라우팅은 ownership 레지스트리.
    # approvalRequest chunk = ChatPort 가 *노출만*. 응답은 **ApprovalPort(F1, AppPort 밖 독립 control-plane)** 경유 — ChatPort 흡수 금지(canon, codex R2)
TurnHandle = { requestId, clientId, unsubscribe }   # (startTurn 은 {handle, sent:Promise} 반환)   # 핸들(위조 방지 = 아래 레지스트리가 권위, 핸들 단독 아님)
  # ⚠️ ownership 레지스트리(ClientSessionPort/adapter): startTurn 시 requestId→clientId 등록 + **충돌 거부**(중복 requestId) + **모든 terminal(finish·cancel·error·send실패)** 시 해제(미해제=requestId 영구 점유). *(client lease 만료=ClientSessionPort UC10a 범위, 본 UC1 turn-terminal 아님 — baseline 은 chat-turn timeout 없음)*. legacy agent_response 엔 clientId 없으므로 *shell측 어댑터가 requestId→clientId 매핑 보유*. cancel/approval 권한 = 레지스트리 소유주만(타 client 차단)
ToolPort:                                    # 툴 interaction (독립, UC5) — 별 계약
AgentTransportPort:                          # driven — *순수 transport*(wire 책임만). demux·라우팅 안 함.
    send(payload: AgentOutbound): Promise<void>        # ⚠️ 전 outbound DTO union(chat-request·cancel_stream·approval-response·creds 등) — payload-agnostic. stdio now / gRPC later. **rejection = 호출자에 전파**(baseline 등가). cancel/approval 전송도 이 경로.
    onMessage(cb): Unsub                      # ⚠️ cb 는 **raw `AgentMessage` union 전 variant**(R4). **단일 구독자=MessageRouter**(B.4) — 여러 곳 구독 금지(중복전달 방지)
ClientSessionPort:                           # 다중 클라이언트 신원·owner·lease(UC10a). chunk 라우팅 = (clientId, requestId). UC1=단일 owner 등록(ID 충돌 방지)
# MessageRouter (adapters/, AgentTransportPort.onMessage 단일 구독): AgentMessage demux → 각 semantic port(ChatPort.deliverChunk 등). transport(wire)와 분리된 별 컴포넌트(중복전달·구독주체 모호 제거)
```
> ⚠️ transport-neutral: ChatChunkPayload 에 stdio/gRPC 형식 누출 금지 → stdio→gRPC = `AgentTransportPort` 어댑터 교체만.

## B.3 app/ (포트 사용)
```
ChatService:
  startTurn(req, onChunk): { handle, sent: Promise<void> }   # 구독 선행 등록 → **domain ChatRequest→ChatRequestPayload(protocol) 매핑** → AgentTransportPort.send(payload)(sent 반환). ⚠️ wire encode·demux 안 함(그건 adapter). domain→protocol 매핑 주체=ChatService(순수, wire 무지)
  implements ChatPort.deliverChunk(chunk)   # ⚠️ **router(B.4)가 이미 demux 해 *chat-turn ChatChunk 만* 전달**(ChatService 는 전체 union·wire 안 봄). adapter 는 ports 의 ChatPort 의존, ChatService 가 그 구현. (clientId,requestId) 소유 turn 라우팅
  # ChatTurn 상태기계: text 누적·finish/error 종결·cancel. 인지: Chat ingress→agent(brain)→Express 출력
  # ⚠️ wire DTO(JSON-line/gRPC msg)·raw union 모두 app 모름 — transport 어댑터만(canon)
```

## B.4 adapters/
| 어댑터 | 포트 | 구현 |
|---|---|---|
| `StdioTransportAdapter` | AgentTransportPort | **순수 wire 변환만**: `ChatRequestPayload→wire JSON-line encode` / `wire→AgentMessage union decode`. demux·라우팅 안 함(=MessageRouter). `send_to_agent_command`(stdin)+`agent_response`(stdout). ⚠️ **flat newline JSON 만**(agent 는 한 줄 곧바로 parseRequest). protocol-bridge StdioFrame v1=미사용 scaffold라 *보내지 않음*. gRPC=후속 어댑터(envelope 그때, AgentTransportPort 교체만). |
| `MessageRouter` | (AgentTransportPort.onMessage 단일 구독) | **demux 라우터**: AgentMessage 전 variant switch → chat-turn→**`ChatPort.deliverChunk`**(ports 계약, ChatService 구현 — adapter→ports canon, 구상 app 직접의존 아님) / 비-chat→해당 semantic port(ToolPort 등) / 미지=error+log(STRUCTURE:215~221 canon, app 은 demux 안 함). transport(wire)와 분리=단일 수신경로·중복전달 방지. |
| `GrpcTransportAdapter` (future) | AgentTransportPort | gRPC 다중클라이언트 — 어댑터 교체만(protocol 불변) |
| `TauriChatBridge` | ChatPort | shell ChatPanel ↔ ChatService 연결 |

## B.5 composition/ — `src/main/composition/` 단일 root, ChatPort+AppPort+AgentTransport(stdio) 주입.

## B.6 검증
- **계약 테스트**: mock AgentTransport → ChatService 가 chunk(text/finish/error) 라우팅·ChatTurn 종결·**secret(apiKey 등) 미포함**(provider *선택*은 포함; secret만 creds_update). drift-gate.
- **Old-Baseline 등가**: 옛 흐름(send→stream→finish) 행동 등가(old-auth). transport-neutral DTO 가 stdio/gRPC 무관.
- **승인 turn**: approvalRequest chunk → **ApprovalPort(F1).respond** 로 응답(ChatPort 아님). cancel = ChatPort.cancel(chat-stream 중단; e-stop=SafetyPort 별도).
- **라이브 trace**(루크 머신): 실제 채팅 1턴(입력→스트리밍 응답).

## B.7 다음
2클린 리뷰 → 코드 스캐폴드(`src/main` ChatPort/protocol/StdioTransportAdapter) → UC1 수직(U1.1~1.6) 엮기 → 라이브 trace.
