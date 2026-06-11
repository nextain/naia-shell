# UC13 os 측 승인 게이트 결선 — approval_request 렌더 + approval_response 송신 (2026-06-11)

> 짝: new-naia-agent UC5 §D(agent 승인 게이트, 2-clean+라이브). 이 문서 = **os 측** 결선 — agent 가 보낸 approval_request 를 앱 UI 가 렌더하고, 사용자 결정을 approval_response 로 새 core 경유 송신.
> 앵커: 새 core wire(H-agent) 불변. AgentOutbound 에 approval_response 변종·toAgentOutbound·message-router approvalRequest·chatChunkToWire 는 **이미 존재**(UC1 §B.4). 갭 = (1) shell-compat 가 approval 송신 미노출 (2) chat-service NEW_CORE 분기 부재 (3) **결정 vocab mismatch 버그**.

## §A. 배선 점검 결과(현황)
- **INBOUND(완전 배선)**: agent `approval_request` → wire → os MessageRouter → ChatChunk `approvalRequest{toolCallId,toolName,tier}` → `chatChunkToWire` → `{type:"approval_request",...}` → `onChunk` → ChatPanel handleChunk case "approval_request"(렌더). ✅ 새 core 에서 동작(chatChunkToWire 가 매핑).
- **OUTBOUND(갭)**: ChatPanel `handleApprovalDecision/auto-approve` → 로컬 `sendApprovalResponse(requestId,toolCallId,decision)` → **`invoke("send_to_agent_command", {approval_response})` 직접 호출**(chat-service 우회).
- ⚠️ **버그(점검서 발견)**: ChatPanel 결정 vocab = `"once"|"always"|"reject"`. 그러나 new-naia-agent `decodeRequest` = `decision === "approve" ? "approve" : "reject"` → **`once`/`always`(승인 의도)가 전부 reject 로 둔갑**. 새 core 에서 사용자가 승인해도 agent 거부. (old 경로는 old agent 가 once/always 이해 → old 는 정상.)

## §B. 계약(갭 해소)
### B.1 shell-compat(os core) — approval 송신 노출
- `sendApprovalResponse(requestId: string, toolCallId: string, decision: "approve"|"reject"): Promise<void>` 추가 → `transport.send({ kind:"approvalResponse", requestId, toolCallId, decision })`(toAgentOutbound → wire `approval_response`). sendChatMessage/cancelChat/sendCredsUpdate 와 동일 패턴(Promise, send reject 전파).

### B.2 shell chat-service.ts — NEW_CORE 분기 + 결정 매핑 (fire-and-forget 안전)
- `export async function sendApprovalResponse(requestId, toolCallId, uiDecision: "once"|"always"|"reject"): Promise<void>`:
  - **결정 매핑**: `mapped = uiDecision === "reject" ? "reject" : "approve"`(once/always→approve — 승인 의도 보존, 버그 수정).
  - 분기를 **단일 try/catch 로 감싸 내부 swallow+log**(old ChatPanel 의 `.catch(log)` 패리티) → **호출자에게 절대 reject 안 함**(fire-and-forget 안전, 미처리 rejection 없음):
    - `if (isNewCore())`: `await coreChat().sendApprovalResponse(requestId, toolCallId, mapped)` (coreChat 는 send reject 전파하나 여기서 catch+Logger.warn).
    - else(old): `await safeSendToAgent({type:"approval_response", requestId, toolCallId, decision: uiDecision}, "sendApprovalResponse")`(old 패턴 — old agent 가 once/always raw 이해, unavailable swallow=회귀 없음).
  - ⚠️ **UI 제거는 optimistic**(old 동작 패리티 — 호출처가 결정 직후 승인 프롬프트 제거; 송신 실패 시 agent 보류는 turn cancel/timeout 으로 바운드 해소). 송신 성공 보장이 필요한 강화는 후속.

### B.3 ChatPanel — 로컬 sendApprovalResponse 제거, chat-service 사용
- ChatPanel 로컬 `sendApprovalResponse`(직접 invoke) 삭제 → chat-service 의 것 import(sendChatMessage 와 동일 패턴). 3개 호출처(handleApprovalDecision·voice auto-approve·tool auto-approve)는 **fire-and-forget 그대로 안전**(chat-service 가 내부 swallow). uiDecision once/always/reject 전달, chat-service 가 매핑·라우팅. **UI/렌더 불변**(로직 seam 만 교체).

## §C. 불변식
- (UC13-I1) **결정 의미 보존**: once/always→approve, reject→reject(new core). 사용자 승인이 agent 에서 reject 되지 않음.
- (UC13-I2) **old 경로 회귀 없음**: NEW_CORE 아니면 기존 raw once/always/reject 송신(old agent 호환).
- (UC13-I3) wire/agent/슬라이스2 불변 — os 측 송신 결선만. approval_response 권한(requestId 소유)= agent 측 prepareDecision 키 대조(§D).
- (UC13-I4) INBOUND 렌더 불변(이미 동작).

## §D. 검증
- 계약/단위: chat-service sendApprovalResponse — (a) NEW_CORE + once → coreChat.sendApprovalResponse(...,"approve") (b) always → "approve" (c) reject → "reject" (d) !NEW_CORE → safeSendToAgent(raw uiDecision, swallow) (e) NEW_CORE coreChat reject → 내부 swallow+log(호출자 무throw) (f) old agent unavailable → swallow. shell-compat sendApprovalResponse → transport.send(approvalResponse).
- **실 UI E2E**(Playwright, uc1-new-core 패턴): mock agent 가 approval_request emit → ChatPanel 승인 UI 렌더 → approve 클릭 → 새 core wire 로 `{type:"approval_response", decision:"approve"}` 송신 단언(window.__E2E_OUTBOUND__). reject 클릭 → decision "reject".
- **2-AI 크로스리뷰(codex + GLM5.1)**: §C 계약 + shell-compat/chat-service 코드 2연속 NONE 양 AI.
