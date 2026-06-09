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
| `ChatChunk` | **AgentMessage 중 chat-turn subset 의 domain 표현. 포함기준 권위=agent writeLine 출력(index.ts) 단일** (shell types.ts=소비측 부분뷰, 정보용일 뿐 게이트 아님): `text·thinking·toolUse·toolResult·approvalRequest·finish·error·usage·logEntry·tokenWarning`(=agent chat-turn 출력). **transport-neutral**, `{requestId,clientId}` 소유권. payload canon=agent 출력(index.ts) 기준. ⚠️ **demux 규칙(exhaustive — 열거 아닌 클래스, 수행=transport-adapter 라우터 B.4)**: `AgentMessage`(권위=agent index.ts 출력) *전 variant* 를 switch — chat-turn(requestId 보유: text·thinking·tool_use·tool_result·approval_request·finish·error·usage·log_entry·token_warning)→ChatChunk→`deliverChunk`(소유권 필수) / 비-chat known(panel_control·panel_install_result·panel_tool_call=UC9·skill_list_response=UC5·audio=voice·object·embedding_progress·ready)→**해당 semantic port — 단 UC1 시점 미배선(UC9/UC5/voice 범위)이면 PendingRouteSink(log+보류, drop 아님)로 보내 exhaustive 유지, 해당 UC 에서 실제 포트 배선** / **UnknownAgentMessage·소유권(requestId) 없는 것 = DiagnosticSink(error+log, 소유권 불요 — deliverChunk 아님), silent drop 금지**. variant 권위 = `AgentMessage`(=agent writeLine 출력 index.ts, superset). shell `lib/types.ts AgentResponseChunk`=부분뷰. demux exhaustive=AgentMessage 기준, 미지=error+log. |
| `ChatTurn` | requestId 로 묶인 chunk 시퀀스 상태기계: `streaming →(cancel 요청)→ cancelling →(inbound)→ finish/error(terminal)`. ⚠️ **cancel 은 비종결 요청** — finish/error 만 종결(=ownership 해제, B.2 일치). 순수. |
| `DomainOutbound` | **app→agent 송신 domain 의도 폐쇄 union**(AgentTransportPort.send 경계 타입; adapter 가 이를 AgentOutbound(protocol)→wire 로 변환). = `ChatRequest(위) \| CancelTurn{requestId,clientId} \| ApprovalResponseIntent{requestId,clientId,toolCallId,decision:'approve'\|'reject'} \| CredsUpdate{provider,secret:{apiKey?\|naiaKey?}}`(UC1 범위 — secret 은 도메인 내부에선 보유하되 *송신 채널만* creds_update 로 분리, F0 정합). AgentOutbound 4 variant 와 1:1 대응(domain↔protocol 매핑 = adapter). |

## B.2 ports/ (driven+driving)
```
# ports/protocol — transport-neutral DTO (직렬화/프레이밍은 transport 어댑터만)
ChatRequestPayload / ChatChunkPayload = { ...의미 구조, wire-framing 누출 금지 }   # ⚠️ transport-neutral *중립 intermediate*(ports 소유). **domain↔protocol↔wire 변환 전부 adapter 책임**(STRUCTURE canon, R12). stdio·gRPC 어댑터 공유 target. **app(ChatService)=domain 만**(protocol·wire 무지)
AgentOutbound = **shell→agent 송신 protocol DTO 폐쇄 union**, `type` discriminant 판별 = `ChatRequestPayload{type:"chat_request"} | CancelPayload{type:"cancel_stream",requestId} | ApprovalResponsePayload{type:"approval_response"} | CredsUpdatePayload{type:"creds_update"}`(UC1 범위 4개 — 폐쇄. outbound 는 *우리가 생성*하므로 미지 없음; 후속 UC 가 멤버 추가 시 union 명시 확장). 권위=baseline parseRequest 처리 집합. transport=payload-agnostic(전 outbound 같은 send 경로). AgentMessage(수신, superset+Unknown)과 비대칭 이유=수신은 미지 가능·송신은 폐쇄.
AgentMessage = **raw 디코드 union (SoT here)** = `KnownAgentMessage(18 variant) | UnknownAgentMessage`. `UnknownAgentMessage = { type: string(18 외), raw: unknown }`(미지 catch-all — exhaustive demux 의 default arm). variant 집합 권위 = agent writeLine 출력(`agent/index.ts`) — wire 실집합(superset). shell `lib/types.ts AgentResponseChunk`=소비측 부분뷰(≠SoT). 소유=ports/protocol, 스키마=index.ts 출력 미러.

# AppPort = ChatPort + ToolPort *조립 facade* (재흡수 아님, canon)
ChatPort:                                   # 대화 ingress (driving — shell이 호출)
    startTurn(req, onChunk): { handle: TurnHandle, sent: Promise<void> }   # ⚠️ 원자적 listen-then-send. **sent Promise = send reject 호출자 전파(baseline 등가)**; 추가로 onChunk(error)+구독/레지스트리 해제. handle=취소/소유, sent=발신 결과.
    cancel(handle: TurnHandle): Promise<void> # cancel_stream (실행 중 중단) = `AgentTransportPort.send(CancelPayload)`. 비동기 — 전송 실패 reject 전파(send 등가)
    deliverChunk(chunk: ChatChunk): void      # ⚠️ 수신 sink (driving-in, **ports 계약**) — router(B.4)가 chat-turn chunk 를 여기로. app 의 ChatService 가 *구현*(adapter→ports canon, 구상 직접의존 금지). requestId→onChunk 라우팅은 ownership 레지스트리.
    # approvalRequest chunk = ChatPort 가 *노출만*. 응답은 **ApprovalPort(F1, AppPort 밖 독립 control-plane)** 경유 — ChatPort 흡수 금지(canon, codex R2)
TurnHandle = { requestId, clientId, unsubscribe }   # (startTurn 은 {handle, sent:Promise} 반환)   # 핸들(위조 방지 = 아래 레지스트리가 권위, 핸들 단독 아님)
  # ⚠️ ownership 레지스트리 **단일 책임자 = ClientSessionPort 구현(adapter)** — 등록·충돌거부·해제·cancel/approval 권한인가 전부 여기 1곳(ChatService·MessageRouter·shell 어댑터는 *조회/통지*만, 소유 아님). startTurn 시 requestId→clientId 등록 + **충돌 거부**(중복 requestId) + **해제 = inbound 종결 chunk(finish/error) 수신 시 OR *초기* send reject(요청이 agent 에 도달 못 함=chunk 안 옴, 안전)**. ⚠️ **cancel_stream send reject 로는 해제 안 함** — turn 이 여전히 라이브일 수 있어 후속 finish/error 유실 위험(R12); cancel 은 *요청*일 뿐 해제는 뒤따르는 finish/error 가(R10). (agent 가 cancel 후 아무것도 안 보내는 경우=lease/timeout, UC10a 범위) *(client lease 만료=ClientSessionPort UC10a 범위, 본 UC1 turn-terminal 아님 — baseline 은 chat-turn timeout 없음)*. legacy agent_response 엔 clientId 없으므로 inbound 측은 requestId 로 레지스트리 조회해 clientId 복원. cancel/approval 권한 = 레지스트리(=ClientSessionPort)가 소유주 대조해 인가(타 client 차단)
ToolPort:                                    # 툴 interaction (독립, UC5) — 별 계약
AgentTransportPort:                          # driven — *순수 transport*(wire 책임만). demux·라우팅 안 함.
    send(out: DomainOutbound): Promise<void>           # ⚠️ 경계=**domain 레벨 outbound 의도**(domain ChatRequest·cancel·approval-response 등). adapter 가 domain→AgentOutbound(protocol)→wire 변환(app 은 protocol/wire 무지, canon). payload-agnostic·rejection 호출자 전파. cancel/approval 전송도 이 경로.
    onMessage(cb): Unsub                      # ⚠️ cb=**raw `AgentMessage`(protocol) 전 variant**(R4). **단일 구독자=MessageRouter**(B.4) — 여러 곳 구독 금지(중복전달 방지). router 가 protocol AgentMessage→domain ChatChunk 변환 후 deliver(app=domain).
ClientSessionPort:                           # 다중 클라이언트 신원·owner·lease(UC10a) + **ownership 레지스트리 단일 소유자**(requestId→clientId, 충돌거부·해제·권한인가의 SoT). chunk 라우팅=(clientId,requestId). UC1=단일 owner 등록(ID 충돌 방지)
# MessageRouter (adapters/, AgentTransportPort.onMessage 단일 구독): AgentMessage demux → 각 semantic port(ChatPort.deliverChunk 등). transport(wire)와 분리된 별 컴포넌트(중복전달·구독주체 모호 제거)
```
> ⚠️ transport-neutral: ChatChunkPayload 에 stdio/gRPC 형식 누출 금지 → stdio→gRPC = `AgentTransportPort` 어댑터 교체만.

## B.3 app/ (포트 사용)
```
ChatService (implements ChatPort: startTurn/cancel/deliverChunk):
  startTurn(req, onChunk): { handle, sent: Promise<void> }   # 구독 선행 등록 → AgentTransportPort.send(**domain** req)(sent 반환). ⚠️ **domain 만 다룸** — domain↔protocol↔wire 변환·demux 전부 adapter(canon, R12). ChatService 는 protocol/wire 모름
  implements ChatPort.deliverChunk(chunk)   # ⚠️ **router(B.4)가 이미 demux 해 *chat-turn ChatChunk 만* 전달**(ChatService 는 전체 union·wire 안 봄). adapter 는 ports 의 ChatPort 의존, ChatService 가 그 구현. (clientId,requestId) 소유 turn 라우팅
  # ChatTurn 상태기계: text 누적 · cancel=cancelling 전이(**비종결**) · finish/error 만 종결(ownership 해제 일치, B.2). 인지: Chat ingress→agent(brain)→Express 출력
  # ⚠️ wire DTO(JSON-line/gRPC msg)·raw union 모두 app 모름 — transport 어댑터만(canon)
```

## B.4 adapters/
| 어댑터 | 포트 | 구현 |
|---|---|---|
| `StdioTransportAdapter` | AgentTransportPort | **변환 전담**(canon): `domain outbound→AgentOutbound(protocol)→wire JSON-line encode` / `wire→AgentMessage(protocol) decode`(domain 변환은 router). chat-request·cancel_stream·approval-response·creds 전 outbound. demux·라우팅 안 함(=MessageRouter). `send_to_agent_command`(stdin)+`agent_response`(stdout). ⚠️ **flat newline JSON 만**(agent 는 한 줄 곧바로 parseRequest). protocol-bridge StdioFrame v1=미사용 scaffold라 *보내지 않음*. gRPC=후속 어댑터(envelope 그때, AgentTransportPort 교체만). |
| `MessageRouter` | (AgentTransportPort.onMessage 단일 구독) | **demux 라우터**: AgentMessage(protocol) 전 variant switch → chat-turn(requestId)→**domain ChatChunk 변환 후 `ChatPort.deliverChunk`**(ports 계약, ChatService 구현=domain, 소유권 필수 — adapter→ports canon) / 비-chat known→해당 semantic port(ToolPort 등; UC1 미배선=PendingRouteSink log+보류) / UnknownAgentMessage·소유권 없음→**DiagnosticSink(error+log, 소유권 불요)** (STRUCTURE:215~221 canon, app 은 demux/protocol 안 봄). ⇒ 18 variant + Unknown 전부 분기 도착=exhaustive 보장. transport(wire)와 분리=단일 수신경로·중복전달 방지. |
| `GrpcTransportAdapter` (future) | AgentTransportPort | gRPC 다중클라이언트 — 어댑터 교체만(protocol 불변) |
| `TauriChatBridge` | (ChatPort *의존/호출* — 구현 아님) | **outbound 전용 driving adapter**: shell ChatPanel `invoke`→`ChatPort.startTurn/cancel` 호출 + startTurn `onChunk`→shell 렌더(event) 전달. ⚠️ **agent stdout(`agent_response`) 수신은 Bridge 아님** = StdioTransportAdapter+MessageRouter 단일 경로(중복 구독 금지, R15). ChatPort 구현자=app 의 ChatService. |

## B.5 composition/ — `src/main/composition/` 단일 root, ChatPort+AppPort+AgentTransport(stdio) 주입.

## B.6 검증
- **계약 테스트**: mock AgentTransport.onMessage 방출 → **MessageRouter demux → ChatService.deliverChunk**(ChatService 는 onMessage 직접 구독 안 함, R15) → chunk(text/finish/error) 라우팅·ChatTurn 종결. + send 시 **secret(apiKey/naiaKey) 미포함**(provider 선택은 포함; secret만 creds_update). drift-gate.
- **Old-Baseline 등가**: 옛 흐름(send→stream→finish) 행동 등가(old-auth). transport-neutral DTO 가 stdio/gRPC 무관.
- **승인 turn**: approvalRequest chunk → **ApprovalPort(F1).respond** 로 응답(ChatPort 아님). cancel = ChatPort.cancel(chat-stream 중단; e-stop=SafetyPort 별도).
- **라이브 trace**(루크 머신): 실제 채팅 1턴(입력→스트리밍 응답).

## B.7 다음
2클린 리뷰 → 코드 스캐폴드(`src/main` ChatPort/protocol/StdioTransportAdapter) → UC1 수직(U1.1~1.6) 엮기 → 라이브 trace.
